import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import test, { after } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import type { AgentBuildOptions } from "../src/agent/teacher-agent.ts";
import {
	MfnClient,
	MfnIngestOutbox,
	setActiveMfnRuntime,
	type MfnActiveRuntime,
	type MfnMemoryPutPayload,
	type MfnRequestEnvelope,
	type RecalledMemory,
	type TurnIngestPayload,
} from "../src/memory/mfn/index.ts";

const PERSIST_ROOT = process.env.PEER_PERSIST_ROOT ?? "/usr/lib/persist/peer";
const SCRATCH_ROOT = process.env.PEER_TEST_SCRATCH ?? path.join(PERSIST_ROOT, "scratch");
const TEST_TOKEN = "h".repeat(64);
const MUTABLE_ENV = process.env as Record<string, string | undefined>;

fs.mkdirSync(SCRATCH_ROOT, { recursive: true, mode: 0o700 });
const TEST_DIR = path.join(SCRATCH_ROOT, `chat-mfn-${randomBytes(4).toString("hex")}`);
const DATA_DIR = path.join(TEST_DIR, "data");
const AUTH_FILE = path.join(TEST_DIR, "auth.json");
fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
fs.writeFileSync(AUTH_FILE, "{}\n", { mode: 0o600 });

const SAVED_ENV = {
	NODE_ENV: MUTABLE_ENV.NODE_ENV,
	LH_DATA_DIR: MUTABLE_ENV.LH_DATA_DIR,
	LH_AUTH_FILE: MUTABLE_ENV.LH_AUTH_FILE,
	OPENROUTER_API_KEY: MUTABLE_ENV.OPENROUTER_API_KEY,
};
MUTABLE_ENV.NODE_ENV = "test";
MUTABLE_ENV.LH_DATA_DIR = DATA_DIR;
MUTABLE_ENV.LH_AUTH_FILE = AUTH_FILE;
MUTABLE_ENV.OPENROUTER_API_KEY = "test-key";

const { createTeacherAgent } = await import("../src/agent/teacher-agent.ts");
const { handleChatInput } = await import("../src/server/chat-handler.ts");
const { runningTurn } = await import("../src/server/turn-runs.ts");
const { chatStore } = await import("../src/store/chats.ts");

function restoreEnvKey(key: keyof typeof SAVED_ENV): void {
	const prior = SAVED_ENV[key];
	if (prior === undefined) delete MUTABLE_ENV[key];
	else MUTABLE_ENV[key] = prior;
}

after(() => {
	setActiveMfnRuntime(null);
	restoreEnvKey("NODE_ENV");
	restoreEnvKey("LH_DATA_DIR");
	restoreEnvKey("LH_AUTH_FILE");
	restoreEnvKey("OPENROUTER_API_KEY");
	fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

interface HandlerGatewayState {
	mode: "ok" | "mismatch409";
	recalled: RecalledMemory[];
	ingested: TurnIngestPayload[];
	lexicalPuts: MfnMemoryPutPayload[];
}

function replyGatewayOp(state: HandlerGatewayState, env: MfnRequestEnvelope): { status: number; body: unknown } {
	if (state.mode === "mismatch409") {
		const err = { code: "embedder_mismatch", message: "digest mismatch", retryable: false };
		return { status: 409, body: { version: 2, request_id: env.request_id, status: "error", error: err } };
	}
	if (env.operation === "turn.recall") {
		const res = {
			format_version: 1,
			space_id: "nomic-v1",
			memories: state.recalled,
			themes: [],
			anticipations: { actors: [], entities: [], topics: [] },
			complete: true,
			degraded: [],
		};
		return { status: 200, body: { version: 2, request_id: env.request_id, status: "ok", result: { result: res } } };
	}
	if (env.operation === "memory.put") {
		state.lexicalPuts.push(env.payload as unknown as MfnMemoryPutPayload);
		const exec = { operation_id: env.operation_id };
		return { status: 200, body: { version: 2, request_id: env.request_id, status: "committed", result: exec } };
	}
	if (env.operation === "turn.ingest") {
		const p = env.payload as unknown as TurnIngestPayload;
		state.ingested.push(p);
		const group = {
			format_version: 1,
			turn_id: p.turn_id,
			core: "committed",
			enrichment: "complete",
			children: [],
			plan_summary: {},
		};
		const exec = { operation_id: env.operation_id, result: { group } };
		return { status: 200, body: { version: 2, request_id: env.request_id, status: "committed", result: exec } };
	}
	return { status: 200, body: { version: 2, request_id: env.request_id, status: "ok", result: {} } };
}

async function startHandlerGateway(state: HandlerGatewayState): Promise<{ port: number; close: () => Promise<void> }> {
	const server = http.createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (c: Buffer) => chunks.push(c));
		req.on("end", () => {
			const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { request: MfnRequestEnvelope };
			const reply = replyGatewayOp(state, parsed.request);
			res.writeHead(reply.status, { "Content-Type": "application/json", Connection: "close" });
			res.end(JSON.stringify(reply.body));
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
	const port = (server.address() as net.AddressInfo).port;
	const close = () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
	return { port, close };
}

function getClosedPort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const srv = net.createServer();
		srv.once("error", reject);
		srv.listen(0, "127.0.0.1", () => {
			const port = (srv.address() as net.AddressInfo).port;
			srv.close((e) => (e ? reject(e) : resolve(port)));
		});
	});
}

