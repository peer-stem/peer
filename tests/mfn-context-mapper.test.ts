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

interface StoredLexicalItem {
	memory_id: string;
	content: string;
	tags: string[];
	metadata: Record<string, string>;
}

interface MockGatewayState {
	embedderAvailable: boolean;
	pools: Map<string, Record<string, unknown>>;
	lexicalRecords: Map<string, StoredLexicalItem>;
	ingestedOps: Map<string, TurnIngestPayload>;
	recallRequests: TurnRecallPayload[];
	recalledFixture: RecalledMemory[];
}

function makeScratchDir(prefix: string): string {
	fs.mkdirSync(SCRATCH_ROOT, { recursive: true, mode: 0o700 });
	const dir = path.join(SCRATCH_ROOT, `${prefix}-${randomBytes(4).toString("hex")}`);
	fs.mkdirSync(dir, { mode: 0o700 });
	return dir;
}

after(() => {
	setActiveMfnRuntime(null);
});

function validateEnvelope(env: MfnRequestEnvelope): void {
	assert.equal(env.version, 2);
	assert.match(env.request_id, /^[A-Za-z0-9_-]{1,128}$/);
	if (MUTATION_OPS.has(env.operation)) {
		assert.equal(typeof env.operation_id, "string");
		assert.equal(isUuidV7(env.operation_id!), true);
		assert.equal(env.durability, "committed");
	} else {
		assert.equal(env.operation_id, undefined);
		assert.equal(env.durability, undefined);
	}
}

function validateTurnIngestContract(payload: TurnIngestPayload): void {
	assert.equal(payload.memories.length >= 1 && payload.memories.length <= 4, true);
	const batchIds = new Set<string>();
	for (const mem of payload.memories) {
		assert.equal(isValidCallerMemoryId(mem.memory_id), true);
		assert.equal(batchIds.has(mem.memory_id), false);
		batchIds.add(mem.memory_id);
		for (const tag of mem.tags ?? []) {
			assert.equal(tag.startsWith("mfn."), false);
		}
	}
	for (const del of payload.delivered ?? []) {
		assert.equal(isValidCallerMemoryId(del.memory_id), true);
		assert.equal(batchIds.has(del.anchor), true);
		const act = del.activation ?? 1;
		assert.equal(act > 0 && act <= 1, true);
	}
}

function handleTurnRecall(state: MockGatewayState, env: MfnRequestEnvelope): { status: number; body: unknown } {
	const payload = env.payload as unknown as TurnRecallPayload;
	state.recallRequests.push(payload);
	const complete = state.embedderAvailable;
	const recallResult = {
		format_version: 1,
		space_id: "nomic-v1",
		memories: complete ? state.recalledFixture : [],
		themes: complete
			? [{ pattern_id: "p-hebb", label: "Hebbian decay", summary: "Co-active trace reinforcement", score: 0.82, confidence: 0.9, activation_count: 4, members: [] }]
			: [],
		anticipations: {
			actors: [{ subject_id: "4700000000000000001", label: "Learner", confidence: 0.75, evidence_count: 3 }],
			entities: [],
			topics: [],
		},
		window_scores: {},
		layers: [],
		complete,
		degraded: complete ? [] : ["embedder_unavailable"],
	};
	const exec = { operation_id: null, workflow_state: complete ? "committed" : "needs_attention", outcomes: [], result: recallResult };
	return { status: complete ? 200 : 207, body: { version: 2, request_id: env.request_id, status: complete ? "ok" : "partial", result: exec } };
}

function handleTurnIngest(state: MockGatewayState, env: MfnRequestEnvelope): { status: number; body: unknown } {
	const payload = env.payload as unknown as TurnIngestPayload;
	validateTurnIngestContract(payload);
	if (!state.embedderAvailable) {
		const err = { code: "embedder_unavailable", message: "Ollama embedder offline", retryable: true };
		return { status: 503, body: { version: 2, request_id: env.request_id, status: "error", error: err } };
	}
	const opId = env.operation_id!;
	const prior = state.ingestedOps.get(opId);
	if (prior) {
		assert.deepEqual(prior, payload);
	} else {
		state.ingestedOps.set(opId, structuredClone(payload));
	}
	const group = { format_version: 1, turn_id: payload.turn_id, core: "committed", enrichment: "complete", children: [], plan_summary: {} };
	const exec = { operation_id: opId, workflow_state: "committed", workflow_revision: "1", outcomes: [], result: { group } };
	return { status: 200, body: { version: 2, request_id: env.request_id, status: "committed", result: exec } };
}

