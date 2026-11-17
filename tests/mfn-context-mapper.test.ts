import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import test, { after } from "node:test";
import type { PlanTree } from "../src/core/contracts/plan.ts";
import { toLlmMessages, type LhMessage } from "../src/core/native-messages.ts";
import {
	MfnApiError, MfnClient, MfnIngestOutbox, getActiveMfnRuntime, ingestSettledTurnWithMfn,
	isUuidV7, isValidCallerMemoryId, messageMemoryId, prepareTurnContextWithMfn, setActiveMfnRuntime,
	type MfnMemoryPutPayload, type MfnRequestEnvelope, type RecalledMemory,
	type TurnIngestPayload, type TurnRecallPayload,
} from "../src/memory/mfn/index.ts";
import { isMfnRuntimeActive, prepareMfnTurnBridge } from "../src/server/mfn-turn-bridge.ts";

const PERSIST_ROOT = process.env.PEER_PERSIST_ROOT ?? "/usr/lib/persist/peer";
const SCRATCH_ROOT = process.env.PEER_TEST_SCRATCH ?? path.join(PERSIST_ROOT, "scratch");
const TEST_TOKEN = "t".repeat(64);
const MUTATION_OPS = new Set(["pool.put", "memory.put", "turn.ingest"]);

interface MockGatewayState {
	embedderAvailable: boolean;
	lexicalPauseRemaining?: number;
	recallForceError?: { status: number; code: string; retryable: boolean } | null;
	lexicalSearchForceError?: boolean;
	lexicalSearchCalls?: number;
	lexicalPutOpIds?: string[];
	pools: Map<string, Record<string, unknown>>;
	lexicalRecords: Map<string, MfnMemoryPutPayload & { tags: string[]; metadata: Record<string, string> }>;
	ingestedOps: Map<string, TurnIngestPayload>;
	recallRequests: TurnRecallPayload[];
	recalledFixture: RecalledMemory[];
}

function makeScratchDir(prefix: string): string {
	const dir = path.join(SCRATCH_ROOT, `${prefix}-${randomBytes(4).toString("hex")}`);
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	return dir;
}
after(() => setActiveMfnRuntime(null));

function okEnv(requestId: string, status: string, result: unknown, httpStatus = 200) {
	return { status: httpStatus, body: { version: 2, request_id: requestId, status, result } };
}
function errEnv(requestId: string, httpStatus: number, code: string, retryable: boolean) {
	const error = { code, message: code, retryable };
	return { status: httpStatus, body: { version: 2, request_id: requestId, status: "error", error } };
}
function validateEnvelope(env: MfnRequestEnvelope): void {
	assert.equal(env.version, 2);
	assert.match(env.request_id, /^[A-Za-z0-9_-]{1,128}$/);
	if (!MUTATION_OPS.has(env.operation)) {
		assert.equal(env.operation_id === undefined && env.durability === undefined, true);
		return;
	}
	const validOp = typeof env.operation_id === "string" && isUuidV7(env.operation_id);
	assert.equal(validOp && env.durability === "committed", true);
}

function validateTurnIngestContract(payload: TurnIngestPayload): void {
	assert.equal(payload.memories.length >= 1 && payload.memories.length <= 4, true);
	const batchIds = new Set<string>();
	for (const mem of payload.memories) {
		assert.equal(isValidCallerMemoryId(mem.memory_id) && !batchIds.has(mem.memory_id), true);
		batchIds.add(mem.memory_id);
		for (const tag of mem.tags ?? []) assert.equal(tag.startsWith("mfn."), false);
	}
	for (const del of payload.delivered ?? []) {
		const act = del.activation ?? 1;
		assert.equal(isValidCallerMemoryId(del.memory_id) && batchIds.has(del.anchor) && act > 0 && act <= 1, true);
	}
}

