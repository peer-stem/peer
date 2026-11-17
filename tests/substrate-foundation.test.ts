import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
	assertNoForbiddenGpuLibraries,
	findForbiddenGpuLibraries,
	isForbiddenGpuEnvKey,
	resolveComputeBackend,
	sanitizeComputeEnv,
} from "../src/substrate/hardware-guard.ts";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PERSIST_ROOT = process.env.PEER_PERSIST_ROOT ?? "/usr/lib/persist/peer";
const BUILD_ROOT = path.join(PERSIST_ROOT, "build");
const SCRATCH_BASE = path.join(PERSIST_ROOT, "scratch");
const REQUIRE_SUBSTRATE = process.env.PEER_REQUIRE_SUBSTRATE === "1";

const LJ_ARCHIVE_PATH = path.join(BUILD_ROOT, "lumberjack", "liblumberjack.a");
const MFN_GATEWAY_PATH = path.join(BUILD_ROOT, "mfn", "bin", "mfn-gateway");
const MANIFEST_PATH = path.join(BUILD_ROOT, "substrate-manifest.json");
const HAS_LJ_ARCHIVE = fs.existsSync(LJ_ARCHIVE_PATH);
const HAS_MFN_BINARIES = fs.existsSync(MFN_GATEWAY_PATH);
const HAS_MANIFEST = fs.existsSync(MANIFEST_PATH);

const EXPECTED_SUBMODULES: ReadonlyArray<readonly [string, string]> = [
	["extern/cloudcanvas", "69076f7989dde91b6d84d50c826a3eab081c197c"],
	["extern/cloudcanvas-lib", "155271b0c24ee6be777be82223f418917099779b"],
	["extern/lumberjack", "f4e80554f1aa88e1612639f1b3c380ec24e56588"],
	["extern/mfn", "489ca2f0abad00e687908a66177fc4156738eac7"],
];

const EXPECTED_LJ_EXPORTS = [
	"ic_lj_abi_version",
	"ic_lj_adopt",
	"ic_lj_aggregate",
	"ic_lj_application_call",
	"ic_lj_application_configure",
	"ic_lj_application_free",
	"ic_lj_close",
	"ic_lj_echo",
	"ic_lj_event_append",
	"ic_lj_event_end",
	"ic_lj_event_entries",
	"ic_lj_event_plan",
	"ic_lj_event_start",
	"ic_lj_events_publish",
	"ic_lj_forest",
	"ic_lj_node_create",
	"ic_lj_open",
	"ic_lj_query",
	"ic_lj_stream_poll",
];

const MFN_BINARY_NAMES = ["ifr", "dsr", "alm", "cpe", "psr", "mfn-gateway"] as const;

const LJ_SMOKE_C = `
#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include "lumberjack.h"

#define REQ(s) (const char *)(s), (int64_t)strlen(s)

int main(int argc, char **argv) {
	assert(argc == 2);
	assert(ic_lj_abi_version() == LJ_ABI_VERSION);
	char open_req[512];
	snprintf(open_req, sizeof open_req,
		"organization: peer\\ndatabase_path: %s\\nname: state\\nprincipal: peer-system\\n", argv[1]);
	lj_handle_t h = 0;
	assert(ic_lj_open(REQ(open_req), &h) == LJ_OK && h != 0);
	char out[LJ_MUTATION_OUT_MIN + 4096];
	int64_t len = -1;
	assert(ic_lj_node_create(h, REQ("path: knowledge/propositions/n1\\ntype: leaf\\n"), out, sizeof out, &len) == LJ_OK);
	assert(ic_lj_event_start(h, REQ("path: knowledge/propositions/n1\\nevent_id: ev1\\n"), out, sizeof out, &len) == LJ_OK);
	assert(ic_lj_event_append(h, REQ("path: knowledge/propositions/n1\\nevent_id: ev1\\ncontent: bayes-rule\\n"), out, sizeof out, &len) == LJ_OK);
	assert(ic_lj_event_end(h, REQ("path: knowledge/propositions/n1\\nevent_id: ev1\\n"), out, sizeof out, &len) == LJ_OK);
	assert(ic_lj_event_entries(h, REQ("path: knowledge/propositions/n1\\nevent_id: ev1\\n"), out, sizeof out, &len) == LJ_OK);
	out[len] = '\\0';
	assert(strstr(out, "bayes-rule") != NULL);
	assert(ic_lj_stream_poll(h, REQ("after: 0\\ntimeout_ms: 0\\n"), out, sizeof out, &len) == LJ_OK);
	assert(ic_lj_close(h) == LJ_OK);
	return 0;
}
`;

