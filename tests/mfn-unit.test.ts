import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
	MAX_CALLER_MEMORY_ID,
	MfnSupervisor,
	UUID_V7_PATTERN,
	buildEmbeddersConfig,
	buildMfnSupervisorEnv,
	isUuidV7,
	isValidCallerMemoryId,
	memoryIdFromKey,
	messageMemoryId,
	mintUuidV7,
	parseMfnReadyLine,
	prepareMfnSupervisorLayout,
	probeOllamaModelDigest,
	validateEmbedderEndpoint,
	writeEmbeddersPinFile,
} from "../src/memory/mfn/index.ts";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PERSIST_ROOT = process.env.PEER_PERSIST_ROOT ?? "/usr/lib/persist/peer";
const SCRATCH_ROOT = process.env.PEER_TEST_SCRATCH ?? path.join(PERSIST_ROOT, "scratch");

function makeScratchDir(prefix: string): string {
	fs.mkdirSync(SCRATCH_ROOT, { recursive: true, mode: 0o700 });
	const dir = path.join(SCRATCH_ROOT, `${prefix}-${randomBytes(4).toString("hex")}`);
	fs.mkdirSync(dir, { mode: 0o700 });
	return dir;
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
		"http://localhost:11434",
		"https://127.0.0.1:11434",
		"HTTP://127.0.0.1:11434",
		"http://user@127.0.0.1:11434",
		"http://127.0.0.1:11434/",
		"http://127.0.0.1:11434/api",
		"http://127.0.0.1:11434?x=1",
		"http://127.0.0.1:11434#frag",
		"http://127.0.0.1",
		"http://127.0.0.1:0",
		"http://127.0.0.1:70000",
		"http://10.0.0.1:11434",
		"http://[::ffff:127.0.0.1]:11434",
		"http://[::1%lo]:11434",
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

test("writeEmbeddersPinFile writes 0600 file inside 0700 parent and refuses symlinks", () => {
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
		assert.equal(written.embedders.length, 1);
		assert.equal(fs.statSync(pinDir).mode & 0o777, 0o700);
		assert.equal(fs.statSync(pinPath).mode & 0o777, 0o600);
		const symlinkPath = path.join(pinDir, "symlink.json");
		fs.symlinkSync(pinPath, symlinkPath);
		assert.throws(() => writeEmbeddersPinFile(symlinkPath, [entry]));
		assert.throws(() => buildEmbeddersConfig([entry, entry]), /Duplicate embedder space_id/);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("buildMfnSupervisorEnv strips forbidden GPU and MFN_* variables via sanitizeComputeEnv", () => {
	const scratch = makeScratchDir("env");
	try {
		const polluted: NodeJS.ProcessEnv = {
			NODE_ENV: "test",
			PATH: "/usr/bin",
			CUDA_HOME: "/opt/forbidden",
			CUDA_VISIBLE_DEVICES: "0",
			ROCR_VISIBLE_DEVICES: "0",
			HIP_PLATFORM: "forbidden",
			HSA_OVERRIDE_GFX_VERSION: "11.0.0",
			GPU_DEVICE_ORDINAL: "0",
			MFN_DATA_DIR: "/stale/data",
			MFN_EMBEDDERS_FILE: "/stale/embedders.json",
		};
		const cpuEnv = buildMfnSupervisorEnv(polluted, "cpu", scratch);
		assert.equal(cpuEnv.CUDA_HOME, undefined);
		assert.equal(cpuEnv.HIP_PLATFORM, undefined);
		assert.equal(cpuEnv.HSA_OVERRIDE_GFX_VERSION, undefined);
		assert.equal(cpuEnv.GPU_DEVICE_ORDINAL, undefined);
		assert.equal(cpuEnv.MFN_DATA_DIR, undefined);
		assert.equal(cpuEnv.MFN_EMBEDDERS_FILE, undefined);
		assert.equal(cpuEnv.CUDA_VISIBLE_DEVICES, "");
		assert.equal(cpuEnv.ROCR_VISIBLE_DEVICES, "");
		assert.equal(cpuEnv.OLLAMA_LLM_LIBRARY, "cpu");
		assert.equal(cpuEnv.TMPDIR, scratch);
		const vkEnv = buildMfnSupervisorEnv(polluted, "vulkan", scratch);
		assert.equal(vkEnv.OLLAMA_LLM_LIBRARY, "vulkan");
		assert.equal(vkEnv.OLLAMA_VULKAN, "1");
	} finally {
		fs.rmSync(scratch, { recursive: true, force: true });
	}
});

test("MfnSupervisor validates socket length, spawns controller, parses readiness, and stops cleanly", async () => {
	const scratch = makeScratchDir("sup");
	const stateRoot = path.join(SCRATCH_ROOT, `s-${randomBytes(3).toString("hex")}`);
	try {
		const longRoot = path.join(scratch, "x".repeat(95));
		assert.throws(() => prepareMfnSupervisorLayout(longRoot), /exceeds 107-byte Unix sun_path limit/);
		assert.equal(parseMfnReadyLine("noise"), null);
		const fakeScript = path.join(scratch, "fake-engine.mjs");
		fs.writeFileSync(
			fakeScript,
			`process.stdout.write(JSON.stringify({ endpoint: "http://127.0.0.1:19999", state: "ready", ready: true }) + "\\n");\nsetInterval(() => {}, 1000);\nprocess.on("SIGTERM", () => process.exit(0));\n`,
			{ mode: 0o600 },
		);
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
			shutdownTimeoutMs: 5_000,
		});
		const ready = await sup.start();
		assert.equal(ready.ready, true);
		assert.equal(fs.statSync(path.join(stateRoot, "data")).mode & 0o777, 0o700);
		assert.equal(fs.statSync(path.join(stateRoot, "runtime")).mode & 0o777, 0o700);
		assert.equal(fs.statSync(path.join(stateRoot, "secrets", "api-token")).mode & 0o777, 0o600);
		assert.ok(sup.createClient());
		await sup.stop();
	} finally {
		fs.rmSync(stateRoot, { recursive: true, force: true });
		fs.rmSync(scratch, { recursive: true, force: true });
	}
});
