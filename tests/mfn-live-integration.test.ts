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
	"search",
	"document",
	"query",
	"user",
	"assistant",
	"a",
	"an",
	"the",
	"is",
	"are",
	"to",
	"me",
	"how",
	"and",
	"under",
	"for",
	"remind",
	"explain",
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
		const embeddings = inputs.map((item) => deterministicVector768(item));
		const body = JSON.stringify({ embeddings });
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
		if (req.method === "POST" && req.url === "/api/embed") {
			handleOllamaEmbed(req, res);
			return;
		}
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
			const addr = server.address() as net.AddressInfo;
			resolve({ port: addr.port, setOnline, close });
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

function postGatewayRoute(port: number, routePath: string, token: string, bodyJson: string, timeoutMs = 8_000): Promise<{ httpStatus: number; rawBody: string }> {
	const headers: http.OutgoingHttpHeaders = {
		Authorization: `Bearer ${token}`,
		Accept: "application/json",
		"Content-Type": "application/json",
		"Content-Length": String(Buffer.byteLength(bodyJson, "utf8")),
		Connection: "close",
	};
	return new Promise((resolve, reject) => {
		const req = http.request({ hostname: "127.0.0.1", port, path: routePath, method: "POST", headers, agent: false }, (res) => {
			const chunks: Buffer[] = [];
			res.on("data", (c: Buffer) => chunks.push(c));
			res.once("end", () => resolve({ httpStatus: res.statusCode ?? 0, rawBody: Buffer.concat(chunks).toString("utf8") }));
			res.once("error", reject);
		});
		const timer = setTimeout(() => req.destroy(new Error(`Timeout on ${routePath}`)), timeoutMs);
		req.once("close", () => clearTimeout(timer));
		req.once("error", reject);
		req.end(bodyJson, "utf8");
	});
}

async function verifyHebbianSpreadAndExclusions(client: MfnClient, outbox: MfnIngestOutbox): Promise<void> {
	const s1Msgs = [
		makeUserMsg("m_s1_1", "A sigma algebra is closed under complement and countable unions.", 1_000),
		makeUserMsg("m_s1_2", "Vitali construction partitions equivalence classes modulo rationals.", 2_000),
	];
	const firstIngest = await ingestSettledTurnWithMfn({
		client,
		outbox,
		chatId: "chat_s1",
		turnMessages: s1Msgs,
		mainPoolId: "peer-main",
		lexicalPoolId: "peer-lexical",
	});
	assert.equal(firstIngest.ingestedBatches, 1);
	assert.equal(firstIngest.lexicalWrites + firstIngest.queuedLexicalWrites, 2);
	if (outbox.size() > 0) await outbox.flush(client);
	const memId1 = messageMemoryId("chat_s1", "m_s1_1");
	const memId2 = messageMemoryId("chat_s1", "m_s1_2");
	await assertLiveSpreadNeighbor(client, memId2);
	await assertLiveExclusionHonored(client, s1Msgs[0]!, memId1);
}

async function assertLiveSpreadNeighbor(client: MfnClient, memId2: string): Promise<void> {
	const s2Msgs = [makeUserMsg("m_s2_1", "How is a sigma algebra closed under complement and countable unions?", 3_000)];
	let spreadNeighbor = undefined;
	const deadline = Date.now() + 3_000;
	while (Date.now() < deadline) {
		const recalled = await prepareTurnContextWithMfn({
			client,
			chatId: "chat_s2",
			messages: s2Msgs,
			mainPoolId: "peer-main",
			lexicalPoolId: "peer-lexical",
		});
		spreadNeighbor = recalled.recalledMemories.find((m) => m.memory_id === memId2);
		if (spreadNeighbor && (spreadNeighbor.activation.spread > 0 || spreadNeighbor.evidence.some((e) => e.layer === 3))) {
			assert.ok(recalled.marker?.content.includes("sigma algebra"));
			break;
		}
		await sleepMs(40);
	}
	assert.ok(spreadNeighbor, "Expected co-ingested zero-overlap neighbor to be recalled via L3 spread");
	assert.equal(spreadNeighbor.activation.spread > 0 || spreadNeighbor.evidence.some((e) => e.layer === 3), true);
}