function handleTurnRecall(state: MockGatewayState, env: MfnRequestEnvelope): { status: number; body: unknown } {
	state.recallRequests.push(env.payload as unknown as TurnRecallPayload);
	if (state.recallForceError) {
		const f = state.recallForceError;
		return errEnv(env.request_id, f.status, f.code, f.retryable);
	}
	const complete = state.embedderAvailable;
	const theme = {
		pattern_id: "p-hebb", label: "Hebbian decay", summary: "Co-active trace reinforcement",
		score: 0.82, confidence: 0.9, activation_count: 4, members: [],
	};
	const actors = [{ subject_id: "4700000000000000001", label: "Learner", confidence: 0.75, evidence_count: 3 }];
	const recallResult = {
		format_version: 1, space_id: "nomic-v1",
		memories: complete ? state.recalledFixture : [],
		themes: complete ? [theme] : [],
		anticipations: { actors, entities: [], topics: [] },
		window_scores: {}, layers: [], complete,
		degraded: complete ? [] : ["embedder_unavailable"],
	};
	const wf = complete ? "committed" : "needs_attention";
	const exec = { operation_id: null, workflow_state: wf, outcomes: [], result: recallResult };
	return okEnv(env.request_id, complete ? "ok" : "partial", exec, complete ? 200 : 207);
}

function handleTurnIngest(state: MockGatewayState, env: MfnRequestEnvelope): { status: number; body: unknown } {
	const payload = env.payload as unknown as TurnIngestPayload;
	validateTurnIngestContract(payload);
	if (!state.embedderAvailable) return errEnv(env.request_id, 503, "embedder_unavailable", true);
	const opId = env.operation_id!;
	const prior = state.ingestedOps.get(opId);
	if (prior) assert.deepEqual(prior, payload);
	else state.ingestedOps.set(opId, structuredClone(payload));
	const group = {
		format_version: 1, turn_id: payload.turn_id, core: "committed",
		enrichment: "complete", children: [], plan_summary: {},
	};
	const exec = { operation_id: opId, workflow_state: "committed", outcomes: [], result: { group } };
	return okEnv(env.request_id, "committed", exec);
}

function handleLexicalPut(state: MockGatewayState, env: MfnRequestEnvelope): { status: number; body: unknown } {
	state.lexicalPutOpIds?.push(env.operation_id!);
	if ((state.lexicalPauseRemaining ?? 0) > 0) {
		state.lexicalPauseRemaining = (state.lexicalPauseRemaining ?? 0) - 1;
		return errEnv(env.request_id, 503, "admission_paused", true);
	}
	const p = env.payload as { memory_id: string; content: string; tags?: string[]; metadata?: Record<string, string> };
	state.lexicalRecords.set(p.memory_id, {
		memory_id: p.memory_id, content: p.content, tags: p.tags ?? [], metadata: p.metadata ?? {},
	});
	const exec = { operation_id: env.operation_id, workflow_state: "committed", outcomes: [] };
	return okEnv(env.request_id, "committed", exec);
}

function handleLexicalRead(state: MockGatewayState, env: MfnRequestEnvelope): { status: number; body: unknown } {
	if (env.operation === "memory.search") {
		state.lexicalSearchCalls = (state.lexicalSearchCalls ?? 0) + 1;
		if (state.lexicalSearchForceError) return errEnv(env.request_id, 503, "layer2_down", true);
		const q = String((env.payload as { query?: string }).query ?? "").toLowerCase();
		const hits = [...state.lexicalRecords.values()]
			.filter((r) => r.content.toLowerCase().includes(q) || q.includes("bayes"))
			.map((r) => ({ memory_id: r.memory_id, score: 0.77 }));
		return okEnv(env.request_id, "ok", { outcomes: [{ layer: 2, state: "ok", result: { hits } }] });
	}
	const id = String((env.payload as { memory_id?: string }).memory_id ?? "");
	const item = state.lexicalRecords.get(id);
	if (!item) return errEnv(env.request_id, 404, "not_found", false);
	const outcomes = [{ layer: 2, state: "ok", result: { memory: item, created_at_us: 1000 } }];
	return okEnv(env.request_id, "ok", { outcomes });
}

function dispatchOperation(state: MockGatewayState, env: MfnRequestEnvelope): { status: number; body: unknown } {
	validateEnvelope(env);
	if (env.operation === "ping" || env.operation === "health.get") {
		return okEnv(env.request_id, "ok", { outcomes: [{ layer: 1, state: "ok" }] });
	}
	if (env.operation === "pool.get") {
		if (!state.pools.has(env.pool_id!)) return errEnv(env.request_id, 404, "all_targets_failed", false);
		const outcomes = [{ layer: 2, state: "ok", result: state.pools.get(env.pool_id!) }];
		return okEnv(env.request_id, "ok", { outcomes });
	}
	if (env.operation === "pool.put") {
		state.pools.set(env.pool_id!, env.payload);
		return okEnv(env.request_id, "committed", { operation_id: env.operation_id, outcomes: [] });
	}
	if (env.operation === "memory.put") return handleLexicalPut(state, env);
	if (env.operation === "memory.search" || env.operation === "memory.peek") return handleLexicalRead(state, env);
	if (env.operation === "turn.recall") return handleTurnRecall(state, env);
	if (env.operation === "turn.ingest") return handleTurnIngest(state, env);
	throw new Error(`Unexpected operation: ${env.operation}`);
}

