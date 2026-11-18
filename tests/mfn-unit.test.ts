import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
	MAX_CALLER_MEMORY_ID, MfnApiError, MfnClient, MfnIngestOutbox, MfnSupervisor, UUID_V7_PATTERN,
	buildEmbeddersConfig, buildMfnSupervisorEnv, createFileOutboxPersistence, createLumberJackOutboxPersistence,
	isUuidV7, isValidCallerMemoryId, memoryIdFromKey, messageMemoryId, mintUuidV7, parseMfnReadyLine,
	prepareMfnSupervisorLayout, probeOllamaModelDigest, validateEmbedderEndpoint, writeEmbeddersPinFile,
	writePrivateFile0600, type MfnOutboxClient, type TurnIngestPayload,
} from "../src/memory/mfn/index.ts";
import { isPerItemPoisonMfnError } from "../src/memory/mfn/outbox.ts";
import { LumberJackForest } from "../src/store/lumberjack/binding.ts";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
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
	operationId: opId, response: { version: 2 as const, request_id: "r", status: "committed" as const },
});

test("mintUuidV7 produces valid RFC 9562 UUIDv7 strings and encodes timestamp", () => {
	const fixedMs = 1_794_052_800_123;
	const [id1, id2] = [mintUuidV7(fixedMs), mintUuidV7(fixedMs)];
	assert.match(id1, UUID_V7_PATTERN);
	assert.equal(isUuidV7(id1) && id1 !== id2, true);
	assert.equal(BigInt(`0x${id1.slice(0, 8) + id1.slice(9, 13)}`), BigInt(fixedMs));
	for (const bad of [-1, Number.NaN]) assert.throws(() => mintUuidV7(bad), RangeError);
});

test("memoryIdFromKey produces deterministic positive decimal IDs below 2^62", () => {
	assert.equal(memoryIdFromKey("chat-1:msg-1"), messageMemoryId("chat-1", "msg-1"));
	for (let i = 0; i < 200; i++) {
		const id = memoryIdFromKey(`sample-key-${i}`);
		assert.match(id, /^[1-9][0-9]*$/);
		assert.equal(BigInt(id) >= 1n && BigInt(id) <= MAX_CALLER_MEMORY_ID && isValidCallerMemoryId(id), true);
	}
	assert.equal(isValidCallerMemoryId("0") || isValidCallerMemoryId((1n << 62n).toString(10)), false);
	assert.equal(isValidCallerMemoryId(MAX_CALLER_MEMORY_ID.toString(10)), true);
});

test("validateEmbedderEndpoint accepts only http loopback IP literals with explicit port", () => {
	for (const ok of ["http://127.0.0.1:11434", "http://127.0.0.2:11435", "http://[::1]:11435"]) {
		assert.equal(validateEmbedderEndpoint(ok), ok);
	}
	for (const bad of [
		"http://localhost:11434", "https://127.0.0.1:11434", "HTTP://127.0.0.1:11434", "http://user@127.0.0.1:11434",
		"http://127.0.0.1:11434/", "http://127.0.0.1:11434/api", "http://127.0.0.1:11434?x=1", "http://127.0.0.1",
		"http://127.0.0.1:0", "http://127.0.0.1:70000", "http://10.0.0.1:11434", "http://[::ffff:127.0.0.1]:11434",
	]) {
		assert.throws(() => validateEmbedderEndpoint(bad), Error);
	}
});

test("probeOllamaModelDigest validates installed model and rejects digest mismatches", async () => {
	const tagsFetch = (models: unknown) =>
		(async () => new Response(JSON.stringify({ models }), { status: 200 })) as unknown as typeof fetch;
	const [digestA, digestB] = ["a".repeat(64), "b".repeat(64)];
	const [url, model] = ["http://127.0.0.1:11434", "nomic-embed-text:latest"];
	const okFetch = tagsFetch([
		{ name: "other:latest", model: "other:latest", digest: "0".repeat(64) },
		{ name: model, model, digest: digestA },
	]);
	assert.equal(await probeOllamaModelDigest(url, model, okFetch, digestA), digestA);
	await assert.rejects(() => probeOllamaModelDigest(url, model, okFetch, digestB), /digest mismatch/);
	const conflictFetch = tagsFetch([{ name: model, digest: digestA }, { model, digest: digestB }]);
	await assert.rejects(() => probeOllamaModelDigest(url, model, conflictFetch), /Conflicting Ollama digests/);
	await assert.rejects(() => probeOllamaModelDigest(url, "missing:latest", okFetch), /not installed/);
});

