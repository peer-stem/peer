import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
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
const REQUIRE_SUBSTRATE = process.env.PEER_REQUIRE_SUBSTRATE === "1";
const MANIFEST_PATH = path.join(BUILD_ROOT, "substrate-manifest.json");
const HAS_MANIFEST = fs.existsSync(MANIFEST_PATH);

const EXPECTED_SUBMODULES: ReadonlyArray<readonly [string, string]> = [
	["extern/cloudcanvas", "69076f7989dde91b6d84d50c826a3eab081c197c"],
	["extern/cloudcanvas-lib", "d5a5fa1496f7b52de108aad0262692698be7baa9"],
	["extern/lumberjack", "f4e80554f1aa88e1612639f1b3c380ec24e56588"],
	["extern/mfn", "489ca2f0abad00e687908a66177fc4156738eac7"],
];

const MFN_BINARY_NAMES = ["ifr", "dsr", "alm", "cpe", "psr", "mfn-gateway"] as const;

function sha256File(filePath: string): string {
	return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
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
