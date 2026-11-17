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
import { LumberJackForest } from "../src/store/lumberjack/binding.ts";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PERSIST_ROOT = process.env.PEER_PERSIST_ROOT ?? "/usr/lib/persist/peer";
const SCRATCH_ROOT = process.env.PEER_TEST_SCRATCH ?? path.join(PERSIST_ROOT, "scratch");
const LJ_ADDON_PATH = path.join(PERSIST_ROOT, "build", "lumberjack", "lumberjack_peer.node");

function makeScratchDir(prefix: string): string {
	fs.mkdirSync(SCRATCH_ROOT, { recursive: true, mode: 0o700 });
	const dir = path.join(SCRATCH_ROOT, `${prefix}-${randomBytes(3).toString("hex")}`);
	fs.mkdirSync(dir, { mode: 0o700 });
	return dir;
}

function sleepMs(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function sampleTurnPayload(label: string): TurnIngestPayload {
	return {
		turn_id: mintUuidV7(),
		session: { kind: "chat", id: label },
		occurred_at_us: Date.now() * 1_000,
		memories: [{ memory_id: memoryIdFromKey(label), content: `content:${label}` }],
	};
}

test("mintUuidV7 produces valid RFC 9562 UUIDv7 strings and encodes timestamp", () => {
	const fixedMs = 1_794_052_800_123;
	const id1 = mintUuidV7(fixedMs);
	const id2 = mintUuidV7(fixedMs);
	assert.match(id1, UUID_V7_PATTERN);
	assert.equal(isUuidV7(id1), true);
	assert.notEqual(id1, id2);
	const tsHex = id1.slice(0, 8) + id1.slice(9, 13);
	assert.equal(BigInt(`0x${tsHex}`), BigInt(fixedMs));
	assert.throws(() => mintUuidV7(-1), RangeError);
	assert.throws(() => mintUuidV7(Number.NaN), RangeError);
});

test("memoryIdFromKey produces deterministic positive decimal IDs below 2^62", () => {
	const a1 = memoryIdFromKey("chat-1:msg-1");
	const a2 = memoryIdFromKey("chat-1:msg-1");
	const b = messageMemoryId("chat-1", "msg-1");
	assert.equal(a1, a2);
	assert.equal(a1, b);
	for (let i = 0; i < 200; i++) {
		const id = memoryIdFromKey(`sample-key-${i}`);
		assert.match(id, /^[1-9][0-9]*$/);
		const num = BigInt(id);
		assert.equal(num >= 1n && num <= MAX_CALLER_MEMORY_ID, true);
		assert.equal(isValidCallerMemoryId(id), true);
	}
	assert.equal(isValidCallerMemoryId("0"), false);
	assert.equal(isValidCallerMemoryId((1n << 62n).toString(10)), false);
	assert.equal(isValidCallerMemoryId(MAX_CALLER_MEMORY_ID.toString(10)), true);
});

test("validateEmbedderEndpoint accepts only http loopback IP literals with explicit port", () => {
	assert.equal(validateEmbedderEndpoint("http://127.0.0.1:11434"), "http://127.0.0.1:11434");
	assert.equal(validateEmbedderEndpoint("http://127.0.0.2:11435"), "http://127.0.0.2:11435");
	assert.equal(validateEmbedderEndpoint("http://[::1]:11435"), "http://[::1]:11435");
	const rejected = [
		"http://localhost:11434", "https://127.0.0.1:11434", "HTTP://127.0.0.1:11434",
		"http://user@127.0.0.1:11434", "http://127.0.0.1:11434/", "http://127.0.0.1:11434/api",
		"http://127.0.0.1:11434?x=1", "http://127.0.0.1:11434#frag", "http://127.0.0.1",
		"http://127.0.0.1:0", "http://127.0.0.1:70000", "http://10.0.0.1:11434",
		"http://[::ffff:127.0.0.1]:11434", "http://[::1%lo]:11434",
	];
	for (const bad of rejected) {
		assert.throws(() => validateEmbedderEndpoint(bad), Error, `expected rejection for ${bad}`);
	}
});

function mockTagsFetch(models: unknown, status = 200): typeof fetch {
	return (async () =>
		new Response(JSON.stringify({ models }), {
			status,
			headers: { "Content-Type": "application/json" },
		})) as unknown as typeof fetch;
}

test("probeOllamaModelDigest validates installed model and rejects digest mismatches", async () => {
	const digestA = "a".repeat(64);
	const digestB = "b".repeat(64);
	const okFetch = mockTagsFetch([
		{ name: "other:latest", model: "other:latest", digest: "0".repeat(64) },
		{ name: "nomic-embed-text:latest", model: "nomic-embed-text:latest", digest: digestA },
	]);
	const resolved = await probeOllamaModelDigest("http://127.0.0.1:11434", "nomic-embed-text:latest", okFetch, digestA);
	assert.equal(resolved, digestA);
	await assert.rejects(
		() => probeOllamaModelDigest("http://127.0.0.1:11434", "nomic-embed-text:latest", okFetch, digestB),
		/digest mismatch/,
	);
	const conflictFetch = mockTagsFetch([
		{ name: "nomic-embed-text:latest", digest: digestA },
		{ model: "nomic-embed-text:latest", digest: digestB },
	]);
	await assert.rejects(
		() => probeOllamaModelDigest("http://127.0.0.1:11434", "nomic-embed-text:latest", conflictFetch),
		/Conflicting Ollama digests/,
	);
	await assert.rejects(
		() => probeOllamaModelDigest("http://127.0.0.1:11434", "missing:latest", okFetch),
		/not installed/,
	);
});

test("writePrivateFile0600 and writeEmbeddersPinFile refuse symlinks and hardlinks before truncating (M13)", () => {
	const dir = makeScratchDir("pin");
	try {
		const pinDir = path.join(dir, "private");
		const pinPath = path.join(pinDir, "embedders.json");
		const entry = {
			space_id: "nomic-v1",
			endpoint: "http://127.0.0.1:11434",
			model: "nomic-embed-text:latest",
			model_digest: "c".repeat(64),
			dimensions: 768,
		};
		const written = writeEmbeddersPinFile(pinPath, [entry]);
		assert.equal(written.format_version, 1);
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
			NODE_ENV: "test",
			PATH: "/usr/bin",
			HOME: "/home/persist",
			PEER_PERSIST_ROOT: PERSIST_ROOT,
			OPENAI_API_KEY: "sk-secret-openai",
			ANTHROPIC_API_KEY: "sk-secret-anthropic",
			OPENROUTER_API_KEY: "sk-secret-openrouter",
			LD_PRELOAD: "/evil/preload.so",
			LD_LIBRARY_PATH: "/evil/lib",
			PYTHONPATH: "/evil/py",
			PYTHONSTARTUP: "/evil/rc.py",
			CUDA_HOME: "/opt/forbidden",
			ROCR_VISIBLE_DEVICES: "0",
			HIP_PLATFORM: "forbidden",
			GPU_DEVICE_ORDINAL: "0",
			MFN_DATA_DIR: "/stale/data",
			MFN_EMBEDDERS_FILE: "/stale/embedders.json",
		};
		const cpuEnv = buildMfnSupervisorEnv(polluted, "cpu", scratch);
		assert.equal(cpuEnv.PATH, "/usr/bin");
		assert.equal(cpuEnv.HOME, "/home/persist");
		assert.equal(cpuEnv.PEER_PERSIST_ROOT, PERSIST_ROOT);
		assert.equal(cpuEnv.OPENAI_API_KEY, undefined);
		assert.equal(cpuEnv.ANTHROPIC_API_KEY, undefined);
		assert.equal(cpuEnv.OPENROUTER_API_KEY, undefined);
		assert.equal(cpuEnv.LD_PRELOAD, undefined);
		assert.equal(cpuEnv.LD_LIBRARY_PATH, undefined);
		assert.equal(cpuEnv.PYTHONPATH, undefined);
		assert.equal(cpuEnv.PYTHONSTARTUP, undefined);
		assert.equal(cpuEnv.CUDA_HOME, undefined);
		assert.equal(cpuEnv.MFN_DATA_DIR, undefined);
		assert.equal(cpuEnv.CUDA_VISIBLE_DEVICES, "");
		assert.equal(cpuEnv.OLLAMA_LLM_LIBRARY, "cpu");
		assert.equal(cpuEnv.TMPDIR, scratch);
		const vkEnv = buildMfnSupervisorEnv(polluted, "vulkan", scratch);
		assert.equal(vkEnv.OLLAMA_LLM_LIBRARY, "vulkan");
		assert.equal(vkEnv.OPENAI_API_KEY, undefined);
	} finally {
		fs.rmSync(scratch, { recursive: true, force: true });
	}
});