test("writePrivateFile0600 and writeEmbeddersPinFile refuse symlinks and hardlinks before truncating (M13)", () => {
	const dir = makeScratchDir("pin");
	try {
		const pinDir = path.join(dir, "private");
		const pinPath = path.join(pinDir, "embedders.json");
		const entry = {
			space_id: "nomic-v1", endpoint: "http://127.0.0.1:11434",
			model: "nomic-embed-text:latest", model_digest: "c".repeat(64), dimensions: 768,
		};
		assert.equal(writeEmbeddersPinFile(pinPath, [entry]).format_version, 1);
		assert.equal(fs.statSync(pinDir).mode & 0o777, 0o700);
		assert.equal(fs.statSync(pinPath).mode & 0o777, 0o600);
		const symlinkPath = path.join(pinDir, "symlink.json");
		fs.symlinkSync(pinPath, symlinkPath);
		assert.throws(() => writeEmbeddersPinFile(symlinkPath, [entry]));
		const preciousPath = path.join(pinDir, "precious.txt");
		writePrivateFile0600(preciousPath, "precious-content\n");
		const hardlinkPath = path.join(pinDir, "hardlink.txt");
		fs.linkSync(preciousPath, hardlinkPath);
		assert.throws(() => writePrivateFile0600(hardlinkPath, "clobbered\n"), /single-link regular file/);
		assert.equal(fs.readFileSync(preciousPath, "utf8"), "precious-content\n");
		assert.throws(() => buildEmbeddersConfig([entry, entry]), /Duplicate embedder space_id/);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("buildMfnSupervisorEnv allowlists OS vars and strips secrets, LD_*, PYTHON*, GPU, and MFN_* (M11)", () => {
	const scratch = makeScratchDir("env");
	try {
		const polluted: NodeJS.ProcessEnv = {
			NODE_ENV: "test", PATH: "/usr/bin", HOME: "/home/persist", PEER_PERSIST_ROOT: PERSIST_ROOT,
			OPENAI_API_KEY: "sk-secret", ANTHROPIC_API_KEY: "sk-secret", OPENROUTER_API_KEY: "sk-secret",
			LD_PRELOAD: "/evil.so", LD_LIBRARY_PATH: "/evil", PYTHONPATH: "/evil", PYTHONSTARTUP: "/rc.py",
			CUDA_HOME: "/opt/forbidden", ROCR_VISIBLE_DEVICES: "0", HIP_PLATFORM: "x", MFN_DATA_DIR: "/stale",
		};
		const cpuEnv = buildMfnSupervisorEnv(polluted, "cpu", scratch);
		assert.equal(cpuEnv.PATH === "/usr/bin" && cpuEnv.PEER_PERSIST_ROOT === PERSIST_ROOT, true);
		const stripped = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "LD_PRELOAD", "PYTHONPATH", "CUDA_HOME"];
		for (const k of stripped) assert.equal(cpuEnv[k], undefined);
		assert.equal(cpuEnv.MFN_DATA_DIR, undefined);
		assert.equal(cpuEnv.CUDA_VISIBLE_DEVICES === "" && cpuEnv.OLLAMA_LLM_LIBRARY === "cpu", true);
		assert.equal(cpuEnv.TMPDIR, scratch);
		assert.equal(buildMfnSupervisorEnv(polluted, "vulkan", scratch).OLLAMA_LLM_LIBRARY, "vulkan");
	} finally {
		fs.rmSync(scratch, { recursive: true, force: true });
	}
});

function writeFakeEngineScript(fakeScript: string, modeFile: string, orphanPidFile: string): void {
	const readyJson = "{ endpoint: \"http://127.0.0.1:19999\", state: mode, ready: true }";
	fs.writeFileSync(fakeScript, [
		"import { spawn } from \"node:child_process\";",
		"import fs from \"node:fs\";",
		`const mode = fs.readFileSync(${JSON.stringify(modeFile)}, "utf8").trim();`,
		"const runtimeDir = process.argv[process.argv.indexOf(\"--runtime-dir\") + 1];",
		"if (mode === \"orphan\") {",
		"\tconst opts = { detached: true, stdio: \"ignore\", env: { ...process.env, MFN_RUNTIME_DIR: runtimeDir } };",
		"\tconst child = spawn(process.execPath, [\"-e\", \"setInterval(() => {}, 1000)\"], opts);",
		"\tchild.unref();",
		`\tfs.writeFileSync(${JSON.stringify(orphanPidFile)}, String(child.pid));`,
		"\tprocess.on(\"SIGTERM\", () => {});",
		"}",
		`process.stdout.write(JSON.stringify(${readyJson}) + "\\n");`,
		"if (mode === \"crash\") setTimeout(() => process.exit(1), 40);",
		"else setInterval(() => {}, 1000);",
	].join("\n"), { mode: 0o600 });
}

function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		const raw = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
		const rparen = raw.lastIndexOf(")");
		return !(rparen >= 0 && raw.slice(rparen + 2, rparen + 3) === "Z");
	} catch {
		return false;
	}
}

