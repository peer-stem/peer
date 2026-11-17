import http from "node:http";
import net from "node:net";

export interface WireRequest {
	method: string;
	path: string;
	headers?: Record<string, string>;
	omitHost?: boolean;
	body?: Buffer | Uint8Array | string;
	chunked?: boolean;
	agent?: http.Agent | false;
	timeoutMs?: number;
}

export interface WireResponse {
	status: number;
	headers: Record<string, string>;
	rawBody: Buffer;
	text: string;
	prematureClose: boolean;
}

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

export function normalizeRawHeaders(rawHeaders: readonly string[]): Record<string, string> {
	const out: Record<string, string> = {};
	for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
		const key = rawHeaders[i]?.toLowerCase();
		const val = rawHeaders[i + 1];
		if (!key || val === undefined) continue;
		out[key] = out[key] !== undefined ? `${out[key]}, ${val}` : val;
	}
	return out;
}

function toBodyBuffer(body: Buffer | Uint8Array | string | undefined): Buffer | undefined {
	if (body === undefined) return undefined;
	if (Buffer.isBuffer(body)) return body;
	if (typeof body === "string") return Buffer.from(body, "utf8");
	return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
}

function buildWireHeaders(port: number, reqSpec: WireRequest, payload: Buffer | undefined): Record<string, string> {
	const headers: Record<string, string> = {};
	if (!reqSpec.omitHost) headers.Host = `127.0.0.1:${port}`;
	if (!reqSpec.agent) headers.Connection = "close";
	if (reqSpec.headers) {
		for (const [key, val] of Object.entries(reqSpec.headers)) {
			if (key.toLowerCase() === "host") delete headers.Host;
			headers[key] = val;
		}
	}
	const hasContentLength = Object.keys(headers).some((k) => k.toLowerCase() === "content-length");
	const hasTransferEncoding = Object.keys(headers).some((k) => k.toLowerCase() === "transfer-encoding");
	if (reqSpec.chunked && !hasTransferEncoding) {
		headers["Transfer-Encoding"] = "chunked";
	} else if (payload !== undefined && !hasContentLength && !hasTransferEncoding) {
		headers["Content-Length"] = String(payload.byteLength);
	}
	return headers;
}

function writePayloadChunks(req: http.ClientRequest, payload: Buffer | undefined, chunked: boolean): void {
	if (payload === undefined) {
		req.end();
		return;
	}
	if (!chunked || payload.byteLength <= 65_536) {
		req.end(payload);
		return;
	}
	let offset = 0;
	const step = 262_144;
	const pump = () => {
		while (offset < payload.byteLength && !req.destroyed) {
			const end = Math.min(offset + step, payload.byteLength);
			const slice = payload.subarray(offset, end);
			offset = end;
			if (offset >= payload.byteLength) { req.end(slice); return; }
			if (!req.write(slice)) { req.once("drain", pump); return; }
		}
	};
	pump();
}

export function sendWire(port: number, reqSpec: WireRequest): Promise<WireResponse> {
	const payload = toBodyBuffer(reqSpec.body);
	const headers = buildWireHeaders(port, reqSpec, payload);
	const opts = { hostname: "127.0.0.1", port, method: reqSpec.method, path: reqSpec.path, headers, agent: reqSpec.agent ?? false };
	return new Promise<WireResponse>((resolve, reject) => {
		const req = http.request(opts, (res) => collectWireResponse(res, resolve));
		req.on("error", reject);
		req.setTimeout(reqSpec.timeoutMs ?? 30_000, () => {
			req.destroy(new Error(`Wire request timed out: ${reqSpec.method} ${reqSpec.path}`));
		});
		writePayloadChunks(req, payload, Boolean(reqSpec.chunked));
	});
}

