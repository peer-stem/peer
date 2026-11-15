import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { Dispatch, ServeHttp } from "./types.ts";

export interface ServeHttpOptions {
	getBodyLimit?: (pathname: string) => number | null;
	onWarn?: (message: string) => void;
	shutdownSignal?: AbortSignal;
}

export interface ApiHttpServer {
	server: http.Server;
	close(): Promise<void>;
}

type BodyLimitFn = (pathname: string) => number | null;
type StreamingRequestInit = RequestInit & { duplex?: "half" };

const FALLBACK_BODY_LIMIT = 27_262_976;
let cachedBodyLimit: BodyLimitFn | null = null;

async function getDefaultBodyLimit(): Promise<BodyLimitFn> {
	if (cachedBodyLimit) return cachedBodyLimit;
	try {
		const { bodyLimit } = (await import("./router.ts")) as { bodyLimit: BodyLimitFn };
		cachedBodyLimit = bodyLimit;
		return bodyLimit;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException | null)?.code;
		if (code === "ERR_MODULE_NOT_FOUND") return () => FALLBACK_BODY_LIMIT;
		throw error;
	}
}

function firstHostHeader(message: IncomingMessage): string | undefined {
	const host = message.headers.host;
	return Array.isArray(host) ? host[0] : host;
}

function parsePortFromHost(hostHeader: string | undefined): number | null {
	if (!hostHeader) return null;
	const match = /^(?:\[[^\]]+\]|[^:]+):(\d+)$/.exec(hostHeader.trim());
	if (!match?.[1]) return null;
	const port = Number(match[1]);
	return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
}

function buildRequestUrl(message: IncomingMessage): string {
	const rawHost = message.socket?.localAddress || "127.0.0.1";
	const host = rawHost.includes(":") && !rawHost.startsWith("[") ? `[${rawHost}]` : rawHost;
	const socketPort = message.socket?.localPort;
	const port = socketPort && socketPort > 0 ? socketPort : (parsePortFromHost(firstHostHeader(message)) ?? 80);
	const rawUrl = message.url ?? "/";
	if (rawUrl.startsWith("/")) return `http://${host}:${port}${rawUrl}`;
	if (rawUrl.startsWith("http://") || rawUrl.startsWith("https://")) {
		const parsed = new URL(rawUrl);
		return `http://${host}:${port}${parsed.pathname}${parsed.search}`;
	}
	return `http://${host}:${port}/${rawUrl === "*" ? "" : rawUrl}`;
}

function appendHeaderValues(headers: Headers, key: string, values: string[]): void {
	for (const item of values) {
		headers.append(key, item);
	}
}

function buildRequestHeaders(message: IncomingMessage): Headers {
	const headers = new Headers();
	if (Array.isArray(message.rawHeaders) && message.rawHeaders.length > 0) {
		for (let i = 0; i + 1 < message.rawHeaders.length; i += 2) {
			const key = message.rawHeaders[i];
			const value = message.rawHeaders[i + 1];
			if (key !== undefined && value !== undefined) headers.append(key, value);
		}
		return headers;
	}
	for (const [key, value] of Object.entries(message.headers)) {
		if (typeof value === "string") headers.append(key, value);
		else if (Array.isArray(value)) appendHeaderValues(headers, key, value);
	}
	return headers;
}

function toUint8Array(chunk: Buffer | string | Uint8Array): Uint8Array {
	if (Buffer.isBuffer(chunk)) {
		return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
	}
	if (chunk instanceof Uint8Array) return chunk;
	return Buffer.from(chunk);
}

interface BodyStreamContext {
	message: IncomingMessage;
	limit: number | null;
	onWarn: (message: string) => void;
	received: number;
	attached: boolean;
	settled: boolean;
	detach: () => void;
}

function closeBodyStream(ctx: BodyStreamContext, controller: ReadableStreamDefaultController<Uint8Array>): void {
	if (ctx.settled) return;
	ctx.settled = true;
	ctx.detach();
	controller.close();
}