async function startMockGateway(state: MockGatewayState): Promise<{ port: number; close: () => Promise<void> }> {
	const server = http.createServer((req, res) => {
		assert.equal(req.method === "POST" && req.url === "/v2/execute", true);
		assert.equal(req.headers.authorization === `Bearer ${TEST_TOKEN}` && req.headers.connection === "close", true);
		const chunks: Buffer[] = [];
		req.on("data", (c: Buffer) => chunks.push(c));
		req.on("end", () => {
			const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { request: MfnRequestEnvelope };
			const reply = dispatchOperation(state, parsed.request);
			res.writeHead(reply.status, { "Content-Type": "application/json", Connection: "close" });
			res.end(JSON.stringify(reply.body));
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
	const port = (server.address() as { port: number }).port;
	return { port, close: () => new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r()))) };
}

function makeEmptyGatewayState(embedderAvailable = true): MockGatewayState {
	return {
		embedderAvailable, pools: new Map(), lexicalRecords: new Map(),
		ingestedOps: new Map(), recallRequests: [], recalledFixture: [],
	};
}

function makeTranscript(chatId: string): { messages: LhMessage[]; tree: PlanTree } {
	const zeroCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
	const usage = { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20, cost: zeroCost };
	const stub = { api: "faux" as const, provider: "test", model: "test-model", usage, stopReason: "toolUse" as const };
	const toolCall = [{ type: "toolCall" as const, id: "call_1", name: "plan_init", arguments: { title: "Bayes" } }];
	const oldTutor = [{ type: "text" as const, text: "Old tutor ".repeat(400) }];
	const m4: LhMessage = {
		id: "m4", role: "toolResult", toolCallId: "call_1", toolName: "plan_init",
		content: [{ type: "text", text: "Plan ok" }], isError: false, timestamp: 4,
	};
	const messages: LhMessage[] = [
		{ id: "m1", role: "user", content: "Old question about priors ".repeat(400), timestamp: 1 },
		{ id: "m2", role: "assistant", content: oldTutor, timestamp: 2, ...stub, stopReason: "stop" },
		{ id: "m3", role: "assistant", content: toolCall, timestamp: 3, ...stub },
		m4,
		{ id: "m5", role: "user", content: `Ask in ${chatId}: how does Bayes rule update priors?`, timestamp: 5 },
	];
	const nodes = [{ id: "n1", title: "Bayes Theorem", summary: "Posterior update" }];
	return { messages, tree: { version: 1, nodes, edges: [] } };
}

function makeRecalledItem(id: string, content: string, total: number): RecalledMemory {
	return {
		memory_id: id, content, tags: [], metadata: {}, created_at_us: 10, anchor_memory_id: null,
		activation: { cue: 0.9, spread: 0.3, strength: 0.95, total, weight: 1 },
		evidence: [{ layer: 2, rank: 1, score: 0.9 }],
	};
}

test("200 ok turn.recall maps memories, themes, anticipations, plan tree, and drops live-tail duplicates", async () => {
	const chatId = "chat-happy";
	const { messages, tree } = makeTranscript(chatId);
	const tailDupId = messageMemoryId(chatId, "m5");
	const state = makeEmptyGatewayState(true);
	state.recalledFixture = [
		makeRecalledItem("9001", "Prior belief P(H) scales likelihood.", 1.1875),
		makeRecalledItem(tailDupId, "Duplicate of liveTail m5", 1),
	];
	const gw = await startMockGateway(state);
	try {
		const client = new MfnClient({ port: gw.port, token: TEST_TOKEN });
		await client.ensurePools({
			mainPoolId: "peer-main", lexicalPoolId: "peer-lexical", spaceId: "nomic-v1", dimensions: 768,
		});
		const expectedMain = { capacity: 100_000, vector_space: { id: "nomic-v1", dimensions: 768, mode: "caller" } };
		assert.deepEqual(state.pools.get("peer-main"), expectedMain);
		assert.deepEqual(state.pools.get("peer-lexical"), { capacity: 100_000 });
		const prepared = await prepareTurnContextWithMfn({
			client, chatId, messages, tree, mainPoolId: "peer-main", lexicalPoolId: "peer-lexical", liveTailTokens: 20,
		});
		assert.equal(prepared.cutIndex > 0 && prepared.liveTail[0]?.id === "m3", true);
		assert.equal(state.recallRequests[0]?.window?.memory_ids[0], tailDupId);
		assert.equal(state.recallRequests[0]?.exclude_memory_ids?.includes(tailDupId), true);
		assert.deepEqual(prepared.recalledMemories.map((m) => m.memory_id), ["9001"]);
		assert.ok(prepared.marker);
		assert.match(prepared.marker.content, /Bayes Theorem/);
		assert.match(prepared.marker.content, /Prior belief P\(H\)/);
		assert.match(prepared.marker.content, /Hebbian decay/);
		assert.doesNotMatch(prepared.marker.content, /Duplicate of liveTail/);
		assert.equal(toLlmMessages(prepared.agentMessages)[0]?.role, "user");
	} finally {
		await gw.close();
	}
});

function makeColdTurnMessages(): LhMessage[] {
	const zeroCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
	const textBlock = [{ type: "text" as const, text: "Marginal likelihood normalizes the posterior." }];
	return [
		{ id: "c1", role: "user", content: "Remember Bayes theorem denominator P(E).", timestamp: 10 },
		{
			id: "c2", role: "assistant", content: textBlock, timestamp: 11, api: "faux", provider: "t", model: "m",
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: zeroCost },
			stopReason: "stop",
		},
	];
}

