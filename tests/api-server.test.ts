import assert from "node:assert/strict";
import http from "node:http";
import net, { type AddressInfo } from "node:net";
import { test, type TestContext } from "node:test";
import {
	createApiHttpServer,
	serveHttp,
	type ApiHttpServer,
	type ServeHttpOptions,
} from "../src/api/server.ts";
import type { Dispatch, ServeHttp } from "../src/api/types.ts";

interface BoundTestServer {
	api: ApiHttpServer;
	port: number;
	url: string;
}

async function startServer(
	t: TestContext,
	dispatch: Dispatch,
	options?: ServeHttpOptions,
): Promise<BoundTestServer> {
	const api = createApiHttpServer(dispatch, options);
	t.after(async () => {
		await api.close();
	});
	await new Promise<void>((resolve) => {
		api.server.listen(0, "127.0.0.1", () => resolve());
	});
	const addr = api.server.address() as AddressInfo;
	return { api, port: addr.port, url: `http://127.0.0.1:${addr.port}` };
}

function sendRawRequest(
	options: http.RequestOptions,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
	return new Promise((resolve, reject) => {
		const req = http.request(options, (res) => {
			const chunks: Buffer[] = [];
			res.on("data", (chunk: Buffer) => chunks.push(chunk));
			res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
		});
		req.on("error", reject);
		req.end();
	});
}

function openClientStream(url: string): Promise<{ req: http.ClientRequest; res: http.IncomingMessage }> {
	return new Promise((resolve, reject) => {
		const req = http.get(url, (res) => resolve({ req, res }));
		req.on("error", reject);
	});
}

function readNextChunk(res: http.IncomingMessage): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const onData = (chunk: Buffer) => {
			res.off("error", onErr);
			resolve(chunk);
		};
		const onErr = (err: Error) => {
			res.off("data", onData);
			reject(err);
		};
		res.once("data", onData);
		res.once("error", onErr);
	});
}

function waitForStreamEnd(res: http.IncomingMessage): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		res.on("data", (chunk: Buffer) => chunks.push(chunk));
		res.on("end", () => resolve(Buffer.concat(chunks)));
		res.on("error", reject);
	});
}

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

function makeStreamOnCancel(onCancel: () => void): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({ cancel: onCancel });
}

function makeControlledStream(): {
	stream: ReadableStream<Uint8Array>;
	push: (text: string) => void;
	close: () => void;
} {
	let ctrl!: ReadableStreamDefaultController<Uint8Array>;
	const encoder = new TextEncoder();
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			ctrl = controller;
		},
	});
	return {
		stream,
		push: (text: string) => ctrl.enqueue(encoder.encode(text)),
		close: () => ctrl.close(),
	};
}

function makeBackpressureStream(
	totalChunks: number,
	chunkBytes: Uint8Array,
): { stream: ReadableStream<Uint8Array>; getPulled: () => number } {
	let pulled = 0;
	const pull = (controller: ReadableStreamDefaultController<Uint8Array>) => {
		if (pulled >= totalChunks) {
			controller.close();
			return;
		}
		pulled += 1;
		controller.enqueue(chunkBytes);
	};
	const stream = new ReadableStream<Uint8Array>({ pull }, { highWaterMark: 0 });
	return { stream, getPulled: () => pulled };
}

async function summarizeBodyDispatch(req: Request): Promise<Response> {
	const bytes = new Uint8Array(await req.arrayBuffer());
	const head = Buffer.from(bytes.subarray(0, 8)).toString("utf-8");
	const tail = Buffer.from(bytes.subarray(Math.max(0, bytes.byteLength - 8))).toString("utf-8");
	return Response.json({ len: bytes.byteLength, head, tail });
}

test("preserves raw URL, Host, multi Set-Cookie, and omits framework headers", async (t) => {
	const typeCheck: ServeHttp = serveHttp;
	assert.equal(typeof typeCheck, "function");
	let seenUrl = "";
	let seenHost = "";
	let seenCustom = "";
	const srv = await startServer(t, async (req) => {
		seenUrl = req.url;
		seenHost = req.headers.get("host") ?? "";
		seenCustom = req.headers.get("x-dup") ?? "";
		const headers = new Headers({ "Content-Type": "application/json" });
		headers.append("Set-Cookie", "sid=one; Path=/");
		headers.append("Set-Cookie", "theme=dark; HttpOnly");
		return new Response('{"ok":true}', { status: 201, headers });
	});
	const rawPath = "/api/chats/a%2Fb%2Dc?q=1%202&pct=%25";
	const res = await sendRawRequest({
		host: "127.0.0.1",
		port: srv.port,
		method: "GET",
		path: rawPath,
		headers: {
			Host: "custom.local:9999",
			"Accept-Encoding": "gzip",
			"X-Dup": ["alpha", "beta"],
		},
	});
	assert.equal(seenUrl, `http://127.0.0.1:${srv.port}${rawPath}`);
	assert.equal(seenHost, "custom.local:9999");
	assert.equal(seenCustom, "alpha, beta");
	assert.equal(res.status, 201);
	assert.deepEqual(res.headers["set-cookie"], ["sid=one; Path=/", "theme=dark; HttpOnly"]);
	assert.equal(res.headers["x-powered-by"], undefined);
	assert.equal(res.headers.etag, undefined);
	assert.equal(res.headers["content-encoding"], undefined);
	assert.equal(res.body.toString("utf-8"), '{"ok":true}');
});