function sha256File(filePath: string): string {
	return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function createScratchDir(prefix: string): string {
	fs.mkdirSync(SCRATCH_BASE, { recursive: true, mode: 0o755 });
	const dir = path.join(SCRATCH_BASE, `${prefix}-${process.pid}-${randomBytes(4).toString("hex")}`);
	fs.mkdirSync(dir, { mode: 0o700 });
	return dir;
}

function getFreeLoopbackPort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const srv = net.createServer();
		srv.once("error", reject);
		srv.listen(0, "127.0.0.1", () => {
			const addr = srv.address();
			const port = typeof addr === "object" && addr ? addr.port : 0;
			srv.close((err) => (err ? reject(err) : resolve(port)));
		});
	});
}

function findReadyInLines(lines: string[]): { endpoint: string; ready: boolean } | null {
	for (const line of lines) {
		const trimmed = line.trim();
		if (trimmed.startsWith("{") && trimmed.includes('"endpoint"')) {
			return JSON.parse(trimmed) as { endpoint: string; ready: boolean };
		}
	}
	return null;
}

function waitForReadyLine(proc: ReturnType<typeof spawn>, timeoutMs: number): Promise<{ endpoint: string; ready: boolean }> {
	return new Promise((resolve, reject) => {
		let stdoutBuf = "";
		let stderrBuf = "";
		const timer = setTimeout(() => reject(new Error(`MFN readiness timeout; stderr=${stderrBuf}`)), timeoutMs);
		proc.stderr?.on("data", (chunk: Buffer) => {
			stderrBuf += chunk.toString("utf8");
		});
		proc.stdout?.on("data", (chunk: Buffer) => {
			stdoutBuf += chunk.toString("utf8");
			const lines = stdoutBuf.split("\n");
			stdoutBuf = lines.pop() ?? "";
			const parsed = findReadyInLines(lines);
			if (!parsed) return;
			clearTimeout(timer);
			resolve(parsed);
		});
		proc.once("exit", (code) => {
			clearTimeout(timer);
			reject(new Error(`MFN exited early (${code}): ${stderrBuf}`));
		});
	});
}

function collectJsonResponse(
	res: http.IncomingMessage,
	onParsed: (value: { status: number; body: { status?: string } }) => void,
): void {
	const chunks: Buffer[] = [];
	res.on("data", (chunk: Buffer) => chunks.push(chunk));
	res.on("end", () => {
		const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { status?: string };
		onParsed({ status: res.statusCode ?? 0, body });
	});
}

function postMfnExecute(
	port: number,
	token: string,
	operation: string,
	timeoutMs = 5_000,
): Promise<{ status: number; body: { status?: string } }> {
	const request = { version: 2, request_id: `s0-${operation.replace(".", "-")}`, operation, payload: {}, timeout_ms: 5000 };
	const payload = JSON.stringify({ request });
	const headers = {
		Authorization: `Bearer ${token}`,
		Accept: "application/json",
		"Content-Type": "application/json",
		"Content-Length": Buffer.byteLength(payload),
		Connection: "close",
	};
	const opts = { hostname: "127.0.0.1", port, path: "/v2/execute", method: "POST", headers };
	return new Promise((resolve, reject) => {
		let settled = false;
		const finish = (fn: () => void) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			fn();
		};
		const req = http.request(opts, (res) => collectJsonResponse(res, (val) => finish(() => resolve(val))));
		const timer = setTimeout(() => {
			req.destroy();
			finish(() => reject(new Error(`postMfnExecute(${operation}) timed out after ${timeoutMs}ms`)));
		}, timeoutMs);
		req.once("error", (err) => finish(() => reject(err)));
		req.end(payload);
	});
}

function waitForExitOnSigterm(
	proc: ReturnType<typeof spawn>,
	timeoutMs: number,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			proc.kill("SIGKILL");
			reject(new Error(`Child pid=${proc.pid} failed to exit within ${timeoutMs}ms after SIGTERM`));
		}, timeoutMs);
		proc.once("exit", (code, signal) => {
			clearTimeout(timer);
			resolve({ code, signal });
		});
		proc.kill("SIGTERM");
	});
}

async function stopChild(
	proc: ReturnType<typeof spawn>,
	timeoutMs = 10_000,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
	const result = proc.exitCode === null && proc.signalCode === null
		? await waitForExitOnSigterm(proc, timeoutMs)
		: { code: proc.exitCode, signal: proc.signalCode };
	proc.stdout?.destroy();
	proc.stderr?.destroy();
	return result;
}

