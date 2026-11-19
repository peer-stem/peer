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
	const setOnline = (next: boolean) => { isOnline = next; };
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
			// Retry while gateway settles.
		}
		await sleepMs(25);
	}
	throw new Error("Timed out waiting for health.get to report all dispatch and layers unpaused");
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
	const l3Sources = [
		spreadNeighbor.activation.spread > 0 ? "spread" : "",
		...spreadNeighbor.evidence.filter((e) => e.layer === 3).map(() => "layer3"),
	].filter(Boolean);
	assert.ok(l3Sources.length >= 1, "Expected L3 spread activation or layer-3 evidence");
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

async function verifyDegradedOutboxAndReplay(
	client: MfnClient,
	outbox: MfnIngestOutbox,
	setOllamaOnline: (online: boolean) => void,
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
	assert.ok(degradedCtx.degraded.length >= 1);
	assert.equal(degradedCtx.lexicalSupplements.some((s) => s.content.includes("Radon Nikodym")), true);
	setOllamaOnline(true);
	await waitGatewayUnpaused(client);
	await outbox.flush(client, { force: true });
	assert.equal(outbox.size(), 0);
}

async function runLiveSpreadAndDegradedSuite(stateRoot: string): Promise<void> {
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
		supervisor = new MfnSupervisor({
			repoRoot: WORKTREE_ROOT, stateRoot, binDir: MFN_BIN_DIR, port: mfnPort, backend: "cpu", embeddersFile,
		});
		assert.equal((await supervisor.start()).ready, true);
		const client = supervisor.createClient(8_000);
		await client.ensurePools({
			mainPoolId: "peer-main", lexicalPoolId: "peer-lexical", spaceId: "nomic-v1", dimensions: 768,
		});
		const outbox = new MfnIngestOutbox({ filePath: path.join(stateRoot, "secrets", "outbox.json") });
		await verifyHebbianSpreadAndExclusions(client, outbox);
		await verifyDegradedOutboxAndReplay(client, outbox, ollama.setOnline);
	} catch (err) {
		if (supervisor) console.error("[mfn-live stderr]", supervisor.getStderrTail());
		throw err;
	} finally {
		if (supervisor) await supervisor.stop();
		await ollama.close();
	}
}

test(
	"Live MFN 2.0 native CPU engine runs L3 spread, exclusions, and degraded Ollama replay",
	{ skip: SKIP_REASON },
	async () => {
		fs.mkdirSync(SCRATCH_ROOT, { recursive: true, mode: 0o700 });
		const stateRoot = path.join(SCRATCH_ROOT, `m${randomBytes(2).toString("hex")}`);
		try {
			await runLiveSpreadAndDegradedSuite(stateRoot);
		} finally {
			fs.rmSync(stateRoot, { recursive: true, force: true });
		}
	},
);
