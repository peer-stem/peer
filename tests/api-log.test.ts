import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { LogLevel } from "../src/api/config.ts";
import { createLogger } from "../src/api/log.ts";

interface ParsedLogRecord {
	timestamp: string;
	level: string;
	message: string;
	fields?: Record<string, unknown>;
	truncated?: boolean;
	originalBytes?: number;
}

class ControlledStream extends EventEmitter {
	readonly chunks: string[] = [];
	writable = true;
	destroyed = false;
	writableEnded = false;
	private pauseWrites = false;
	private pauseCountdown: number | null = null;

	setBackpressure(active: boolean): void {
		this.pauseWrites = active;
		this.pauseCountdown = null;
	}

	pauseEvery(writesBeforeFalse: number): void {
		this.pauseCountdown = writesBeforeFalse;
	}

	write(chunk: Uint8Array | string): boolean {
		const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
		this.chunks.push(text);
		if (this.pauseCountdown !== null) {
			this.pauseCountdown -= 1;
			if (this.pauseCountdown <= 0) return false;
			return true;
		}
		return !this.pauseWrites;
	}

	records(): ParsedLogRecord[] {
		return this.chunks.map((raw) => {
			assert.equal(raw.endsWith("\n"), true, "every log record must end with newline");
			assert.equal(raw.slice(0, -1).includes("\n"), false, "every log record must be single-line");
			return JSON.parse(raw) as ParsedLogRecord;
		});
	}
}

function runAllLevels(level: LogLevel): string[] {
	const stream = new ControlledStream();
	const logger = createLogger({ level, stream: stream as unknown as NodeJS.WritableStream });
	logger.debug("d-msg");
	logger.info("i-msg");
	logger.warn("w-msg");
	logger.error("e-msg");
	return stream.records().map((entry) => entry.level);
}

test("createLogger filters entries across all 5 log levels", () => {
	assert.deepEqual(runAllLevels("debug"), ["debug", "info", "warn", "error"]);
	assert.deepEqual(runAllLevels("info"), ["info", "warn", "error"]);
	assert.deepEqual(runAllLevels("warn"), ["warn", "error"]);
	assert.deepEqual(runAllLevels("error"), ["error"]);
	assert.deepEqual(runAllLevels("silent"), []);
});

test("createLogger serializes metadata, Error with cause, BigInt, and circular refs safely", () => {
	const stream = new ControlledStream();
	const logger = createLogger({ level: "debug", stream: stream as unknown as NodeJS.WritableStream });
	const rootCause = new Error("disk full");
	const topError = Object.assign(new Error("write failed", { cause: rootCause }), { code: "ENOSPC" });
	const shared = { tag: "reused" };
	const circular: Record<string, unknown> = { count: 9007199254740993n, first: shared, second: shared };
	circular.self = circular;

	logger.error("operation failed", { err: topError, meta: circular });

	const records = stream.records();
	assert.equal(records.length, 1);
	const record = records[0]!;
	assert.equal(record.level, "error");
	assert.equal(record.message, "operation failed");
	assert.equal(Number.isNaN(Date.parse(record.timestamp)), false);
	const errField = record.fields?.err as Record<string, unknown>;
	assert.equal(errField.name, "Error");
	assert.equal(errField.message, "write failed");
	assert.equal(errField.code, "ENOSPC");
	assert.equal((errField.cause as Record<string, unknown>).message, "disk full");
	const metaField = record.fields?.meta as Record<string, unknown>;
	assert.equal(metaField.count, "9007199254740993");
	assert.equal(metaField.self, "[Circular]");
	assert.deepEqual(metaField.first, { tag: "reused" });
	assert.deepEqual(metaField.second, { tag: "reused" });
});

test("createLogger never throws when fields contain throwing getters or toJSON", () => {
	const stream = new ControlledStream();
	const logger = createLogger({ level: "info", stream: stream as unknown as NodeJS.WritableStream });
	const hostile: Record<string, unknown> = {
		ok: "yes",
		toJSON() {
			throw new Error("toJSON trap");
		},
	};
	Object.defineProperty(hostile, "explosive", {
		enumerable: true,
		get() {
			throw new Error("getter trap");
		},
	});

	assert.doesNotThrow(() => {
		logger.info("hostile payload", { hostile });
	});
	const records = stream.records();
	assert.equal(records.length, 1);
	const serialized = records[0]?.fields?.hostile as Record<string, unknown>;
	assert.equal(serialized.ok, "yes");
	assert.equal(serialized.explosive, "[Unserializable]");
});