test("returns 500 Internal Server Error when dispatch throws before headers", async (t) => {
	const srv = await startServer(t, async () => {
		throw new Error("boom");
	});
	const res = await fetch(`${srv.url}/api/fail`);
	assert.equal(res.status, 500);
	assert.equal(await res.text(), "Internal Server Error");
});

test("uses null body for GET/HEAD and unread empty stream for bodiless POST/DELETE", async (t) => {
	const observed: Record<string, { hasBody: boolean; byteLen: number }> = {};
	const srv = await startServer(t, async (req) => {
		if (new URL(req.url).pathname === "/unread") {
			return Response.json({ hasBody: req.body !== null });
		}
		if (req.body === null) {
			observed[req.method] = { hasBody: false, byteLen: 0 };
			return new Response(null, { status: 204 });
		}
		const bytes = new Uint8Array(await req.arrayBuffer());
		observed[req.method] = { hasBody: true, byteLen: bytes.byteLength };
		return new Response(null, { status: 204 });
	});
	for (const method of ["GET", "HEAD", "POST", "DELETE"]) {
		const res = await fetch(`${srv.url}/check`, { method });
		assert.equal(res.status, 204);
	}
	assert.deepEqual(observed.GET, { hasBody: false, byteLen: 0 });
	assert.deepEqual(observed.HEAD, { hasBody: false, byteLen: 0 });
	assert.deepEqual(observed.POST, { hasBody: true, byteLen: 0 });
	assert.deepEqual(observed.DELETE, { hasBody: true, byteLen: 0 });
	const unread = await fetch(`${srv.url}/unread`, { method: "POST", body: "ignored-payload" });
	assert.deepEqual(await unread.json(), { hasBody: true });
});

test("HEAD writes headers with empty body and cancels response stream", async (t) => {
	const cancelled = deferred<void>();
	const srv = await startServer(t, async () => {
		const stream = makeStreamOnCancel(() => cancelled.resolve());
		return new Response(stream, {
			status: 200,
			headers: { "Content-Type": "text/plain; charset=utf-8", "Content-Length": "42" },
		});
	});
	const res = await fetch(`${srv.url}/head-stream`, { method: "HEAD" });
	assert.equal(res.status, 200);
	assert.equal(res.headers.get("content-length"), "42");
	assert.equal((await res.arrayBuffer()).byteLength, 0);
	await cancelled.promise;
});

test("flushes response headers immediately before first SSE byte and streams unbuffered", async (t) => {
	const controlled = makeControlledStream();
	const srv = await startServer(t, async () => {
		return new Response(controlled.stream, {
			status: 200,
			headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
		});
	});
	const { res } = await openClientStream(`${srv.url}/sse`);
	assert.equal(res.statusCode, 200);
	assert.equal(res.headers["content-type"], "text/event-stream");

	const firstRead = readNextChunk(res);
	controlled.push("data: first\n\n");
	assert.equal((await firstRead).toString("utf-8"), "data: first\n\n");

	const secondRead = readNextChunk(res);
	controlled.push("data: second\n\n");
	assert.equal((await secondRead).toString("utf-8"), "data: second\n\n");

	const rest = waitForStreamEnd(res);
	controlled.close();
	assert.equal((await rest).byteLength, 0);
});

function drainSocketToEnd(sock: net.Socket): Promise<number> {
	return new Promise((resolve, reject) => {
		let total = 0;
		sock.on("data", (chunk: Buffer) => {
			total += chunk.byteLength;
		});
		sock.on("end", () => resolve(total));
		sock.on("error", reject);
		sock.resume();
	});
}

