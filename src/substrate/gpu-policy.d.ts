export declare const FORBIDDEN_GPU_ENV_PREFIXES: readonly [
	"CUDA_",
	"NVIDIA_",
	"NVCC_",
	"NCCL_",
	"ROCR_",
	"ROCM_",
	"HIP_",
	"HSA_",
	"MIOPEN_",
	"GPU_",
	"AMD_",
];

export declare const FORBIDDEN_GPU_LIBRARY_PATTERN: RegExp;

export declare function isForbiddenGpuEnvKey(key: string): boolean;