async function assertLiveExclusionHonored(client: MfnClient, tailMsg: LhMessage, memId1: string): Promise<void> {
	const sameChatCtx = await prepareTurnContextWithMfn({
		client,
		chatId: "chat_s1",
		messages: [tailMsg],
		mainPoolId: "peer-main",
		lexicalPoolId: "peer-lexical",
	});
	assert.equal(sameChatCtx.recalledMemories.some((m) => m.memory_id === memId1), false);
	const rawExcluded = await client.turnRecall("peer-main", {
		query: { text: "A sigma algebra is closed under complement and countable unions.", context: null },
		session: { kind: "chat", id: "chat_s1" },
		exclude_memory_ids: [memId1],
	});
	assert.equal(rawExcluded.result.memories.some((m) => m.memory_id === memId1), false);
}

async function waitGatewayUnpaused(client: MfnClient): Promise<void> {
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		try {
			const health = await client.healthGet(2_000);
			const outcomes = health.result?.outcomes ?? [];
			const raw = JSON.stringify(health);
			if (!raw.includes("\"dispatch_paused\":true") && outcomes.length > 0) return;
		} catch {
			// Retry while capture settles.
		}
		await sleepMs(40);
	}
}

async function continuousIngestUntilStopped(
	client: MfnClient,
	outbox: MfnIngestOutbox,
	slot: number,
	shouldStop: () => boolean,
	expectedIds: string[],
): Promise<void> {
	let step = 0;
	while (!shouldStop()) {
		const msgId = `bp_${slot}_${step++}`;
		expectedIds.push(messageMemoryId("chat_bp", msgId));
		await ingestSettledTurnWithMfn({
			client,
			outbox,
			chatId: "chat_bp",
			turnMessages: [makeUserMsg(msgId, `Borel measurable function preserves preimages item ${msgId}.`, 10_000 + step)],
			mainPoolId: "peer-main",
			lexicalPoolId: "peer-lexical",
		});
	}
}

async function flushAndVerifyIds(client: MfnClient, outbox: MfnIngestOutbox, expectedIds: string[]): Promise<void> {
	const flushDeadline = Date.now() + 10_000;
	while (outbox.size() > 0 && Date.now() < flushDeadline) {
		await waitGatewayUnpaused(client);
		await outbox.flush(client);
		if (outbox.size() > 0) await sleepMs(60);
	}
	assert.equal(outbox.size(), 0);
	for (const memId of expectedIds) {
		const lexPeek = await client.execute("memory.peek", { memory_id: memId }, { poolId: "peer-lexical" });
		const mainPeek = await client.execute("memory.peek", { memory_id: memId }, { poolId: "peer-main" });
		assert.equal(lexPeek.envelope.status, "ok");
		assert.equal(mainPeek.envelope.status, "ok");
	}
}

async function verifyAdmissionPausedDuringBackup(
	mfnPort: number,
	token: string,
	outbox: MfnIngestOutbox,
): Promise<void> {
	let admissionPausedCount = 0;
	const spiedClient = new MfnClient({
		token,
		timeoutMs: 8_000,
		transport: async (bodyJson, timeoutMs) => {
			const res = await postGatewayRoute(mfnPort, "/v2/execute", token, bodyJson, timeoutMs + 500);
			if (res.httpStatus === 503 && res.rawBody.includes("\"admission_paused\"")) admissionPausedCount += 1;
			return res;
		},
	});
	const expectedIds: string[] = [];
	const stopAt = Date.now() + 8_000;
	let stopWriters = false;
	const shouldStop = () => stopWriters || admissionPausedCount > 0 || Date.now() >= stopAt;
	const writers = [0, 1].map((slot) => continuousIngestUntilStopped(spiedClient, outbox, slot, shouldStop, expectedIds));
	let nextBackupAt = 0;
	while (admissionPausedCount === 0 && Date.now() < stopAt) {
		if (Date.now() >= nextBackupAt) {
			const res = await postGatewayRoute(mfnPort, "/v2/backups", token, JSON.stringify({ request_id: mintUuidV7() }));
			assert.equal(res.httpStatus === 202 || res.httpStatus === 503, true);
			nextBackupAt = Date.now() + 1_200;
		}
		await sleepMs(15);
	}
	stopWriters = true;
	await Promise.all(writers);
	assert.equal(admissionPausedCount > 0, true, "Expected live backup capture to trigger 503 admission_paused");
	await flushAndVerifyIds(spiedClient, outbox, expectedIds);
}

