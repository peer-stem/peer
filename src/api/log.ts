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

function safeReadProperty(
	record: Record<string, unknown>,
	key: string,
	ancestors: Set<object>,
): unknown {
	try {
		return sanitizeValue(record[key], ancestors);
	} catch {
		return "[Unserializable]";
	}
}

function serializeError(err: Error, ancestors: Set<object>): Record<string, unknown> {
	const out: Record<string, unknown> = {
		name: err.name,
		message: err.message,
	};
	if (err.stack !== undefined) out.stack = err.stack;
	if (err.cause !== undefined) out.cause = sanitizeValue(err.cause, ancestors);
	for (const key of Object.keys(err)) {
		if (key in out) continue;
		out[key] = safeReadProperty(err as unknown as Record<string, unknown>, key, ancestors);
	}
	return out;
}

function sanitizeRecord(input: Record<string, unknown>, ancestors: Set<object>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const key of Object.keys(input)) {
		out[key] = safeReadProperty(input, key, ancestors);
	}
	return out;
}

function sanitizeValue(value: unknown, ancestors: Set<object>): unknown {
	if (value === null || value === undefined) return value;
	if (typeof value === "bigint") return value.toString();
	if (typeof value === "function" || typeof value === "symbol") return String(value);
	if (typeof value !== "object") return value;
	if (ancestors.has(value)) return "[Circular]";
	ancestors.add(value);
	try {
		if (value instanceof Error) return serializeError(value, ancestors);
		if (value instanceof Date) return Number.isNaN(value.getTime()) ? "Invalid Date" : value.toISOString();
		if (Array.isArray(value)) return value.map((item) => sanitizeValue(item, ancestors));
		return sanitizeRecord(value as Record<string, unknown>, ancestors);
	} finally {
		ancestors.delete(value);
	}
}

function formatLogLine(level: ActiveLogLevel, message: string, fields?: Record<string, unknown>): string {
	const timestamp = new Date().toISOString();
	try {
		const record: Record<string, unknown> = { timestamp, level, message: String(message) };
		if (fields !== undefined) {
			record.fields = sanitizeValue(fields, new Set());
		}
		return `${JSON.stringify(record)}\n`;
	} catch {
		return `${JSON.stringify({ timestamp, level, message: String(message), fieldsError: true })}\n`;
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