function writeFakeEngineScript(fakeScript: string, modeFile: string, orphanPidFile: string): void {
	const lines = [
		"import { spawn } from \"node:child_process\";",
		"import fs from \"node:fs\";",
		`const mode = fs.readFileSync(${JSON.stringify(modeFile)}, "utf8").trim();`,
		"const rtIdx = process.argv.indexOf(\"--runtime-dir\");",
		"const runtimeDir = process.argv[rtIdx + 1];",
		"if (mode === \"orphan\") {",
		"\tconst child = spawn(process.execPath, [\"-e\", \"setInterval(() => {}, 1000)\"], {",
		"\t\tdetached: true, stdio: \"ignore\", env: { ...process.env, MFN_RUNTIME_DIR: runtimeDir },",
		"\t});",
		"\tchild.unref();",
		`\tfs.writeFileSync(${JSON.stringify(orphanPidFile)}, String(child.pid));`,
		"\tprocess.on(\"SIGTERM\", () => {});",
		"}",
		"process.stdout.write(JSON.stringify({ endpoint: \"http://127.0.0.1:19999\", state: mode, ready: true }) + \"\\n\");",
		"if (mode === \"crash\") setTimeout(() => process.exit(1), 40);",
		"else setInterval(() => {}, 1000);",
	];
	fs.writeFileSync(fakeScript, lines.join("\n"), { mode: 0o600 });
}

