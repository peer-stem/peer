import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { MfnApiError, MfnClient } from "../src/memory/mfn/index.ts";

const sleepMs = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function isTimeoutMfnError(err: unknown): boolean {
	assert.ok(err instanceof MfnApiError);
	assert.equal(err.code, "timeout");
	return true;
}

async function assertSlowDripDeadline(): Promise<void> {
	let iv: ReturnType<typeof setInterval> | undefined;
	const dripServer = http.createServer((_req, res) => {
		res.writeHead(200, { "Content-Type": "application/json" });
		res.write("{");
		iv = setInterval(() => res.write(" "), 25);
		res.once("close", () => clearInterval(iv));
	});
	await new Promise<void>((resolve) => dripServer.listen(0, "127.0.0.1", () => resolve()));
	try {
		const port = (dripServer.address() as { port: number }).port;
		const client = new MfnClient({ port, token: "t".repeat(64), timeoutMs: 100 });
		await assert.rejects(() => client.ping(100), isTimeoutMfnError);
	} finally {
		clearInterval(iv);
		await new Promise<void>((resolve) => dripServer.close(() => resolve()));
	}
}

function okL2Reply(reqId: string, result: unknown) {
	const outcomes = [{ layer: 2, state: "ok", result }];
	const env = { version: 2, request_id: reqId, status: "ok", result: { outcomes } };
	return { httpStatus: 200, rawBody: JSON.stringify(env) };
}

function buildSearchHitsEnvelope(requestId: string, ids = ["1", "2", "3", "4", "5", "6"]) {
	return okL2Reply(requestId, { hits: ids.map((id, i) => ({ memory_id: id, score: 1 - i * 0.1 })) });
}

function buildPeekEnvelope(requestId: string, id: string) {
	return okL2Reply(requestId, { memory: { memory_id: id, content: `text-${id}`, tags: [], metadata: {} } });
}

function buildOverloadedEnvelope(requestId: string) {
	const error = { code: "overloaded", message: "busy", retryable: true };
	return { httpStatus: 503, rawBody: JSON.stringify({ version: 2, request_id: requestId, status: "error", error }) };
}

function buildInternalErrorEnvelope(requestId: string) {
	const error = { code: "internal_error", message: "corrupt slot", retryable: false };
	return { httpStatus: 500, rawBody: JSON.stringify({ version: 2, request_id: requestId, status: "error", error }) };
}

interface ParsedMockReq {
	request: { operation: string; request_id: string; payload: { memory_id?: string } };
}

function makeParallelHydrationClient(onConcurrency: (active: number) => void): MfnClient {
	let inFlight = 0;
	return new MfnClient({
		token: "t".repeat(64),
		timeoutMs: 1_000,
		transport: async (bodyJson) => {
			const { request } = JSON.parse(bodyJson) as ParsedMockReq;
			if (request.operation === "memory.search") return buildSearchHitsEnvelope(request.request_id);
			inFlight += 1;
			onConcurrency(inFlight);
			await sleepMs(45);
			inFlight -= 1;
			return buildPeekEnvelope(request.request_id, request.payload.memory_id ?? "0");
		},
	});
}

function makePartialOverloadClient(peekAttempts: Map<string, number>): MfnClient {
	return new MfnClient({
		token: "t".repeat(64),
		transport: async (bodyJson) => {
			const { request } = JSON.parse(bodyJson) as ParsedMockReq;
			const ids = ["1", "2", "3"];
			if (request.operation === "memory.search") return buildSearchHitsEnvelope(request.request_id, ids);
			const id = request.payload.memory_id ?? "0";
			const count = (peekAttempts.get(id) ?? 0) + 1;
			peekAttempts.set(id, count);
			if ((id === "1" && count === 1) || id === "2") return buildOverloadedEnvelope(request.request_id);
			return buildPeekEnvelope(request.request_id, id);
		},
	});
}

test("MfnClient enforces concurrency=2, retries overloaded peek once, and keeps sibling hits (M12, N7)", async () => {
	await assertSlowDripDeadline();
	let maxConcurrentPeeks = 0;
	const parallelClient = makeParallelHydrationClient((active) => {
		maxConcurrentPeeks = Math.max(maxConcurrentPeeks, active);
	});
	const matches = await parallelClient.lexicalSearch("peer-lexical", { query: "test", top_k: 6 }, 1_000);
	assert.equal(matches.length, 6);
	assert.equal(maxConcurrentPeeks, 2);
	const peekAttempts = new Map<string, number>();
	const partialClient = makePartialOverloadClient(peekAttempts);
	const degradedHits = await partialClient.lexicalSearch("peer-lexical", { query: "test", top_k: 3 }, 800);
	assert.deepEqual(degradedHits.map((h) => h.memory_id), ["1", "3"]);
	assert.equal(peekAttempts.get("1"), 2);
	assert.equal(peekAttempts.get("2"), 2);
	const exhaustedClient = new MfnClient({
		token: "t".repeat(64),
		transport: async (bodyJson) => {
			const { request } = JSON.parse(bodyJson) as ParsedMockReq;
			await sleepMs(60);
			return buildSearchHitsEnvelope(request.request_id, ["1"]);
		},
	});
	await assert.rejects(() => exhaustedClient.lexicalSearch("peer-lexical", { query: "slow" }, 20), /timeout/);
});

test("MfnClient.lexicalSearch skips non-gate memory.peek 500 internal_error hit and warns (N20)", async () => {
	const peekAttempts = new Map<string, number>();
	const client = new MfnClient({
		token: "t".repeat(64),
		transport: async (bodyJson) => {
			const { request } = JSON.parse(bodyJson) as ParsedMockReq;
			if (request.operation === "memory.search") {
				return buildSearchHitsEnvelope(request.request_id, ["101", "102"]);
			}
			const id = request.payload.memory_id ?? "0";
			peekAttempts.set(id, (peekAttempts.get(id) ?? 0) + 1);
			if (id === "101") return buildInternalErrorEnvelope(request.request_id);
			return buildPeekEnvelope(request.request_id, id);
		},
	});
	const warnings: string[] = [];
	const origWarn = console.warn;
	console.warn = (...args: unknown[]) => {
		warnings.push(args.map((a) => (a instanceof Error ? `${a.name}: ${a.message}` : String(a))).join(" "));
	};
	try {
		const hits = await client.lexicalSearch("peer-lexical", { query: "test", top_k: 2 }, 1_000);
		assert.equal(peekAttempts.get("101"), 1);
		assert.equal(peekAttempts.get("102"), 1);
		assert.equal(hits.length, 1);
		assert.equal(hits[0]?.memory_id, "102");
		assert.equal(hits[0]?.content, "text-102");
		assert.equal(warnings.length, 1);
		assert.match(warnings[0]!, /\[mfn\] memory\.peek failed for 101; skipping hit:/);
		assert.match(warnings[0]!, /internal_error/);
	} finally {
		console.warn = origWarn;
	}
});