test("submodules are pinned to approved commits and clean", () => {
	const gitmodules = fs.readFileSync(path.join(REPO_ROOT, ".gitmodules"), "utf8");
	for (const [subPath, expectedSha] of EXPECTED_SUBMODULES) {
		assert.match(gitmodules, new RegExp(`path = ${subPath.replace("/", "\\/")}`));
		const fullPath = path.join(REPO_ROOT, subPath);
		const actualSha = execFileSync("git", ["-C", fullPath, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
		assert.equal(actualSha, expectedSha, `submodule ${subPath} pin mismatch`);
		const dirty = execFileSync("git", ["-C", fullPath, "status", "--porcelain"], { encoding: "utf8" }).trim();
		assert.equal(dirty, "", `submodule ${subPath} has uncommitted artifacts: ${dirty}`);
	}
});

test("hardware guard allows only CPU or Nova/Vulkan and rejects CUDA/ROCm/GPU_/AMD_", () => {
	assert.equal(resolveComputeBackend(undefined), "cpu");
	assert.equal(resolveComputeBackend(""), "cpu");
	assert.equal(resolveComputeBackend("cpu"), "cpu");
	assert.equal(resolveComputeBackend("CPU-ONLY"), "cpu");
	assert.equal(resolveComputeBackend("vulkan"), "vulkan");
	assert.equal(resolveComputeBackend("nova"), "vulkan");
	assert.equal(resolveComputeBackend("nova-vulkan"), "vulkan");
	for (const bad of ["cuda", "CUDA", "rocm", "ROCm", "hip", "nvidia", "amd", "opencl", "auto"]) {
		assert.throws(() => resolveComputeBackend(bad), /Invalid compute backend/);
	}
	assert.equal(isForbiddenGpuEnvKey("CUDA_HOME"), true);
	assert.equal(isForbiddenGpuEnvKey("HSA_OVERRIDE_GFX_VERSION"), true);
	assert.equal(isForbiddenGpuEnvKey("GPU_DEVICE_ORDINAL"), true);
	assert.equal(isForbiddenGpuEnvKey("GPU_UNLISTED_DRIVER_FLAG"), true);
	assert.equal(isForbiddenGpuEnvKey("AMD_UNLISTED_DRIVER_FLAG"), true);
	assert.equal(isForbiddenGpuEnvKey("PATH"), false);
});

test("sanitizeComputeEnv strips CUDA/ROCm/GPU_/AMD_ variables and enforces safe Ollama flags", () => {
	const polluted: NodeJS.ProcessEnv = {
		NODE_ENV: "test",
		PATH: "/usr/bin",
		CUDA_HOME: "/opt/cuda",
		CUDA_VISIBLE_DEVICES: "0",
		ROCR_VISIBLE_DEVICES: "0",
		HIP_PLATFORM: "amd",
		HSA_OVERRIDE_GFX_VERSION: "11.0.0",
		NVIDIA_VISIBLE_DEVICES: "all",
		GPU_DEVICE_ORDINAL: "0",
		GPU_ARBITRARY_TUNING: "1",
		AMD_ARBITRARY_DEBUG: "2",
	};
	const cpuEnv = sanitizeComputeEnv(polluted, "cpu");
	assert.equal(cpuEnv.CUDA_HOME, undefined);
	assert.equal(cpuEnv.HIP_PLATFORM, undefined);
	assert.equal(cpuEnv.HSA_OVERRIDE_GFX_VERSION, undefined);
	assert.equal(cpuEnv.GPU_DEVICE_ORDINAL, undefined);
	assert.equal(cpuEnv.GPU_ARBITRARY_TUNING, undefined);
	assert.equal(cpuEnv.AMD_ARBITRARY_DEBUG, undefined);
	assert.equal(cpuEnv.CUDA_VISIBLE_DEVICES, "");
	assert.equal(cpuEnv.ROCR_VISIBLE_DEVICES, "");
	assert.equal(cpuEnv.HIP_VISIBLE_DEVICES, "");
	assert.equal(cpuEnv.NVIDIA_VISIBLE_DEVICES, "none");
	assert.equal(cpuEnv.OLLAMA_LLM_LIBRARY, "cpu");

	const vkEnv = sanitizeComputeEnv(polluted, "vulkan");
	assert.equal(vkEnv.OLLAMA_LLM_LIBRARY, "vulkan");
	assert.equal(vkEnv.OLLAMA_VULKAN, "1");
	assert.equal(vkEnv.CUDA_VISIBLE_DEVICES, "");
	assert.equal(vkEnv.ROCR_VISIBLE_DEVICES, "");
	assert.equal(vkEnv.GPU_ARBITRARY_TUNING, undefined);
	assert.equal(vkEnv.AMD_ARBITRARY_DEBUG, undefined);
});

test("findForbiddenGpuLibraries flags CUDA and ROCm shared objects while allowing Vulkan and libc", () => {
	const safeLdd = "\tlibvulkan.so.1 => /usr/lib/libvulkan.so.1\n\tliblmdb.so.0 => /usr/lib/liblmdb.so.0\n\tlibc.so.6 => /usr/lib/libc.so.6\n";
	assert.deepEqual(findForbiddenGpuLibraries(safeLdd), []);
	assert.doesNotThrow(() => assertNoForbiddenGpuLibraries("safe-bin", safeLdd));

	const unsafeLdd = "\tlibcudart.so.12 => /opt/cuda/libcudart.so.12\n\tlibamdhip64.so.6 => /opt/rocm/libamdhip64.so.6\n";
	assert.deepEqual(findForbiddenGpuLibraries(unsafeLdd), ["libamdhip64.so", "libcudart.so"]);
	assert.throws(() => assertNoForbiddenGpuLibraries("bad-bin", unsafeLdd), /Forbidden CUDA\/ROCm/);
});

interface SubstrateManifest {
	computeBackend: string;
	lumberjack: {
		commit: string;
		archiveSha256: string;
		headerSha256: string;
		peerArchiveSha256: string;
		peerAddonSha256: string;
	};
	mfn: {
		commit: string;
		binaries: Record<string, string>;
	};
}

test(
	"substrate-manifest.json records verified LumberJack addon and MFN binary SHA-256 digests",
	{ skip: !HAS_MANIFEST && !REQUIRE_SUBSTRATE ? "prebuilt substrate manifest absent" : false },
	() => {
		assert.equal(fs.existsSync(MANIFEST_PATH), true, `missing ${MANIFEST_PATH}`);
		const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8")) as SubstrateManifest;
		assert.equal(manifest.computeBackend, "cpu");
		assert.equal(manifest.lumberjack.commit, EXPECTED_SUBMODULES[2]?.[1]);
		assert.equal(manifest.mfn.commit, EXPECTED_SUBMODULES[3]?.[1]);
		const ljDir = path.join(BUILD_ROOT, "lumberjack");
		assert.equal(manifest.lumberjack.archiveSha256, sha256File(path.join(ljDir, "liblumberjack.a")));
		assert.equal(manifest.lumberjack.headerSha256, sha256File(path.join(ljDir, "lumberjack.h")));
		assert.equal(manifest.lumberjack.peerArchiveSha256, sha256File(path.join(ljDir, "liblumberjack_peer.a")));
		assert.equal(manifest.lumberjack.peerAddonSha256, sha256File(path.join(ljDir, "lumberjack_peer.node")));
		for (const name of MFN_BINARY_NAMES) {
			assert.equal(manifest.mfn.binaries[name], sha256File(path.join(BUILD_ROOT, "mfn", "bin", name)));
		}
	},
);

test(
	"LumberJack C-ABI v2 archive exports exact 19 functions and passes SSD C11 smoke",
	{ skip: !HAS_LJ_ARCHIVE && !REQUIRE_SUBSTRATE ? "prebuilt liblumberjack.a absent" : false },
	() => {
		const ljDir = path.join(BUILD_ROOT, "lumberjack");
		assert.equal(fs.existsSync(LJ_ARCHIVE_PATH), true, "missing liblumberjack.a");
		const nmOut = execFileSync("nm", ["-g", "--defined-only", LJ_ARCHIVE_PATH], { encoding: "utf8" });
		const rawNames = nmOut
			.split(/\r?\n/)
			.map((line) => line.trim().split(/\s+/))
			.filter((parts) => parts[1] === "T" && parts[2]?.startsWith("ic_lj_"))
			.map((parts) => parts[2] as string);
		const found = [...new Set(rawNames)].sort();
		assert.deepEqual(found, EXPECTED_LJ_EXPORTS);

		const scratch = createScratchDir("s0-lj-smoke");
		try {
			const env = { ...sanitizeComputeEnv(process.env, "cpu"), TMPDIR: scratch };
			const cFile = path.join(scratch, "smoke.c");
			const binFile = path.join(scratch, "smoke");
			const dbDir = path.join(scratch, "forest");
			fs.mkdirSync(dbDir, { mode: 0o700 });
			fs.writeFileSync(cFile, LJ_SMOKE_C);
			execFileSync("gcc", ["-std=c11", "-Wall", "-Wextra", "-Werror", "-I", ljDir, "-o", binFile, cFile, LJ_ARCHIVE_PATH, "-lpthread", "-ldl", "-lresolv"], { env });
			const lddOut = execFileSync("ldd", [binFile], { env, encoding: "utf8" });
			assertNoForbiddenGpuLibraries("lumberjack-smoke", lddOut);
			execFileSync(binFile, [dbDir], { env });
		} finally {
			fs.rmSync(scratch, { recursive: true, force: true });
		}
	},
);

function spawnScratchMfnEngine(
	mfnBinDir: string,
	scratch: string,
	port: number,
	token: string,
	baseEnv: NodeJS.ProcessEnv,
): ReturnType<typeof spawn> {
	const dataDir = path.join(scratch, "data");
	const runtimeDir = path.join(scratch, "runtime");
	const secretsDir = path.join(scratch, "secrets");
	const tokenFile = path.join(secretsDir, "api-token");
	fs.mkdirSync(dataDir, { mode: 0o700 });
	fs.mkdirSync(runtimeDir, { mode: 0o700 });
	fs.mkdirSync(secretsDir, { mode: 0o700 });
	fs.writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 });
	const engineEnv: NodeJS.ProcessEnv = { ...baseEnv, TMPDIR: scratch };
	for (const key of Object.keys(engineEnv)) {
		if (key.startsWith("MFN_")) {
			delete engineEnv[key];
		}
	}
	const scriptPath = path.join(REPO_ROOT, "extern", "mfn", "scripts", "mfn-engine.py");
	return spawn(
		"python3",
		[
			scriptPath,
			"--data-dir",
			dataDir,
			"--runtime-dir",
			runtimeDir,
			"--token-file",
			tokenFile,
			"--port",
			String(port),
			"--ifr",
			path.join(mfnBinDir, "ifr"),
			"--dsr",
			path.join(mfnBinDir, "dsr"),
			"--alm",
			path.join(mfnBinDir, "alm"),
			"--cpe",
			path.join(mfnBinDir, "cpe"),
			"--psr",
			path.join(mfnBinDir, "psr"),
			"--gateway",
			path.join(mfnBinDir, "mfn-gateway"),
		],
		{ env: engineEnv, stdio: ["ignore", "pipe", "pipe"] },
	);
}

