import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { LhMessage } from "../src/core/native-messages.ts";
import {
	MfnClient,
	MfnIngestOutbox,
	MfnSupervisor,
	ingestSettledTurnWithMfn,
	messageMemoryId,
	mintUuidV7,
	prepareTurnContextWithMfn,
	probeOllamaModelDigest,
	writeEmbeddersPinFile,
} from "../src/memory/mfn/index.ts";

const WORKTREE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PERSIST_ROOT = process.env.PEER_PERSIST_ROOT ?? "/usr/lib/persist/peer";
const MFN_BIN_DIR = path.join(PERSIST_ROOT, "build", "mfn", "bin");
const SCRATCH_ROOT = process.env.PEER_TEST_SCRATCH ?? path.join(PERSIST_ROOT, "scratch");
const MODEL_NAME = "nomic-embed-text:latest";
const MODEL_DIGEST = "a1b2c3d4e5f60718293a4b5c6d7e8f90112233445566778899aabbccddeeff00";
const SKIP_REASON =
	!fs.existsSync(path.join(MFN_BIN_DIR, "mfn-gateway")) && process.env.PEER_REQUIRE_SUBSTRATE !== "1"
		? "native MFN binaries absent"
		: false;

const STOPWORDS = new Set([
	"search", "document", "query", "user", "assistant", "a", "an", "the",
	"is", "are", "to", "me", "how", "and", "under", "for", "remind", "explain",
]);

function deterministicVector768(text: string): number[] {
	const vec = new Array<number>(768).fill(0.0001);
	const tokens = text
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((tok) => tok.length > 1 && !STOPWORDS.has(tok));
	for (const tok of tokens) {
		const digest = createHash("sha256").update(tok).digest();
		for (let k = 0; k < 8; k++) {
			const idx = digest.readUInt16BE(k * 2) % 768;
			const sign = (digest[16 + k]! & 1) === 0 ? 1 : -1;
			vec[idx] = vec[idx]! + sign * 1.0;
		}
	}
	return vec;
}

function handleOllamaEmbed(req: http.IncomingMessage, res: http.ServerResponse): void {
	const chunks: Buffer[] = [];
	req.on("data", (c: Buffer) => chunks.push(c));
	req.on("end", () => {
		const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { input?: string[] };
		const inputs = Array.isArray(parsed.input) ? parsed.input : [];
		const body = JSON.stringify({ embeddings: inputs.map((item) => deterministicVector768(item)) });
		res.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
		res.end(body);
	});
}

function startMockOllamaServer(): Promise<{
	port: number;
	setOnline: (online: boolean) => void;
	close: () => Promise<void>;
}> {
	let isOnline = true;
	const server = http.createServer((req, res) => {
		if (!isOnline) {
			res.writeHead(503, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "mock ollama offline" }));
			return;
		}
		if (req.method === "GET" && req.url === "/api/tags") {
			const body = JSON.stringify({ models: [{ name: MODEL_NAME, model: MODEL_NAME, digest: MODEL_DIGEST }] });
			res.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
			res.end(body);
			return;
		}
		if (req.method === "POST" && req.url === "/api/embed") return handleOllamaEmbed(req, res);
		res.writeHead(404);
		res.end();
	});
	const setOnline = (next: boolean) => {
		isOnline = next;
	};
	const close = () => new Promise<void>((done) => server.close(() => done()));
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			resolve({ port: (server.address() as net.AddressInfo).port, setOnline, close });
		});
	});
}

function findFreeTcpPort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const srv = net.createServer();
		srv.once("error", reject);
		srv.listen(0, "127.0.0.1", () => {
			const port = (srv.address() as net.AddressInfo).port;
			srv.close((err) => (err ? reject(err) : resolve(port)));
		});
	});
}

