import assert from "node:assert/strict";
import http from "node:http";
import net, { type AddressInfo } from "node:net";
import { test, type TestContext } from "node:test";
import { createApiHttpServer, type ApiHttpServer, type CreateApiHttpServerOptions } from "../src/api/server.ts";
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

async function closeWithDeadline(api: ApiHttpServer, onTimeout: () => void, deadlineMs: number): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			onTimeout();
			reject(new Error("srv.api.close() hung past shutdownTimeoutMs"));
		}, deadlineMs);
	});
	try {
		await Promise.race([api.close(), timeout]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

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
	assert.ok(pulledWhilePaused > 0, `pulled=${pulledWhilePaused}`);
	assert.ok(pulledWhilePaused < totalChunks, `pulled=${pulledWhilePaused}`);
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
	await closeWithDeadline(srv.api, () => releaseStuck.resolve(), 1_500);
	await pendingFetch;
	assert.deepEqual(warnings, ["Forced HTTP connection close after 60ms shutdown deadline."]);
});