function dispatchOperation(state: MockGatewayState, env: MfnRequestEnvelope): { status: number; body: unknown } {
	validateEnvelope(env);
	if (env.operation === "ping" || env.operation === "health.get") {
		return { status: 200, body: { version: 2, request_id: env.request_id, status: "ok", result: { operation_id: null, workflow_state: "committed", outcomes: [{ layer: 1, state: "ok" }] } } };
	}
	if (env.operation === "pool.get") {
		if (!state.pools.has(env.pool_id!)) {
			return { status: 404, body: { version: 2, request_id: env.request_id, status: "error", error: { code: "all_targets_failed", message: "not found", retryable: false } } };
		}
		return { status: 200, body: { version: 2, request_id: env.request_id, status: "ok", result: { operation_id: null, workflow_state: "committed", outcomes: [{ layer: 2, state: "ok", result: state.pools.get(env.pool_id!) }] } } };
	}
	if (env.operation === "pool.put") {
		state.pools.set(env.pool_id!, env.payload);
		return { status: 200, body: { version: 2, request_id: env.request_id, status: "committed", result: { operation_id: env.operation_id, workflow_state: "committed", outcomes: [] } } };
	}
	if (env.operation === "memory.put") {
		const p = env.payload as { memory_id: string; content: string; tags?: string[]; metadata?: Record<string, string> };
		state.lexicalRecords.set(p.memory_id, { memory_id: p.memory_id, content: p.content, tags: p.tags ?? [], metadata: p.metadata ?? {} });
		return { status: 200, body: { version: 2, request_id: env.request_id, status: "committed", result: { operation_id: env.operation_id, workflow_state: "committed", outcomes: [] } } };
	}
	if (env.operation === "memory.search") {
		const q = String((env.payload as { query?: string }).query ?? "").toLowerCase();
		const hits = [...state.lexicalRecords.values()]
			.filter((r) => r.content.toLowerCase().includes(q) || q.includes("bayes"))
			.map((r) => ({ memory_id: r.memory_id, score: 0.77 }));
		return { status: 200, body: { version: 2, request_id: env.request_id, status: "ok", result: { operation_id: null, workflow_state: "committed", outcomes: [{ layer: 2, state: "ok", result: { hits } }] } } };
	}
	if (env.operation === "memory.peek") {
		const id = String((env.payload as { memory_id?: string }).memory_id ?? "");
		const item = state.lexicalRecords.get(id);
		if (!item) return { status: 404, body: { version: 2, request_id: env.request_id, status: "error", error: { code: "not_found", message: "absent", retryable: false } } };
		return { status: 200, body: { version: 2, request_id: env.request_id, status: "ok", result: { operation_id: null, workflow_state: "committed", outcomes: [{ layer: 2, state: "ok", result: { memory: item, created_at_us: 1000, telemetry: "unobserved" } }] } } };
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
	return { port, close: () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))) };
}

function makeTranscript(chatId: string): { messages: LhMessage[]; tree: PlanTree } {
	const stubStamps = {
		api: "faux" as const,
		provider: "test",
		model: "test-model",
		usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "toolUse" as const,
	};
	const messages: LhMessage[] = [
		{ id: "m1", role: "user", content: "Old question about priors ".repeat(400), timestamp: 1 },
		{ id: "m2", role: "assistant", content: [{ type: "text", text: "Old tutor explanation ".repeat(400) }], timestamp: 2, ...stubStamps, stopReason: "stop" },
		{ id: "m3", role: "assistant", content: [{ type: "toolCall", id: "call_1", name: "plan_init", arguments: { title: "Bayes" } }], timestamp: 3, ...stubStamps },
		{ id: "m4", role: "toolResult", toolCallId: "call_1", toolName: "plan_init", content: [{ type: "text", text: "Plan initialized" }], isError: false, timestamp: 4 },
		{ id: "m5", role: "user", content: `Ask in ${chatId}: how does Bayes rule update priors?`, timestamp: 5 },
	];
	const tree: PlanTree = { version: 1, nodes: [{ id: "n1", title: "Bayes Theorem", summary: "Posterior update" }], edges: [] };
	return { messages, tree };
}