function waitFor(cond: () => boolean, timeoutMs = 2_000): Promise<void> {
	return new Promise((resolve, reject) => {
		const deadline = Date.now() + timeoutMs;
		const tick = () => {
			if (cond()) return resolve();
			if (Date.now() >= deadline) return reject(new Error("Timed out waiting for condition"));
			setTimeout(tick, 20);
		};
		tick();
	});
}

function makeScriptedBuildAgent(replyText: string, seenContexts: string[][]) {
	const faux = createFauxCore({});
	faux.setResponses([
		(ctx) => {
			seenContexts.push(ctx.messages.map((m) => JSON.stringify((m as { content: unknown }).content)));
			return fauxAssistantMessage([fauxText(replyText)]);
		},
	]);
	const engine = { model: faux.getModel(), streamFn: faux.streamSimple };
	return (opts: AgentBuildOptions) => createTeacherAgent(undefined, { engine, messages: opts.messages });
}

const RECALLED_DIAGONAL_MEM: RecalledMemory = {
	memory_id: "9101",
	content: "[user] Cantor diagonal argument proves uncountability of reals.",
	tags: [],
	metadata: {},
	created_at_us: 100,
	activation: { cue: 0.92, spread: 0.25, strength: 1, total: 1.17, weight: 1 },
	anchor_memory_id: null,
	evidence: [{ layer: 2, rank: 1, score: 0.92 }],
};

