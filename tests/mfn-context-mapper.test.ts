import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import test, { after } from "node:test";
import type { PlanTree } from "../src/core/contracts/plan.ts";
import { toLlmMessages, type LhMessage } from "../src/core/native-messages.ts";
import {
	MfnClient,
	MfnIngestOutbox,
	getActiveMfnRuntime,
	ingestSettledTurnWithMfn,
	isUuidV7,
	isValidCallerMemoryId,
	messageMemoryId,
	prepareTurnContextWithMfn,
	setActiveMfnRuntime,
	type MfnMemoryPutPayload,
	type MfnRequestEnvelope,
	type RecalledMemory,
	type TurnIngestPayload,
	type TurnRecallPayload,
} from "../src/memory/mfn/index.ts";
import { isMfnRuntimeActive, prepareMfnTurnBridge } from "../src/server/mfn-turn-bridge.ts";

const PERSIST_ROOT = process.env.PEER_PERSIST_ROOT ?? "/usr/lib/persist/peer";
const SCRATCH_ROOT = process.env.PEER_TEST_SCRATCH ?? path.join(PERSIST_ROOT, "scratch");
const TEST_TOKEN = "t".repeat(64);
const MUTATION_OPS = new Set(["pool.put", "memory.put", "turn.ingest"]);

interface MockGatewayState {
	embedderAvailable: boolean;
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
		assert.equal(env.operation_id, undefined);
		assert.equal(env.durability, undefined);
		return;
	}
	assert.equal(typeof env.operation_id, "string");
	assert.equal(isUuidV7(env.operation_id!), true);
	assert.equal(env.durability, "committed");
}

function validateTurnIngestContract(payload: TurnIngestPayload): void {
	assert.ok(payload.memories.length >= 1);
	assert.ok(payload.memories.length <= 4);
	const batchIds = new Set<string>();
	for (const mem of payload.memories) {
		assert.equal(isValidCallerMemoryId(mem.memory_id), true);
		assert.equal(batchIds.has(mem.memory_id), false);
		batchIds.add(mem.memory_id);
		for (const tag of mem.tags ?? []) assert.equal(tag.startsWith("mfn."), false);
	}
	for (const del of payload.delivered ?? []) {
		const act = del.activation ?? 1;
		assert.equal(isValidCallerMemoryId(del.memory_id), true);
		assert.equal(batchIds.has(del.anchor), true);
		assert.ok(act > 0);
		assert.ok(act <= 1);
	}
}

function handleTurnRecall(state: MockGatewayState, env: MfnRequestEnvelope): { status: number; body: unknown } {
	state.recallRequests.push(env.payload as unknown as TurnRecallPayload);
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

function handleLexicalOp(state: MockGatewayState, env: MfnRequestEnvelope): { status: number; body: unknown } {
	if (env.operation === "memory.put") {
		const p = env.payload as { memory_id: string; content: string; tags?: string[]; metadata?: Record<string, string> };
		state.lexicalRecords.set(p.memory_id, {
			memory_id: p.memory_id, content: p.content, tags: p.tags ?? [], metadata: p.metadata ?? {},
		});
		return okEnv(env.request_id, "committed", { operation_id: env.operation_id, workflow_state: "committed", outcomes: [] });
	}
	if (env.operation === "memory.search") {
		const q = String((env.payload as { query?: string }).query ?? "").toLowerCase();
		const hits = [...state.lexicalRecords.values()]
			.filter((r) => r.content.toLowerCase().includes(q) || q.includes("bayes"))
			.map((r) => ({ memory_id: r.memory_id, score: 0.77 }));
		return okEnv(env.request_id, "ok", { outcomes: [{ layer: 2, state: "ok", result: { hits } }] });
	}
	const id = String((env.payload as { memory_id?: string }).memory_id ?? "");
	const item = state.lexicalRecords.get(id);
	if (!item) return errEnv(env.request_id, 404, "not_found", false);
	return okEnv(env.request_id, "ok", { outcomes: [{ layer: 2, state: "ok", result: { memory: item, created_at_us: 1000 } }] });
}

function dispatchOperation(state: MockGatewayState, env: MfnRequestEnvelope): { status: number; body: unknown } {
	validateEnvelope(env);
	if (env.operation === "pool.get") {
		if (!state.pools.has(env.pool_id!)) return errEnv(env.request_id, 404, "all_targets_failed", false);
		return okEnv(env.request_id, "ok", { outcomes: [{ layer: 2, state: "ok", result: state.pools.get(env.pool_id!) }] });
	}
	if (env.operation === "pool.put") {
		state.pools.set(env.pool_id!, env.payload);
		return okEnv(env.request_id, "committed", { operation_id: env.operation_id, outcomes: [] });
	}
	if (env.operation === "memory.put" || env.operation === "memory.search" || env.operation === "memory.peek") {
		return handleLexicalOp(state, env);
	}
	if (env.operation === "turn.recall") return handleTurnRecall(state, env);
	if (env.operation === "turn.ingest") return handleTurnIngest(state, env);
	throw new Error(`Unexpected operation: ${env.operation}`);
}

async function startMockGateway(state: MockGatewayState): Promise<{ port: number; close: () => Promise<void> }> {
	const server = http.createServer((req, res) => {
		assert.equal(req.method, "POST");
		assert.equal(req.url, "/v2/execute");
		assert.equal(req.headers.authorization, `Bearer ${TEST_TOKEN}`);
		assert.equal(req.headers.connection, "close");
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
	return { messages, tree: { version: 1, nodes: [{ id: "n1", title: "Bayes Theorem", summary: "Posterior update" }], edges: [] } };
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
		await client.ensurePools({ mainPoolId: "peer-main", lexicalPoolId: "peer-lexical", spaceId: "nomic-v1", dimensions: 768 });
		assert.deepEqual(state.pools.get("peer-main"), { capacity: 100_000, vector_space: { id: "nomic-v1", dimensions: 768, mode: "caller" } });
		assert.deepEqual(state.pools.get("peer-lexical"), { capacity: 100_000 });
		const prepared = await prepareTurnContextWithMfn({
			client, chatId, messages, tree, mainPoolId: "peer-main", lexicalPoolId: "peer-lexical", liveTailTokens: 20,
		});
		assert.ok(prepared.cutIndex > 0);
		assert.equal(prepared.liveTail[0]?.id, "m3");
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
		assert.equal(res1.lexicalWrites, 2);
		assert.equal(res1.queuedBatches, 1);
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
		assert.equal(batches[0]?.memories.length, 4);
		assert.equal(batches[0]?.delivered?.[0]?.activation, 1);
		assert.equal(batches[0]?.delivered?.[0]?.anchor, batches[0]?.memories[0]?.memory_id);
		assert.equal(batches[1]?.memories.length, 1);
		assert.equal(batches[1]?.predecessor_memory_id, batches[0]?.memories[3]?.memory_id);
		setActiveMfnRuntime({ client, outbox, mainPoolId: "peer-main", lexicalPoolId: "peer-lexical", liveTailTokens: 500 });
		assert.equal(isMfnRuntimeActive(), true);
		assert.notEqual(getActiveMfnRuntime(), null);
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
