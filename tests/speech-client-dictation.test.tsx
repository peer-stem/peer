/**
 * The browser side of local dictation: the engine is chosen fail-closed, no
 * hosted token is requested for a local run, and a cancelled run cancels the
 * transcription requests it left in flight.
 */
import React, { act } from "react";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { parseHTML } from "linkedom";
import { useDictation, type Dictation } from "../components/dictation.tsx";
import { LocalTranscriber } from "../components/dictation-local.ts";
import { loadSpeech } from "../components/speech-settings.ts";
import type { SpeechSettings, UserSettings } from "../src/core/index.ts";

const ENDPOINT = "http://127.0.0.1:3901/v1";

class Socket extends EventTarget {
	static CONNECTING = 0;
	static OPEN = 1;
	static all: Socket[] = [];
	readyState = Socket.CONNECTING;
	constructor() { super(); Socket.all.push(this); }
	send() {}
	close() { this.readyState = 3; }
}
class AudioGraph {
	state = "running";
	destination = {};
	audioWorklet = { addModule: async () => {} };
	createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
}
class Worklet {
	static last: Worklet | undefined;
	port: { onmessage?: (event: { data: unknown }) => void } = {};
	constructor() { Worklet.last = this; }
	connect() {}
	disconnect() {}
}

/** One 100 ms frame of 16 kHz PCM16 speech. */
function voiced(): ArrayBuffer {
	return new Int16Array(1600).fill(10_000).buffer;
}

async function settle(): Promise<void> {
	for (let i = 0; i < 5; i++) await new Promise((done) => setImmediate(done));
}

type Transcribe = (signal: AbortSignal | undefined) => Promise<Response>;

let restore: (() => void) | undefined;
let dispose: (() => Promise<void>) | undefined;

type State = { speech?: SpeechSettings; speechFails: boolean; tokens: number; captures: number; transcribe: Transcribe };

function replaceGlobals(values: Record<string, unknown>): void {
	const previous = new Map<string, PropertyDescriptor | undefined>();
	for (const [key, value] of Object.entries(values)) {
		previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	restore = () => {
		for (const [key, descriptor] of previous) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else delete (globalThis as Record<string, unknown>)[key];
		}
	};
}

function install(state: State): void {
	const dom = parseHTML("<html><body><div id='root'></div></body></html>");
	const record = (): UserSettings => ({ version: 1, dictation: { language: "en" }, ...(state.speech ? { speech: state.speech } : {}) });
	const respond = async (url: string, init?: RequestInit) => {
		if (url === "/api/stt/token") { state.tokens++; return Response.json({ token: "test-token" }); }
		if (url.startsWith("/api/stt/transcribe")) return state.transcribe(init?.signal ?? undefined);
		assert.equal(url, "/api/settings");
		// Only the speech read asks for no-store; the language read does not.
		if (init?.cache === "no-store" && state.speechFails) return Response.json({}, { status: 500 });
		return Response.json({ settings: record() });
	};
	const getUserMedia = async () => {
		state.captures++;
		return { getTracks: () => [{ stop() {} }] };
	};
	replaceGlobals({
		React, window: dom.window, document: dom.document, CustomEvent: dom.window.CustomEvent,
		navigator: { userAgent: "", platform: "", mediaDevices: { getUserMedia } },
		WebSocket: Socket, AudioContext: AudioGraph, AudioWorkletNode: Worklet, IS_REACT_ACT_ENVIRONMENT: true, fetch: respond,
	});
}

async function fixture(speech: SpeechSettings | undefined, speechFails = false) {
	const state = { speech, speechFails, tokens: 0, captures: 0, appends: [] as string[],
		transcribe: (async () => Response.json({ text: "spoken words" })) as Transcribe };
	Socket.all = [];
	install(state);
	// The speech choice is cached for the window; each test states its own.
	if (!speechFails) await loadSpeech(true);
	const { createRoot } = await import("react-dom/client");
	const root = createRoot(document.getElementById("root")!);
	let latest!: Dictation;
	function Harness() {
		latest = useDictation({ append: (text) => state.appends.push(text) });
		return null;
	}
	await act(async () => { root.render(<Harness />); await settle(); });
	dispose = async () => { await act(async () => { root.unmount(); }); };
	return { state, get dictation() { return latest; } };
}

