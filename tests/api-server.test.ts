import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import net, { type AddressInfo } from "node:net";
import { test, type TestContext } from "node:test";
import { MAX_IMPORT_BODY_BYTES } from "../lib/notes-import-limits.ts";
import {
	createApiHttpServer,
	serveHttp,
	type ApiHttpServer,
	type CreateApiHttpServerOptions,
} from "../src/api/server.ts";
import type { Dispatch } from "../src/api/types.ts";

interface BoundTestServer {
	api: ApiHttpServer;
	port: number;
	url: string;
}

async function startServer(
	t: TestContext,
	dispatch: Dispatch,
	options?: CreateApiHttpServerOptions,
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
	fail: (err: Error) => void;
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
		fail: (err: Error) => ctrl.error(err),
		close: () => ctrl.close(),
	};
}

function makeBackpressureStream(
	totalChunks: number,
	chunkBytes: Uint8Array,
): { stream: ReadableStream<Uint8Array>; getPulled: () => number; waitStalled: () => Promise<number> } {
	let pulled = 0;
	const firstPull = deferred<void>();
	const pull = (controller: ReadableStreamDefaultController<Uint8Array>) => {
		if (pulled >= totalChunks) {
			controller.close();
			return;
		}
		pulled += 1;
		if (pulled === 1) firstPull.resolve();
		controller.enqueue(chunkBytes);
	};
	const stream = new ReadableStream<Uint8Array>({ pull }, { highWaterMark: 0 });
	const waitStalled = async (): Promise<number> => {
		await firstPull.promise;
		let prev = -1;
		for (let i = 0; i < 200; i++) {
			await new Promise<void>((r) => setImmediate(r));
			if (pulled === prev) return pulled;
			prev = pulled;
		}
		return pulled;
	};
	return { stream, getPulled: () => pulled, waitStalled };
}

async function summarizeBodyDispatch(req: Request): Promise<Response> {
	const bytes = new Uint8Array(await req.arrayBuffer());
	const head = Buffer.from(bytes.subarray(0, 8)).toString("utf-8");
	const tail = Buffer.from(bytes.subarray(Math.max(0, bytes.byteLength - 8))).toString("utf-8");
	return Response.json({
		len: bytes.byteLength,
		contentLength: req.headers.get("content-length"),
		head,
		tail,
	});
}