function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
	} catch {
		return false;
	}
	try {
		const raw = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
		const rparen = raw.lastIndexOf(")");
		if (rparen >= 0 && raw.slice(rparen + 2, rparen + 3) === "Z") return false;
	} catch {
		return false;
	}
	return true;
}

async function waitPidGone(pid: number, timeoutMs = 500): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (!isPidAlive(pid)) return;
		await sleepMs(15);
	}
	assert.equal(isPidAlive(pid), false);
}

test("MfnSupervisor resets readiness on unexpected exit for restart and reaps orphaned session children (M8)", async () => {
	const scratch = makeScratchDir("sup");
	const stateRoot = path.join(SCRATCH_ROOT, `s${randomBytes(2).toString("hex")}`);
	try {
		const longRoot = path.join(scratch, "x".repeat(95));
		assert.throws(() => prepareMfnSupervisorLayout(longRoot), /exceeds 107-byte Unix sun_path limit/);
		assert.equal(parseMfnReadyLine("noise"), null);
		const modeFile = path.join(scratch, "mode.txt");
		const orphanPidFile = path.join(scratch, "orphan.pid");
		const fakeScript = path.join(scratch, "fake-engine.mjs");
		writeFakeEngineScript(fakeScript, modeFile, orphanPidFile);
		const binDir = path.join(scratch, "bin");
		fs.mkdirSync(binDir, { mode: 0o700 });
		const sup = new MfnSupervisor({
			repoRoot: REPO_ROOT,
			stateRoot,
			binDir,
			port: 19_999,
			pythonBin: process.execPath,
			scriptPath: fakeScript,
			startupTimeoutMs: 5_000,
			shutdownTimeoutMs: 120,
		});
		fs.writeFileSync(modeFile, "crash");
		assert.equal((await sup.start()).state, "crash");
		const waitDown = Date.now() + 2_000;
		while (sup.isRunning() && Date.now() < waitDown) await sleepMs(20);
		assert.equal(sup.isRunning(), false);
		fs.writeFileSync(modeFile, "orphan");
		assert.equal((await sup.start()).state, "orphan");
		assert.equal(sup.isRunning(), true);
		const orphanPid = Number(fs.readFileSync(orphanPidFile, "utf8").trim());
		process.kill(orphanPid, 0);
		await sup.stop();
		assert.equal(sup.isRunning(), false);
		await waitPidGone(orphanPid);
	} finally {
		fs.rmSync(stateRoot, { recursive: true, force: true });
		fs.rmSync(scratch, { recursive: true, force: true });
	}
});