async function verifyDegradedOutboxAndReplay(
	client: MfnClient,
	outbox: MfnIngestOutbox,
	setOllamaOnline: (online: boolean) => void,
): Promise<void> {
	await waitGatewayUnpaused(client);
	setOllamaOnline(false);
	const offlineMsg = [makeUserMsg("m_off_1", "Radon Nikodym derivative relates absolutely continuous measures.", 20_000)];
	const queued = await ingestSettledTurnWithMfn({
		client,
		outbox,
		chatId: "chat_s2",
		turnMessages: offlineMsg,
		mainPoolId: "peer-main",
		lexicalPoolId: "peer-lexical",
	});
	assert.equal(queued.queuedBatches, 1);
	assert.equal(queued.lexicalWrites + queued.queuedLexicalWrites, 1);
	if (queued.queuedLexicalWrites > 0) {
		await waitGatewayUnpaused(client);
		await outbox.flush(client);
	}
	assert.equal(outbox.size(), 1);

	const degradedCtx = await prepareTurnContextWithMfn({
		client,
		chatId: "chat_s3",
		messages: [makeUserMsg("m_s3_1", "Explain Radon Nikodym derivative for measures", 21_000)],
		mainPoolId: "peer-main",
		lexicalPoolId: "peer-lexical",
	});
	assert.equal(degradedCtx.degraded.length >= 1, true);
	assert.equal(degradedCtx.lexicalSupplements.some((s) => s.content.includes("Radon Nikodym")), true);

	setOllamaOnline(true);
	const flushDeadline = Date.now() + 8_000;
	while (outbox.size() > 0 && Date.now() < flushDeadline) {
		await waitGatewayUnpaused(client);
		await outbox.flush(client);
		if (outbox.size() > 0) await sleepMs(50);
	}
	assert.equal(outbox.size(), 0);
}

test(
	"Live MFN 2.0 native CPU engine runs L3 Hebbian spread, exclude_memory_ids, backup admission_paused recovery, and degraded replay",
	{ skip: SKIP_REASON },
	async () => {
		fs.mkdirSync(SCRATCH_ROOT, { recursive: true, mode: 0o700 });
		const stateRoot = path.join(SCRATCH_ROOT, `m${randomBytes(2).toString("hex")}`);
		const ollama = await startMockOllamaServer();
		const mfnPort = await findFreeTcpPort();
		let supervisor: MfnSupervisor | null = null;
		try {
			const ollamaUrl = `http://127.0.0.1:${ollama.port}`;
			const digest = await probeOllamaModelDigest(ollamaUrl, MODEL_NAME, fetch, MODEL_DIGEST);
			const embeddersFile = path.join(stateRoot, "secrets", "embedders.json");
			const pin = { space_id: "nomic-v1", endpoint: ollamaUrl, model: MODEL_NAME, model_digest: digest, dimensions: 768, timeout_ms: 1_500 };
			writeEmbeddersPinFile(embeddersFile, [pin]);
			supervisor = new MfnSupervisor({ repoRoot: WORKTREE_ROOT, stateRoot, binDir: MFN_BIN_DIR, port: mfnPort, backend: "cpu", embeddersFile });
			const ready = await supervisor.start();
			assert.equal(ready.ready, true);
			const client = supervisor.createClient(8_000);
			await client.ensurePools({ mainPoolId: "peer-main", lexicalPoolId: "peer-lexical", spaceId: "nomic-v1", dimensions: 768 });
			const outbox = new MfnIngestOutbox({ filePath: path.join(stateRoot, "secrets", "outbox.json") });
			const token = fs.readFileSync(path.join(stateRoot, "secrets", "api-token"), "utf8").trim();
			await verifyHebbianSpreadAndExclusions(client, outbox);
			await verifyAdmissionPausedDuringBackup(mfnPort, token, outbox);
			await verifyDegradedOutboxAndReplay(client, outbox, ollama.setOnline);
		} catch (err) {
			if (supervisor) console.error("[mfn-live stderr]", supervisor.getStderrTail());
			throw err;
		} finally {
			if (supervisor) await supervisor.stop();
			await ollama.close();
			fs.rmSync(stateRoot, { recursive: true, force: true });
		}
	},
);