test("applies socket drain backpressure when streaming to a paused client", async (t) => {
	const totalChunks = 512;
	const chunkBytes = new Uint8Array(64 * 1024).fill(0x6b);
	const producer = makeBackpressureStream(totalChunks, chunkBytes);
	const srv = await startServer(t, async () => new Response(producer.stream, { status: 200 }));
	const sock = net.connect(srv.port, "127.0.0.1");
	t.after(() => sock.destroy());
	await new Promise<void>((resolve, reject) => {
		sock.once("connect", () => resolve());
		sock.once("error", reject);
	});
	sock.pause();
	sock.write("GET /backpressure HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n");
	await new Promise((resolve) => setTimeout(resolve, 80));
	const pulledWhilePaused = producer.getPulled();
	assert.ok(pulledWhilePaused > 0 && pulledWhilePaused < totalChunks, `pulled=${pulledWhilePaused}`);
	const wireBytes = await drainSocketToEnd(sock);
	assert.ok(wireBytes > totalChunks * chunkBytes.byteLength);
	assert.equal(producer.getPulled(), totalChunks);
});

test("mid-stream client disconnect aborts request.signal and immediately cancels idle response.body", async (t) => {
	const signalAborted = deferred<void>();
	const bodyCancelled = deferred<void>();
	const srv = await startServer(t, async (req) => {
		req.signal.addEventListener("abort", () => signalAborted.resolve(), { once: true });
		const idleStream = makeStreamOnCancel(() => bodyCancelled.resolve());
		return new Response(idleStream, {
			status: 200,
			headers: { "Content-Type": "text/event-stream" },
		});
	});
	const { req, res } = await openClientStream(`${srv.url}/idle-sse`);
	assert.equal(res.statusCode, 200);
	req.destroy();
	res.destroy();
	await Promise.all([signalAborted.promise, bodyCancelled.promise]);
});

test("caps request body at exact byte limit with warning and no ECONNRESET vs null uncut", async (t) => {
	const warnings: string[] = [];
	const srv = await startServer(t, summarizeBodyDispatch, {
		getBodyLimit: (pathname) => (pathname === "/exempt" ? null : 64),
		onWarn: (msg) => warnings.push(msg),
	});
	const exactRes = await fetch(`${srv.url}/capped`, { method: "POST", body: "X".repeat(64) });
	assert.equal(exactRes.status, 200);
	assert.deepEqual(await exactRes.json(), { len: 64, head: "XXXXXXXX", tail: "XXXXXXXX" });
	assert.equal(warnings.length, 0);

	const prefix = "A".repeat(56) + "12345678";
	const oversized = Buffer.concat([Buffer.from(prefix), Buffer.alloc(512 * 1024, 0x5a)]);
	const cutRes = await fetch(`${srv.url}/capped?x=1`, { method: "POST", body: oversized });
	assert.equal(cutRes.status, 200);
	assert.deepEqual(await cutRes.json(), { len: 64, head: "AAAAAAAA", tail: "12345678" });
	assert.deepEqual(warnings, [
		"Request body exceeded 64 bytes for /capped?x=1. Only the first 64 bytes will be available.",
	]);

	const exemptRes = await fetch(`${srv.url}/exempt`, { method: "POST", body: oversized });
	assert.equal(exemptRes.status, 200);
	const exemptJson = (await exemptRes.json()) as { len: number; head: string; tail: string };
	assert.equal(exemptJson.len, oversized.byteLength);
	assert.equal(exemptJson.tail, "ZZZZZZZZ");
	assert.equal(warnings.length, 1);
});

test("createApiHttpServer sets requestTimeout=0 and closes open SSE streams in < 500ms", async () => {
	let cancelledCount = 0;
	const api = createApiHttpServer(async () => {
		const sse = makeStreamOnCancel(() => {
			cancelledCount += 1;
		});
		return new Response(sse, { status: 200, headers: { "Content-Type": "text/event-stream" } });
	});
	assert.equal(api.server.requestTimeout, 0);
	await new Promise<void>((resolve) => {
		api.server.listen(0, "127.0.0.1", () => resolve());
	});
	const port = (api.server.address() as AddressInfo).port;
	const c1 = await openClientStream(`http://127.0.0.1:${port}/sse-1`);
	const c2 = await openClientStream(`http://127.0.0.1:${port}/sse-2`);
	const end1 = waitForStreamEnd(c1.res);
	const end2 = waitForStreamEnd(c2.res);

	const startedAt = performance.now();
	await api.close();
	const elapsedMs = performance.now() - startedAt;

	await Promise.all([end1, end2]);
	assert.equal(cancelledCount, 2);
	assert.ok(elapsedMs < 500, `expected close() < 500ms, took ${elapsedMs.toFixed(1)}ms`);
});
