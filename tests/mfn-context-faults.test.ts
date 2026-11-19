import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import test, { after } from "node:test";
import type { PlanTree } from "../src/core/contracts/plan.ts";
import type { LhMessage } from "../src/core/native-messages.ts";
import {
	MfnApiError,
	MfnClient,
	MfnIngestOutbox,
	ingestSettledTurnWithMfn,
	messageMemoryId,
	prepareTurnContextWithMfn,
	setActiveMfnRuntime,
	type MfnMemoryPutPayload,
	type MfnRequestEnvelope,
	type TurnIngestPayload,
} from "../src/memory/mfn/index.ts";
import { prepareMfnTurnBridge } from "../src/server/mfn-turn-bridge.ts";

const TEST_TOKEN = "t".repeat(64);

interface FaultGatewayState {
	embedderAvailable: boolean;
	lexicalPauseRemaining: number;
	recallForceError: { status: number; code: string; retryable: boolean } | null;
	lexicalSearchForceError: boolean;
	lexicalSearchCalls: number;
	lexicalPutOpIds: string[];
	lexicalRecords: Map<string, MfnMemoryPutPayload>;
}

after(() => setActiveMfnRuntime(null));

function okEnv(requestId: string, status: string, result: unknown, httpStatus = 200) {
	return { status: httpStatus, body: { version: 2, request_id: requestId, status, result } };
}

function errEnv(requestId: string, httpStatus: number, code: string, retryable: boolean) {
	const error = { code, message: code, retryable };
	return { status: httpStatus, body: { version: 2, request_id: requestId, status: "error", error } };
}

function dispatchFaultGateway(state: FaultGatewayState, env: MfnRequestEnvelope): { status: number; body: unknown } {
	if (env.operation === "memory.put") {
		state.lexicalPutOpIds.push(env.operation_id!);
		if (state.lexicalPauseRemaining > 0) {
			state.lexicalPauseRemaining -= 1;
			return errEnv(env.request_id, 503, "admission_paused", true);
		}
		const p = env.payload as unknown as MfnMemoryPutPayload;
		state.lexicalRecords.set(p.memory_id, p);
		return okEnv(env.request_id, "committed", { operation_id: env.operation_id, workflow_state: "committed", outcomes: [] });
	}
	if (env.operation === "turn.ingest") {
		const payload = env.payload as unknown as TurnIngestPayload;
		if (!state.embedderAvailable) return errEnv(env.request_id, 503, "embedder_unavailable", true);
		const group = { format_version: 1, turn_id: payload.turn_id, core: "committed", enrichment: "complete", children: [], plan_summary: {} };
		return okEnv(env.request_id, "committed", { operation_id: env.operation_id, workflow_state: "committed", outcomes: [], result: { group } });
	}
	if (env.operation === "turn.recall") {
		if (state.recallForceError) {
			const f = state.recallForceError;
			return errEnv(env.request_id, f.status, f.code, f.retryable);
		}
		const complete = state.embedderAvailable;
		const recallResult = {
			format_version: 1, space_id: "nomic-v1", memories: [], themes: [],
			anticipations: { actors: [], entities: [], topics: [] },
			window_scores: {}, layers: [], complete, degraded: complete ? [] : ["embedder_unavailable"],
		};
		return okEnv(env.request_id, complete ? "ok" : "partial", { result: recallResult }, complete ? 200 : 207);
	}
	if (env.operation === "memory.search") {
		state.lexicalSearchCalls += 1;
		if (state.lexicalSearchForceError) return errEnv(env.request_id, 503, "layer2_down", true);
		return okEnv(env.request_id, "ok", { outcomes: [{ layer: 2, state: "ok", result: { hits: [] } }] });
	}
	throw new Error(`Unexpected operation: ${env.operation}`);
}

async function startFaultGateway(state: FaultGatewayState): Promise<{ port: number; close: () => Promise<void> }> {
	const server = http.createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (c: Buffer) => chunks.push(c));
		req.on("end", () => {
			const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { request: MfnRequestEnvelope };
			const reply = dispatchFaultGateway(state, parsed.request);
			res.writeHead(reply.status, { "Content-Type": "application/json", Connection: "close" });
			res.end(JSON.stringify(reply.body));
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
	const port = (server.address() as net.AddressInfo).port;
	return { port, close: () => new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r()))) };
}

function makeFaultState(): FaultGatewayState {
	return {
		embedderAvailable: true,
		lexicalPauseRemaining: 0,
		recallForceError: null,
		lexicalSearchForceError: false,
		lexicalSearchCalls: 0,
		lexicalPutOpIds: [],
		lexicalRecords: new Map(),
	};
}