function failBodyStream(
	ctx: BodyStreamContext,
	controller: ReadableStreamDefaultController<Uint8Array>,
	err: unknown,
): void {
	if (ctx.settled) return;
	ctx.settled = true;
	ctx.detach();
	controller.error(err instanceof Error ? err : new Error(String(err)));
}

function handleBodyChunk(
	ctx: BodyStreamContext,
	controller: ReadableStreamDefaultController<Uint8Array>,
	rawChunk: Buffer | string | Uint8Array,
): void {
	if (ctx.settled) return;
	const bytes = toUint8Array(rawChunk);
	if (bytes.byteLength === 0) return;
	if (ctx.limit !== null && ctx.received + bytes.byteLength > ctx.limit) {
		const remaining = ctx.limit - ctx.received;
		if (remaining > 0) controller.enqueue(bytes.subarray(0, remaining));
		ctx.received = ctx.limit;
		const targetUrl = ctx.message.url ?? "/";
		ctx.onWarn(`Request body exceeded ${ctx.limit} bytes for ${targetUrl}. Only the first ${ctx.limit} bytes will be available.`);
		closeBodyStream(ctx, controller);
		ctx.message.resume();
		return;
	}
	ctx.received += bytes.byteLength;
	controller.enqueue(bytes);
	if ((controller.desiredSize ?? 0) <= 0) ctx.message.pause();
}

function attachMessageToController(
	ctx: BodyStreamContext,
	controller: ReadableStreamDefaultController<Uint8Array>,
): boolean {
	if (ctx.message.aborted) {
		failBodyStream(ctx, controller, new Error("Request body aborted"));
		return false;
	}
	if (ctx.message.readableEnded) {
		closeBodyStream(ctx, controller);
		return false;
	}
	if (ctx.message.destroyed && !ctx.message.complete) {
		failBodyStream(ctx, controller, new Error("Request socket destroyed"));
		return false;
	}
	const onData = (chunk: Buffer | string) => handleBodyChunk(ctx, controller, chunk);
	const onEnd = () => closeBodyStream(ctx, controller);
	const onAborted = () => failBodyStream(ctx, controller, new Error("Request body aborted"));
	const onError = (err: unknown) => failBodyStream(ctx, controller, err);
	const onClose = () => {
		if (!ctx.message.complete && !ctx.message.readableEnded) {
			failBodyStream(ctx, controller, new Error("Request socket closed early"));
		} else {
			closeBodyStream(ctx, controller);
		}
	};
	ctx.detach = () => {
		ctx.message.off("data", onData);
		ctx.message.off("end", onEnd);
		ctx.message.off("aborted", onAborted);
		ctx.message.off("error", onError);
		ctx.message.off("close", onClose);
	};
	ctx.message.on("data", onData);
	ctx.message.on("end", onEnd);
	ctx.message.on("aborted", onAborted);
	ctx.message.on("error", onError);
	ctx.message.on("close", onClose);
	return true;
}

function pullBodyChunk(ctx: BodyStreamContext, controller: ReadableStreamDefaultController<Uint8Array>): void {
	if (ctx.settled) return;
	if (!ctx.attached) {
		ctx.attached = true;
		if (!attachMessageToController(ctx, controller)) return;
	}
	ctx.message.resume();
}

function cancelBodyStream(ctx: BodyStreamContext): void {
	if (ctx.settled) return;
	ctx.settled = true;
	ctx.detach();
	if (!ctx.message.readableEnded && !ctx.message.destroyed) ctx.message.resume();
}

function createRequestBodyStream(
	message: IncomingMessage,
	limit: number | null,
	onWarn: (message: string) => void,
): ReadableStream<Uint8Array> {
	const ctx: BodyStreamContext = {
		message,
		limit,
		onWarn,
		received: 0,
		attached: false,
		settled: false,
		detach: () => {},
	};
	return new ReadableStream<Uint8Array>(
		{
			pull: (controller) => pullBodyChunk(ctx, controller),
			cancel: () => cancelBodyStream(ctx),
		},
		{ highWaterMark: 0 },
	);
}

