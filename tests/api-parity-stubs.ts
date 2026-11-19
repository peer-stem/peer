import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import {
	FIXED_WAV,
	buildOpenAiSseChunks,
	createDeferred,
	delay,
	detectExtractionToolCall,
	readRequestBytes,
	streamOverCapWav,
	summarizeChatBody,
	writeCliStubs,
	type ChatHoldHandle,
	type DeferredGate,
	type ServerSide,
	type TtsAbortHandle,
	type TtsStubMode,
} from "./api-parity-stubs-media.ts";

export {
	createDeferred,
	writeCliStubs,
	type ChatHoldHandle,
	type DeferredGate,
	type ServerSide,
	type TtsAbortHandle,
	type TtsStubMode,
};

export interface UpstreamCall {
	side: ServerSide;
	method: string;
	path: string;
	bodySummary: unknown;
}

export interface StubServer {
	port: number;
	baseUrl: string;
	baseUrlFor: (side: ServerSide) => string;
	setSide: (side: ServerSide) => void;
	takeCalls: () => { next: UpstreamCall[]; api: UpstreamCall[] };
	clearCalls: () => void;
	setVoices: (voices: readonly { id: string; name: string }[]) => void;
	setTtsMode: (mode: TtsStubMode) => void;
	releaseTtsOverflow: (side: ServerSide) => void;
	armTtsAbort: () => TtsAbortHandle;
	armChatHold: () => ChatHoldHandle;
	close: () => Promise<void>;
}

interface StubState {
	side: ServerSide;
	calls: { next: UpstreamCall[]; api: UpstreamCall[] };
	voices: { id: string; name: string }[];
	ttsMode: TtsStubMode;
	ttsOverflowRelease: Record<ServerSide, DeferredGate>;
	ttsAbort: { started: DeferredGate; aborted: DeferredGate } | null;
	chatHold: {
		armed: boolean;
		started: Record<ServerSide, DeferredGate>;
		release: Record<ServerSide, DeferredGate>;
	};
}

function recordCall(state: StubState, side: ServerSide, method: string, reqPath: string, bodySummary: unknown): void {
	state.calls[side].push({ side, method, path: reqPath, bodySummary });
}

function parseStubRoute(state: StubState, rawUrl: string | undefined): { side: ServerSide; pathname: string } {
	const url = new URL(rawUrl ?? "/", "http://127.0.0.1");
	if (url.pathname.startsWith("/next/v1")) return { side: "next", pathname: url.pathname.slice("/next".length) };
	if (url.pathname.startsWith("/api/v1")) return { side: "api", pathname: url.pathname.slice("/api".length) };
	return { side: state.side, pathname: url.pathname };
}

async function handleChatCompletions(
	state: StubState,
	side: ServerSide,
	pathname: string,
	req: IncomingMessage,
	res: ServerResponse,
): Promise<void> {
	const raw = await readRequestBytes(req);
	const parsed = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
	recordCall(state, side, "POST", pathname, summarizeChatBody(parsed));
	const model = typeof parsed.model === "string" ? parsed.model : "stub-model";
	const toolCall = detectExtractionToolCall(parsed);
	if (parsed.stream === false) {
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify({
			id: "chatcmpl_parity_sync",
			object: "chat.completion",
			created: 1,
			model,
			choices: [{ index: 0, message: { role: "assistant", content: "Stub parity model response." }, finish_reason: "stop" }],
			usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 },
		}));
		return;
	}
	res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
	const chunks = buildOpenAiSseChunks(model, toolCall);
	if (chunks[0]) res.write(chunks[0]);
	if (state.chatHold.armed && !toolCall) {
		state.chatHold.started[side].resolve();
		await Promise.race([
			state.chatHold.release[side].promise,
			new Promise<void>((done) => res.once("close", done)),
		]);
	}
	for (let i = 1; i < chunks.length; i++) {
		if (res.destroyed || res.writableEnded) return;
		await delay(8);
		const piece = chunks[i];
		if (piece && !res.destroyed && !res.writableEnded) res.write(piece);
	}
	if (!res.destroyed && !res.writableEnded) res.end();
}

async function handleSpeechTts(
	state: StubState,
	side: ServerSide,
	pathname: string,
	req: IncomingMessage,
	res: ServerResponse,
): Promise<void> {
	const raw = await readRequestBytes(req);
	const parsed = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
	recordCall(state, side, "POST", pathname, parsed);
	if (state.ttsMode === "over-cap-header") {
		res.writeHead(200, { "Content-Type": "audio/wav", "Content-Length": "33554433" });
		res.end(FIXED_WAV);
		return;
	}
	if (state.ttsMode === "over-cap") {
		await streamOverCapWav(res, state.ttsOverflowRelease[side].promise);
		return;
	}
	if (state.ttsMode === "hold-for-abort") {
		const abortTracker = state.ttsAbort;
		res.writeHead(200, { "Content-Type": "audio/wav" });
		res.write(FIXED_WAV.subarray(0, 64));
		res.flushHeaders();
		req.once("aborted", () => abortTracker?.aborted.resolve());
		res.once("close", () => {
			if (!res.writableFinished) abortTracker?.aborted.resolve();
		});
		abortTracker?.started.resolve();
		return;
	}
	res.writeHead(200, { "Content-Type": "audio/wav" });
	const third = Math.floor(FIXED_WAV.length / 3);
	res.write(FIXED_WAV.subarray(0, third));
	await delay(12);
	res.write(FIXED_WAV.subarray(third, third * 2));
	await delay(12);
	res.end(FIXED_WAV.subarray(third * 2));
}

