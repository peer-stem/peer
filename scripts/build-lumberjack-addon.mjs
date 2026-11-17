#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	FORBIDDEN_GPU_LIBRARY_PATTERN,
	isForbiddenGpuEnvKey,
} from "../src/substrate/gpu-policy.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PERSIST_ROOT = process.env.PEER_PERSIST_ROOT ?? "/usr/lib/persist/peer";
const BUILD_ROOT = path.join(PERSIST_ROOT, "build");
const CACHE_DIR = path.join(BUILD_ROOT, "substrate-cache");
const LJ_OUT = path.join(BUILD_ROOT, "lumberjack");
const SCRATCH_TMP = path.join(PERSIST_ROOT, "scratch", `build-lj-addon-${process.pid}`);
const GO_EXT_DIR = path.join(REPO_ROOT, "src", "native", "lumberjack-peer");
const NAPI_SRC = path.join(REPO_ROOT, "src", "native", "lumberjack_napi.c");

function createCleanEnv() {
	const env = {};
	for (const [key, val] of Object.entries(process.env)) {
		if (typeof val !== "string" || isForbiddenGpuEnvKey(key)) {
			continue;
		}
		env[key] = val;
	}
	Object.assign(env, {
		PEER_COMPUTE_BACKEND: "cpu",
		CUDA_VISIBLE_DEVICES: "",
		ROCR_VISIBLE_DEVICES: "",
		HIP_VISIBLE_DEVICES: "",
		NVIDIA_VISIBLE_DEVICES: "none",
		OLLAMA_LLM_LIBRARY: "cpu",
		TMPDIR: SCRATCH_TMP,
		GOCACHE: path.join(CACHE_DIR, "gocache"),
		GOMODCACHE: path.join(CACHE_DIR, "gomodcache"),
		GOPATH: path.join(CACHE_DIR, "gopath"),
		CGO_ENABLED: "1",
		GOTOOLCHAIN: "local",
		GOOS: "linux",
		GOARCH: "amd64",
		GOAMD64: "v1",
		GOWORK: "off",
	});
	return env;
}

function resolveNodeIncludeDir() {
	const candidates = [
		"/usr/include/node",
		path.resolve(process.execPath, "../../include/node"),
	];
	for (const dir of candidates) {
		if (fs.existsSync(path.join(dir, "node_api.h"))) {
			return dir;
		}
	}
	throw new Error("Unable to locate node_api.h header directory");
}

function compileAddonSharedLib(nodeInc, addonPath, archivePath, env) {
	const args = [
		"-shared",
		"-fPIC",
		"-std=c11",
		"-O2",
		"-Wall",
		"-Wextra",
		"-Werror",
		"-I",
		nodeInc,
		"-I",
		GO_EXT_DIR,
		"-I",
		path.join(REPO_ROOT, "extern", "lumberjack", "ffi"),
		"-I",
		LJ_OUT,
		"-o",
		addonPath,
		NAPI_SRC,
		archivePath,
		"-lpthread",
		"-ldl",
		"-lresolv",
	];
	execFileSync("gcc", args, { env, stdio: "inherit" });
}

function main() {
	fs.mkdirSync(SCRATCH_TMP, { recursive: true, mode: 0o700 });
	fs.mkdirSync(CACHE_DIR, { recursive: true, mode: 0o755 });
	fs.mkdirSync(LJ_OUT, { recursive: true, mode: 0o755 });
	const env = createCleanEnv();
	const archivePath = path.join(LJ_OUT, "liblumberjack_peer.a");
	const addonPath = path.join(LJ_OUT, "lumberjack_peer.node");
	const nodeInc = resolveNodeIncludeDir();
	try {
		console.log("[lumberjack-addon] Building Go product archive liblumberjack_peer.a...");
		const goArgs = ["build", "-C", GO_EXT_DIR, "-buildmode=c-archive", "-trimpath", "-o", archivePath, "."];
		execFileSync("go", goArgs, { env, stdio: "inherit" });
		console.log("[lumberjack-addon] Compiling C11 N-API addon lumberjack_peer.node...");
		compileAddonSharedLib(nodeInc, addonPath, archivePath, env);
		const lddOut = execFileSync("ldd", [addonPath], { env, encoding: "utf8" });
		const bad = FORBIDDEN_GPU_LIBRARY_PATTERN.exec(lddOut);
		if (bad) {
			throw new Error(`Forbidden GPU library ${bad[0]} linked into ${addonPath}`);
		}
		console.log(`[lumberjack-addon] Built cleanly -> ${addonPath}`);
	} finally {
		fs.rmSync(SCRATCH_TMP, { recursive: true, force: true });
	}
}

main();
