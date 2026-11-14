/**
 * The browser side of reading aloud: every audio URL and element is released,
 * playback stops with its conversation, auto-read and the play buttons share
 * one id, a failure shows only on its own item, and a save does not refetch.
 */
import React, { act } from "react";
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { parseHTML } from "linkedom";
import { createRoot, type Root } from "react-dom/client";
import { replyToSpeak, SpeakButton, speechIdOf, useAutoSpeak } from "../components/speak-button.tsx";
import { speak, stopSpeaking, toSpeakable } from "../components/speech-playback.ts";
import { loadSpeech, saveSpeech } from "../components/speech-settings.ts";
import { notifySettingsSaved } from "../components/settings-signal.ts";
import type { LhViewMessage } from "../src/core/index.ts";

const SPEECH = { endpoint: "http://127.0.0.1:3901/v1", speak: "auto" as const };
/** Over one 280-character piece: read as two pieces, the second fetched ahead. */
const LONG = "This sentence is part of a long reply. ".repeat(10);

class FakeAudio extends EventTarget {
	static all: FakeAudio[] = [];
	static refuse = false;
	src: string | null;
	loads = 0;
	constructor(url: string) { super(); this.src = url; FakeAudio.all.push(this); }
	play() { return FakeAudio.refuse ? Promise.reject(new Error("autoplay refused")) : Promise.resolve(); }
	pause() {}
	removeAttribute(name: string) { if (name === "src") this.src = null; }
	load() { this.loads++; }
	end() { this.dispatchEvent(new Event("ended")); }
}

const net = { created: [] as string[], revoked: new Set<string>(), reads: 0, abortListeners: 0, signals: [] as AbortSignal[] };

/** Counts abort listeners left on the request signal by finished pieces. */
function watch(signal: AbortSignal): void {
	if (net.signals.includes(signal)) return;
	net.signals.push(signal);
	const add = signal.addEventListener.bind(signal);
	const remove = signal.removeEventListener.bind(signal);
	signal.addEventListener = ((type: string, ...rest: [never, never]) => { if (type === "abort") net.abortListeners++; add(type, ...rest); }) as typeof signal.addEventListener;
	signal.removeEventListener = ((type: string, ...rest: [never, never]) => { if (type === "abort") net.abortListeners--; remove(type, ...rest); }) as typeof signal.removeEventListener;
}

async function respond(url: string, init?: RequestInit): Promise<Response> {
	if (url === "/api/tts/speak") { watch(init!.signal!); return new Response(new Blob(["audio"], { type: "audio/wav" })); }
	if (url === "/api/settings/speech") return Response.json({ settings: { version: 1, speech: JSON.parse(init!.body as string) } });
	assert.equal(url, "/api/settings");
	net.reads++;
	return Response.json({ settings: { version: 1, speech: SPEECH } });
}

let restore: (() => void) | undefined;
let dispose: (() => Promise<void>) | undefined;

beforeEach(async () => {
	const dom = parseHTML("<html><body><div id='root'></div></body></html>");
	Object.assign(net, { created: [], revoked: new Set<string>(), reads: 0, abortListeners: 0, signals: [] });
	FakeAudio.all = [];
	FakeAudio.refuse = false;
	const urls = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };
	URL.createObjectURL = () => { const url = `blob:test/${net.created.length}`; net.created.push(url); return url; };
	URL.revokeObjectURL = (url: string) => { net.revoked.add(url); };
	const previous = new Map<string, PropertyDescriptor | undefined>();
	for (const [key, value] of Object.entries({ React, window: dom.window, document: dom.document, CustomEvent: dom.window.CustomEvent, Audio: FakeAudio, fetch: respond, IS_REACT_ACT_ENVIRONMENT: true })) {
		previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	await loadSpeech(true);
	restore = () => {
		Object.assign(URL, { createObjectURL: urls.create, revokeObjectURL: urls.revoke });
		for (const [key, descriptor] of previous) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else delete (globalThis as Record<string, unknown>)[key];
		}
	};
});

afterEach(async () => { await stop(); await dispose?.(); restore?.(); dispose = undefined; restore = undefined; });

/** Playback publishes to mounted buttons, so its calls run inside act. */
const play = (id: string, text: string) => act(async () => { speak(id, text); });
const stop = () => act(async () => { stopSpeaking(); });

async function settle(): Promise<void> {
	await act(async () => { for (let i = 0; i < 8; i++) await new Promise((done) => setImmediate(done)); });
}

const reply: LhViewMessage = { id: "group-1", role: "assistant", parts: [
	{ type: "reasoning", text: "thinking" },
	{ type: "text", id: "native-1-t0", text: "First passage." },
	{ type: "text", text: "Second passage, without a part id." },
] };

