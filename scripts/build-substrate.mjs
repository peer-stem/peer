#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PERSIST_ROOT = process.env.PEER_PERSIST_ROOT ?? "/usr/lib/persist/peer";
const BUILD_ROOT = path.join(PERSIST_ROOT, "build");
const CACHE_DIR = path.join(BUILD_ROOT, "substrate-cache");
const SCRATCH_TMP = path.join(PERSIST_ROOT, "scratch", `build-substrate-${process.pid}`);
const LJ_SRC = path.join(REPO_ROOT, "extern", "lumberjack");
const MFN_SRC = path.join(REPO_ROOT, "extern", "mfn");
const LJ_OUT = path.join(BUILD_ROOT, "lumberjack");
const MFN_BIN = path.join(BUILD_ROOT, "mfn", "bin");

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

const RUST_TARGETS = [
	["mfn_layer2_dsr", "layer2_socket_server", "dsr"],
	["layer4-rust-cpe", "layer4_socket_server", "cpe"],
	["layer5-rust-psr", "layer5_socket_server", "psr"],
	["mfn-telepathy", "mfn-gateway", "mfn-gateway"],
];

const GPU_PREFIXES = ["CUDA_", "NVIDIA_", "NVCC_", "NCCL_", "ROCR_", "ROCM_", "HIP_", "HSA_", "MIOPEN_"];
const BLOCKED_LIB_RE =
	/\b(libcuda|libcudart|libcublas|libcurand|libcufft|libcusparse|libcusolver|libcudnn|libnvrtc|libnccl|libamdhip64|libhsa-runtime64|librocblas|libhipblas|libmiopen|librocm)[\w.-]*\.so\b/i;
const COMPILER_OVERRIDES = new Set([
	"RUSTFLAGS",
	"CARGO_ENCODED_RUSTFLAGS",
	"GOFLAGS",
	"ZIG_LIB_DIR",
	"CGO_CFLAGS",
	"CGO_LDFLAGS",
	"RUSTC_WRAPPER",
	"RUSTC_WORKSPACE_WRAPPER",
	"RUSTC",
	"GOEXPERIMENT",
	"GOROOT",
]);

function createBuildEnv() {
	const env = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (typeof value !== "string" || COMPILER_OVERRIDES.has(key)) {
			continue;
		}
		const upper = key.toUpperCase();
		if (GPU_PREFIXES.some((prefix) => upper.startsWith(prefix)) || key.startsWith("CARGO_PROFILE_RELEASE_")) {
			continue;
		}
		env[key] = value;
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
		CGO_ENABLED: "1",
		GOTOOLCHAIN: "local",
		GOOS: "linux",
		GOARCH: "amd64",
		GOAMD64: "v1",
		GOWORK: "off",
	});
	return env;
}

function run(cmd, args, env, cwd = REPO_ROOT, capture = false) {
	return execFileSync(cmd, args, {
		cwd,
		env,
		encoding: "utf8",
		stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
	});
}