function sleepMs(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeUserMsg(id: string, content: string, timestamp: number): LhMessage {
	return { id, role: "user", content, timestamp } as LhMessage;
}

const PSR_PROXY_RELAY_LINES = [
	"def rx(s, n):",
	"    b = bytearray()",
	"    while len(b) < n:",
	"        c = s.recv(n - len(b))",
	"        if not c: return None",
	"        b.extend(c)",
	"    return bytes(b)",
	"def relay(cli, rpath, stop):",
	"    up = None",
	"    try:",
	"        while not stop.is_set():",
	"            hdr = rx(cli, 4)",
	"            if not hdr: break",
	"            body = rx(cli, struct.unpack('<I', hdr)[0])",
	"            if body is None: break",
	"            if b'admin.pause_writes' in body:",
	"                cap = time.monotonic() + 8.0",
	"                while os.path.exists(HOLD) and time.monotonic() < cap and not stop.is_set():",
	"                    time.sleep(0.01)",
	"            if up is None:",
	"                up = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)",
	"                up.connect(rpath)",
	"            up.sendall(hdr + body)",
	"            rh = rx(up, 4)",
	"            if not rh: break",
	"            rb = rx(up, struct.unpack('<I', rh)[0])",
	"            if rb is None: break",
	"            cli.sendall(rh + rb)",
	"    except OSError: pass",
	"    finally:",
	"        for s in (up, cli):",
	"            try: s and s.close()",
	"            except OSError: pass",
];

function buildPsrProxyPython(realPsr: string, realRuntimeDir: string, holdFile: string): string {
	const cfgLines = [
		`REAL_PSR = ${JSON.stringify(realPsr)}`,
		`REAL_RT = ${JSON.stringify(realRuntimeDir)}`,
		`HOLD = ${JSON.stringify(holdFile)}`,
	];
	return [
		"#!/usr/bin/env python3",
		"import os, signal, socket, struct, subprocess, sys, threading, time",
		...cfgLines,
		...PSR_PROXY_RELAY_LINES,
		"os.makedirs(REAL_RT, mode=0o700, exist_ok=True); os.chmod(REAL_RT, 0o700)",
		"rpath = os.path.join(REAL_RT, 'layer5.sock')",
		"ppath = os.path.join(os.environ['MFN_RUNTIME_DIR'], 'layer5.sock')",
		"env = {**os.environ, 'MFN_RUNTIME_DIR': REAL_RT}",
		"proc = subprocess.Popen([REAL_PSR], env=env, stdin=subprocess.DEVNULL, start_new_session=True)",
		"t0 = time.monotonic()",
		"while not os.path.exists(rpath):",
		"    if proc.poll() is not None or time.monotonic() - t0 > 5.0: sys.exit(1)",
		"    time.sleep(0.01)",
		"if os.path.exists(ppath): os.unlink(ppath)",
		"os.umask(0o177); srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM); srv.bind(ppath)",
		"os.chmod(ppath, 0o600); srv.listen(32); srv.settimeout(0.1); stop = threading.Event()",
		"def on_sig(sig, _f):",
		"    stop.set()",
		"    if proc.poll() is None: proc.send_signal(sig)",
		"signal.signal(signal.SIGTERM, on_sig); signal.signal(signal.SIGINT, on_sig)",
		"while not stop.is_set() and proc.poll() is None:",
		"    try: cli, _ = srv.accept()",
		"    except socket.timeout: continue",
		"    except OSError: break",
		"    threading.Thread(target=relay, args=(cli, rpath, stop), daemon=True).start()",
		"for fn in (srv.close, lambda: os.unlink(ppath)):",
		"    try: fn()",
		"    except OSError: pass",
		"if proc.poll() is None: proc.send_signal(signal.SIGTERM)",
		"rc = proc.wait(timeout=10.0); sys.exit(0 if rc == 0 else rc)",
		"",
	].join("\n");
}

function prepareProxiedBinDir(stateRoot: string, holdFile: string): string {
	const proxyBinDir = path.join(stateRoot, "bin");
	const psrRealDir = path.join(stateRoot, "psr-real");
	fs.mkdirSync(proxyBinDir, { recursive: true, mode: 0o700 });
	fs.chmodSync(proxyBinDir, 0o700);
	fs.mkdirSync(psrRealDir, { recursive: true, mode: 0o700 });
	fs.chmodSync(psrRealDir, 0o700);
	for (const name of ["ifr", "dsr", "alm", "cpe", "mfn-gateway"]) {
		const dst = path.join(proxyBinDir, name);
		fs.copyFileSync(path.join(MFN_BIN_DIR, name), dst);
		fs.chmodSync(dst, 0o755);
	}
	const psrProxyPath = path.join(proxyBinDir, "psr");
	const script = buildPsrProxyPython(path.join(MFN_BIN_DIR, "psr"), psrRealDir, holdFile);
	fs.writeFileSync(psrProxyPath, script, { mode: 0o755 });
	fs.chmodSync(psrProxyPath, 0o755);
	return proxyBinDir;
}

function readIncomingBody(
	res: http.IncomingMessage,
	resolve: (val: { httpStatus: number; rawBody: string }) => void,
	reject: (err: unknown) => void,
): void {
	const chunks: Buffer[] = [];
	res.on("data", (c: Buffer) => chunks.push(c));
	res.once("end", () => {
		resolve({ httpStatus: res.statusCode ?? 0, rawBody: Buffer.concat(chunks).toString("utf8") });
	});
	res.once("error", reject);
}

function postGatewayRoute(
	port: number, routePath: string, token: string, bodyJson: string, timeoutMs = 8_000,
): Promise<{ httpStatus: number; rawBody: string }> {
	const headers: http.OutgoingHttpHeaders = {
		Authorization: `Bearer ${token}`,
		Accept: "application/json",
		"Content-Type": "application/json",
		"Content-Length": String(Buffer.byteLength(bodyJson, "utf8")),
		Connection: "close",
	};
	return new Promise((resolve, reject) => {
		const opts = { hostname: "127.0.0.1", port, path: routePath, method: "POST", headers, agent: false };
		const req = http.request(opts, (res) => readIncomingBody(res, resolve, reject));
		const timer = setTimeout(() => req.destroy(new Error(`Timeout on ${routePath}`)), timeoutMs);
		req.once("close", () => clearTimeout(timer));
		req.once("error", reject);
		req.end(bodyJson, "utf8");
	});
}

async function waitGatewayPaused(client: MfnClient, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const health = await client.healthGet(2_000);
		if (JSON.stringify(health).includes("\"dispatch_paused\":true")) return;
		await sleepMs(15);
	}
	throw new Error("Timed out waiting for health.get to report dispatch_paused: true");
}