async function verifyLiveMfnSmoke(port: number, token: string): Promise<void> {
	for (const op of ["ping", "health.get"]) {
		const res = await postMfnExecute(port, token, op, 5_000);
		assert.equal(res.status, 200, `${op} status`);
		assert.equal(res.body.status, "ok");
	}
}

test(
	"MFN 2.0 native CPU binaries link zero GPU libs, answer ping + health.get, and drain cleanly on SIGTERM",
	{ skip: !HAS_MFN_BINARIES && !REQUIRE_SUBSTRATE ? "prebuilt MFN binaries absent" : false },
	async () => {
		const mfnBinDir = path.join(BUILD_ROOT, "mfn", "bin");
		const env = sanitizeComputeEnv(process.env, "cpu");
		for (const name of MFN_BINARY_NAMES) {
			const binPath = path.join(mfnBinDir, name);
			assert.equal(fs.statSync(binPath).mode & 0o022, 0, `${name} must not be group/other writable`);
			assertNoForbiddenGpuLibraries(name, execFileSync("ldd", [binPath], { env, encoding: "utf8" }));
		}
		const scratch = createScratchDir("s0-mfn-smoke");
		const token = randomBytes(32).toString("hex");
		const port = await getFreeLoopbackPort();
		const proc = spawnScratchMfnEngine(mfnBinDir, scratch, port, token, env);
		let stopped = false;
		try {
			const ready = await waitForReadyLine(proc, 25_000);
			assert.equal(ready.ready, true);
			await verifyLiveMfnSmoke(port, token);
			const exit = await stopChild(proc, 10_000);
			stopped = true;
			assert.equal(exit.code, 0, `expected clean SIGTERM exit code 0, got ${exit.code}`);
			assert.equal(exit.signal, null, `expected clean SIGTERM exit signal null, got ${exit.signal}`);
		} finally {
			if (!stopped) await stopChild(proc, 10_000).catch(() => undefined);
			fs.rmSync(scratch, { recursive: true, force: true });
		}
	},
);
