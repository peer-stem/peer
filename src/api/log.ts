import type { LogLevel } from "./config.ts";

export interface Logger {
	debug(message: string, fields?: Record<string, unknown>): void;
	info(message: string, fields?: Record<string, unknown>): void;
	warn(message: string, fields?: Record<string, unknown>): void;
	error(message: string, fields?: Record<string, unknown>): void;
	flush(): Promise<void>;
}

export interface LoggerOptions {
	level: LogLevel;
	stream?: NodeJS.WritableStream;
	maxBufferedLines?: number;
}

type ActiveLogLevel = Exclude<LogLevel, "silent">;

interface SinkState {
	stream: NodeJS.WritableStream;
	maxBufferedLines: number;
	queue: string[];
	droppedCount: number;
	backpressured: boolean;
	flushResolvers: Array<() => void>;
}

const DEFAULT_MAX_BUFFERED_LINES = 1024;
const MAX_SANITIZE_DEPTH = 4;
const MAX_STRING_CHARS = 4096;
const MAX_COLLECTION_ITEMS = 64;
const MAX_LOG_LINE_BYTES = 16384;
const LEVEL_RANK: Record<LogLevel, number> = {
	debug: 10,
	info: 20,
	warn: 30,
	error: 40,
	silent: 50,
};
const guardedStreams = new WeakSet<NodeJS.WritableStream>();

function guardStreamErrors(stream: NodeJS.WritableStream): void {
	if (guardedStreams.has(stream)) return;
	guardedStreams.add(stream);
	stream.on("error", () => {
		/* swallow broken pipe or stream errors so logging never crashes the server */
	});
}

function normalizeMaxBufferedLines(value: number | undefined): number {
	if (value === undefined) return DEFAULT_MAX_BUFFERED_LINES;
	if (!Number.isFinite(value) || value < 0) return 0;
	return Math.trunc(value);
}

function truncateString(value: string, limit = MAX_STRING_CHARS): string {
	if (value.length <= limit) return value;
	return `${value.slice(0, limit)}...[truncated ${value.length - limit} chars]`;
}

function safeReadProperty(
	record: Record<string, unknown>,
	key: string,
	ancestors: Set<object>,
	depth: number,
): unknown {
	try {
		return sanitizeValue(record[key], ancestors, depth);
	} catch {
		return "[Unserializable]";
	}
}

function serializeError(err: Error, ancestors: Set<object>, depth: number): Record<string, unknown> {
	const out: Record<string, unknown> = {
		name: truncateString(err.name),
		message: truncateString(err.message),
	};
	if (err.stack !== undefined) out.stack = truncateString(err.stack);
	if (err.cause !== undefined) out.cause = sanitizeValue(err.cause, ancestors, depth + 1);
	const keys = Object.keys(err);
	const limit = Math.min(keys.length, MAX_COLLECTION_ITEMS);
	for (let i = 0; i < limit; i++) {
		const key = keys[i]!;
		if (key in out) continue;
		out[key] = safeReadProperty(err as unknown as Record<string, unknown>, key, ancestors, depth + 1);
	}
	if (keys.length > MAX_COLLECTION_ITEMS) out._truncatedKeys = keys.length - MAX_COLLECTION_ITEMS;
	return out;
}

function sanitizeArray(items: unknown[], ancestors: Set<object>, depth: number): unknown[] {
	const limit = Math.min(items.length, MAX_COLLECTION_ITEMS);
	const out = items.slice(0, limit).map((item) => sanitizeValue(item, ancestors, depth + 1));
	if (items.length > MAX_COLLECTION_ITEMS) out.push(`[...${items.length - MAX_COLLECTION_ITEMS} more items]`);
	return out;
}

function sanitizeRecord(
	input: Record<string, unknown>,
	ancestors: Set<object>,
	depth: number,
): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	const keys = Object.keys(input);
	const limit = Math.min(keys.length, MAX_COLLECTION_ITEMS);
	for (let i = 0; i < limit; i++) {
		const key = keys[i]!;
		out[key] = safeReadProperty(input, key, ancestors, depth + 1);
	}
	if (keys.length > MAX_COLLECTION_ITEMS) out._truncatedKeys = keys.length - MAX_COLLECTION_ITEMS;
	return out;
}

function sanitizeObjectValue(value: object, ancestors: Set<object>, depth: number): unknown {
	if (value instanceof Date) return Number.isNaN(value.getTime()) ? "Invalid Date" : value.toISOString();
	if (ArrayBuffer.isView(value)) {
		const kind = Buffer.isBuffer(value) ? "Buffer" : (value.constructor?.name || "TypedArray");
		return `[${kind} ${value.byteLength} bytes]`;
	}
	if (value instanceof ArrayBuffer) return `[ArrayBuffer ${value.byteLength} bytes]`;
	if (depth >= MAX_SANITIZE_DEPTH) return "[MaxDepth]";
	if (ancestors.has(value)) return "[Circular]";
	ancestors.add(value);
	try {
		if (value instanceof Error) return serializeError(value, ancestors, depth);
		if (Array.isArray(value)) return sanitizeArray(value, ancestors, depth);
		return sanitizeRecord(value as Record<string, unknown>, ancestors, depth);
	} finally {
		ancestors.delete(value);
	}
}

