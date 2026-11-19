import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
	MfnApiError,
	MfnIngestOutbox,
	createFileOutboxPersistence,
	createLumberJackOutboxPersistence,
	memoryIdFromKey,
	mintUuidV7,
	writePrivateFile0600,
	type MfnOutboxClient,
	type TurnIngestPayload,
} from "../src/memory/mfn/index.ts";
import { isPerItemPoisonMfnError } from "../src/memory/mfn/outbox.ts";
import { LumberJackForest } from "../src/store/lumberjack/binding.ts";

const PERSIST_ROOT = process.env.PEER_PERSIST_ROOT ?? "/usr/lib/persist/peer";
const SCRATCH_ROOT = process.env.PEER_TEST_SCRATCH ?? path.join(PERSIST_ROOT, "scratch");
const LJ_ADDON_PATH = path.join(PERSIST_ROOT, "build", "lumberjack", "lumberjack_peer.node");

function makeScratchDir(prefix: string): string {
	const dir = path.join(SCRATCH_ROOT, `${prefix}-${randomBytes(3).toString("hex")}`);
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	return dir;
}

const sleepMs = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function sampleTurnPayload(label: string): TurnIngestPayload {
	return {
		turn_id: mintUuidV7(),
		session: { kind: "chat", id: label },
		occurred_at_us: Date.now() * 1_000,
		memories: [{ memory_id: memoryIdFromKey(label), content: `content:${label}` }],
	};
}

const apiErr = (httpStatus: number, code: string, retryable = false) =>
	new MfnApiError({ httpStatus, code, message: code, retryable });
const okTurn = (opId = "x") => ({
	operationId: opId,
	response: { version: 2 as const, request_id: "r", status: "committed" as const },
});

function createModeOutboxClient(getMode: () => string, seen: string[]): MfnOutboxClient {
	return {
		turnIngest: async (_pool, payload, opId) => {
			const mode = getMode();
			if (payload.session.id === "poison") throw apiErr(400, "invalid_request");
			if (mode === "paused") throw apiErr(503, "admission_paused", true);
			if (mode === "401") throw apiErr(401, "unauthenticated");
			if (mode === "409") throw apiErr(409, "embedder_mismatch");
			if (mode === "embedder_down") throw apiErr(503, "embedder_unavailable", true);
			seen.push(opId ?? payload.session.id);
			return okTurn(opId);
		},
		lexicalPut: async (_pool, payload, opId) => {
			seen.push(`lex:${opId}:${payload.memory_id}`);
			return { version: 2, request_id: "r", status: "committed" };
		},
	};
}

test("MfnIngestOutbox quarantines 400 into deadLetters, evicts at cap, and auto-flushes (M6, N2)", async () => {
	const flushedIds: string[] = [];
	let mode = "ok";
	const mockClient = createModeOutboxClient(() => mode, flushedIds);
	const outbox = new MfnIngestOutbox({ maxEntries: 3, maxAgeMs: 5_000, baseBackoffMs: 10 });
	const [op1, op2, op3, op4] = [mintUuidV7(), mintUuidV7(), mintUuidV7(), mintUuidV7()];
	outbox.enqueue({ operationId: op1, poolId: "p", payload: sampleTurnPayload("old-1") });
	outbox.enqueue({ operationId: op2, poolId: "p", payload: sampleTurnPayload("poison") });
	outbox.enqueue({ operationId: op3, poolId: "p", payload: sampleTurnPayload("good-turn") });
	outbox.enqueue({
		kind: "lexical_put", operationId: op4, poolId: "pl", lexicalPayload: { memory_id: "42", content: "lex" },
	});
	assert.equal(outbox.size(), 3);
	assert.equal(outbox.droppedCount, 1);
	const res = await outbox.flush(mockClient);
	assert.equal(res.quarantined, 1);
	assert.equal(res.flushed, 2);
	assert.equal(outbox.deadLetters()[0]?.entry.operationId, op2);
	assert.deepEqual(flushedIds, [op3, `lex:${op4}:42`]);
	mode = "paused";
	outbox.enqueue({ operationId: mintUuidV7(), poolId: "p", payload: sampleTurnPayload("auto") });
	await outbox.flush(mockClient);
	assert.equal(outbox.size(), 1);
	mode = "ok";
	const stopAuto = outbox.startAutoFlush(mockClient, 25);
	try {
		const deadline = Date.now() + 1_500;
		while (outbox.size() > 0 && Date.now() < deadline) await sleepMs(20);
		assert.equal(outbox.size(), 0);
	} finally {
		stopAuto();
	}
});