function Conversation({ conversationId, status, message }: { conversationId: string; status: string; message: LhViewMessage }) {
	useAutoSpeak(conversationId, status, replyToSpeak(message));
	return <>{message.parts.map((part, index) => part.type === "text" && <SpeakButton key={index} id={speechIdOf(message.id, part.id, index)} text={part.text ?? ""} />)}</>;
}

let root: Root | undefined;

async function render(conversationId: string, status: string, message: LhViewMessage = reply): Promise<void> {
	const view = root ??= createRoot(document.getElementById("root")!);
	await act(async () => { view.render(<Conversation conversationId={conversationId} status={status} message={message} />); });
	dispose = async () => { await act(async () => { view.unmount(); }); root = undefined; };
	await settle();
}

const buttons = () => [...document.querySelectorAll("[data-testid='speak-button']")].map((button) => button.getAttribute("aria-label"));
const alerts = () => [...document.querySelectorAll("[role='alert']")].map((alert) => alert.textContent);

test("inline $...$ math is spoken as a formula, as $$...$$ is; prices stay prose", () => {
	assert.equal(toSpeakable("So $\\frac{a}{b}$ and $x$ hold."), "So formula and formula hold.");
	assert.equal(toSpeakable("It costs $5 and $10 today."), "It costs 5 and 10 today.");
	assert.equal(toSpeakable("$$x^2$$ then $y_1$"), "formula then formula");
});

test("stop releases the piece playing and the piece fetched ahead", async () => {
	await play("a", LONG);
	await settle();
	assert.equal(net.created.length, 2, "the second piece is fetched while the first plays");
	await stop();
	await settle();
	assert.deepEqual([...net.revoked].sort(), [...net.created].sort());
	assert.equal(FakeAudio.all[0]!.src, null);
});

test("a new request releases everything the replaced one held", async () => {
	await play("a", LONG);
	await settle();
	const replaced = [...net.created];
	await play("b", "Short.");
	await settle();
	for (const url of replaced) assert.ok(net.revoked.has(url), url);
});

test("a refused play releases both pieces and reports on the failed item only, until the next play", async () => {
	await render("chat-1", "ready");
	FakeAudio.refuse = true;
	await play(speechIdOf(reply.id, undefined, 2), LONG);
	await settle();
	assert.deepEqual([...net.revoked].sort(), [...net.created].sort());
	assert.deepEqual(alerts(), ["autoplay refused"], "one alert, on the failed passage");
	const failed = document.querySelectorAll("[data-testid='speak-button']")[1]!.parentElement!;
	assert.equal(failed.querySelector("[role='alert']")?.textContent, "autoplay refused");
	FakeAudio.refuse = false;
	await play("native-1-t0", "Short.");
	await settle();
	assert.deepEqual(alerts(), []);
});

test("a finished piece leaves no element, source or abort listener behind", async () => {
	await play("a", "Short.");
	await settle();
	assert.equal(net.abortListeners, 1);
	FakeAudio.all[0]!.end();
	await settle();
	assert.equal(net.abortListeners, 0);
	assert.equal(FakeAudio.all[0]!.src, null);
	assert.equal(FakeAudio.all[0]!.loads, 1);
	assert.deepEqual([...net.revoked], net.created);
});

test("auto-read speaks under the first passage's id, so that button shows it and stops it", async () => {
	await render("chat-1", "streaming");
	await render("chat-1", "ready");
	assert.deepEqual(buttons(), ["Stop reading", "Read aloud"]);
	const first = document.querySelector("[data-testid='speak-button']") as unknown as { click: () => void };
	await act(async () => { first.click(); });
	await settle();
	assert.deepEqual(buttons(), ["Read aloud", "Read aloud"]);
	assert.equal(net.signals[0]!.aborted, true);
});

test("reading stops when the conversation changes or its view unmounts", async () => {
	await render("chat-1", "ready");
	await play("native-1-t0", LONG);
	await settle();
	await render("chat-2", "ready");
	assert.equal(net.signals[0]!.aborted, true, "switching conversation stops reading");
	await play("native-1-t0", LONG);
	await settle();
	await dispose!();
	dispose = undefined;
	assert.equal(net.signals[1]!.aborted, true, "leaving the conversation stops reading");
});

test("a speech setting saved here is not read back; a save elsewhere still is", async () => {
	await render("chat-1", "ready");
	const reads = net.reads;
	await act(async () => { assert.equal(await saveSpeech({ ...SPEECH, speak: "button" }), true); });
	await settle();
	assert.equal(net.reads, reads);
	await act(async () => { notifySettingsSaved("speech"); });
	await settle();
	assert.equal(net.reads, reads + 1);
});
