export type ComputeBackend = "cpu" | "vulkan";

export const FORBIDDEN_GPU_ENV_PREFIXES = [
	"CUDA_",
	"NVIDIA_",
	"NVCC_",
	"NCCL_",
	"ROCR_",
	"ROCM_",
	"HIP_",
	"HSA_",
	"MIOPEN_",
] as const;

export const FORBIDDEN_GPU_ENV_KEYS = new Set([
	"GPU_DEVICE_ORDINAL",
	"GPU_MAX_HEAP_SIZE",
	"GPU_MAX_ALLOC_PERCENT",
	"GPU_SINGLE_ALLOC_PERCENT",
	"AMD_LOG_LEVEL",
	"AMD_SERIALIZE_KERNEL",
	"AMD_SERIALIZE_COPY",
]);

export const FORBIDDEN_GPU_LIBRARY_PATTERN =
	/\b(libcuda|libcudart|libcublas|libcurand|libcufft|libcusparse|libcusolver|libcudnn|libnvrtc|libnccl|libamdhip64|libhsa-runtime64|librocblas|libhipblas|libmiopen|librocm)[\w.-]*\.so\b/i;

const REJECTED_BACKEND_TOKENS = new Set([
	"cuda",
	"nvidia",
	"rocm",
	"hip",
	"amd",
	"opencl",
	"sycl",
	"metal",
	"auto",
]);

export function resolveComputeBackend(raw?: string | null): ComputeBackend {
	const normalized = raw?.trim().toLowerCase() ?? "";
	if (normalized === "" || normalized === "cpu" || normalized === "cpu-only") {
		return "cpu";
	}
	if (normalized === "vulkan" || normalized === "nova" || normalized === "nova-vulkan") {
		return "vulkan";
	}
	const detail = REJECTED_BACKEND_TOKENS.has(normalized)
		? `"${normalized}" is hardware-blocked (CUDA and ROCm crash this host)`
		: `unsupported backend "${raw}"`;
	throw new Error(
		`Invalid compute backend: ${detail}. Allowed values: "cpu" or "vulkan" (Nova/Vulkan).`,
	);
}

export function isForbiddenGpuEnvKey(key: string): boolean {
	const upper = key.toUpperCase();
	if (FORBIDDEN_GPU_ENV_KEYS.has(upper)) {
		return true;
	}
	for (const prefix of FORBIDDEN_GPU_ENV_PREFIXES) {
		if (upper.startsWith(prefix)) {
			return true;
		}
	}
	return false;
}

export function sanitizeComputeEnv(
	sourceEnv: NodeJS.ProcessEnv = process.env,
	backend: ComputeBackend = "cpu",
): NodeJS.ProcessEnv {
	const resolved = resolveComputeBackend(backend);
	const clean: NodeJS.ProcessEnv = { NODE_ENV: sourceEnv.NODE_ENV ?? "production" };
	for (const [key, value] of Object.entries(sourceEnv)) {
		if (key === "NODE_ENV" || typeof value !== "string" || isForbiddenGpuEnvKey(key)) {
			continue;
		}
		clean[key] = value;
	}
	clean.PEER_COMPUTE_BACKEND = resolved;
	clean.CUDA_VISIBLE_DEVICES = "";
	clean.ROCR_VISIBLE_DEVICES = "";
	clean.HIP_VISIBLE_DEVICES = "";
	clean.NVIDIA_VISIBLE_DEVICES = "none";
	if (resolved === "vulkan") {
		clean.OLLAMA_LLM_LIBRARY = "vulkan";
		clean.OLLAMA_VULKAN = "1";
		delete clean.GGML_VK_VISIBLE_DEVICES;
	} else {
		clean.OLLAMA_LLM_LIBRARY = "cpu";
		delete clean.OLLAMA_VULKAN;
		clean.GGML_VK_VISIBLE_DEVICES = "";
	}
	return clean;
}

export function findForbiddenGpuLibraries(lddOutput: string): string[] {
	const matches = new Set<string>();
	for (const rawLine of lddOutput.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line) {
			continue;
		}
		const match = FORBIDDEN_GPU_LIBRARY_PATTERN.exec(line);
		if (match?.[0]) {
			matches.add(match[0]);
		}
	}
	return [...matches].sort();
}

export function assertNoForbiddenGpuLibraries(binaryLabel: string, lddOutput: string): void {
	const found = findForbiddenGpuLibraries(lddOutput);
	if (found.length > 0) {
		throw new Error(
			`Forbidden CUDA/ROCm shared libraries linked into ${binaryLabel}: ${found.join(", ")}`,
		);
	}
}