test("createLogger queues under backpressure, drains on drain event, and resolves flush()", async () => {
	const stream = new ControlledStream();
	stream.setBackpressure(true);
	const logger = createLogger({ level: "info", stream: stream as unknown as NodeJS.WritableStream });

	logger.info("first");
	logger.info("second");
	logger.info("third");
	assert.equal(stream.chunks.length, 1, "only first write hits stream before drain");

	let flushed = false;
	const pendingFlush = logger.flush().then(() => {
		flushed = true;
	});
	await Promise.resolve();
	assert.equal(flushed, false, "flush waits while stream is backpressured");

	stream.pauseEvery(1);
	stream.emit("drain");
	assert.equal(stream.chunks.length, 2, "re-enters backpressure if drain write returns false");
	assert.equal(flushed, false);

	stream.setBackpressure(false);
	stream.emit("drain");
	await pendingFlush;
	assert.equal(flushed, true);
	assert.deepEqual(
		stream.records().map((r) => r.message),
		["first", "second", "third"],
	);
});

test("createLogger bounds queued lines and emits a single overflow notice upon drain", async () => {
	const stream = new ControlledStream();
	stream.setBackpressure(true);
	const logger = createLogger({
		level: "info",
		stream: stream as unknown as NodeJS.WritableStream,
		maxBufferedLines: 2,
	});

	logger.info("line-1");
	logger.info("line-2");
	logger.info("line-3");
	logger.info("line-4");
	logger.info("line-5");
	logger.info("line-6");
	assert.equal(stream.chunks.length, 1);

	stream.setBackpressure(false);
	stream.emit("drain");
	await logger.flush();

	const records = stream.records();
	assert.equal(records.length, 4);
	assert.deepEqual(
		records.slice(0, 3).map((r) => r.message),
		["line-1", "line-2", "line-3"],
	);
	const overflow = records[3]!;
	assert.equal(overflow.level, "warn");
	assert.equal(overflow.fields?.dropped, 3);

	logger.info("after-drain");
	assert.equal(stream.records().length, 5);
});

test("createLogger survives EPIPE stream errors without throwing, hanging flush, or leaking listeners", async () => {
	const stream = new ControlledStream();
	const initialErrListeners = process.stderr.listenerCount("error");
	createLogger({ level: "info" });
	createLogger({ level: "warn" });
	assert.equal(process.stderr.listenerCount("error") - initialErrListeners <= 1, true);

	stream.setBackpressure(true);
	const logger = createLogger({ level: "info", stream: stream as unknown as NodeJS.WritableStream });
	logger.info("before-epipe");
	logger.info("queued-before-epipe");
	const flushPromise = logger.flush();

	const epipe = Object.assign(new Error("broken pipe"), { code: "EPIPE" });
	assert.doesNotThrow(() => {
		stream.emit("error", epipe);
	});
	await flushPromise;
	assert.equal(stream.listenerCount("drain"), 0, "temporary drain listener cleaned up on error");
});

test("createLogger summarizes typed arrays and caps nesting depth and oversized lines", () => {
	const stream = new ControlledStream();
	const logger = createLogger({ level: "info", stream: stream as unknown as NodeJS.WritableStream });
	const bigBuffer = Buffer.alloc(1024 * 1024, 0x41);
	const view = new Uint16Array(16);
	const rawAb = new ArrayBuffer(64);
	const deep = { l1: { l2: { l3: { l4: { secret: "too-deep" } } } } };

	logger.error("binary-and-depth", {
		buf: bigBuffer,
		typed: view,
		ab: rawAb,
		deep,
		longText: "x".repeat(6000),
	});

	const wide: Record<string, string> = {};
	for (let i = 0; i < 10; i++) wide[`k${i}`] = "y".repeat(3500);
	logger.warn("oversized-line", wide);

	const records = stream.records();
	assert.equal(records.length, 2);
	const firstFields = records[0]!.fields!;
	assert.equal(firstFields.buf, "[Buffer 1048576 bytes]");
	assert.equal(firstFields.typed, "[Uint16Array 32 bytes]");
	assert.equal(firstFields.ab, "[ArrayBuffer 64 bytes]");
	const l2 = ((firstFields.deep as Record<string, unknown>).l1 as Record<string, unknown>).l2 as Record<string, unknown>;
	assert.equal(l2.l3, "[MaxDepth]");
	assert.match(String(firstFields.longText), /\.\.\.\[truncated 1904 chars\]$/);

	const second = records[1]!;
	assert.equal(second.truncated, true);
	assert.ok((second.originalBytes ?? 0) > 16384);
	assert.ok(Buffer.byteLength(stream.chunks[1]!, "utf8") <= 16384);
});
