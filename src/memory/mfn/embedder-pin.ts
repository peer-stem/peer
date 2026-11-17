import fs from "node:fs";
import path from "node:path";

export interface EmbedderPinEntry {
	space_id: string;
	endpoint: string;
	model: string;
	model_digest: string;
	dimensions: number;
	document_prompt: string;
	query_prompt: string;
	max_input_bytes: number;
	timeout_ms: number;
	batch: number;
	keep_alive: string;
}

export interface EmbedderPinEntryInput {
	space_id: string;
	endpoint: string;
	model: string;
	model_digest: string;
	dimensions: number;
	document_prompt?: string;
	query_prompt?: string;
	max_input_bytes?: number;
	timeout_ms?: number;
	batch?: number;
	keep_alive?: string;
}

export interface EmbeddersPinFile {
	format_version: 1;
	embedders: EmbedderPinEntry[];
}

export interface LoopbackEndpoint {
	host: string;
	port: number;
	normalized: string;
}

const HEX_64_LOWER = /^[0-9a-f]{64}$/;
const KEEP_ALIVE_RE = /^[A-Za-z0-9.-]{1,32}$/;
const PORT_DECIMAL_RE = /^[1-9][0-9]{0,4}$/;
const OCTET_DECIMAL_RE = /^(?:0|[1-9][0-9]{0,2})$/;
const CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/;
const MAX_PIN_FILE_BYTES = 262_144;

function isLoopbackIpv4(host: string): boolean {
	const parts = host.split(".");
	if (parts.length !== 4) {
		return false;
	}
	const nums: number[] = [];
	for (const part of parts) {
		if (!OCTET_DECIMAL_RE.test(part)) {
			return false;
		}
		const val = Number(part);
		if (val < 0 || val > 255) {
			return false;
		}
		nums.push(val);
	}
	return nums[0] === 127;
}