function sha256File(filePath) {
	return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function verifyLumberJackArchive(archivePath, env) {
	run(
		"gcc",
		[
			"-std=c11",
			"-Wall",
			"-Wextra",
			"-Werror",
			"-fsyntax-only",
			"-I",
			path.join(LJ_SRC, "ffi"),
			"-I",
			LJ_OUT,
			path.join(LJ_SRC, "ffi", "ctest", "header_agreement.c"),
		],
		env,
	);
	const nmOut = run("nm", ["-g", "--defined-only", archivePath], env, REPO_ROOT, true);
	if (nmOut.includes("ic_lj__panic_for_test")) {
		throw new Error("Shipped liblumberjack.a unexpectedly contains ic_lj__panic_for_test");
	}
	const exportsFound = nmOut
		.split(/\r?\n/)
		.map((line) => line.trim().split(/\s+/))
		.filter((parts) => parts[1] === "T" && parts[2]?.startsWith("ic_lj_"))
		.map((parts) => parts[2])
		.sort();
	const unique = [...new Set(exportsFound)];
	if (JSON.stringify(unique) !== JSON.stringify(EXPECTED_LJ_EXPORTS)) {
		throw new Error(`LumberJack export mismatch: got ${unique.join(", ")}`);
	}
}

function buildLumberJack(env) {
	fs.mkdirSync(LJ_OUT, { recursive: true, mode: 0o755 });
	const archivePath = path.join(LJ_OUT, "liblumberjack.a");
	console.log("[substrate] Building LumberJack C-ABI v2 archive...");
	run("go", ["build", "-C", LJ_SRC, "-buildmode=c-archive", "-trimpath", "-o", archivePath, "./ffi"], env);
	fs.copyFileSync(path.join(LJ_SRC, "ffi", "lumberjack.h"), path.join(LJ_OUT, "lumberjack.h"));
	verifyLumberJackArchive(archivePath, env);
	return {
		commit: run("git", ["-C", LJ_SRC, "rev-parse", "HEAD"], env, REPO_ROOT, true).trim(),
		archiveSha256: sha256File(archivePath),
		headerSha256: sha256File(path.join(LJ_OUT, "lumberjack.h")),
	};
}

function buildMfnRust(env, cargoTarget) {
	const args = [
		"build",
		"--release",
		"--locked",
		"--manifest-path",
		path.join(MFN_SRC, "Cargo.toml"),
		"--target-dir",
		cargoTarget,
	];
	for (const [pkg, bin] of RUST_TARGETS) {
		args.push("-p", pkg, "--bin", bin);
	}
	run("cargo", args, env);
	for (const [, srcBin, dstBin] of RUST_TARGETS) {
		const dst = path.join(MFN_BIN, dstBin);
		fs.copyFileSync(path.join(cargoTarget, "release", srcBin), dst);
		fs.chmodSync(dst, 0o755);
	}
}

function buildMfnGoAndZig(env) {
	const almDst = path.join(MFN_BIN, "alm");
	run("go", ["build", "-C", path.join(MFN_SRC, "layer3-go-alm"), "-mod=readonly", "-trimpath", "-o", almDst, "."], env);
	fs.chmodSync(almDst, 0o755);
	const zigPrefix = path.join(CACHE_DIR, "zig-prefix");
	run(
		"zig",
		[
			"build",
			"--cache-dir",
			path.join(CACHE_DIR, "zig-local"),
			"--global-cache-dir",
			path.join(CACHE_DIR, "zig-global"),
			"-Doptimize=ReleaseSafe",
			"--prefix",
			zigPrefix,
		],
		env,
		path.join(MFN_SRC, "layer1-zig-ifr"),
	);
	const ifrDst = path.join(MFN_BIN, "ifr");
	fs.copyFileSync(path.join(zigPrefix, "bin", "ifr_socket_server"), ifrDst);
	fs.chmodSync(ifrDst, 0o755);
}

function verifyMfnBinaries(env) {
	const hashes = {};
	for (const name of ["ifr", "dsr", "alm", "cpe", "psr", "mfn-gateway"]) {
		const binPath = path.join(MFN_BIN, name);
		const lddOut = run("ldd", [binPath], env, REPO_ROOT, true);
		const badMatch = BLOCKED_LIB_RE.exec(lddOut);
		if (badMatch) {
			throw new Error(`Forbidden GPU library ${badMatch[0]} linked into ${binPath}`);
		}
		hashes[name] = sha256File(binPath);
	}
	return hashes;
}

function assertSubmodulesClean(env) {
	for (const subPath of [LJ_SRC, MFN_SRC]) {
		const dirty = run("git", ["-C", subPath, "status", "--porcelain"], env, REPO_ROOT, true).trim();
		if (dirty) {
			throw new Error(`Submodule working tree became dirty during build (${subPath}):\n${dirty}`);
		}
	}
}

function main() {
	fs.mkdirSync(SCRATCH_TMP, { recursive: true, mode: 0o700 });
	fs.mkdirSync(CACHE_DIR, { recursive: true, mode: 0o755 });
	fs.mkdirSync(MFN_BIN, { recursive: true, mode: 0o755 });
	const env = createBuildEnv();
	try {
		const ljInfo = buildLumberJack(env);
		console.log("[substrate] Building MFN 2.0 native CPU owners...");
		buildMfnRust(env, path.join(CACHE_DIR, "cargo-target"));
		buildMfnGoAndZig(env);
		const mfnHashes = verifyMfnBinaries(env);
		assertSubmodulesClean(env);
		const mfnCommit = run("git", ["-C", MFN_SRC, "rev-parse", "HEAD"], env, REPO_ROOT, true).trim();
		const mfnInfo = { commit: mfnCommit, binaries: mfnHashes };
		const manifest = {
			builtAt: new Date().toISOString(),
			computeBackend: "cpu",
			lumberjack: ljInfo,
			mfn: mfnInfo,
		};
		const manifestPath = path.join(BUILD_ROOT, "substrate-manifest.json");
		fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });
		console.log(`[substrate] Built cleanly -> ${manifestPath}`);
	} finally {
		fs.rmSync(SCRATCH_TMP, { recursive: true, force: true });
	}
}

main();