function sanitizeValue(value: unknown, ancestors: Set<object>, depth = 0): unknown {
	if (value === null || value === undefined) return value;
	if (typeof value === "string") return truncateString(value);
	if (typeof value === "bigint") return value.toString();
	if (typeof value === "function" || typeof value === "symbol") return truncateString(String(value));
	if (typeof value !== "object") return value;
	return sanitizeObjectValue(value, ancestors, depth);
}

function formatLogLine(level: ActiveLogLevel, message: string, fields?: Record<string, unknown>): string {
	const timestamp = new Date().toISOString();
	const safeMsg = truncateString(String(message));
	try {
		const record: Record<string, unknown> = { timestamp, level, message: safeMsg };
		if (fields !== undefined) {
			record.fields = sanitizeValue(fields, new Set(), 0);
		}
		const serialized = JSON.stringify(record);
		if (Buffer.byteLength(serialized, "utf8") <= MAX_LOG_LINE_BYTES) return `${serialized}\n`;
		const capped = {
			timestamp,
			level,
			message: truncateString(String(message), 1024),
			truncated: true,
			originalBytes: Buffer.byteLength(serialized, "utf8"),
		};
		return `${JSON.stringify(capped)}\n`;
	} catch {
		return `${JSON.stringify({ timestamp, level, message: safeMsg, fieldsError: true })}\n`;
	}
}

function isStreamUnwritable(stream: NodeJS.WritableStream): boolean {
	const candidate = stream as NodeJS.WritableStream & { destroyed?: boolean; writableEnded?: boolean };
	return Boolean(candidate.destroyed || candidate.writableEnded || candidate.writable === false);
}

function writeLineToStream(state: SinkState, line: string): boolean {
	if (isStreamUnwritable(state.stream)) return true;
	let erroredSynchronously = false;
	const onSyncError = () => {
		erroredSynchronously = true;
	};
	state.stream.once("error", onSyncError);
	try {
		const accepted = state.stream.write(line);
		if (erroredSynchronously || isStreamUnwritable(state.stream)) return true;
		return accepted;
	} catch {
		return true;
	} finally {
		state.stream.removeListener("error", onSyncError);
	}
}

function resolveFlushes(state: SinkState): void {
	if (state.flushResolvers.length === 0) return;
	const resolvers = state.flushResolvers.splice(0, state.flushResolvers.length);
	for (const resolve of resolvers) {
		resolve();
	}
}

function enterBackpressure(state: SinkState): void {
	if (state.backpressured) return;
	state.backpressured = true;
	const cleanup = () => {
		state.stream.removeListener("drain", handleDrain);
		state.stream.removeListener("error", handleAbort);
		state.stream.removeListener("close", handleAbort);
	};
	const handleDrain = () => {
		cleanup();
		state.backpressured = false;
		drainQueue(state);
	};
	const handleAbort = () => {
		cleanup();
		state.backpressured = false;
		state.queue.length = 0;
		state.droppedCount = 0;
		resolveFlushes(state);
	};
	state.stream.on("drain", handleDrain);
	state.stream.on("error", handleAbort);
	state.stream.on("close", handleAbort);
}

function drainQueue(state: SinkState): void {
	while (state.queue.length > 0) {
		const next = state.queue.shift();
		if (next === undefined) break;
		if (!writeLineToStream(state, next)) {
			enterBackpressure(state);
			return;
		}
	}
	if (state.droppedCount > 0) {
		const dropped = state.droppedCount;
		state.droppedCount = 0;
		const notice = formatLogLine("warn", `Dropped ${dropped} log line(s) due to backpressure overflow`, { dropped });
		if (!writeLineToStream(state, notice)) {
			enterBackpressure(state);
			return;
		}
	}
	resolveFlushes(state);
}

function writeOrEnqueue(state: SinkState, line: string): void {
	if (!state.backpressured) {
		if (!writeLineToStream(state, line)) {
			enterBackpressure(state);
		}
		return;
	}
	if (state.queue.length < state.maxBufferedLines) {
		state.queue.push(line);
	} else {
		state.droppedCount += 1;
	}
}

function flushSink(state: SinkState): Promise<void> {
	if (!state.backpressured && state.queue.length === 0 && state.droppedCount === 0) {
		return Promise.resolve();
	}
	return new Promise<void>((resolve) => {
		state.flushResolvers.push(resolve);
	});
}

export function createLogger(options: LoggerOptions): Logger {
	const stream = options.stream ?? process.stderr;
	guardStreamErrors(stream);
	const threshold = LEVEL_RANK[options.level];
	const state: SinkState = {
		stream,
		maxBufferedLines: normalizeMaxBufferedLines(options.maxBufferedLines),
		queue: [],
		droppedCount: 0,
		backpressured: false,
		flushResolvers: [],
	};
	const emitAt = (level: ActiveLogLevel, message: string, fields?: Record<string, unknown>) => {
		if (LEVEL_RANK[level] < threshold) return;
		writeOrEnqueue(state, formatLogLine(level, message, fields));
	};
	return {
		debug: (message, fields) => emitAt("debug", message, fields),
		info: (message, fields) => emitAt("info", message, fields),
		warn: (message, fields) => emitAt("warn", message, fields),
		error: (message, fields) => emitAt("error", message, fields),
		flush: () => flushSink(state),
	};
}
