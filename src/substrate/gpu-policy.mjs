export const FORBIDDEN_GPU_ENV_PREFIXES = Object.freeze([
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
]);

export const FORBIDDEN_GPU_LIBRARY_PATTERN =
	/\b(libcuda|libcudart|libcublas|libcurand|libcufft|libcusparse|libcusolver|libcudnn|libnvrtc|libnccl|libamdhip64|libhsa-runtime64|librocblas|libhipblas|libmiopen|librocm)[\w.-]*\.so\b/i;

export function isForbiddenGpuEnvKey(key) {
	const upper = String(key).toUpperCase();
	for (const prefix of FORBIDDEN_GPU_ENV_PREFIXES) {
		if (upper.startsWith(prefix)) {
			return true;
		}
	}
	return false;
}
