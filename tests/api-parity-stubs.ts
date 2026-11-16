import * as fs from "node:fs";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import * as path from "node:path";

export type ServerSide = "next" | "api";
export type TtsStubMode = "normal" | "over-cap" | "over-cap-header" | "hold-for-abort";

export interface UpstreamCall {
	side: ServerSide;
	method: string;
	path: string;
	bodySummary: unknown;
}

export interface DeferredGate {
	promise: Promise<void>;
	resolve: () => void;
}

export interface ChatHoldHandle {
	waitStarted: (side: ServerSide) => Promise<void>;
	release: (side: ServerSide) => void;
	clear: () => void;
}

export interface TtsAbortHandle {
	waitStarted: () => Promise<void>;
	waitAborted: () => Promise<void>;
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

export function createDeferred(): DeferredGate {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

export function writeCliStubs(binDir: string): void {
	fs.mkdirSync(binDir, { recursive: true, mode: 0o700 });
	const claudePath = path.join(binDir, "claude");
	const codexPath = path.join(binDir, "codex");
	const agyPath = path.join(binDir, "agy");
	fs.writeFileSync(claudePath, "#!/bin/sh\nprintf '99.0.0 (Claude Code)\\n'\n", { mode: 0o755 });
	fs.writeFileSync(codexPath, "#!/bin/sh\nprintf '99.0.0\\n'\n", { mode: 0o755 });
	const agyScript = [
		"#!/bin/sh",
		"if [ \"$1\" = \"models\" ]; then",
		"\tprintf 'stub-agy-model\\tStub Agy Model\\n'",
		"else",
		"\tprintf '99.0.0\\n'",
		"fi",
		"",
	].join("\n");
	fs.writeFileSync(agyPath, agyScript, { mode: 0o755 });
	fs.chmodSync(claudePath, 0o755);
	fs.chmodSync(codexPath, 0o755);
	fs.chmodSync(agyPath, 0o755);
}

function makeTinyWav(): Buffer {
	const pcmSamples = 8000;
	const dataBytes = pcmSamples * 2;
	const buf = Buffer.alloc(44 + dataBytes);
	buf.write("RIFF", 0, "ascii");
	buf.writeUInt32LE(36 + dataBytes, 4);
	buf.write("WAVE", 8, "ascii");
	buf.write("fmt ", 12, "ascii");
	buf.writeUInt32LE(16, 16);
	buf.writeUInt16LE(1, 20);
	buf.writeUInt16LE(1, 22);
	buf.writeUInt32LE(16000, 24);
	buf.writeUInt32LE(32000, 28);
	buf.writeUInt16LE(2, 32);
	buf.writeUInt16LE(16, 34);
	buf.write("data", 36, "ascii");
	buf.writeUInt32LE(dataBytes, 40);
	for (let i = 0; i < pcmSamples; i++) {
		buf.writeInt16LE((i % 32) * 200 - 3000, 44 + i * 2);
	}
	return buf;
}

const FIXED_WAV = makeTinyWav();

function readRequestBytes(req: IncomingMessage): Promise<Buffer> {
	return new Promise<Buffer>((resolve, reject) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer | string) => {
			chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
		});
		req.on("end", () => resolve(Buffer.concat(chunks)));
		req.on("error", reject);
	});
}