test("N1: 90s outage across 18 auto-flushes deletes 0 entries; expired > maxAgeMs persists", async () => {
	let now = 1_000_000;
	let offline = true;
	const client: MfnOutboxClient = {
		turnIngest: async (_pool, _payload, opId) => {
			if (offline) throw apiErr(503, "embedder_unavailable", true);
			return okTurn(opId);
		},
	};
	const dir = makeScratchDir("n1");
	try {
		const outboxFile = path.join(dir, "outbox.json");
		const box = new MfnIngestOutbox({
			filePath: outboxFile, nowFn: () => now, baseBackoffMs: 1_000, maxAgeMs: 120_000, maxDeadLetters: 2,
		});
		box.enqueue({ operationId: mintUuidV7(), poolId: "p", payload: sampleTurnPayload("a") });
		box.enqueue({ operationId: mintUuidV7(), poolId: "p", payload: sampleTurnPayload("b") });
		assert.equal(box.entries()[0]?.nextRetryAtMs, undefined);
		for (let step = 0; step < 18; step++) {
			now += 5_000;
			await box.flush(client);
		}
		assert.equal(box.size(), 2);
		assert.equal(box.deadLetters().length, 0);
		assert.ok((box.entries()[0]?.nextRetryAtMs ?? 0) > 1_000_000);
		offline = false;
		assert.equal((await box.flush(client, { force: true })).flushed, 2);
		const expOp = mintUuidV7();
		box.enqueue({ operationId: expOp, poolId: "p", payload: sampleTurnPayload("exp") });
		now += 200_000;
		assert.equal((await box.flush(client)).quarantined, 1);
		const reloaded = new MfnIngestOutbox({ filePath: outboxFile });
		assert.equal(reloaded.size(), 0);
		assert.equal(reloaded.deadLetters()[0]?.entry.operationId, expOp);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("N2 & N4: 401/409 stop drain intact, lexical_put passes embedder_unavailable, opId eviction works", async () => {
	for (const s of [400, 413, 415, 422]) assert.equal(isPerItemPoisonMfnError(apiErr(s, "bad")), true);
	for (const s of [401, 403, 404, 409, 503]) assert.equal(isPerItemPoisonMfnError(apiErr(s, "sys")), false);
	let mode = "401";
	const seen: string[] = [];
	const sysClient = createModeOutboxClient(() => mode, seen);
	const box = new MfnIngestOutbox({ baseBackoffMs: 1_000 });
	box.enqueue({ operationId: mintUuidV7(), poolId: "p", payload: sampleTurnPayload("t1") });
	box.enqueue({ operationId: mintUuidV7(), poolId: "p", payload: sampleTurnPayload("t2") });
	const lexOp = mintUuidV7();
	box.enqueue({ kind: "lexical_put", operationId: lexOp, poolId: "pl", lexicalPayload: { memory_id: "77", content: "c" } });
	await box.flush(sysClient, { force: true });
	assert.equal(box.size(), 3);
	assert.equal(box.deadLetters().length, 0);
	mode = "409";
	await box.flush(sysClient, { force: true });
	assert.equal(box.size(), 3);
	mode = "embedder_down";
	const partial = await box.flush(sysClient, { force: true });
	assert.equal(partial.flushed, 1);
	assert.equal(box.size(), 2);
	assert.deepEqual(seen, [`lex:${lexOp}:77`]);
	const raceBox = new MfnIngestOutbox({ maxEntries: 2 });
	const [r1, r2, r3] = [mintUuidV7(), mintUuidV7(), mintUuidV7()];
	raceBox.enqueue({ operationId: r1, poolId: "p", payload: sampleTurnPayload("r1") });
	raceBox.enqueue({ operationId: r2, poolId: "p", payload: sampleTurnPayload("r2") });
	const raceSeen: string[] = [];
	await raceBox.flush({
		turnIngest: async (_pool, payload, opId) => {
			if (opId === r1) raceBox.enqueue({ operationId: r3, poolId: "p", payload: sampleTurnPayload("r3") });
			raceSeen.push(payload.session.id);
			return okTurn(opId);
		},
	});
	assert.deepEqual(raceSeen, ["r1", "r2", "r3"]);
	assert.equal(raceBox.size(), 0);
});

function verifyRealLumberJackOutbox(forestDir: string, opId: string, deadOpId: string): void {
	const withForest = <T>(fn: (f: LumberJackForest) => T): T => {
		const f = new LumberJackForest(forestDir);
		try { return fn(f); } finally { f.close(); }
	};
	withForest((forest) => {
		const box = new MfnIngestOutbox({ persistence: createLumberJackOutboxPersistence(forest) });
		box.enqueue({ operationId: opId, poolId: "main", payload: sampleTurnPayload("real-lj") });
		box.quarantine({ operationId: deadOpId, poolId: "main", payload: sampleTurnPayload("dead-lj") }, "poison");
	});
	withForest((reopened) => {
		const reloaded = new MfnIngestOutbox({ persistence: createLumberJackOutboxPersistence(reopened) });
		assert.equal(reloaded.entries()[0]?.operationId, opId);
		assert.equal(reloaded.deadLetters()[0]?.entry.operationId, deadOpId);
	});
}

test("Outbox persistence writes format_version 3, sweeps stale .tmp.*, and backs up corrupt files (M7, N4)", () => {
	const dir = makeScratchDir("persist");
	try {
		const outboxFile = path.join(dir, "outbox.json");
		const staleTmp = `${outboxFile}.tmp.9999.deadbeef`;
		writePrivateFile0600(staleTmp, "partial");
		const [opA, deadOp] = [mintUuidV7(), mintUuidV7()];
		const box1 = new MfnIngestOutbox({ persistence: createFileOutboxPersistence(outboxFile) });
		box1.enqueue({ kind: "lexical_put", operationId: opA, poolId: "lex", lexicalPayload: { memory_id: "9", content: "hi" } });
		box1.quarantine({ kind: "lexical_put", operationId: deadOp, poolId: "lex", lexicalPayload: { memory_id: "8", content: "bad" } }, "400");
		assert.equal(fs.existsSync(staleTmp), false);
		assert.equal(JSON.parse(fs.readFileSync(outboxFile, "utf8")).format_version, 3);
		writePrivateFile0600(outboxFile, JSON.stringify({ format_version: 2, entries: box1.entries() }));
		const v2Loaded = new MfnIngestOutbox({ filePath: outboxFile });
		assert.equal(v2Loaded.entries()[0]?.operationId, opA);
		assert.equal(v2Loaded.deadLetters().length, 0);
		writePrivateFile0600(outboxFile, "{\"format_version\":3,\"entries\":[corrupt");
		assert.equal(new MfnIngestOutbox({ filePath: outboxFile }).size(), 0);
		const corruptBackups = fs.readdirSync(dir).filter((f) => f.startsWith("outbox.json.corrupt."));
		assert.equal(corruptBackups.length, 1);
		assert.equal(fs.statSync(path.join(dir, corruptBackups[0]!)).mode & 0o777, 0o600);
		let storedSlot: unknown = null;
		const mockLj = createLumberJackOutboxPersistence({
			getNode: (p) => (p === "memory/outbox" && storedSlot ? { slot: storedSlot } : null),
			upsertNode: (input) => ((storedSlot = input.slot), {}),
		});
		const ljBox = new MfnIngestOutbox({ persistence: mockLj });
		ljBox.enqueue({ operationId: opA, poolId: "main", payload: sampleTurnPayload("lj") });
		assert.equal((storedSlot as { format_version?: number }).format_version, 3);
		if (fs.existsSync(LJ_ADDON_PATH)) verifyRealLumberJackOutbox(path.join(dir, "forest"), opA, deadOp);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