function createMockOutboxClient(flushedIds: string[], isPaused: () => boolean): MfnOutboxClient {
	return {
		turnIngest: async (_pool, payload, opId) => {
			if (payload.session.id === "poison") throw new MfnApiError({ httpStatus: 400, code: "invalid_request", message: "bad", retryable: false });
			if (isPaused()) throw new MfnApiError({ httpStatus: 503, code: "admission_paused", message: "paused", retryable: true });
			flushedIds.push(opId ?? "");
			return { operationId: opId ?? "", response: { version: 2, request_id: "r", status: "committed" } };
		},
		lexicalPut: async (_pool, payload, opId) => {
			flushedIds.push(`lex:${opId}:${payload.memory_id}`);
			return { version: 2, request_id: "r", status: "committed" };
		},
	};
}

test("MfnIngestOutbox quarantines poisoned head, evicts oldest at cap, and auto-flushes (M6, M13)", async () => {
	const flushedIds: string[] = [];
	let paused = false;
	const mockClient = createMockOutboxClient(flushedIds, () => paused);
	const outbox = new MfnIngestOutbox({ maxEntries: 3, maxAttempts: 2, maxAgeMs: 5_000 });
	const op1 = mintUuidV7();
	const op2 = mintUuidV7();
	const op3 = mintUuidV7();
	const op4 = mintUuidV7();
	outbox.enqueue({ operationId: op1, poolId: "p", payload: sampleTurnPayload("old-1") });
	outbox.enqueue({ operationId: op2, poolId: "p", payload: sampleTurnPayload("poison") });
	outbox.enqueue({ operationId: op3, poolId: "p", payload: sampleTurnPayload("good-turn") });
	outbox.enqueue({ kind: "lexical_put", operationId: op4, poolId: "pl", lexicalPayload: { memory_id: "42", content: "lex" } });
	assert.equal(outbox.size(), 3);
	assert.equal(outbox.droppedCount, 1);
	assert.equal(outbox.entries()[0]?.operationId, op2);
	const res = await outbox.flush(mockClient);
	assert.equal(res.quarantined, 1);
	assert.equal(res.flushed, 2);
	assert.equal(outbox.quarantinedCount, 1);
	assert.deepEqual(flushedIds, [op3, `lex:${op4}:42`]);
	paused = true;
	outbox.enqueue({ operationId: mintUuidV7(), poolId: "p", payload: sampleTurnPayload("auto") });
	await outbox.flush(mockClient);
	assert.equal(outbox.size(), 1);
	paused = false;
	const stopAuto = outbox.startAutoFlush(mockClient, 30);
	try {
		const deadline = Date.now() + 1_500;
		while (outbox.size() > 0 && Date.now() < deadline) await sleepMs(20);
		assert.equal(outbox.size(), 0);
	} finally {
		stopAuto();
	}
});

