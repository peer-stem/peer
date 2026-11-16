import { createHash, randomBytes } from "node:crypto";

export const UUID_V7_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export const MAX_CALLER_MEMORY_ID = (1n << 62n) - 1n;

const CALLER_MEMORY_ID_PREFIX = "peer-mfn-id-v1\0";
const POSITIVE_DECIMAL_PATTERN = /^[1-9][0-9]{0,19}$/;

export function isUuidV7(value: string): boolean {
	return UUID_V7_PATTERN.test(value);
}

export function isValidCallerMemoryId(value: string): boolean {
	if (!POSITIVE_DECIMAL_PATTERN.test(value)) {
		return false;
	}
	const parsed = BigInt(value);
	return parsed >= 1n && parsed <= MAX_CALLER_MEMORY_ID;
}

export function mintUuidV7(nowMs: number = Date.now()): string {
	if (!Number.isFinite(nowMs) || nowMs < 0) {
		throw new RangeError(`Invalid UUIDv7 timestamp: ${nowMs}`);
	}
	const ts = BigInt(Math.floor(nowMs)) & 0xffffffffffffn;
	const bytes = Buffer.alloc(16);
	bytes[0] = Number((ts >> 40n) & 0xffn);
	bytes[1] = Number((ts >> 32n) & 0xffn);
	bytes[2] = Number((ts >> 24n) & 0xffn);
	bytes[3] = Number((ts >> 16n) & 0xffn);
	bytes[4] = Number((ts >> 8n) & 0xffn);
	bytes[5] = Number(ts & 0xffn);
	randomBytes(10).copy(bytes, 6);
	bytes[6] = (bytes[6]! & 0x0f) | 0x70;
	bytes[8] = (bytes[8]! & 0x3f) | 0x80;
	const hex = bytes.toString("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export function memoryIdFromKey(key: string): string {
	const digest = createHash("sha256")
		.update(CALLER_MEMORY_ID_PREFIX, "utf8")
		.update(key, "utf8")
		.digest();
	const raw = digest.readBigUInt64BE(0);
	const masked = (raw & MAX_CALLER_MEMORY_ID) || 1n;
	return masked.toString(10);
}

export function messageMemoryId(chatId: string, messageId: string): string {
	return memoryIdFromKey(`${chatId}:${messageId}`);
}