test("preserves raw URL, Host, multi Set-Cookie, and omits framework headers", async (t) => {
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

test("reports request-build, dispatch, and mid-stream body failures via options.onError", async (t) => {
	const reported: Error[] = [];
	const controlled = makeControlledStream();
	const dispatch = async (req: Request) => {
		if (new URL(req.url).pathname === "/stream-err") {
			return new Response(controlled.stream, { status: 200, headers: { "Content-Type": "text/plain" } });
		}
		throw new Error("dispatch-boom");
	};
	const srv = await startServer(t, dispatch, {
		onError: (err) => reported.push(err instanceof Error ? err : new Error(String(err))),
	});

	// 1. buildWebRequest throws on forbidden TRACE method
	const traceRes = await sendRawRequest({ host: "127.0.0.1", port: srv.port, method: "TRACE", path: "/api/x" });
	assert.equal(traceRes.status, 500);
	assert.equal(traceRes.body.toString("utf-8"), "Internal Server Error");
	assert.equal(reported.length, 1);

	// 2. dispatch throws before headers
	const dispRes = await fetch(`${srv.url}/api/fail`);
	assert.equal(dispRes.status, 500);
	assert.equal(await dispRes.text(), "Internal Server Error");
	assert.equal(reported.length, 2);
	assert.equal(reported[1]?.message, "dispatch-boom");

	// 3. response body stream errors mid-way after flushing first chunk
	const { res } = await openClientStream(`${srv.url}/stream-err`);
	const first = readNextChunk(res);
	controlled.push("part-1");
	assert.equal((await first).toString("utf-8"), "part-1");
	const closed = new Promise<void>((resolve) => res.once("close", () => resolve()));
	controlled.fail(new Error("mid-stream-boom"));
	await closed;
	assert.equal(reported.length, 3);
	assert.equal(reported[2]?.message, "mid-stream-boom");
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
	const totalChunks = 256;
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
	const pulledWhilePaused = await producer.waitStalled();
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

test("caps request body at exact 27,262,976-byte default limit, strips query from warning, and leaves exempt uncut", async (t) => {
	const warnings: string[] = [];
	const srv = await startServer(t, summarizeBodyDispatch, {
		onWarn: (msg) => warnings.push(msg),
	});
	const exactPayload = Buffer.alloc(MAX_IMPORT_BODY_BYTES, 0x58);
	const exactRes = await fetch(`${srv.url}/api/capped`, { method: "POST", body: exactPayload });
	assert.equal(exactRes.status, 200);
	assert.deepEqual(await exactRes.json(), {
		len: MAX_IMPORT_BODY_BYTES,
		contentLength: String(MAX_IMPORT_BODY_BYTES),
		head: "XXXXXXXX",
		tail: "XXXXXXXX",
	});
	assert.equal(warnings.length, 0);

	const oversized = Buffer.alloc(MAX_IMPORT_BODY_BYTES + 4096, 0x41);
	oversized.write("12345678", MAX_IMPORT_BODY_BYTES - 8, "utf-8");
	oversized.fill(0x5a, MAX_IMPORT_BODY_BYTES);
	const cutRes = await fetch(`${srv.url}/api/capped?token=secret`, { method: "POST", body: oversized });
	assert.equal(cutRes.status, 200);
	assert.deepEqual(await cutRes.json(), {
		len: MAX_IMPORT_BODY_BYTES,
		contentLength: String(oversized.byteLength),
		head: "AAAAAAAA",
		tail: "12345678",
	});
	assert.deepEqual(warnings, [
		`Request body exceeded ${MAX_IMPORT_BODY_BYTES} bytes for /api/capped. Only the first ${MAX_IMPORT_BODY_BYTES} bytes will be available.`,
	]);

	const exemptRes = await fetch(`${srv.url}/api/plugins/document-one/documents/markdown`, {
		method: "POST",
		body: oversized,
	});
	assert.equal(exemptRes.status, 200);
	const exemptJson = (await exemptRes.json()) as { len: number; tail: string };
	assert.equal(exemptJson.len, oversized.byteLength);
	assert.equal(exemptJson.tail, "ZZZZZZZZ");
});

test("keeps Node default requestTimeout and closes open SSE streams cleanly without force warning", async (t) => {
	let cancelledCount = 0;
	const warnings: string[] = [];
	const dispatch = async () => {
		const sse = makeStreamOnCancel(() => { cancelledCount += 1; });
		return new Response(sse, { status: 200, headers: { "Content-Type": "text/event-stream" } });
	};
	const srv = await startServer(t, dispatch, { onWarn: (msg) => warnings.push(msg) });
	assert.equal(srv.api.server.requestTimeout, 300_000);
	const c1 = await openClientStream(`${srv.url}/sse-1`);
	const c2 = await openClientStream(`${srv.url}/sse-2`);
	const end1 = waitForStreamEnd(c1.res);
	const end2 = waitForStreamEnd(c2.res);

	await srv.api.close();
	await Promise.all([end1, end2]);
	assert.equal(cancelledCount, 2);
	assert.deepEqual(warnings, []);
});

test("arms shutdown deadline before in-flight handlers settle and logs when close is forced", async (t) => {
	const warnings: string[] = [];
	const entered = deferred<void>();
	const releaseStuck = deferred<void>();
	const dispatch = async () => {
		entered.resolve();
		await releaseStuck.promise;
		return new Response("late");
	};
	const srv = await startServer(t, dispatch, { shutdownTimeoutMs: 60, onWarn: (msg) => warnings.push(msg) });
	t.after(() => releaseStuck.resolve());
	const pendingFetch = fetch(`${srv.url}/stuck`).catch(() => null);
	await entered.promise;
	await srv.api.close();
	await pendingFetch;
	assert.deepEqual(warnings, ["Forced HTTP connection close after 60ms shutdown deadline."]);
});

function makeFakeServerResponse(msg: IncomingMessage): ServerResponse {
	const res = new http.ServerResponse(msg);
	res.assignSocket(new PassThrough() as unknown as net.Socket);
	return res;
}

test("normalizes absolute-form, asterisk-form, IPv6, and Host-port fallback targets in serveHttp", async (t) => {
	const seenUrls: string[] = [];
	const srv = await startServer(t, async (req) => {
		seenUrls.push(req.url);
		return new Response(null, { status: 204 });
	});
	const sock = net.connect(srv.port, "127.0.0.1");
	t.after(() => sock.destroy());
	await new Promise<void>((resolve, reject) => {
		sock.once("connect", () => resolve());
		sock.once("error", reject);
	});
	sock.write(`GET http://foreign.example:9999/api/abs?q=1 HTTP/1.1\r\nHost: 127.0.0.1:${srv.port}\r\nConnection: close\r\n\r\n`);
	await drainSocketToEnd(sock);
	assert.equal(seenUrls[0], `http://127.0.0.1:${srv.port}/api/abs?q=1`);

	const asteriskPipe = new PassThrough();
	const fakeMsg = Object.assign(asteriskPipe, {
		method: "OPTIONS",
		url: "*",
		headers: { host: "[::1]:4321" },
		rawHeaders: ["Host", "[::1]:4321"],
		aborted: false,
		complete: true,
		socket: { localAddress: "::1", localPort: 0 },
	}) as unknown as IncomingMessage;
	asteriskPipe.end();
	await serveHttp(fakeMsg, makeFakeServerResponse(fakeMsg), async (req) => {
		seenUrls.push(req.url);
		return new Response(null, { status: 204 });
	});
	assert.equal(seenUrls[1], "http://[::1]:4321/");
});

test("detaches request body listeners in finally when handler stops reading mid-stream", async () => {
	const bodyPipe = new PassThrough();
	const fakeMsg = Object.assign(bodyPipe, {
		method: "POST",
		url: "/api/partial",
		headers: { host: "127.0.0.1:8080" },
		rawHeaders: ["Host", "127.0.0.1:8080"],
		aborted: false,
		complete: false,
		socket: { localAddress: "127.0.0.1", localPort: 8080 },
	}) as unknown as IncomingMessage;
	bodyPipe.write(Buffer.from("first-chunk"));
	await serveHttp(fakeMsg, makeFakeServerResponse(fakeMsg), async (req) => {
		const reader = req.body!.getReader();
		const first = await reader.read();
		assert.equal(Buffer.from(first.value ?? []).toString("utf-8"), "first-chunk");
		reader.releaseLock();
		return new Response("early-400", { status: 400 });
	});
	assert.equal(bodyPipe.listenerCount("data"), 0);
	assert.equal(bodyPipe.listenerCount("end"), 0);
	assert.equal(bodyPipe.listenerCount("aborted"), 0);
	bodyPipe.end();
});