function bindDisconnectSignal(
	message: IncomingMessage,
	res: ServerResponse,
	shutdownSignal?: AbortSignal,
): { signal: AbortSignal; cleanup: () => void } {
	const controller = new AbortController();
	const abort = () => {
		if (!controller.signal.aborted) controller.abort();
	};
	const onResClose = () => {
		if (!res.writableFinished) abort();
	};
	const noopError = () => {};
	message.on("error", noopError);
	res.on("error", noopError);
	if (message.aborted || (res.destroyed && !res.writableFinished) || shutdownSignal?.aborted) {
		abort();
	} else {
		res.on("close", onResClose);
		message.on("aborted", abort);
		shutdownSignal?.addEventListener("abort", abort, { once: true });
	}
	const cleanup = () => {
		res.off("close", onResClose);
		message.off("aborted", abort);
		shutdownSignal?.removeEventListener("abort", abort);
	};
	return { signal: controller.signal, cleanup };
}

async function buildWebRequest(
	message: IncomingMessage,
	signal: AbortSignal,
	options?: ServeHttpOptions,
): Promise<Request> {
	const url = buildRequestUrl(message);
	const method = message.method ?? "GET";
	const headers = buildRequestHeaders(message);
	const upper = method.toUpperCase();
	if (upper === "GET" || upper === "HEAD") {
		return new Request(url, { method, headers, signal });
	}
	const getLimit = options?.getBodyLimit ?? (await getDefaultBodyLimit());
	const limit = getLimit(new URL(url).pathname);
	const body = createRequestBodyStream(message, limit, options?.onWarn ?? console.warn);
	const init: StreamingRequestInit = { method, headers, body, signal, duplex: "half" };
	return new Request(url, init);
}

function applyResponseHeaders(res: ServerResponse, headers: Headers): void {
	const cookies = headers.getSetCookie();
	if (cookies.length > 0) res.setHeader("set-cookie", cookies);
	headers.forEach((value, key) => {
		if (key.toLowerCase() !== "set-cookie") res.setHeader(key, value);
	});
}

function waitForDrain(res: ServerResponse, signal: AbortSignal): Promise<void> {
	if (signal.aborted || res.destroyed || res.writableEnded) return Promise.resolve();
	return new Promise<void>((resolve) => {
		const done = () => {
			res.off("drain", done);
			res.off("close", done);
			res.off("error", done);
			signal.removeEventListener("abort", done);
			resolve();
		};
		res.on("drain", done);
		res.on("close", done);
		res.on("error", done);
		signal.addEventListener("abort", done, { once: true });
	});
}

function releaseReaderSafely(reader: ReadableStreamDefaultReader<Uint8Array>): void {
	try {
		reader.releaseLock();
	} catch {
		// Reader lock already released.
	}
}

async function pumpReaderToResponse(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	res: ServerResponse,
	signal: AbortSignal,
): Promise<void> {
	while (!signal.aborted && !res.destroyed && !res.writableEnded) {
		const { done, value } = await reader.read();
		if (done || signal.aborted || res.destroyed || res.writableEnded) break;
		if (value.byteLength > 0 && !res.write(value)) {
			await waitForDrain(res, signal);
		}
	}
	if (!res.writableEnded && !res.destroyed) res.end();
}

async function streamResponseBody(
	res: ServerResponse,
	body: ReadableStream<Uint8Array>,
	signal: AbortSignal,
	shutdownSignal?: AbortSignal,
): Promise<void> {
	res.flushHeaders();
	const reader = body.getReader();
	const onAbort = () => {
		void reader.cancel().catch(() => {});
		if (shutdownSignal?.aborted && !res.writableEnded && !res.destroyed) res.end();
	};
	signal.addEventListener("abort", onAbort, { once: true });
	if (signal.aborted) onAbort();
	try {
		await pumpReaderToResponse(reader, res, signal);
	} catch (error) {
		if (!signal.aborted && !res.destroyed && !res.writableEnded) {
			res.destroy(error instanceof Error ? error : undefined);
		}
	} finally {
		signal.removeEventListener("abort", onAbort);
		releaseReaderSafely(reader);
	}
}

