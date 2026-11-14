/**
 * The speech proxy's bounds: inbound bodies are counted while they stream,
 * upstream JSON and audio are capped, only audio is relayed, a client that
 * goes away cancels the forward, and the real upstream client encodes the
 * transcription form.
 */
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

import { SPEECH_AUDIO_LIMIT, type SpeechSettings } from "../src/core/contracts/speech.ts";
import { speakResponse, transcribeResponse, voicesResponse } from "../src/server/speech.ts";

const LOCAL: SpeechSettings = { dictation: "local", endpoint: "http://127.0.0.1:3901/v1", sttModel: "small" };
const MIB = 1024 * 1024;

/** An endless body of `chunk`-byte pieces that counts how many were pulled. */
function endless(chunk: number, fill = 0x61) {
	const piece = new Uint8Array(chunk).fill(fill);
	const counter = { pulls: 0, cancelled: false };
	const stream = new ReadableStream<Uint8Array>({
		pull(controller) { counter.pulls++; controller.enqueue(piece); },
		cancel() { counter.cancelled = true; },
	}, { highWaterMark: 0 });
	return { stream, counter };
}

function never(): { send: typeof fetch; calls: number } {
	const state = { calls: 0, send: (async () => { state.calls++; return new Response(null); }) as typeof fetch };
	return state;
}

function upstream(response: () => Response): typeof fetch {
	return (async () => response()) as typeof fetch;
}

function post(path: string, body: BodyInit, signal?: AbortSignal): Request {
	return new Request(`http://localhost${path}`, { method: "POST", body, signal, duplex: "half" } as RequestInit);
}

test("dictation audio with no length header is cut off at the limit, not buffered whole", async () => {
	const { stream, counter } = endless(MIB);
	const sent = never();
	const response = await transcribeResponse(post("/api/stt/transcribe", stream), () => LOCAL, sent.send);
	assert.equal(response.status, 413);
	assert.equal(sent.calls, 0);
	assert.ok(counter.pulls <= SPEECH_AUDIO_LIMIT / MIB + 2, `pulled ${counter.pulls} MiB`);
	assert.ok(counter.cancelled);
});

test("a speak body is bounded while it streams", async () => {
	const { stream, counter } = endless(64 * 1024);
	const sent = never();
	const response = await speakResponse(post("/api/tts/speak", stream), () => LOCAL, sent.send);
	assert.equal(response.status, 400);
	assert.equal(sent.calls, 0);
	assert.ok(counter.pulls <= 2, `pulled ${counter.pulls} pieces`);
});

test("speak relays only audio, refuses an oversized declared length, and marks it nosniff", async () => {
	const speak = (reply: () => Response) => speakResponse(post("/api/tts/speak", JSON.stringify({ text: "Hi." })), () => LOCAL, upstream(reply));
	const html = await speak(() => new Response("<script>x</script>", { headers: { "Content-Type": "text/html" } }));
	assert.deepEqual([html.status, await html.json()], [502, { message: "The speech endpoint did not return audio." }]);
	const untyped = await speak(() => new Response(new Uint8Array(4)));
	assert.equal(untyped.status, 502);
	const declared = await speak(() => new Response(new Uint8Array(4), { headers: { "Content-Type": "audio/wav", "Content-Length": String(64 * MIB) } }));
	assert.deepEqual([declared.status, await declared.json()], [502, { message: "The speech endpoint returned too much audio." }]);
	const audio = await speak(() => new Response(new Uint8Array(4), { headers: { "Content-Type": "audio/mpeg" } }));
	assert.deepEqual([audio.status, audio.headers.get("content-type"), audio.headers.get("x-content-type-options")], [200, "audio/mpeg", "nosniff"]);
});

test("speak stops relaying an endless audio stream at its cap", async () => {
	const { stream, counter } = endless(MIB);
	const response = await speakResponse(post("/api/tts/speak", JSON.stringify({ text: "Hi." })), () => LOCAL,
		upstream(() => new Response(stream, { headers: { "Content-Type": "audio/wav" } })));
	assert.equal(response.status, 200);
	await assert.rejects(response.arrayBuffer());
	assert.ok(counter.pulls <= 40, `pulled ${counter.pulls} MiB`);
});

test("upstream JSON is read within a bound: transcript, voices and error text", async () => {
	const { stream, counter } = endless(256 * 1024, 0x20);
	const transcript = await transcribeResponse(post("/api/stt/transcribe", new Uint8Array(8)), () => LOCAL,
		upstream(() => new Response(stream, { headers: { "Content-Type": "application/json" } })));
	assert.deepEqual([transcript.status, await transcript.json()], [502, { message: "The speech endpoint returned no transcript." }]);
	assert.ok(counter.pulls <= 6, `pulled ${counter.pulls} pieces`);
	const voices = await voicesResponse(new Request("http://localhost/api/tts/voices"), () => LOCAL,
		upstream(() => new Response(endless(256 * 1024, 0x20).stream)));
	assert.deepEqual(await voices.json(), { voices: [] });
	const failed = await transcribeResponse(post("/api/stt/transcribe", new Uint8Array(8)), () => LOCAL,
		upstream(() => new Response(endless(256 * 1024, 0x20).stream, { status: 500 })));
	assert.deepEqual(await failed.json(), { message: "Speech endpoint answered 500" });
});

test("a client that goes away cancels the forward instead of waiting out the timeout", { timeout: 5_000 }, async () => {
	const seen: AbortSignal[] = [];
	const send = ((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
		seen.push(init.signal!);
		init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
	})) as typeof fetch;
	const client = new AbortController();
	const pending = speakResponse(post("/api/tts/speak", JSON.stringify({ text: "Hi." }), client.signal), () => LOCAL, send);
	while (seen.length === 0) await new Promise((resolve) => setImmediate(resolve));
	client.abort();
	const response = await pending;
	assert.equal(response.status, 502);
	assert.equal(seen[0]!.aborted, true);
});

/** A loopback speech server in this process, on a spare port. */
async function withServer(handle: (request: IncomingMessage, body: string) => [number, string, string], run: (endpoint: string) => Promise<void>) {
	const server = createServer((request, response) => {
		const chunks: Buffer[] = [];
		request.on("data", (chunk: Buffer) => chunks.push(chunk));
		request.on("end", () => {
			const [status, type, body] = handle(request, Buffer.concat(chunks).toString("latin1"));
			response.writeHead(status, { "Content-Type": type }).end(body);
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`);
	} finally {
		await new Promise((resolve) => server.close(resolve));
	}
}

test("the real upstream client sends the transcription form and no Origin header", async () => {
	const seen: { type?: string; origin?: string; body: string }[] = [];
	await withServer((request, body) => {
		seen.push({ type: request.headers["content-type"], origin: request.headers.origin, body });
		return [200, "application/json", JSON.stringify({ text: " heard " })];
	}, async (endpoint) => {
		const response = await transcribeResponse(post("/api/stt/transcribe?language=es", new Uint8Array(16)), () => ({ ...LOCAL, endpoint }));
		assert.deepEqual(await response.json(), { text: "heard" });
	});
	assert.match(seen[0]!.type ?? "", /^multipart\/form-data; boundary=/);
	assert.equal(seen[0]!.origin, undefined);
	assert.match(seen[0]!.body, /name="model"\r\n\r\nsmall\r\n/);
	assert.match(seen[0]!.body, /name="language"\r\n\r\nes\r\n/);
	assert.match(seen[0]!.body, /name="file"; filename="speech.wav"\r\nContent-Type: audio\/wav/);
});
