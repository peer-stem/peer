import http from "node:http";
import {
	buildWireHeaders,
	normalizeRawHeaders,
	sendRawSocket,
	sendWire,
	toBodyBuffer,
	writePayloadChunks,
	type WireRequest,
	type WireResponse,
} from "./api-parity-wire-http.ts";

export {
	normalizeRawHeaders,
	sendRawSocket,
	sendWire,
	type WireRequest,
	type WireResponse,
};

export interface SseEvent {
	event: string;
	id: string;
	data: string;
}

export interface LiveStreamHandle {
	status: number;
	headers: Record<string, string>;
	headersElapsedMs: number;
	waitForBytes: (minBytes: number, timeoutMs?: number) => Promise<Buffer>;
	waitForText: (needle: string, timeoutMs?: number) => Promise<string>;
	waitForCount: (needle: string, minCount: number, timeoutMs?: number) => Promise<string>;
	readRest: (timeoutMs?: number) => Promise<{ rawBody: Buffer; prematureClose: boolean }>;
	snapshotText: () => string;
	hasEnded: () => boolean;
	abort: () => void;
}

interface StreamBufferState {
	chunks: Buffer[];
	totalBytes: number;
	ended: boolean;
	premature: boolean;
	notify: Set<() => void>;
}

function notifyWaiters(state: StreamBufferState): void {
	for (const fn of [...state.notify]) fn();
}

function waitStreamCondition(state: StreamBufferState, pred: () => boolean, timeoutMs = 15_000): Promise<void> {
	if (pred()) return Promise.resolve();
	if (state.ended) return Promise.reject(new Error("Stream ended before condition was met"));
	return new Promise<void>((resolve, reject) => {
		const check = () => {
			const matched = pred();
			if (!matched && !state.ended) return;
			clearTimeout(timer);
			state.notify.delete(check);
			if (matched) resolve();
			else reject(new Error("Stream ended before condition was met"));
		};
		const timer = setTimeout(() => {
			state.notify.delete(check);
			reject(new Error(`Stream condition timed out after ${timeoutMs}ms`));
		}, timeoutMs);
		state.notify.add(check);
	});
}

export function countOccurrences(haystack: string, needle: string): number {
	return needle.length === 0 ? 0 : haystack.split(needle).length - 1;
}

function makeStreamWaiters(
	req: http.ClientRequest,
	res: http.IncomingMessage,
	state: StreamBufferState,
	status: number,
	headers: Record<string, string>,
	headersElapsedMs: number,
): LiveStreamHandle {
	const readText = () => Buffer.concat(state.chunks).toString("utf8");
	return {
		status,
		headers,
		headersElapsedMs,
		waitForBytes: async (minBytes, timeoutMs) => {
			await waitStreamCondition(state, () => state.totalBytes >= minBytes, timeoutMs);
			return Buffer.concat(state.chunks);
		},
		waitForText: async (needle, timeoutMs) => {
			await waitStreamCondition(state, () => readText().includes(needle), timeoutMs);
			return readText();
		},
		waitForCount: async (needle, minCount, timeoutMs) => {
			await waitStreamCondition(state, () => countOccurrences(readText(), needle) >= minCount, timeoutMs);
			return readText();
		},
		readRest: async (timeoutMs = 15_000) => {
			await waitStreamCondition(state, () => state.ended, timeoutMs);
			return { rawBody: Buffer.concat(state.chunks), prematureClose: state.premature };
		},
		snapshotText: readText,
		hasEnded: () => state.ended,
		abort: () => {
			res.destroy();
			req.destroy();
		},
	};
}