async function runConfiguredTurn(title: string, userText: string, replyText: string, seenContexts: string[][]) {
	const chat = chatStore.createChat(title);
	chatStore.saveSettings(chat.id, { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" } });
	const buildAgent = makeScriptedBuildAgent(replyText, seenContexts);
	const res = await handleChatInput(chat.id, { type: "text", text: userText }, buildAgent);
	assert.equal(res.status, 200);
	const handle = runningTurn(chat.id);
	if (handle) {
		await new Response(handle.subscribe()).text();
	}
	return chat.id;
}

test("handleChatInput projects recalled MFN context to model and ingests settled turn on finish (M10)", async () => {
	const state: HandlerGatewayState = {
		mode: "ok",
		recalled: [RECALLED_DIAGONAL_MEM],
		ingested: [],
		lexicalPuts: [],
	};
	const gw = await startHandlerGateway(state);
	try {
		const client = new MfnClient({ port: gw.port, token: TEST_TOKEN });
		const outbox = new MfnIngestOutbox();
		setActiveMfnRuntime({ client, outbox, mainPoolId: "peer-main", lexicalPoolId: "peer-lexical" });
		const seenContexts: string[][] = [];
		const chatId = await runConfiguredTurn(
			"MFN active turn",
			"How does diagonalization prove uncountability?",
			"Diagonalization flips the nth digit to construct an omitted real.",
			seenContexts,
		);
		assert.equal(seenContexts.length, 1);
		assert.equal(seenContexts[0]!.some((m) => m.includes("Cantor diagonal argument")), true);
		const saved = chatStore.getChat(chatId)!;
		assert.equal(saved.messages.length, 2);
		assert.equal(saved.messages[0]?.role, "user");
		assert.equal(saved.messages[1]?.role, "assistant");
		await waitFor(() => state.ingested.length === 1 && state.lexicalPuts.length === 2);
		assert.equal(state.ingested[0]?.memories.length, 2);
		assert.equal(state.ingested[0]?.delivered?.[0]?.memory_id, "9101");
	} finally {
		setActiveMfnRuntime(null);
		await gw.close();
	}
});

test("handleChatInput succeeds 200 when MFN has ECONNREFUSED or returns 409 embedder_mismatch (M2, M10)", async () => {
	const deadPort = await getClosedPort();
	const deadOutbox = new MfnIngestOutbox();
	try {
		const deadClient = new MfnClient({ port: deadPort, token: TEST_TOKEN, timeoutMs: 300 });
		const deadRt = {
			client: deadClient, outbox: deadOutbox, mainPoolId: "peer-main", lexicalPoolId: "peer-lexical",
		};
		setActiveMfnRuntime(deadRt);
		const seenDead: string[][] = [];
		const deadId = await runConfiguredTurn("MFN dead port", "Hello while down", "Still teaching.", seenDead);
		assert.equal(seenDead.length, 1);
		assert.equal(chatStore.getChat(deadId)?.messages.length, 2);
		await waitFor(() => deadOutbox.size() >= 1);
	} finally {
		setActiveMfnRuntime(null);
	}
	const state409: HandlerGatewayState = { mode: "mismatch409", recalled: [], ingested: [], lexicalPuts: [] };
	const gw409 = await startHandlerGateway(state409);
	const outbox409 = new MfnIngestOutbox();
	try {
		const client409 = new MfnClient({ port: gw409.port, token: TEST_TOKEN, timeoutMs: 500 });
		const rt409 = { client: client409, outbox: outbox409, mainPoolId: "peer-main", lexicalPoolId: "peer-lexical" };
		setActiveMfnRuntime(rt409);
		const seen409: string[][] = [];
		const chat409Id = await runConfiguredTurn("MFN 409 mismatch", "Hello on mismatch", "Mismatch safe.", seen409);
		assert.equal(seen409.length, 1);
		assert.equal(chatStore.getChat(chat409Id)?.messages.length, 2);
		await waitFor(() => outbox409.size() === 3);
	} finally {
		setActiveMfnRuntime(null);
		await gw409.close();
	}
});

function createFaultyPrepRuntime(client: MfnClient, outbox: MfnIngestOutbox): MfnActiveRuntime {
	return {
		client,
		outbox,
		mainPoolId: "peer-main",
		lexicalPoolId: "peer-lexical",
		get liveTailTokens(): number {
			throw new Error("forced-bridge-prep-fault");
		},
	};
}

test("handleChatInput catches prepareMfnTurnBridge fault and falls back to raw transcript (§8.3)", async () => {
	const state: HandlerGatewayState = { mode: "ok", recalled: [], ingested: [], lexicalPuts: [] };
	const gw = await startHandlerGateway(state);
	const origConsoleError = console.error;
	const errorLogs: string[] = [];
	console.error = (...args: unknown[]) => {
		errorLogs.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(" "));
	};
	try {
		const client = new MfnClient({ port: gw.port, token: TEST_TOKEN });
		setActiveMfnRuntime(createFaultyPrepRuntime(client, new MfnIngestOutbox()));
		const seenContexts: string[][] = [];
		const chatId = await runConfiguredTurn("Bridge fault", "Prompt under bridge fault", "Recovered.", seenContexts);
		assert.equal(seenContexts.length, 1);
		assert.equal(chatStore.getChat(chatId)?.messages.length, 2);
		const expectedPrefix = `[chat ${chatId}] MFN turn preparation failed; falling back to raw transcript:`;
		const matched = errorLogs.some((l) => l.includes(expectedPrefix) && l.includes("forced-bridge-prep-fault"));
		assert.equal(matched, true);
		await waitFor(() => state.ingested.length === 1 && state.lexicalPuts.length === 2);
	} finally {
		console.error = origConsoleError;
		setActiveMfnRuntime(null);
		await gw.close();
	}
});