test("MfnIngestOutbox enforces maxAttempts and maxAgeMs quarantine so trailing entries flush (M6)", async () => {
	let failHead = true;
	const seen: string[] = [];
	const client: MfnOutboxClient = {
		turnIngest: async (_pool, payload) => {
			if (payload.session.id === "stuck" && failHead) throw new MfnApiError({ httpStatus: 503, code: "embedder_unavailable", message: "down", retryable: true });
			seen.push(payload.session.id);
			return { operationId: "x", response: { version: 2, request_id: "r", status: "committed" } };
		},
	};
	const cappedBox = new MfnIngestOutbox({ maxAttempts: 2 });
	cappedBox.enqueue({ operationId: mintUuidV7(), poolId: "p", payload: sampleTurnPayload("stuck") });
	cappedBox.enqueue({ operationId: mintUuidV7(), poolId: "p", payload: sampleTurnPayload("behind-stuck") });
	await cappedBox.flush(client);
	assert.equal(cappedBox.size(), 2);
	const secondFlush = await cappedBox.flush(client);
	assert.equal(secondFlush.quarantined, 1);
	assert.equal(secondFlush.flushed, 1);
	assert.deepEqual(seen, ["behind-stuck"]);
	failHead = false;
	const expiringBox = new MfnIngestOutbox({ maxAgeMs: 15 });
	expiringBox.enqueue({ operationId: mintUuidV7(), poolId: "p", payload: sampleTurnPayload("expired") });
	await sleepMs(30);
	const expRes = await expiringBox.flush(client);
	assert.equal(expRes.quarantined, 1);
	assert.equal(expiringBox.size(), 0);
});

function verifyRealLumberJackOutbox(forestDir: string, opId: string): void {
	const forest = new LumberJackForest(forestDir);
	try {
		const box = new MfnIngestOutbox({ persistence: createLumberJackOutboxPersistence(forest) });
		box.enqueue({ operationId: opId, poolId: "main", payload: sampleTurnPayload("real-lj") });
	} finally {
		forest.close();
	}
	const reopened = new LumberJackForest(forestDir);
	try {
		const reloaded = new MfnIngestOutbox({ persistence: createLumberJackOutboxPersistence(reopened) });
		assert.equal(reloaded.entries()[0]?.operationId, opId);
	} finally {
		reopened.close();
	}
}

function createMockLjPersistence(writes: Array<{ path: string; type?: string; kind?: string; slot?: unknown }>, onSlot: (s: unknown) => void, readSlot: () => unknown) {
	return createLumberJackOutboxPersistence({
		getNode: (p) => (p === "memory/outbox" && readSlot() ? { slot: readSlot() } : null),
		upsertNode: (input) => {
			writes.push(input);
			onSlot(input.slot);
			return {};
		},
	});
}