function attachStreamResponse(req: http.ClientRequest, res: http.IncomingMessage, started: number): LiveStreamHandle {
	const state: StreamBufferState = { chunks: [], totalBytes: 0, ended: false, premature: false, notify: new Set() };
	res.on("data", (chunk: Buffer | string) => {
		const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		state.chunks.push(buf);
		state.totalBytes += buf.byteLength;
		notifyWaiters(state);
	});
	const finish = (premature: boolean) => {
		if (state.ended) return;
		state.ended = true;
		state.premature = premature;
		notifyWaiters(state);
	};
	res.on("end", () => finish(false));
	res.on("aborted", () => finish(true));
	res.on("error", () => finish(true));
	res.on("close", () => finish(!res.complete));
	return makeStreamWaiters(req, res, state, res.statusCode ?? 0, normalizeRawHeaders(res.rawHeaders), Date.now() - started);
}

export interface PendingStreamConnection {
	headersArrived: () => boolean;
	waitHeaders: (timeoutMs?: number) => Promise<LiveStreamHandle>;
	abort: () => void;
}

function waitPendingHeaders(
	getHandle: () => LiveStreamHandle | null,
	getErr: () => Error | null,
	waiters: Set<() => void>,
	timeoutMs: number,
): Promise<LiveStreamHandle> {
	return new Promise<LiveStreamHandle>((resolve, reject) => {
		const check = () => {
			const h = getHandle();
			const e = getErr();
			if (!h && !e) return;
			clearTimeout(timer);
			waiters.delete(check);
			if (h) resolve(h);
			else reject(e);
		};
		const timer = setTimeout(() => {
			waiters.delete(check);
			reject(new Error(`Timed out waiting ${timeoutMs}ms for stream headers`));
		}, timeoutMs);
		waiters.add(check);
	});
}

function makePendingConnection(
	req: http.ClientRequest,
	getHandle: () => LiveStreamHandle | null,
	getErr: () => Error | null,
	waiters: Set<() => void>,
): PendingStreamConnection {
	return {
		headersArrived: () => getHandle() !== null,
		waitHeaders: (timeoutMs = 15_000) => {
			const existing = getHandle();
			if (existing) return Promise.resolve(existing);
			const existingErr = getErr();
			if (existingErr) return Promise.reject(existingErr);
			return waitPendingHeaders(getHandle, getErr, waiters, timeoutMs);
		},
		abort: () => {
			getHandle()?.abort();
			req.destroy();
		},
	};
}

export function connectWireStream(port: number, reqSpec: WireRequest): PendingStreamConnection {
	const payload = toBodyBuffer(reqSpec.body);
	const headers = buildWireHeaders(port, reqSpec, payload);
	const started = Date.now();
	let handle: LiveStreamHandle | null = null;
	let reqErr: Error | null = null;
	const waiters = new Set<() => void>();
	const req = http.request({ hostname: "127.0.0.1", port, method: reqSpec.method, path: reqSpec.path, headers, agent: false }, (res) => {
		handle = attachStreamResponse(req, res, started);
		for (const fn of [...waiters]) fn();
	});
	req.on("error", (err) => {
		reqErr = err;
		for (const fn of [...waiters]) fn();
	});
	req.flushHeaders();
	writePayloadChunks(req, payload, Boolean(reqSpec.chunked));
	return makePendingConnection(req, () => handle, () => reqErr, waiters);
}

export function openWireStream(port: number, reqSpec: WireRequest): Promise<LiveStreamHandle> {
	return connectWireStream(port, reqSpec).waitHeaders(reqSpec.timeoutMs ?? 15_000);
}

export function parseSseStream(raw: string): SseEvent[] {
	const events: SseEvent[] = [];
	for (const block of raw.replace(/\r\n/g, "\n").split("\n\n")) {
		if (!block.trim()) continue;
		let event = "message";
		let id = "";
		const dataLines: string[] = [];
		let onlyComments = true;
		for (const line of block.split("\n")) {
			if (!line || line.startsWith(":")) continue;
			onlyComments = false;
			if (line.startsWith("event:")) event = line.slice(6).trim();
			else if (line.startsWith("id:")) id = line.slice(3).trim();
			else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
		}
		if (!onlyComments) events.push({ event, id, data: dataLines.join("\n") });
	}
	return events;
}

export function parseNdjsonStream(raw: string): unknown[] {
	return raw
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
		.map((line) => JSON.parse(line) as unknown);
}