test("503 embedder_unavailable queues in outbox, lexicalSearch degrades cleanly, and replays", async () => {
	const dir = makeScratchDir("outbox");
	const outboxFile = path.join(dir, "mfn-outbox.json");
	const state = makeEmptyGatewayState(false);
	const gw = await startMockGateway(state);
	try {
		const client = new MfnClient({ port: gw.port, token: TEST_TOKEN });
		const outbox = new MfnIngestOutbox({ filePath: outboxFile });
		const res1 = await ingestSettledTurnWithMfn({
			client, outbox, chatId: "chat-cold", turnMessages: makeColdTurnMessages(),
			mainPoolId: "peer-main", lexicalPoolId: "peer-lexical", sessionTags: ["mfn.forbidden", "topic:bayes"],
		});
		assert.equal(res1.lexicalWrites === 2 && res1.queuedBatches === 1, true);
		const queued = outbox.entries()[0]!;
		const later: LhMessage[] = [{ id: "c9", role: "user", content: "What normalizes Bayes?", timestamp: 20 }];
		const degradedCtx = await prepareTurnContextWithMfn({
			client, chatId: "chat-cold", messages: later, mainPoolId: "peer-main", lexicalPoolId: "peer-lexical",
		});
		assert.equal(degradedCtx.degraded.includes("embedder_unavailable"), true);
		assert.equal(degradedCtx.lexicalSupplements.length, 2);
		assert.match(degradedCtx.marker?.content ?? "", /Marginal likelihood normalizes/);
		state.embedderAvailable = true;
		const reloadedOutbox = new MfnIngestOutbox({ filePath: outboxFile });
		assert.equal((await reloadedOutbox.flush(client)).flushed, 1);
		assert.equal(reloadedOutbox.size(), 0);
		assert.equal(state.ingestedOps.get(queued.operationId)?.turn_id, queued.payload?.turn_id);
	} finally {
		await gw.close();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("ingestSettledTurnWithMfn chunks >4 messages into 1..4 batches, clamps activation, and wires bridge", async () => {
	const recalled = makeRecalledItem("777", "Recalled anchor fact", 1.4);
	const state = makeEmptyGatewayState(true);
	state.recalledFixture = [recalled];
	const gw = await startMockGateway(state);
	try {
		const client = new MfnClient({ port: gw.port, token: TEST_TOKEN });
		const outbox = new MfnIngestOutbox();
		const fiveMsgs: LhMessage[] = [1, 2, 3, 4, 5].map((n) => ({
			id: `b${n}`, role: "user" as const, content: `Fact number ${n}`, timestamp: n,
		}));
		const res = await ingestSettledTurnWithMfn({
			client, outbox, chatId: "chat-batch", turnMessages: fiveMsgs,
			mainPoolId: "peer-main", lexicalPoolId: "peer-lexical", recalledMemories: [recalled],
		});
		assert.equal(res.ingestedBatches, 2);
		const batches = [...state.ingestedOps.values()];
		assert.equal(batches[0]?.memories.length === 4 && batches[0]?.delivered?.[0]?.activation === 1, true);
		assert.equal(batches[0]?.delivered?.[0]?.anchor, batches[0]?.memories[0]?.memory_id);
		assert.equal(batches[1]?.memories.length, 1);
		assert.equal(batches[1]?.predecessor_memory_id, batches[0]?.memories[3]?.memory_id);
		const rt = { client, outbox, mainPoolId: "peer-main", lexicalPoolId: "peer-lexical", liveTailTokens: 500 };
		setActiveMfnRuntime(rt);
		assert.equal(isMfnRuntimeActive() && Boolean(getActiveMfnRuntime()), true);
		const bridge = await prepareMfnTurnBridge({
			chatId: "chat-batch", priorMessages: fiveMsgs.slice(0, 4),
			appends: [fiveMsgs[4]!], agentMessages: fiveMsgs, stagedAutomatic: false,
		});
		assert.equal(bridge.initialPersistBaseCount, bridge.projectedMessages.length);
		assert.equal(bridge.projectedMessages[0]?.role, "custom");
	} finally {
		setActiveMfnRuntime(null);
		await gw.close();
	}
});

test("503 admission_paused on memory.put retries with stable operationId and replays via outbox (M1)", async () => {
	const state = makeEmptyGatewayState(true);
	state.lexicalPauseRemaining = 2;
	state.lexicalPutOpIds = [];
	const gw = await startMockGateway(state);
	const client = new MfnClient({ port: gw.port, token: TEST_TOKEN });
	const outbox = new MfnIngestOutbox();
	const runLex = (id: string) =>
		ingestSettledTurnWithMfn({
			client, outbox, chatId: "chat-m1", mainPoolId: "peer-main", lexicalPoolId: "peer-lexical",
			turnMessages: [{ id, role: "user", content: `Pause ${id}`, timestamp: 1 }],
		});
	try {
		const r1 = await runLex("lp1");
		assert.equal(r1.lexicalWrites === 1 && r1.queuedLexicalWrites === 0, true);
		const opIds = state.lexicalPutOpIds!;
		assert.equal(opIds.length === 3 && opIds[0] === opIds[2], true);
		state.lexicalPutOpIds = [];
		state.lexicalPauseRemaining = 3;
		const r2 = await runLex("lp2");
		assert.equal(r2.lexicalWrites === 0 && r2.queuedLexicalWrites === 1, true);
		const queuedLex = outbox.entries()[0]!;
		assert.equal(queuedLex.kind === "lexical_put" && queuedLex.operationId === state.lexicalPutOpIds[0], true);
		const flushed = (await outbox.flush(client)).flushed;
		assert.equal(flushed === 1 && state.lexicalRecords.has(messageMemoryId("chat-m1", "lp2")), true);
	} finally {
		await gw.close();
	}
});

async function getClosedPort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const srv = net.createServer();
		srv.once("error", reject);
		srv.listen(0, "127.0.0.1", () => {
			const port = (srv.address() as net.AddressInfo).port;
			srv.close((err) => (err ? reject(err) : resolve(port)));
		});
	});
}