test("MfnSupervisor resets readiness on unexpected exit and reaps orphaned session children (M8)", async () => {
	const scratch = makeScratchDir("sup");
	const stateRoot = path.join(SCRATCH_ROOT, `s${randomBytes(2).toString("hex")}`);
	try {
		assert.throws(() => prepareMfnSupervisorLayout(path.join(scratch, "x".repeat(95))), /exceeds 107-byte/);
		assert.equal(parseMfnReadyLine("noise"), null);
		const modeFile = path.join(scratch, "mode.txt");
		const orphanPidFile = path.join(scratch, "orphan.pid");
		const fakeScript = path.join(scratch, "fake.mjs");
		writeFakeEngineScript(fakeScript, modeFile, orphanPidFile);
		const binDir = path.join(scratch, "bin");
		fs.mkdirSync(binDir, { mode: 0o700 });
		const sup = new MfnSupervisor({
			repoRoot: REPO_ROOT, stateRoot, binDir, port: 19_999,
			pythonBin: process.execPath, scriptPath: fakeScript, startupTimeoutMs: 5_000, shutdownTimeoutMs: 120,
		});
		fs.writeFileSync(modeFile, "crash");
		assert.equal((await sup.start()).state, "crash");
		const waitDown = Date.now() + 2_000;
		while (sup.isRunning() && Date.now() < waitDown) await sleepMs(20);
		assert.equal(sup.isRunning(), false);
		fs.writeFileSync(modeFile, "orphan");
		assert.equal((await sup.start()).state, "orphan");
		const orphanPid = Number(fs.readFileSync(orphanPidFile, "utf8").trim());
		await sup.stop();
		const deadline = Date.now() + 500;
		while (isPidAlive(orphanPid) && Date.now() < deadline) await sleepMs(15);
		assert.equal(isPidAlive(orphanPid), false);
	} finally {
		fs.rmSync(stateRoot, { recursive: true, force: true });
		fs.rmSync(scratch, { recursive: true, force: true });
	}
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
	assert.equal(outbox.size() === 3 && outbox.droppedCount === 1, true);
	const res = await outbox.flush(mockClient);
	assert.equal(res.quarantined === 1 && res.flushed === 2, true);
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
		assert.equal(box.size() === 2 && box.deadLetters().length === 0, true);
		assert.equal((box.entries()[0]?.nextRetryAtMs ?? 0) > 1_000_000, true);
		offline = false;
		assert.equal((await box.flush(client, { force: true })).flushed, 2);
		const expOp = mintUuidV7();
		box.enqueue({ operationId: expOp, poolId: "p", payload: sampleTurnPayload("exp") });
		now += 200_000;
		assert.equal((await box.flush(client)).quarantined, 1);
		const reloaded = new MfnIngestOutbox({ filePath: outboxFile });
		assert.equal(reloaded.size() === 0 && reloaded.deadLetters()[0]?.entry.operationId === expOp, true);
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
	const lexBody = { memory_id: "77", content: "c" };
	box.enqueue({ kind: "lexical_put", operationId: lexOp, poolId: "pl", lexicalPayload: lexBody });
	await box.flush(sysClient, { force: true });
	assert.equal(box.size() === 3 && box.deadLetters().length === 0, true);
	mode = "409";
	await box.flush(sysClient, { force: true });
	assert.equal(box.size(), 3);
	mode = "embedder_down";
	const partial = await box.flush(sysClient, { force: true });
	assert.equal(partial.flushed === 1 && box.size() === 2, true);
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
		const hiLex = { memory_id: "9", content: "hi" };
		box1.enqueue({ kind: "lexical_put", operationId: opA, poolId: "lex", lexicalPayload: hiLex });
		const badLex = { memory_id: "8", content: "bad" };
		box1.quarantine({ kind: "lexical_put", operationId: deadOp, poolId: "lex", lexicalPayload: badLex }, "400");
		assert.equal(fs.existsSync(staleTmp), false);
		assert.equal(JSON.parse(fs.readFileSync(outboxFile, "utf8")).format_version, 3);
		writePrivateFile0600(outboxFile, JSON.stringify({ format_version: 2, entries: box1.entries() }));
		const v2Loaded = new MfnIngestOutbox({ filePath: outboxFile });
		assert.equal(v2Loaded.entries()[0]?.operationId === opA && v2Loaded.deadLetters().length === 0, true);
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
		await assert.rejects(() => client.ping(100), (e: unknown) => e instanceof MfnApiError && e.code === "timeout");
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
	assert.equal(matches.length === 6 && maxConcurrentPeeks === 2, true);
	const peekAttempts = new Map<string, number>();
	const partialClient = makePartialOverloadClient(peekAttempts);
	const degradedHits = await partialClient.lexicalSearch("peer-lexical", { query: "test", top_k: 3 }, 800);
	assert.deepEqual(degradedHits.map((h) => h.memory_id), ["1", "3"]);
	assert.equal(peekAttempts.get("1") === 2 && peekAttempts.get("2") === 2, true);
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