function isHealthFullyUnpaused(health: unknown): boolean {
	type LayerHealth = { result?: { admission_paused?: unknown } };
	const env = health as { result?: { readiness?: { dispatch_paused?: unknown }; outcomes?: LayerHealth[] } };
	const dispatchUnpaused = env.result?.readiness?.dispatch_paused === false;
	const outcomes = env.result?.outcomes ?? [];
	return dispatchUnpaused && outcomes.length === 5 && outcomes.every((o) => o.result?.admission_paused === false);
}

async function waitGatewayUnpaused(client: MfnClient, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			if (isHealthFullyUnpaused(await client.healthGet(2_000))) return;
		} catch {
			// Retry while backup capture settles.
		}
		await sleepMs(25);
	}
	throw new Error("Timed out waiting for health.get to report all dispatch and layers unpaused");
}

async function verifyHebbianSpreadAndExclusions(client: MfnClient, outbox: MfnIngestOutbox): Promise<void> {
	await waitGatewayUnpaused(client);
	const s1Msgs = [
		makeUserMsg("m_s1_1", "A sigma algebra is closed under complement and countable unions.", 1_000),
		makeUserMsg("m_s1_2", "Vitali construction partitions equivalence classes modulo rationals.", 2_000),
	];
	const firstIngest = await ingestSettledTurnWithMfn({
		client, outbox, chatId: "chat_s1", turnMessages: s1Msgs, mainPoolId: "peer-main", lexicalPoolId: "peer-lexical",
	});
	assert.equal(firstIngest.ingestedBatches + firstIngest.queuedBatches, 1);
	assert.equal(firstIngest.lexicalWrites + firstIngest.queuedLexicalWrites, 2);
	while (outbox.size() > 0) {
		await waitGatewayUnpaused(client);
		await outbox.flush(client, { force: true });
		if (outbox.size() > 0) await sleepMs(40);
	}
	const memId1 = messageMemoryId("chat_s1", "m_s1_1");
	const memId2 = messageMemoryId("chat_s1", "m_s1_2");
	await assertLiveSpreadNeighbor(client, memId2);
	await assertLiveExclusionHonored(client, s1Msgs[0]!, memId1);
}

