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
	MfnIngestOutbox,
	MfnSupervisor,
	ingestSettledTurnWithMfn,
	prepareTurnContextWithMfn,
	probeOllamaModelDigest,
	writeEmbeddersPinFile,
} from "../src/memory/mfn/index.ts";

const WORKTREE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PERSIST_ROOT = process.env.PEER_PERSIST_ROOT ?? "/usr/lib/persist/peer";
const MFN_BIN_DIR = path.join(PERSIST_ROOT, "build", "mfn", "bin");
const SCRATCH_ROOT = path.join(PERSIST_ROOT, "scratch");
const MODEL_NAME = "nomic-embed-text:latest";
const MODEL_DIGEST = "a1b2c3d4e5f60718293a4b5c6d7e8f90112233445566778899aabbccddeeff00";

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

function makeUserMsg(id: string, content: string, timestamp: number): LhMessage {
	return { id, role: "user", content, timestamp } as LhMessage;
}

async function verifyCrossSessionAndDegradedFlow(
	supervisor: MfnSupervisor,
	outboxFile: string,
	setOllamaOnline: (online: boolean) => void,
): Promise<void> {
	const client = supervisor.createClient(8_000);
	await client.ensurePools({
		mainPoolId: "peer-main",
		lexicalPoolId: "peer-lexical",
		spaceId: "nomic-v1",
		dimensions: 768,
	});
	const outbox = new MfnIngestOutbox({ filePath: outboxFile });
	const s1Msgs = [
		makeUserMsg("m_s1_1", "A sigma algebra is closed under complement and countable unions.", 1_000),
		makeUserMsg("m_s1_2", "Lebesgue measure assigns outer measure to measurable sets.", 2_000),
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
	assert.equal(firstIngest.queuedBatches, 0);
	assert.equal(firstIngest.lexicalWrites, 2);

	const s2Msgs = [
		makeUserMsg("m_s2_1", "How is a sigma algebra closed under countable unions for Lebesgue measure?", 3_000),
	];
	const recalled = await prepareTurnContextWithMfn({
		client,
		chatId: "chat_s2",
		messages: s2Msgs,
		mainPoolId: "peer-main",
		lexicalPoolId: "peer-lexical",
	});
	assert.equal(recalled.recalledMemories.length >= 1, true);
	assert.ok(recalled.marker?.content.includes("sigma algebra"));

	await verifyDegradedOutboxAndReplay(client, outbox, setOllamaOnline);
}

async function verifyDegradedOutboxAndReplay(
	client: ReturnType<MfnSupervisor["createClient"]>,
	outbox: MfnIngestOutbox,
	setOllamaOnline: (online: boolean) => void,
): Promise<void> {
	setOllamaOnline(false);
	const offlineMsg = [
		makeUserMsg("m_off_1", "Radon Nikodym derivative relates absolutely continuous measures.", 4_000),
	];
	const queued = await ingestSettledTurnWithMfn({
		client,
		outbox,
		chatId: "chat_s2",
		turnMessages: offlineMsg,
		mainPoolId: "peer-main",
		lexicalPoolId: "peer-lexical",
	});
	assert.equal(queued.queuedBatches, 1);
	assert.equal(queued.lexicalWrites, 1);
	assert.equal(outbox.size(), 1);

	const degradedCtx = await prepareTurnContextWithMfn({
		client,
		chatId: "chat_s3",
		messages: [makeUserMsg("m_s3_1", "Explain Radon Nikodym derivative for measures", 5_000)],
		mainPoolId: "peer-main",
		lexicalPoolId: "peer-lexical",
	});
	assert.equal(degradedCtx.degraded.length >= 1, true);
	assert.equal(degradedCtx.lexicalSupplements.some((s) => s.content.includes("Radon Nikodym")), true);

	setOllamaOnline(true);
	const flushed = await outbox.flush(client);
	assert.equal(flushed.flushed, 1);
	assert.equal(flushed.remaining, 0);
}

test("Live MFN 2.0 native CPU engine runs cross-session recall, degraded lexical fallback, and outbox replay", async () => {
	fs.mkdirSync(SCRATCH_ROOT, { recursive: true, mode: 0o755 });
	const stateRoot = path.join(SCRATCH_ROOT, `mfn-${randomBytes(3).toString("hex")}`);
	const ollama = await startMockOllamaServer();
	const mfnPort = await findFreeTcpPort();
	let supervisor: MfnSupervisor | null = null;
	try {
		const ollamaUrl = `http://127.0.0.1:${ollama.port}`;
		const digest = await probeOllamaModelDigest(ollamaUrl, MODEL_NAME, fetch, MODEL_DIGEST);
		assert.equal(digest, MODEL_DIGEST);
		const embeddersFile = path.join(stateRoot, "secrets", "embedders.json");
		const pinEntry = {
			space_id: "nomic-v1",
			endpoint: ollamaUrl,
			model: MODEL_NAME,
			model_digest: digest,
			dimensions: 768,
			timeout_ms: 1_500,
		};
		writeEmbeddersPinFile(embeddersFile, [pinEntry]);
		supervisor = new MfnSupervisor({
			repoRoot: WORKTREE_ROOT,
			stateRoot,
			binDir: MFN_BIN_DIR,
			port: mfnPort,
			backend: "cpu",
			embeddersFile,
		});
		const ready = await supervisor.start();
		assert.equal(ready.ready, true);
		await verifyCrossSessionAndDegradedFlow(supervisor, path.join(stateRoot, "secrets", "outbox.json"), ollama.setOnline);
	} catch (err) {
		if (supervisor) console.error("[mfn-live stderr]", supervisor.getStderrTail());
		throw err;
	} finally {
		if (supervisor) await supervisor.stop();
		await ollama.close();
		fs.rmSync(stateRoot, { recursive: true, force: true });
	}
});