async function assertSystemicRecallFaultsSkipLexical(
	client: MfnClient, state: MockGatewayState, messages: LhMessage[], tree: PlanTree,
): Promise<void> {
	for (const fault of [
		{ status: 409, code: "embedder_mismatch", retryable: false },
		{ status: 401, code: "unauthenticated", retryable: false },
	]) {
		state.recallForceError = fault;
		const ctx = await prepareTurnContextWithMfn({
			client, chatId: "chat-m2", messages, tree,
			mainPoolId: "peer-main", lexicalPoolId: "peer-lexical", liveTailTokens: 20,
		});
		assert.equal(ctx.degraded.includes(fault.code) && state.lexicalSearchCalls === 0, true);
	}
}

test("ECONNREFUSED, 409 embedder_mismatch, and 401 degrade cleanly without calling lexicalSearch (M2)", async () => {
	const { messages, tree } = makeTranscript("chat-m2");
	const deadClient = new MfnClient({ port: await getClosedPort(), token: TEST_TOKEN, timeoutMs: 500 });
	const deadPrepared = await prepareTurnContextWithMfn({
		client: deadClient, chatId: "chat-m2", messages, tree,
		mainPoolId: "peer-main", lexicalPoolId: "peer-lexical", liveTailTokens: 20,
	});
	assert.equal(deadPrepared.degraded.includes("ECONNREFUSED") && deadPrepared.liveTail.length > 0, true);
	const state = makeEmptyGatewayState(true);
	state.lexicalSearchCalls = 0;
	const gw = await startMockGateway(state);
	try {
		const client = new MfnClient({ port: gw.port, token: TEST_TOKEN });
		await assertSystemicRecallFaultsSkipLexical(client, state, messages, tree);
		state.recallForceError = null;
		state.embedderAvailable = false;
		state.lexicalSearchForceError = true;
		const both = await prepareTurnContextWithMfn({
			client, chatId: "chat-m2", messages, mainPoolId: "peer-main", lexicalPoolId: "peer-lexical",
		});
		assert.equal(both.degraded.includes("embedder_unavailable") && both.degraded.includes("layer2_down"), true);
		const throwingClient = { turnRecall: () => Promise.reject(new Error("boom")) } as unknown as MfnClient;
		const throwRt = { client: throwingClient, outbox: new MfnIngestOutbox(), mainPoolId: "m", lexicalPoolId: "l" };
		setActiveMfnRuntime(throwRt);
		const tail = messages.slice(-1);
		const fb = await prepareMfnTurnBridge({
			chatId: "chat-m2", priorMessages: [], appends: tail, agentMessages: tail, stagedAutomatic: false,
		});
		assert.equal(fb.projectedMessages.length, 1);
	} finally {
		setActiveMfnRuntime(null);
		await gw.close();
	}
});