test("Outbox persistence supports atomic file recovery on corrupt JSON and LumberJack memory/outbox slot (M7)", () => {
	const dir = makeScratchDir("persist");
	try {
		const outboxFile = path.join(dir, "outbox.json");
		const opA = mintUuidV7();
		const box1 = new MfnIngestOutbox({ persistence: createFileOutboxPersistence(outboxFile) });
		box1.enqueue({ kind: "lexical_put", operationId: opA, poolId: "lex", lexicalPayload: { memory_id: "9", content: "hi" } });
		assert.equal(fs.statSync(outboxFile).mode & 0o777, 0o600);
		assert.equal(fs.readdirSync(dir).some((f) => f.includes(".tmp.")), false);
		assert.equal(new MfnIngestOutbox({ filePath: outboxFile }).entries()[0]?.operationId, opA);
		writePrivateFile0600(outboxFile, "{\"format_version\":2,\"entries\":[corrupt");
		assert.equal(new MfnIngestOutbox({ filePath: outboxFile }).size(), 0);
		const writes: Array<{ path: string; type?: string; kind?: string; slot?: unknown }> = [];
		let storedSlot: unknown = null;
		const mockLj = createMockLjPersistence(writes, (s) => { storedSlot = s; }, () => storedSlot);
		new MfnIngestOutbox({ persistence: mockLj }).enqueue({ operationId: opA, poolId: "main", payload: sampleTurnPayload("lj") });
		assert.equal(writes[0]?.path, "memory/outbox");
		assert.equal(writes[0]?.type, "leaf");
		assert.equal(writes[0]?.kind, "mfn_outbox");
		assert.equal((storedSlot as { format_version?: number }).format_version, 2);
		assert.equal(new MfnIngestOutbox({ persistence: mockLj }).size(), 1);
		if (fs.existsSync(LJ_ADDON_PATH)) verifyRealLumberJackOutbox(path.join(dir, "forest"), opA);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

async function assertSlowDripDeadline(): Promise<void> {
	const dripTimers = new Set<ReturnType<typeof setInterval>>();
	const dripServer = http.createServer((_req, res) => {
		res.writeHead(200, { "Content-Type": "application/json" });
		res.write("{");
		const iv = setInterval(() => res.write(" "), 25);
		dripTimers.add(iv);
		res.once("close", () => {
			clearInterval(iv);
			dripTimers.delete(iv);
		});
	});
	await new Promise<void>((resolve) => dripServer.listen(0, "127.0.0.1", () => resolve()));
	try {
		const port = (dripServer.address() as { port: number }).port;
		const client = new MfnClient({ port, token: "t".repeat(64), timeoutMs: 100 });
		const t0 = Date.now();
		await assert.rejects(
			() => client.ping(100),
			(err: unknown) => err instanceof MfnApiError && err.code === "timeout" && err.httpStatus === 504,
		);
		assert.equal(Date.now() - t0 < 1_500, true);
	} finally {
		for (const iv of dripTimers) clearInterval(iv);
		await new Promise<void>((resolve) => dripServer.close(() => resolve()));
	}
}

function buildSearchHitsEnvelope(requestId: string) {
	const hits = ["1", "2", "3", "4", "5", "6"].map((id, i) => ({ memory_id: id, score: 1 - i * 0.1 }));
	return { httpStatus: 200, rawBody: JSON.stringify({ version: 2, request_id: requestId, status: "ok", result: { outcomes: [{ layer: 2, state: "ok", result: { hits } }] } }) };
}

function makeParallelHydrationClient(onConcurrency: (active: number) => void): MfnClient {
	let inFlight = 0;
	return new MfnClient({
		token: "t".repeat(64),
		timeoutMs: 1_000,
		transport: async (bodyJson) => {
			const parsed = JSON.parse(bodyJson) as { request: { operation: string; request_id: string; payload: { memory_id?: string } } };
			if (parsed.request.operation === "memory.search") return buildSearchHitsEnvelope(parsed.request.request_id);
			inFlight += 1;
			onConcurrency(inFlight);
			await sleepMs(70);
			inFlight -= 1;
			const id = parsed.request.payload.memory_id ?? "0";
			const rec = { memory: { memory_id: id, content: `text-${id}`, tags: [], metadata: {} } };
			const body = { version: 2, request_id: parsed.request.request_id, status: "ok", result: { outcomes: [{ layer: 2, state: "ok", result: rec }] } };
			return { httpStatus: 200, rawBody: JSON.stringify(body) };
		},
	});
}

test("MfnClient enforces hard wall-clock deadline and gateway-safe concurrent lexical hydration (M12)", async () => {
	await assertSlowDripDeadline();
	let maxConcurrentPeeks = 0;
	const parallelClient = makeParallelHydrationClient((active) => {
		maxConcurrentPeeks = Math.max(maxConcurrentPeeks, active);
	});
	const startParallel = Date.now();
	const matches = await parallelClient.lexicalSearch("peer-lexical", { query: "test", top_k: 6 }, 800);
	assert.equal(matches.length, 6);
	assert.equal(maxConcurrentPeeks, 3);
	assert.equal(Date.now() - startParallel < 320, true);
	const exhaustedClient = new MfnClient({
		token: "t".repeat(64),
		transport: async (bodyJson) => {
			const parsed = JSON.parse(bodyJson) as { request: { request_id: string } };
			await sleepMs(60);
			const body = { version: 2, request_id: parsed.request.request_id, status: "ok", result: { outcomes: [{ layer: 2, state: "ok", result: { hits: [{ memory_id: "1", score: 0.9 }] } }] } };
			return { httpStatus: 200, rawBody: JSON.stringify(body) };
		},
	});
	await assert.rejects(() => exhaustedClient.lexicalSearch("peer-lexical", { query: "slow" }, 20), /timeout/);
});