async function assertLiveSpreadNeighbor(client: MfnClient, memId2: string): Promise<void> {
	const prompt = "How is a sigma algebra closed under complement and countable unions?";
	const s2Msgs = [makeUserMsg("m_s2_1", prompt, 3_000)];
	let spreadNeighbor = undefined;
	const deadline = Date.now() + 3_000;
	while (Date.now() < deadline) {
		const recalled = await prepareTurnContextWithMfn({
			client, chatId: "chat_s2", messages: s2Msgs, mainPoolId: "peer-main", lexicalPoolId: "peer-lexical",
		});
		spreadNeighbor = recalled.recalledMemories.find((m) => m.memory_id === memId2);
		const viaL3 = spreadNeighbor?.evidence.some((e) => e.layer === 3) ?? false;
		if (spreadNeighbor && (spreadNeighbor.activation.spread > 0 || viaL3)) {
			assert.ok(recalled.marker?.content.includes("sigma algebra"));
			break;
		}
		await sleepMs(40);
	}
	assert.ok(spreadNeighbor, "Expected co-ingested zero-overlap neighbor to be recalled via L3 spread");
	assert.equal(spreadNeighbor.activation.spread > 0 || spreadNeighbor.evidence.some((e) => e.layer === 3), true);
}

async function assertLiveExclusionHonored(client: MfnClient, tailMsg: LhMessage, memId1: string): Promise<void> {
	const query = { text: "A sigma algebra is closed under complement and countable unions.", context: null };
	const session = { kind: "chat" as const, id: "chat_s1" };
	const positiveControl = await client.turnRecall("peer-main", { query, session, exclude_memory_ids: [] });
	assert.equal(positiveControl.result.memories.some((m) => m.memory_id === memId1), true);
	const rawExcluded = await client.turnRecall("peer-main", { query, session, exclude_memory_ids: [memId1] });
	assert.equal(rawExcluded.result.memories.some((m) => m.memory_id === memId1), false);
	const sameChatCtx = await prepareTurnContextWithMfn({
		client, chatId: "chat_s1", messages: [tailMsg], mainPoolId: "peer-main", lexicalPoolId: "peer-lexical",
	});
	assert.equal(sameChatCtx.recalledMemories.some((m) => m.memory_id === memId1), false);
}

async function triggerHeldBackupPause(client: MfnClient, mfnPort: number, token: string): Promise<void> {
	const deadline = Date.now() + 8_000;
	while (Date.now() < deadline) {
		const curHealth = await client.healthGet(2_000);
		if (JSON.stringify(curHealth).includes("\"dispatch_paused\":true")) return;
		const bodyJson = JSON.stringify({ request_id: mintUuidV7() });
		const backupRes = await postGatewayRoute(mfnPort, "/v2/backups", token, bodyJson);
		assert.equal(backupRes.httpStatus === 202 || backupRes.httpStatus === 503, true);
		if (backupRes.httpStatus === 202) {
			await waitGatewayPaused(client);
			return;
		}
		await sleepMs(40);
	}
	throw new Error("Timed out establishing held dispatch_paused state");
}

async function verifyAdmissionPausedDuringBackup(
	client: MfnClient, mfnPort: number, token: string, outbox: MfnIngestOutbox, holdFile: string,
): Promise<void> {
	await waitGatewayUnpaused(client);
	fs.writeFileSync(holdFile, "hold\n", { mode: 0o600 });
	try {
		await triggerHeldBackupPause(client, mfnPort, token);
		const pausedHealth = await client.healthGet(2_000);
		assert.equal(JSON.stringify(pausedHealth).includes("\"dispatch_paused\":true"), true);
		const msgId = "bp_paused_1";
		const memId = messageMemoryId("chat_bp", msgId);
		const turnMessages = [makeUserMsg(msgId, "Borel measurable function preserves preimages under pause.", 10_000)];
		const queued = await ingestSettledTurnWithMfn({
			client, outbox, chatId: "chat_bp", turnMessages, mainPoolId: "peer-main", lexicalPoolId: "peer-lexical",
		});
		assert.equal(queued.queuedBatches, 1);
		assert.equal(queued.queuedLexicalWrites, 1);
		fs.rmSync(holdFile, { force: true });
		await waitGatewayUnpaused(client);
		await outbox.flush(client, { force: true });
		assert.equal(outbox.size(), 0);
		const lexPeek = await client.execute("memory.peek", { memory_id: memId }, { poolId: "peer-lexical" });
		const mainPeek = await client.execute("memory.peek", { memory_id: memId }, { poolId: "peer-main" });
		assert.equal(lexPeek.envelope.status, "ok");
		assert.equal(mainPeek.envelope.status, "ok");
	} finally {
		fs.rmSync(holdFile, { force: true });
	}
}

