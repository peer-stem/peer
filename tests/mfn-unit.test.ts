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
	writePrivateFile0600,
} from "../src/memory/mfn/index.ts";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PERSIST_ROOT = process.env.PEER_PERSIST_ROOT ?? "/usr/lib/persist/peer";
const SCRATCH_ROOT = process.env.PEER_TEST_SCRATCH ?? path.join(PERSIST_ROOT, "scratch");

function makeScratchDir(prefix: string): string {
	const dir = path.join(SCRATCH_ROOT, `${prefix}-${randomBytes(3).toString("hex")}`);
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	return dir;
}

const sleepMs = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

test("mintUuidV7 produces valid RFC 9562 UUIDv7 strings and encodes timestamp", () => {
	const fixedMs = 1_794_052_800_123;
	const id1 = mintUuidV7(fixedMs);
	const id2 = mintUuidV7(fixedMs);
	assert.match(id1, UUID_V7_PATTERN);
	assert.equal(isUuidV7(id1), true);
	assert.equal(isUuidV7(id2), true);
	assert.notEqual(id1, id2);
	assert.equal(BigInt(`0x${id1.slice(0, 8) + id1.slice(9, 13)}`), BigInt(fixedMs));
	for (const bad of [-1, Number.NaN]) assert.throws(() => mintUuidV7(bad), RangeError);
});

test("memoryIdFromKey produces deterministic positive decimal IDs below 2^62", () => {
	assert.equal(memoryIdFromKey("chat-1:msg-1"), messageMemoryId("chat-1", "msg-1"));
	for (let i = 0; i < 200; i++) {
		const id = memoryIdFromKey(`sample-key-${i}`);
		assert.match(id, /^[1-9][0-9]*$/);
		assert.ok(BigInt(id) >= 1n);
		assert.ok(BigInt(id) <= MAX_CALLER_MEMORY_ID);
		assert.equal(isValidCallerMemoryId(id), true);
	}
	assert.equal(isValidCallerMemoryId("0"), false);
	assert.equal(isValidCallerMemoryId((1n << 62n).toString(10)), false);
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
		assert.equal(cpuEnv.PATH, "/usr/bin");
		assert.equal(cpuEnv.PEER_PERSIST_ROOT, PERSIST_ROOT);
		for (const k of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "LD_PRELOAD", "PYTHONPATH", "CUDA_HOME"]) {
			assert.equal(cpuEnv[k], undefined);
		}
		assert.equal(cpuEnv.MFN_DATA_DIR, undefined);
		assert.equal(cpuEnv.CUDA_VISIBLE_DEVICES, "");
		assert.equal(cpuEnv.OLLAMA_LLM_LIBRARY, "cpu");
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