async function recordSpeech(f: Awaited<ReturnType<typeof fixture>>): Promise<void> {
	await act(async () => { f.dictation.toggle(); await settle(); });
	assert.equal(f.dictation.phase, "recording");
	await act(async () => { Worklet.last!.port.onmessage!({ data: { type: "audio", buffer: voiced() } }); });
}

afterEach(async () => { await dispose?.(); restore?.(); dispose = undefined; restore = undefined; });

// First on purpose: the speech choice has never been read in this process.
test("an unreadable speech setting stops the run instead of using the hosted engine", async () => {
	const f = await fixture({ dictation: "local", endpoint: ENDPOINT }, true);
	await act(async () => { f.dictation.toggle(); await settle(); });
	assert.equal(f.dictation.phase, "idle");
	assert.match(f.dictation.error!, /Could not load speech settings/);
	assert.equal(f.state.captures, 0);
	assert.equal(Socket.all.length, 0);
	assert.equal(f.state.tokens, 0, "no hosted token while the engine is unknown");
});

test("local dictation without an endpoint stops with a visible error and no microphone", async () => {
	const f = await fixture({ dictation: "local" });
	await act(async () => { f.dictation.toggle(); await settle(); });
	assert.equal(f.dictation.phase, "idle");
	assert.equal(f.dictation.error, "Local dictation needs a speech endpoint URL.");
	assert.equal(f.state.captures, 0);
	assert.equal(Socket.all.length, 0);
	assert.equal(f.state.tokens, 0);
});

test("with the local engine no hosted token is requested at mount, during or after a run", async () => {
	const f = await fixture({ dictation: "local", endpoint: ENDPOINT });
	await recordSpeech(f);
	await act(async () => { f.dictation.toggle(); await settle(); });
	assert.equal(f.dictation.phase, "idle");
	assert.deepEqual(f.state.appends, ["spoken words"]);
	assert.equal(Socket.all.length, 0);
	assert.equal(f.state.tokens, 0);
});

test("the hosted engine still pre-mints its token at mount", async () => {
	const f = await fixture(undefined);
	assert.equal(f.state.tokens, 1);
});

test("Esc while the last piece is transcribed cancels that request and appends nothing", async () => {
	const f = await fixture({ dictation: "local", endpoint: ENDPOINT });
	const signals: (AbortSignal | undefined)[] = [];
	f.state.transcribe = (signal) => {
		signals.push(signal);
		return new Promise((_, reject) => signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError"))));
	};
	await recordSpeech(f);
	await act(async () => { f.dictation.toggle(); await settle(); });
	assert.equal(f.dictation.phase, "stopping");
	assert.equal(signals.length, 1);
	assert.ok(signals[0], "the chunk request carries an abort signal");
	await act(async () => { f.dictation.cancel(); await settle(); });
	assert.equal(signals[0]!.aborted, true);
	assert.equal(f.dictation.phase, "idle");
	assert.deepEqual(f.state.appends, []);
});

test("a discarded transcriber aborts its requests and ignores later audio", async () => {
	const signals: AbortSignal[] = [];
	const transcriber = new LocalTranscriber("en", (_wav, _language, signal) => { signals.push(signal); return new Promise(() => {}); });
	for (let i = 0; i < 150; i++) transcriber.push(voiced()); // 15 s: one piece is cut and sent
	assert.equal(signals.length, 1);
	transcriber.discard();
	assert.equal(signals[0]!.aborted, true);
	for (let i = 0; i < 150; i++) transcriber.push(voiced());
	assert.equal(signals.length, 1, "audio after discard starts no request");
});

test("audio arriving after finish starts no request the run would never read", async () => {
	let sent = 0;
	const transcriber = new LocalTranscriber("en", async () => { sent++; return "words"; });
	transcriber.push(voiced());
	assert.deepEqual(await transcriber.finish(), { texts: ["words"], error: null });
	for (let i = 0; i < 150; i++) transcriber.push(voiced());
	assert.equal(sent, 1);
});