function makeSampleTranscript(chatId: string): { messages: LhMessage[]; tree: PlanTree } {
	const messages: LhMessage[] = [
		{ id: "m1", role: "user", content: "Old question about priors ".repeat(400), timestamp: 1 },
		{ id: "m5", role: "user", content: `Ask in ${chatId}: how does Bayes rule update priors?`, timestamp: 5 },
	];
	return { messages, tree: { version: 1, nodes: [{ id: "n1", title: "Bayes Theorem", summary: "Posterior update" }], edges: [] } };
}

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

test("503 admission_paused on memory.put retries with stable operationId and replays via outbox (M1)", async () => {
	const state = makeFaultState();
	state.lexicalPauseRemaining = 2;
	const gw = await startFaultGateway(state);
	const client = new MfnClient({ port: gw.port, token: TEST_TOKEN });
	const outbox = new MfnIngestOutbox();
	const runLex = (id: string) =>
		ingestSettledTurnWithMfn({
			client, outbox, chatId: "chat-m1", mainPoolId: "peer-main", lexicalPoolId: "peer-lexical",
			turnMessages: [{ id, role: "user", content: `Pause ${id}`, timestamp: 1 }],
		});
	try {
		const r1 = await runLex("lp1");
		assert.equal(r1.lexicalWrites, 1);
		assert.equal(r1.queuedLexicalWrites, 0);
		assert.equal(state.lexicalPutOpIds.length, 3);
		assert.equal(state.lexicalPutOpIds[0], state.lexicalPutOpIds[2]);
		state.lexicalPutOpIds = [];
		state.lexicalPauseRemaining = 3;
		const r2 = await runLex("lp2");
		assert.equal(r2.lexicalWrites, 0);
		assert.equal(r2.queuedLexicalWrites, 1);
		const queuedLex = outbox.entries()[0]!;
		assert.equal(queuedLex.kind, "lexical_put");
		assert.equal(queuedLex.operationId, state.lexicalPutOpIds[0]);
		const flushed = (await outbox.flush(client)).flushed;
		assert.equal(flushed, 1);
		assert.equal(state.lexicalRecords.has(messageMemoryId("chat-m1", "lp2")), true);
	} finally {
		await gw.close();
	}
});

async function assertSystemicRecallFaultsSkipLexical(
	client: MfnClient,
	state: FaultGatewayState,
	messages: LhMessage[],
	tree: PlanTree,
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
		assert.equal(ctx.degraded.includes(fault.code), true);
		assert.equal(state.lexicalSearchCalls, 0);
	}
}

test("ECONNREFUSED, 409 embedder_mismatch, and 401 degrade cleanly without calling lexicalSearch (M2)", async () => {
	const { messages, tree } = makeSampleTranscript("chat-m2");
	const deadClient = new MfnClient({ port: await getClosedPort(), token: TEST_TOKEN, timeoutMs: 500 });
	const deadPrepared = await prepareTurnContextWithMfn({
		client: deadClient, chatId: "chat-m2", messages, tree,
		mainPoolId: "peer-main", lexicalPoolId: "peer-lexical", liveTailTokens: 20,
	});
	assert.equal(deadPrepared.degraded.includes("ECONNREFUSED"), true);
	assert.ok(deadPrepared.liveTail.length > 0);
	const state = makeFaultState();
	const gw = await startFaultGateway(state);
	try {
		const client = new MfnClient({ port: gw.port, token: TEST_TOKEN });
		await assertSystemicRecallFaultsSkipLexical(client, state, messages, tree);
		state.recallForceError = null;
		state.embedderAvailable = false;
		state.lexicalSearchForceError = true;
		const both = await prepareTurnContextWithMfn({
			client, chatId: "chat-m2", messages, mainPoolId: "peer-main", lexicalPoolId: "peer-lexical",
		});
		assert.equal(both.degraded.includes("embedder_unavailable"), true);
		assert.equal(both.degraded.includes("layer2_down"), true);
		const throwingClient = { turnRecall: () => Promise.reject(new Error("boom")) } as unknown as MfnClient;
		setActiveMfnRuntime({ client: throwingClient, outbox: new MfnIngestOutbox(), mainPoolId: "m", lexicalPoolId: "l" });
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
	getHttp: () => number,
	counts: { batch: number; lex: number },
	okBatches: number[],
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
	assert.equal(res400.ingestedBatches, 1);
	assert.equal(res400.queuedBatches, 0);
	assert.equal(res400.lexicalWrites, 4);
	assert.equal(box400.deadLetters().length, 2);
	counts.batch = 0;
	counts.lex = 0;
	faultHttp = 409;
	const box409 = new MfnIngestOutbox();
	const res409 = await runBatch(box409);
	assert.equal(res409.ingestedBatches, 1);
	assert.equal(res409.queuedBatches, 1);
	assert.equal(res409.lexicalWrites, 4);
	assert.equal(res409.queuedLexicalWrites, 1);
	assert.equal(box409.size(), 2);
	assert.deepEqual(okBatches, [1, 1]);
});