async function verifyDegradedOutboxAndReplay(
	client: MfnClient, outbox: MfnIngestOutbox, setOllamaOnline: (online: boolean) => void,
): Promise<void> {
	await waitGatewayUnpaused(client);
	setOllamaOnline(false);
	const text = "Radon Nikodym derivative relates absolutely continuous measures.";
	const offlineMsgs = [makeUserMsg("m_off_1", text, 20_000)];
	const queued = await ingestSettledTurnWithMfn({
		client, outbox, chatId: "chat_s2", turnMessages: offlineMsgs,
		mainPoolId: "peer-main", lexicalPoolId: "peer-lexical",
	});
	assert.equal(queued.queuedBatches, 1);
	assert.equal(queued.lexicalWrites + queued.queuedLexicalWrites, 1);
	if (queued.queuedLexicalWrites > 0) {
		await waitGatewayUnpaused(client);
		await outbox.flush(client, { force: true });
	}
	assert.equal(outbox.size(), 1);
	const askMsg = makeUserMsg("m_s3_1", "Explain Radon Nikodym derivative for measures", 21_000);
	const degradedCtx = await prepareTurnContextWithMfn({
		client, chatId: "chat_s3", messages: [askMsg], mainPoolId: "peer-main", lexicalPoolId: "peer-lexical",
	});
	assert.equal(degradedCtx.degraded.length >= 1, true);
	assert.equal(degradedCtx.lexicalSupplements.some((s) => s.content.includes("Radon Nikodym")), true);
	setOllamaOnline(true);
	await waitGatewayUnpaused(client);
	await outbox.flush(client, { force: true });
	assert.equal(outbox.size(), 0);
}

async function runLiveIntegrationSuite(stateRoot: string, holdFile: string): Promise<void> {
	const ollama = await startMockOllamaServer();
	const mfnPort = await findFreeTcpPort();
	let supervisor: MfnSupervisor | null = null;
	try {
		const ollamaUrl = `http://127.0.0.1:${ollama.port}`;
		const digest = await probeOllamaModelDigest(ollamaUrl, MODEL_NAME, fetch, MODEL_DIGEST);
		const embeddersFile = path.join(stateRoot, "secrets", "embedders.json");
		writeEmbeddersPinFile(embeddersFile, [{
			space_id: "nomic-v1", endpoint: ollamaUrl, model: MODEL_NAME,
			model_digest: digest, dimensions: 768, timeout_ms: 1_500,
		}]);
		const proxyBinDir = prepareProxiedBinDir(stateRoot, holdFile);
		supervisor = new MfnSupervisor({
			repoRoot: WORKTREE_ROOT, stateRoot, binDir: proxyBinDir, port: mfnPort, backend: "cpu", embeddersFile,
		});
		assert.equal((await supervisor.start()).ready, true);
		const client = supervisor.createClient(8_000);
		await client.ensurePools({
			mainPoolId: "peer-main", lexicalPoolId: "peer-lexical", spaceId: "nomic-v1", dimensions: 768,
		});
		const outbox = new MfnIngestOutbox({ filePath: path.join(stateRoot, "secrets", "outbox.json") });
		const token = fs.readFileSync(path.join(stateRoot, "secrets", "api-token"), "utf8").trim();
		await verifyHebbianSpreadAndExclusions(client, outbox);
		await verifyAdmissionPausedDuringBackup(client, mfnPort, token, outbox, holdFile);
		await verifyDegradedOutboxAndReplay(client, outbox, ollama.setOnline);
	} catch (err) {
		if (supervisor) console.error("[mfn-live stderr]", supervisor.getStderrTail());
		throw err;
	} finally {
		fs.rmSync(holdFile, { force: true });
		if (supervisor) await supervisor.stop();
		await ollama.close();
	}
}

test(
	"Live MFN 2.0 native CPU engine runs L3 spread, exclusions, health-verified backup pause, and degraded replay",
	{ skip: SKIP_REASON },
	async () => {
		fs.mkdirSync(SCRATCH_ROOT, { recursive: true, mode: 0o700 });
		const stateRoot = path.join(SCRATCH_ROOT, `m${randomBytes(2).toString("hex")}`);
		const holdFile = path.join(stateRoot, "hold-psr-pause");
		try {
			await runLiveIntegrationSuite(stateRoot, holdFile);
		} finally {
			fs.rmSync(stateRoot, { recursive: true, force: true });
		}
	},
);