test("200 ok turn.recall maps memories, themes, anticipations, plan tree, and drops live-tail duplicates", async () => {
	const chatId = "chat-happy";
	const { messages, tree } = makeTranscript(chatId);
	const tailDupId = messageMemoryId(chatId, "m5");
	const state: MockGatewayState = {
		embedderAvailable: true,
		pools: new Map(),
		lexicalRecords: new Map(),
		ingestedOps: new Map(),
		recallRequests: [],
		recalledFixture: [
			{ memory_id: "9001", content: "Prior belief P(H) scales likelihood.", tags: [], metadata: {}, created_at_us: 10, activation: { cue: 0.9, spread: 0.35, strength: 0.95, total: 1.1875, weight: 1 }, anchor_memory_id: null, evidence: [{ layer: 2, rank: 1, score: 0.9 }] },
			{ memory_id: tailDupId, content: "Duplicate of liveTail m5", tags: [], metadata: {}, created_at_us: 11, activation: { cue: 1, spread: 0, strength: 1, total: 1, weight: 1 }, anchor_memory_id: null, evidence: [{ layer: 1, rank: 1, score: 1 }] },
		],
	};
	const gw = await startMockGateway(state);
	try {
		const client = new MfnClient({ port: gw.port, token: TEST_TOKEN });
		await client.ensurePools({ mainPoolId: "peer-main", lexicalPoolId: "peer-lexical", spaceId: "nomic-v1", dimensions: 768 });
		assert.deepEqual(state.pools.get("peer-main"), { capacity: 100_000, vector_space: { id: "nomic-v1", dimensions: 768, mode: "caller" } });
		assert.deepEqual(state.pools.get("peer-lexical"), { capacity: 100_000 });
		const prepared = await prepareTurnContextWithMfn({ client, chatId, messages, tree, mainPoolId: "peer-main", lexicalPoolId: "peer-lexical", liveTailTokens: 20 });
		assert.equal(prepared.cutIndex > 0, true);
		assert.equal(prepared.liveTail[0]?.id, "m3");
		assert.equal(state.recallRequests[0]?.window?.memory_ids[0], tailDupId);
		assert.equal(state.recallRequests[0]?.exclude_memory_ids?.includes(tailDupId), true);
		assert.deepEqual(prepared.recalledMemories.map((m) => m.memory_id), ["9001"]);
		assert.ok(prepared.marker);
		assert.match(prepared.marker.content, /Bayes Theorem/);
		assert.match(prepared.marker.content, /Prior belief P\(H\)/);
		assert.match(prepared.marker.content, /Hebbian decay/);
		assert.doesNotMatch(prepared.marker.content, /Duplicate of liveTail/);
		const wire = toLlmMessages(prepared.agentMessages);
		assert.equal(wire[0]?.role, "user");
	} finally {
		await gw.close();
	}
});

function makeColdTurnMessages(): LhMessage[] {
	return [
		{ id: "c1", role: "user", content: "Remember Bayes theorem denominator P(E).", timestamp: 10 },
		{
			id: "c2",
			role: "assistant",
			content: [{ type: "text", text: "Marginal likelihood normalizes the posterior." }],
			timestamp: 11,
			api: "faux",
			provider: "t",
			model: "m",
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "stop",
		},
	];
}