function delay(ms: number): Promise<void> {
	return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

interface ToolCallSpec {
	name: string;
	args: Record<string, unknown>;
}

function detectExtractionToolCall(parsed: Record<string, unknown>): ToolCallSpec | null {
	const rawTools = Array.isArray(parsed.tools) ? parsed.tools : [];
	const toolNames = rawTools.flatMap((entry) => {
		if (!entry || typeof entry !== "object") return [];
		const fn = (entry as { function?: { name?: unknown } }).function;
		return typeof fn?.name === "string" ? [fn.name] : [];
	});
	if (toolNames.includes("submit_findings")) {
		const rawText = JSON.stringify(parsed.messages ?? []);
		const match = /TEACHER \[([A-Za-z0-9_-]+)\]/.exec(rawText);
		const prop: Record<string, unknown> = {
			id: "p1",
			name: "Parity extracted proposition",
			statement: "Both servers run identical extraction pipelines against the stub.",
		};
		if (match?.[1]) prop.messageId = match[1];
		return { name: "submit_findings", args: { propositions: [prop], chains: [] } };
	}
	if (toolNames.includes("submit_review")) {
		return { name: "submit_review", args: { links: [{ id: "p1", linkTo: "n_465398b5356a" }] } };
	}
	return null;
}

function summarizeChatBody(parsed: Record<string, unknown>): Record<string, unknown> {
	const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
	return {
		model: parsed.model ?? null,
		stream: Boolean(parsed.stream),
		messageCount: messages.length,
		hasTools: Array.isArray(parsed.tools) && parsed.tools.length > 0,
	};
}

function buildToolSseChunks(model: string, toolCall: ToolCallSpec): string[] {
	const callEntry = {
		index: 0,
		id: "call_parity_0",
		type: "function",
		function: { name: toolCall.name, arguments: JSON.stringify(toolCall.args) },
	};
	const firstDelta = { role: "assistant", tool_calls: [callEntry] };
	const first = {
		id: "chatcmpl_parity_tool",
		object: "chat.completion.chunk",
		created: 1,
		model,
		choices: [{ index: 0, delta: firstDelta, finish_reason: null }],
	};
	const done = {
		id: "chatcmpl_parity_tool",
		object: "chat.completion.chunk",
		created: 1,
		model,
		choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
		usage: { prompt_tokens: 24, completion_tokens: 12, total_tokens: 36 },
	};
	return [`data: ${JSON.stringify(first)}\n\n`, `data: ${JSON.stringify(done)}\n\n`, "data: [DONE]\n\n"];
}

function buildOpenAiSseChunks(model: string, toolCall: ToolCallSpec | null): string[] {
	if (toolCall) return buildToolSseChunks(model, toolCall);
	const part1 = {
		id: "chatcmpl_parity_text",
		object: "chat.completion.chunk",
		created: 1,
		model,
		choices: [{ index: 0, delta: { role: "assistant", content: "Stub parity " }, finish_reason: null }],
	};
	const part2 = {
		id: "chatcmpl_parity_text",
		object: "chat.completion.chunk",
		created: 1,
		model,
		choices: [{ index: 0, delta: { content: "model response." }, finish_reason: null }],
	};
	const stop = {
		id: "chatcmpl_parity_text",
		object: "chat.completion.chunk",
		created: 1,
		model,
		choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
		usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 },
	};
	return [
		`data: ${JSON.stringify(part1)}\n\n`,
		`data: ${JSON.stringify(part2)}\n\n`,
		`data: ${JSON.stringify(stop)}\n\n`,
		"data: [DONE]\n\n",
	];
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

function waitWritableDrain(res: ServerResponse): Promise<void> {
	return new Promise<void>((done) => {
		const finish = () => {
			res.off("drain", finish);
			res.off("close", finish);
			res.off("error", finish);
			done();
		};
		res.on("drain", finish);
		res.on("close", finish);
		res.on("error", finish);
	});
}

async function streamOverCapWav(res: ServerResponse, overflowGate: Promise<void>): Promise<void> {
	res.writeHead(200, { "Content-Type": "audio/wav" });
	const chunk = Buffer.alloc(65_536, 0x55);
	chunk.set(FIXED_WAV.subarray(0, 44), 0);
	for (let i = 0; i < 512; i++) {
		if (res.destroyed || res.writableEnded) return;
		if (!res.write(chunk)) await waitWritableDrain(res);
	}
	await Promise.race([overflowGate, new Promise<void>((done) => res.once("close", done))]);
	for (let i = 0; i < 4; i++) {
		if (res.destroyed || res.writableEnded) return;
		if (!res.write(chunk)) await waitWritableDrain(res);
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
		const onAbort = () => abortTracker?.aborted.resolve();
		req.once("aborted", onAbort);
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