function sendInternalError(res: ServerResponse): void {
	if (!res.headersSent && !res.destroyed && !res.writableEnded) {
		res.statusCode = 500;
		res.setHeader("Content-Type", "text/plain; charset=utf-8");
		res.end("Internal Server Error");
		return;
	}
	if (!res.destroyed && !res.writableEnded) res.destroy();
}

async function writeWebResponse(
	res: ServerResponse,
	request: Request,
	response: Response,
	signal: AbortSignal,
	shutdownSignal?: AbortSignal,
): Promise<void> {
	if (signal.aborted || res.destroyed || res.writableEnded) {
		await response.body?.cancel().catch(() => {});
		if (shutdownSignal?.aborted && !res.writableEnded && !res.destroyed) {
			if (!res.headersSent) res.statusCode = 503;
			res.end();
		}
		return;
	}
	res.statusCode = response.status;
	applyResponseHeaders(res, response.headers);
	if (request.method === "HEAD") {
		res.end();
		await response.body?.cancel().catch(() => {});
		return;
	}
	if (!response.body) {
		res.end();
		return;
	}
	await streamResponseBody(res, response.body, signal, shutdownSignal);
}

export async function serveHttp(
	message: IncomingMessage,
	res: ServerResponse,
	dispatch: Dispatch,
	options?: ServeHttpOptions,
): Promise<void> {
	const { signal, cleanup } = bindDisconnectSignal(message, res, options?.shutdownSignal);
	try {
		const request = await buildWebRequest(message, signal, options);
		let response: Response;
		try {
			response = await dispatch(request);
		} catch {
			sendInternalError(res);
			return;
		}
		await writeWebResponse(res, request, response, signal, options?.shutdownSignal);
	} catch {
		sendInternalError(res);
	} finally {
		cleanup();
	}
}

const _typeCheck: ServeHttp = serveHttp;
void _typeCheck;

function closeNodeServer(server: http.Server): Promise<void> {
	if (!server.listening) return Promise.resolve();
	return new Promise<void>((resolve, reject) => {
		server.close((error) => {
			const code = (error as NodeJS.ErrnoException | undefined)?.code;
			if (error && code !== "ERR_SERVER_NOT_RUNNING") reject(error);
			else resolve();
		});
	});
}

async function shutdownApiServer(
	server: http.Server,
	shutdownController: AbortController,
	inFlight: Set<Promise<void>>,
): Promise<void> {
	const closed = closeNodeServer(server);
	shutdownController.abort();
	server.closeIdleConnections();
	await Promise.allSettled(inFlight);
	server.closeIdleConnections();
	const forceTimer = setTimeout(() => server.closeAllConnections(), 100);
	forceTimer.unref();
	try {
		await closed;
	} finally {
		clearTimeout(forceTimer);
	}
}

export function createApiHttpServer(
	dispatch: Dispatch,
	options?: ServeHttpOptions & { onError?: (error: unknown) => void },
): ApiHttpServer {
	const shutdownController = new AbortController();
	if (options?.shutdownSignal?.aborted) shutdownController.abort();
	else options?.shutdownSignal?.addEventListener("abort", () => shutdownController.abort(), { once: true });
	const inFlight = new Set<Promise<void>>();
	const mergedOptions: ServeHttpOptions = { ...options, shutdownSignal: shutdownController.signal };
	const server = http.createServer((message, res) => {
		const task = serveHttp(message, res, dispatch, mergedOptions).catch((error) => {
			options?.onError?.(error);
		});
		inFlight.add(task);
		void task.finally(() => inFlight.delete(task));
	});
	server.requestTimeout = 0;
	let closing: Promise<void> | null = null;
	return {
		server,
		close(): Promise<void> {
			closing ??= shutdownApiServer(server, shutdownController, inFlight);
			return closing;
		},
	};
}