export function parseLoopbackEndpoint(endpoint: string): LoopbackEndpoint {
	if (!endpoint.startsWith("http://")) {
		throw new Error("Embedder endpoint must start with lowercase http://");
	}
	const rest = endpoint.slice("http://".length);
	if (!rest || /[/?#@\s]/.test(rest) || CONTROL_CHAR_RE.test(rest)) {
		throw new Error("Embedder endpoint must not contain userinfo, path, query, fragment, or whitespace");
	}
	const colonIdx = rest.lastIndexOf(":");
	if (colonIdx <= 0) {
		throw new Error("Embedder endpoint must include an explicit port");
	}
	const hostPart = rest.slice(0, colonIdx);
	const portPart = rest.slice(colonIdx + 1);
	if (!PORT_DECIMAL_RE.test(portPart)) {
		throw new Error("Embedder endpoint port must be 1..65535");
	}
	const port = Number(portPart);
	if (port < 1 || port > 65535) {
		throw new Error("Embedder endpoint port must be 1..65535");
	}
	if (hostPart === "[::1]") {
		return { host: "::1", port, normalized: endpoint };
	}
	if (isLoopbackIpv4(hostPart)) {
		return { host: hostPart, port, normalized: endpoint };
	}
	throw new Error("Embedder endpoint host must be a loopback IP literal (127.0.0.0/8 or [::1])");
}

export function validateEmbedderEndpoint(endpoint: string): string {
	return parseLoopbackEndpoint(endpoint).normalized;
}

function assertBoundedCleanText(value: string, label: string, minBytes: number, maxBytes: number): void {
	if (CONTROL_CHAR_RE.test(value)) {
		throw new Error(`${label} must not contain control characters`);
	}
	const bytes = Buffer.byteLength(value, "utf8");
	if (bytes < minBytes || bytes > maxBytes) {
		throw new Error(`${label} must be ${minBytes}..${maxBytes} UTF-8 bytes`);
	}
}

function assertIntInRange(value: number, label: string, min: number, max: number): void {
	if (!Number.isSafeInteger(value) || value < min || value > max) {
		throw new Error(`${label} must be an integer in ${min}..${max}`);
	}
}

function normalizePinEntry(raw: EmbedderPinEntryInput): EmbedderPinEntry {
	assertBoundedCleanText(raw.space_id, "space_id", 1, 128);
	const endpoint = validateEmbedderEndpoint(raw.endpoint);
	assertBoundedCleanText(raw.model, "model", 1, 256);
	if (!HEX_64_LOWER.test(raw.model_digest)) {
		throw new Error("model_digest must be exactly 64 lowercase hex digits");
	}
	assertIntInRange(raw.dimensions, "dimensions", 1, 8192);
	const maxInput = raw.max_input_bytes ?? 8192;
	assertIntInRange(maxInput, "max_input_bytes", 1, 65536);
	const docPrompt = raw.document_prompt ?? (maxInput > 17 ? "search_document: " : "");
	const queryPrompt = raw.query_prompt ?? (maxInput > 14 ? "search_query: " : "");
	assertBoundedCleanText(docPrompt, "document_prompt", 0, Math.min(1024, maxInput - 1));
	assertBoundedCleanText(queryPrompt, "query_prompt", 0, Math.min(1024, maxInput - 1));
	const timeoutMs = raw.timeout_ms ?? 2000;
	assertIntInRange(timeoutMs, "timeout_ms", 1, 60000);
	const batch = raw.batch ?? 16;
	assertIntInRange(batch, "batch", 1, 64);
	const keepAlive = raw.keep_alive ?? "24h";
	if (!KEEP_ALIVE_RE.test(keepAlive)) {
		throw new Error("keep_alive must match /^[A-Za-z0-9.-]{1,32}$/");
	}
	return {
		space_id: raw.space_id,
		endpoint,
		model: raw.model,
		model_digest: raw.model_digest,
		dimensions: raw.dimensions,
		document_prompt: docPrompt,
		query_prompt: queryPrompt,
		max_input_bytes: maxInput,
		timeout_ms: timeoutMs,
		batch,
		keep_alive: keepAlive,
	};
}

export async function probeOllamaModelDigest(
	endpoint: string,
	model: string,
	fetchImpl: typeof fetch = fetch,
	expectedDigest?: string,
): Promise<string> {
	const cleanEndpoint = validateEmbedderEndpoint(endpoint);
	assertBoundedCleanText(model, "model", 1, 256);
	if (expectedDigest !== undefined && !HEX_64_LOWER.test(expectedDigest)) {
		throw new Error("expectedDigest must be 64 lowercase hex digits");
	}
	const res = await fetchImpl(`${cleanEndpoint}/api/tags`, {
		method: "GET",
		redirect: "error",
		headers: { Accept: "application/json" },
	});
	if (!res.ok) {
		throw new Error(`Ollama /api/tags failed with HTTP ${res.status}`);
	}
	const body = (await res.json()) as { models?: Array<{ name?: unknown; model?: unknown; digest?: unknown }> };
	if (!Array.isArray(body.models)) {
		throw new Error("Malformed Ollama /api/tags response: missing models array");
	}
	const matching = body.models.filter((item) => item?.name === model || item?.model === model);
	if (matching.length === 0) {
		throw new Error(`Pinned Ollama model "${model}" is not installed`);
	}
	const firstDigest = matching[0]?.digest;
	if (typeof firstDigest !== "string" || !HEX_64_LOWER.test(firstDigest)) {
		throw new Error(`Invalid Ollama digest for "${model}"`);
	}
	for (const entry of matching) {
		if (entry.digest !== firstDigest) {
			throw new Error(`Conflicting Ollama digests reported for "${model}"`);
		}
	}
	if (expectedDigest !== undefined && firstDigest !== expectedDigest) {
		throw new Error(`Ollama model digest mismatch for "${model}": expected ${expectedDigest}, got ${firstDigest}`);
	}
	return firstDigest;
}

export function buildEmbeddersConfig(
	opts:
		| EmbedderPinEntryInput
		| readonly EmbedderPinEntryInput[]
		| { embedders: readonly EmbedderPinEntryInput[] },
): EmbeddersPinFile {
	const list = Array.isArray(opts)
		? opts
		: "embedders" in opts
			? opts.embedders
			: [opts as EmbedderPinEntryInput];
	if (list.length > 64) {
		throw new Error("Embedders config accepts at most 64 entries");
	}
	const seenSpaces = new Set<string>();
	const embedders: EmbedderPinEntry[] = [];
	for (const raw of list) {
		const normalized = normalizePinEntry(raw);
		if (seenSpaces.has(normalized.space_id)) {
			throw new Error(`Duplicate embedder space_id: ${normalized.space_id}`);
		}
		seenSpaces.add(normalized.space_id);
		embedders.push(normalized);
	}
	return { format_version: 1, embedders };
}

export function writePrivateFile0600(filePath: string, content: string): void {
	if (!path.isAbsolute(filePath) || filePath.split(path.sep).includes("..")) {
		throw new Error(`Private file path must be clean and absolute: ${filePath}`);
	}
	const parentDir = path.dirname(filePath);
	fs.mkdirSync(parentDir, { recursive: true, mode: 0o700 });
	const parentStat = fs.lstatSync(parentDir);
	if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
		throw new Error(`Private parent path must be a real directory: ${parentDir}`);
	}
	fs.chmodSync(parentDir, 0o700);
	const flags =
		fs.constants.O_WRONLY |
		fs.constants.O_CREAT |
		fs.constants.O_TRUNC |
		fs.constants.O_NOFOLLOW;
	const fd = fs.openSync(filePath, flags, 0o600);
	try {
		const stat = fs.fstatSync(fd);
		if (!stat.isFile() || stat.nlink !== 1) {
			throw new Error(`Private file must be a single-link regular file: ${filePath}`);
		}
		fs.fchmodSync(fd, 0o600);
		fs.writeFileSync(fd, content, "utf8");
		fs.fsyncSync(fd);
	} finally {
		fs.closeSync(fd);
	}
}

export function writeEmbeddersPinFile(
	filePath: string,
	entries: readonly EmbedderPinEntryInput[] | EmbeddersPinFile,
): EmbeddersPinFile {
	const config = "embedders" in entries
		? buildEmbeddersConfig({ embedders: entries.embedders })
		: buildEmbeddersConfig(entries);
	const serialized = `${JSON.stringify(config)}\n`;
	if (Buffer.byteLength(serialized, "utf8") > MAX_PIN_FILE_BYTES) {
		throw new Error("Embedders pin file exceeds 256 KiB cap");
	}
	writePrivateFile0600(filePath, serialized);
	return config;
}