test("503 embedder_unavailable queues in outbox while lexicalPut + 207 lexicalSearch succeed, then replays exact operation_id", async () => {
	const dir = makeScratchDir("outbox");
	const outboxFile = path.join(dir, "mfn-outbox.json");
	const state: MockGatewayState = {
		embedderAvailable: false,
		pools: new Map(),
		lexicalRecords: new Map(),
		ingestedOps: new Map(),
		recallRequests: [],
		recalledFixture: [],
	};
	const gw = await startMockGateway(state);
	try {
		const client = new MfnClient({ port: gw.port, token: TEST_TOKEN });
		const outbox = new MfnIngestOutbox({ filePath: outboxFile });
		const res1 = await ingestSettledTurnWithMfn({
			client,
			outbox,
			chatId: "chat-cold",
			turnMessages: makeColdTurnMessages(),
			mainPoolId: "peer-main",
			lexicalPoolId: "peer-lexical",
			sessionTags: ["mfn.forbidden", "topic:bayes"],
		});
		assert.equal(res1.lexicalWrites, 2);
		assert.equal(res1.queuedBatches, 1);
		const queued = outbox.entries()[0]!;
		const later: LhMessage[] = [{ id: "c9", role: "user", content: "What normalizes Bayes posterior?", timestamp: 20 }];
		const degradedCtx = await prepareTurnContextWithMfn({ client, chatId: "chat-cold", messages: later, mainPoolId: "peer-main", lexicalPoolId: "peer-lexical" });
		assert.equal(degradedCtx.degraded.includes("embedder_unavailable"), true);
		assert.equal(degradedCtx.lexicalSupplements.length, 2);
		assert.match(degradedCtx.marker?.content ?? "", /Marginal likelihood normalizes/);
		state.embedderAvailable = true;
		const reloadedOutbox = new MfnIngestOutbox({ filePath: outboxFile });
		const flushRes = await reloadedOutbox.flush(client);
		assert.equal(flushRes.flushed, 1);
		assert.equal(reloadedOutbox.size(), 0);
		assert.equal(state.ingestedOps.get(queued.operationId)?.turn_id, queued.payload.turn_id);
	} finally {
		await gw.close();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("ingestSettledTurnWithMfn chunks >4 messages into 1..4 batches, clamps delivered activation, and wires runtime bridge", async () => {
	const recalled: RecalledMemory = { memory_id: "777", content: "Recalled anchor fact", tags: [], metadata: {}, created_at_us: 1, activation: { cue: 0.9, spread: 0.5, strength: 1, total: 1.4, weight: 1 }, anchor_memory_id: null, evidence: [{ layer: 2, rank: 1, score: 0.9 }] };
	const state: MockGatewayState = { embedderAvailable: true, pools: new Map(), lexicalRecords: new Map(), ingestedOps: new Map(), recallRequests: [], recalledFixture: [recalled] };
	const gw = await startMockGateway(state);
	try {
		const client = new MfnClient({ port: gw.port, token: TEST_TOKEN });
		const outbox = new MfnIngestOutbox();
		const fiveMsgs: LhMessage[] = [1, 2, 3, 4, 5].map((n) => ({ id: `b${n}`, role: "user" as const, content: `Fact number ${n}`, timestamp: n }));
		const res = await ingestSettledTurnWithMfn({ client, outbox, chatId: "chat-batch", turnMessages: fiveMsgs, mainPoolId: "peer-main", lexicalPoolId: "peer-lexical", recalledMemories: [recalled] });
		assert.equal(res.ingestedBatches, 2);
		const batches = [...state.ingestedOps.values()];
		assert.equal(batches[0]?.memories.length, 4);
		assert.equal(batches[0]?.delivered?.[0]?.activation, 1);
		assert.equal(batches[0]?.delivered?.[0]?.anchor, batches[0]?.memories[0]?.memory_id);
		assert.equal(batches[1]?.memories.length, 1);
		assert.equal(batches[1]?.predecessor_memory_id, batches[0]?.memories[3]?.memory_id);
		setActiveMfnRuntime({ client, outbox, mainPoolId: "peer-main", lexicalPoolId: "peer-lexical", liveTailTokens: 500 });
		assert.equal(isMfnRuntimeActive(), true);
		assert.ok(getActiveMfnRuntime());
		const bridge = await prepareMfnTurnBridge({ chatId: "chat-batch", priorMessages: fiveMsgs.slice(0, 4), appends: [fiveMsgs[4]!], agentMessages: fiveMsgs, stagedAutomatic: false });
		assert.equal(bridge.initialPersistBaseCount, bridge.projectedMessages.length);
		assert.equal(bridge.projectedMessages[0]?.role, "custom");
	} finally {
		setActiveMfnRuntime(null);
		await gw.close();
	}
});
