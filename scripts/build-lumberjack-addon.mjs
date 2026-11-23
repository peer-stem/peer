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

function resolvePersistRoot() {
	if (process.env.PEER_PERSIST_ROOT?.trim()) {
		return path.resolve(process.env.PEER_PERSIST_ROOT.trim());
	}
	if (fs.existsSync("/usr/lib/persist/peer")) {
		return "/usr/lib/persist/peer";
	}
	return path.join(REPO_ROOT, ".peer-build");
}

const PERSIST_ROOT = resolvePersistRoot();
const BUILD_ROOT = path.join(PERSIST_ROOT, "build");
const CACHE_DIR = path.join(BUILD_ROOT, "substrate-cache");
const LJ_OUT = path.join(BUILD_ROOT, "lumberjack");
const SCRATCH_TMP = path.join(PERSIST_ROOT, "scratch", `build-lj-addon-${process.pid}`);
const GO_EXT_DIR = path.join(REPO_ROOT, "src", "native", "lumberjack-peer");
const NAPI_SRC = path.join(REPO_ROOT, "src", "native", "lumberjack_napi.c");
const VENDORED_NAPI_INC = path.join(REPO_ROOT, "src", "native", "include");

function resolveGoTarget() {
	if (process.platform === "win32") {
		throw new Error(
			"Windows native LumberJack addon builds await Win32 LockFileEx support in extern/lumberjack/embedded/lock.go.",
		);
	}
	if (process.platform !== "linux" && process.platform !== "darwin") {
		throw new Error(`Unsupported host platform for LumberJack addon build: ${process.platform}`);
	}
	const goarch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "amd64" : "";
	if (!goarch) {
		throw new Error(`Unsupported host CPU architecture for LumberJack addon build: ${process.arch}`);
	}
	return {
		goos: process.platform,
		goarch,
		...(goarch === "amd64" ? { goamd64: "v1" } : {}),
	};
}

function createCleanEnv(target) {
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
		GOCACHE: env.GOCACHE || path.join(CACHE_DIR, "gocache"),
		GOMODCACHE: env.GOMODCACHE || path.join(CACHE_DIR, "gomodcache"),
		GOPATH: env.GOPATH || path.join(CACHE_DIR, "gopath"),
		CGO_ENABLED: "1",
		GOTOOLCHAIN: process.env.CI ? "auto" : "local",
		GOOS: target.goos,
		GOARCH: target.goarch,
		...(target.goamd64 ? { GOAMD64: target.goamd64 } : {}),
		GOWORK: "off",
	});
	return env;
}

function resolveNodeIncludeDir() {
	const candidates = [
		"/usr/include/node",
		path.resolve(process.execPath, "../../include/node"),
		VENDORED_NAPI_INC,
	];
	for (const dir of candidates) {
		if (fs.existsSync(path.join(dir, "node_api.h"))) {
			return dir;
		}
	}
	throw new Error("Unable to locate node_api.h header directory");
}

function compileAddonSharedLib(nodeInc, addonPath, archivePath, env) {
	const commonIncludes = [
		"-I",
		nodeInc,
		"-I",
		GO_EXT_DIR,
		"-I",
		path.join(REPO_ROOT, "extern", "lumberjack", "ffi"),
		"-I",
		LJ_OUT,
	];
	if (process.platform === "darwin") {
		const cc = env.CC || "clang";
		const args = [
			"-bundle",
			"-undefined",
			"dynamic_lookup",
			"-fPIC",
			"-std=c11",
			"-O2",
			"-Wall",
			"-Wextra",
			"-Werror",
			...commonIncludes,
			"-o",
			addonPath,
			NAPI_SRC,
			archivePath,
			"-framework",
			"CoreFoundation",
			"-framework",
			"Security",
			"-lpthread",
		];
		execFileSync(cc, args, { env, stdio: "inherit" });
		return;
	}
	const cc = env.CC || "gcc";
	const args = [
		"-shared",
		"-fPIC",
		"-std=c11",
		"-O2",
		"-Wall",
		"-Wextra",
		"-Werror",
		...commonIncludes,
		"-o",
		addonPath,
		NAPI_SRC,
		archivePath,
		"-lpthread",
		"-ldl",
		"-lresolv",
	];
	execFileSync(cc, args, { env, stdio: "inherit" });
}

function verifyNoForbiddenGpuLinks(addonPath, env) {
	const cmd = process.platform === "darwin" ? "otool" : "ldd";
	const args = process.platform === "darwin" ? ["-L", addonPath] : [addonPath];
	const out = execFileSync(cmd, args, { env, encoding: "utf8" });
	const bad = FORBIDDEN_GPU_LIBRARY_PATTERN.exec(out);
	if (bad) {
		throw new Error(`Forbidden GPU library ${bad[0]} linked into ${addonPath}`);
	}
}

function main() {
	const target = resolveGoTarget();
	fs.mkdirSync(SCRATCH_TMP, { recursive: true, mode: 0o700 });
	fs.mkdirSync(CACHE_DIR, { recursive: true, mode: 0o755 });
	fs.mkdirSync(LJ_OUT, { recursive: true, mode: 0o755 });
	const env = createCleanEnv(target);
	const archivePath = path.join(LJ_OUT, "liblumberjack_peer.a");
	const addonPath = path.join(LJ_OUT, "lumberjack_peer.node");
	const nodeInc = resolveNodeIncludeDir();
	try {
		console.log(`[lumberjack-addon] Building Go product archive liblumberjack_peer.a (${target.goos}/${target.goarch})...`);
		const goArgs = ["build", "-C", GO_EXT_DIR, "-buildmode=c-archive", "-trimpath", "-o", archivePath, "."];
		execFileSync("go", goArgs, { env, stdio: "inherit" });
		console.log("[lumberjack-addon] Compiling C11 N-API addon lumberjack_peer.node...");
		compileAddonSharedLib(nodeInc, addonPath, archivePath, env);
		verifyNoForbiddenGpuLinks(addonPath, env);
		console.log(`[lumberjack-addon] Built cleanly -> ${addonPath}`);
	} finally {
		fs.rmSync(SCRATCH_TMP, { recursive: true, force: true });
	}
}

main();
