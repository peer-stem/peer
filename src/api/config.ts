export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

export interface ApiConfig {
	hostname: string;
	port: number;
	logLevel: LogLevel;
}

const PORT_ERROR_MESSAGE = "PORT is required and must be an integer between 1 and 65535";
const VALID_LOG_LEVELS: ReadonlySet<string> = new Set(["debug", "info", "warn", "error", "silent"]);
const OCTET_DECIMAL_RE = /^(?:0|[1-9][0-9]{0,2})$/;

function isLoopbackIpv4(host: string): boolean {
	const parts = host.split(".");
	if (parts.length !== 4) return false;
	const nums: number[] = [];
	for (const part of parts) {
		if (!OCTET_DECIMAL_RE.test(part)) return false;
		const val = Number(part);
		if (val < 0 || val > 255) return false;
		nums.push(val);
	}
	return nums[0] === 127;
}

function parsePort(raw: string | undefined): number {
	if (raw === undefined || !/^\d+$/.test(raw)) {
		throw new Error(PORT_ERROR_MESSAGE);
	}
	const port = Number(raw);
	if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
		throw new Error(PORT_ERROR_MESSAGE);
	}
	return port;
}

function parseHostname(raw: string | undefined): string {
	const trimmed = raw?.trim();
	if (!trimmed) return "127.0.0.1";
	const lower = trimmed.toLowerCase();
	if (lower === "localhost") return "localhost";
	if (lower === "::1" || lower === "[::1]") return "::1";
	if (isLoopbackIpv4(trimmed)) return trimmed;
	throw new Error(`HOSTNAME must be a loopback address (127.0.0.0/8, ::1, or localhost); received "${trimmed}"`);
}

function parseLogLevel(raw: string | undefined): LogLevel {
	const trimmed = raw?.trim();
	if (!trimmed) return "info";
	const normalized = trimmed.toLowerCase();
	if (VALID_LOG_LEVELS.has(normalized)) {
		return normalized as LogLevel;
	}
	throw new Error(`LH_LOG_LEVEL must be one of debug, info, warn, error, silent (received "${trimmed}")`);
}

export function readApiConfig(env: Record<string, string | undefined> = process.env): ApiConfig {
	return {
		port: parsePort(env.PORT),
		hostname: parseHostname(env.HOSTNAME),
		logLevel: parseLogLevel(env.LH_LOG_LEVEL),
	};
}