const STUB_MODELS_PAYLOAD = JSON.stringify({
	data: [{ id: "stub-model", context_length: 32768, max_output_tokens: 4096, input_modalities: ["text", "image"] }],
});

async function dispatchStubRequest(state: StubState, req: IncomingMessage, res: ServerResponse): Promise<void> {
	const { side, pathname } = parseStubRoute(state, req.url);
	if (req.method === "GET" && pathname === "/v1/models") {
		recordCall(state, side, "GET", pathname, null);
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(STUB_MODELS_PAYLOAD);
		return;
	}
	if (req.method === "POST" && pathname === "/v1/chat/completions") {
		await handleChatCompletions(state, side, pathname, req, res);
		return;
	}
	if (req.method === "POST" && pathname === "/v1/audio/transcriptions") {
		const bytes = await readRequestBytes(req);
		recordCall(state, side, "POST", pathname, { hasSpeechWav: bytes.includes(Buffer.from("speech.wav")) });
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ text: "hello parity transcript" }));
		return;
	}
	if (req.method === "POST" && pathname === "/v1/audio/speech") {
		await handleSpeechTts(state, side, pathname, req, res);
		return;
	}
	if (req.method === "GET" && pathname === "/v1/audio/voices") {
		recordCall(state, side, "GET", pathname, null);
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ voices: state.voices }));
		return;
	}
	res.writeHead(404, { "Content-Type": "application/json" });
	res.end(JSON.stringify({ error: `Unknown stub route: ${req.method} ${pathname}` }));
}

function makeFreshHoldState() {
	return {
		armed: false,
		started: { next: createDeferred(), api: createDeferred() },
		release: { next: createDeferred(), api: createDeferred() },
	};
}

function makeChatHoldHandle(state: StubState): ChatHoldHandle {
	const hold = { ...makeFreshHoldState(), armed: true };
	state.chatHold = hold;
	return {
		waitStarted: (side) => hold.started[side].promise,
		release: (side) => hold.release[side].resolve(),
		clear: () => { state.chatHold = makeFreshHoldState(); },
	};
}

function buildStubHandle(server: http.Server, sockets: Set<Socket>, state: StubState, port: number): StubServer {
	return {
		port,
		baseUrl: `http://127.0.0.1:${port}/v1`,
		baseUrlFor: (side) => `http://127.0.0.1:${port}/${side}/v1`,
		setSide: (side) => { state.side = side; },
		takeCalls: () => {
			const snapshot = { next: [...state.calls.next], api: [...state.calls.api] };
			state.calls.next.length = 0;
			state.calls.api.length = 0;
			return snapshot;
		},
		clearCalls: () => {
			state.calls.next.length = 0;
			state.calls.api.length = 0;
		},
		setVoices: (voices) => { state.voices = [...voices]; },
		setTtsMode: (mode) => {
			state.ttsMode = mode;
			state.ttsOverflowRelease = { next: createDeferred(), api: createDeferred() };
		},
		releaseTtsOverflow: (side) => state.ttsOverflowRelease[side].resolve(),
		armTtsAbort: () => {
			const tracker = { started: createDeferred(), aborted: createDeferred() };
			state.ttsAbort = tracker;
			state.ttsMode = "hold-for-abort";
			return { waitStarted: () => tracker.started.promise, waitAborted: () => tracker.aborted.promise };
		},
		armChatHold: () => makeChatHoldHandle(state),
		close: () => new Promise<void>((resolve) => {
			for (const sock of sockets) sock.destroy();
			server.close(() => resolve());
		}),
	};
}

export async function startStubServer(): Promise<StubServer> {
	const state: StubState = {
		side: "next",
		calls: { next: [], api: [] },
		voices: [{ id: "alloy", name: "Alloy" }],
		ttsMode: "normal",
		ttsOverflowRelease: { next: createDeferred(), api: createDeferred() },
		ttsAbort: null,
		chatHold: makeFreshHoldState(),
	};
	const sockets = new Set<Socket>();
	const server = http.createServer((req, res) => {
		req.on("error", () => {});
		res.on("error", () => {});
		void dispatchStubRequest(state, req, res).catch(() => {
			if (!res.headersSent && !res.destroyed) res.writeHead(500);
			if (!res.destroyed && !res.writableEnded) res.end();
		});
	});
	server.on("connection", (socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
	});
	const port = await new Promise<number>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const addr = server.address();
			resolve(typeof addr === "object" && addr ? addr.port : 0);
		});
	});
	return buildStubHandle(server, sockets, state, port);
}