function collectWireResponse(res: http.IncomingMessage, resolve: (value: WireResponse) => void): void {
	const chunks: Buffer[] = [];
	let finished = false;
	const done = (prematureClose: boolean) => {
		if (finished) return;
		finished = true;
		const rawBody = Buffer.concat(chunks);
		resolve({
			status: res.statusCode ?? 0,
			headers: normalizeRawHeaders(res.rawHeaders),
			rawBody,
			text: rawBody.toString("utf8"),
			prematureClose,
		});
	};
	res.on("data", (chunk: Buffer | string) => {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	});
	res.on("end", () => done(false));
	res.on("aborted", () => done(true));
	res.on("error", () => done(true));
	res.on("close", () => done(!res.complete));
}

export function sendRawSocket(port: number, rawRequest: Buffer | string, timeoutMs = 10_000): Promise<WireResponse> {
	const outBytes = typeof rawRequest === "string" ? Buffer.from(rawRequest, "utf8") : rawRequest;
	return new Promise<WireResponse>((resolve, reject) => {
		const chunks: Buffer[] = [];
		const socket = net.createConnection({ host: "127.0.0.1", port }, () => {
			socket.write(outBytes);
		});
		socket.setTimeout(timeoutMs, () => socket.destroy(new Error("Raw socket timeout")));
		socket.on("data", (chunk: Buffer | string) => {
			chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
		});
		socket.on("error", reject);
		socket.on("close", () => resolve(parseRawHttpResponse(Buffer.concat(chunks))));
	});
}

function parseRawHttpResponse(buf: Buffer): WireResponse {
	const sep = buf.indexOf("\r\n\r\n");
	const headText = sep >= 0 ? buf.subarray(0, sep).toString("latin1") : buf.toString("latin1");
	const bodySlice = sep >= 0 ? buf.subarray(sep + 4) : Buffer.alloc(0);
	const lines = headText.split("\r\n");
	const statusMatch = /^HTTP\/\d+\.\d+\s+(\d{3})/.exec(lines[0] ?? "");
	const status = statusMatch?.[1] ? Number(statusMatch[1]) : 0;
	const rawPairs: string[] = [];
	for (let i = 1; i < lines.length; i++) {
		const line = lines[i] ?? "";
		const colon = line.indexOf(":");
		if (colon > 0) rawPairs.push(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
	}
	const headers = normalizeRawHeaders(rawPairs);
	const rawBody = headers["transfer-encoding"]?.includes("chunked") ? decodeChunkedBody(bodySlice) : bodySlice;
	return { status, headers, rawBody, text: rawBody.toString("utf8"), prematureClose: false };
}

function decodeChunkedBody(buf: Buffer): Buffer {
	const out: Buffer[] = [];
	let pos = 0;
	while (pos < buf.byteLength) {
		const lineEnd = buf.indexOf("\r\n", pos);
		if (lineEnd < 0) break;
		const sizeHex = buf.subarray(pos, lineEnd).toString("ascii").split(";")[0]?.trim() ?? "";
		const size = Number.parseInt(sizeHex, 16);
		if (!Number.isFinite(size) || size === 0) break;
		const start = lineEnd + 2;
		if (start + size > buf.byteLength) {
			out.push(buf.subarray(start));
			break;
		}
		out.push(buf.subarray(start, start + size));
		pos = start + size + 2;
	}
	return Buffer.concat(out);
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

export function openWireStream(port: number, reqSpec: WireRequest): Promise<LiveStreamHandle> {
	return connectWireStream(port, reqSpec).waitHeaders(reqSpec.timeoutMs ?? 15_000);
}

export function parseSseStream(raw: string): SseEvent[] {
	const events: SseEvent[] = [];
	const blocks = raw.replace(/\r\n/g, "\n").split("\n\n");
	for (const block of blocks) {
		const trimmed = block.trim();
		if (!trimmed) continue;
		let event = "message";
		let id = "";
		const dataLines: string[] = [];
		let onlyComments = true;
		for (const line of block.split("\n")) {
			if (!line) continue;
			if (line.startsWith(":")) continue;
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