function createBatchFaultClient(
	getHttp: () => number, counts: { batch: number; lex: number }, okBatches: number[],
): MfnClient {
	const makeErr = () => {
		const status = getHttp();
		const code = status === 400 ? "invalid_request" : "embedder_mismatch";
		return new MfnApiError({ httpStatus: status, code, message: code, retryable: false });
	};
	return {
		lexicalPut: async () => {
			counts.lex += 1;
			if (counts.lex === 1) throw makeErr();
			return { version: 2 as const, request_id: "r", status: "committed" as const };
		},
		turnIngest: async (_pool: string, payload: TurnIngestPayload, opId?: string) => {
			counts.batch += 1;
			if (counts.batch === 1) throw makeErr();
			okBatches.push(payload.memories.length);
			const response = { version: 2 as const, request_id: "r", status: "committed" as const };
			return { operationId: opId ?? "", response };
		},
	} as unknown as MfnClient;
}

test("N6: 400 or 409 on batch 1 or lexicalPut isolates fault to deadLetters/outbox and runs batch 2", async () => {
	const fiveMsgs: LhMessage[] = [1, 2, 3, 4, 5].map((n) => ({
		id: `n6_${n}`, role: "user" as const, content: `Turn item ${n}`, timestamp: n,
	}));
	const counts = { batch: 0, lex: 0 };
	let faultHttp = 400;
	const okBatches: number[] = [];
	const mockClient = createBatchFaultClient(() => faultHttp, counts, okBatches);
	const runBatch = (outbox: MfnIngestOutbox) =>
		ingestSettledTurnWithMfn({
			client: mockClient, outbox, chatId: "chat-n6", turnMessages: fiveMsgs, mainPoolId: "m", lexicalPoolId: "l",
		});
	const box400 = new MfnIngestOutbox();
	const res400 = await runBatch(box400);
	assert.equal(res400.ingestedBatches === 1 && res400.queuedBatches === 0 && res400.lexicalWrites === 4, true);
	assert.equal(box400.deadLetters().length, 2);
	counts.batch = 0;
	counts.lex = 0;
	faultHttp = 409;
	const box409 = new MfnIngestOutbox();
	const res409 = await runBatch(box409);
	assert.equal(res409.ingestedBatches === 1 && res409.queuedBatches === 1, true);
	assert.equal(res409.lexicalWrites === 4 && res409.queuedLexicalWrites === 1 && box409.size() === 2, true);
	assert.deepEqual(okBatches, [1, 1]);
});
