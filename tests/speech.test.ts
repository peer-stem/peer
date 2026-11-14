/**
 * Local speech options: settings, the forwarding routes, dictation chunking
 * and the text prepared for reading aloud.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { LocalTranscriber, toWav } from "../components/dictation-local.ts";
import { splitForSpeech, toSpeakable } from "../components/speech-playback.ts";
import { normalizeSpeechEndpoint, resolveSpeech, sanitizeSpeechSettings, SPEECH_TEXT_LIMIT, type SpeechSettings } from "../src/core/contracts/speech.ts";
import { parseSpeechSettingsBody } from "../src/server/settings-body.ts";
import { speakResponse, transcribeResponse, voicesResponse } from "../src/server/speech.ts";

const LOCAL: SpeechSettings = { dictation: "local", endpoint: "http://127.0.0.1:3901/v1", sttModel: "small", ttsVoice: "piper/lessac-medium" };
const FRAME_MS = 100;

/** One 100 ms frame of 16 kHz PCM16 at a constant amplitude. */
function frame(amplitude: number): ArrayBuffer {
	return new Int16Array(1600).fill(Math.round(amplitude * 32767)).buffer;
}

function recordingFetch(reply: (url: string, init: RequestInit) => Response) {
	const calls: { url: string; init: RequestInit }[] = [];
	const send = (async (url: string | URL | Request, init: RequestInit = {}) => {
		calls.push({ url: String(url), init });
		return reply(String(url), init);
	}) as typeof fetch;
	return { calls, send };
}

test("endpoints: http(s) only, no credentials, query or fragment; trailing slashes go", () => {
	assert.equal(normalizeSpeechEndpoint("http://127.0.0.1:3901/v1/"), "http://127.0.0.1:3901/v1");
	assert.equal(normalizeSpeechEndpoint(" https://speech.example/api "), "https://speech.example/api");
	for (const bad of ["", "ftp://host/v1", "http://user:pw@host/v1", "http://host/v1?key=1", "http://host/v1#x", "not a url", 7]) {
		assert.equal(normalizeSpeechEndpoint(bad), undefined, String(bad));
	}
});

test("settings: malformed fields are dropped and absent ones resolve to hosted dictation, speech off", () => {
	assert.deepEqual(sanitizeSpeechSettings({ dictation: "local", endpoint: "http://h:1/v1/", speak: "auto", sttModel: " small ", ttsVoice: "a\u0000b", extra: 1 }),
		{ dictation: "local", speak: "auto", endpoint: "http://h:1/v1", sttModel: "small" });
	assert.deepEqual(sanitizeSpeechSettings("nope"), {});
	const resolved = resolveSpeech(undefined);
	assert.deepEqual([resolved.dictation, resolved.speak, resolved.endpoint], ["deepgram", "off", ""]);
});

test("the settings write refuses what would not survive, instead of reporting it saved", () => {
	assert.deepEqual(parseSpeechSettingsBody(LOCAL), { ok: true, settings: LOCAL });
	assert.equal(parseSpeechSettingsBody({ endpoint: "ftp://host" }).ok, false);
	assert.equal(parseSpeechSettingsBody({ dictation: "whisper" }).ok, false);
	assert.equal(parseSpeechSettingsBody({ unknown: true }).ok, false);
	assert.deepEqual(parseSpeechSettingsBody({ endpoint: "" }), { ok: true, settings: {} });
});

test("transcription forwards the chunk with the chosen model and language", async () => {
	const { calls, send } = recordingFetch(() => Response.json({ text: "  two x  " }));
	const request = new Request("http://localhost/api/stt/transcribe?language=en-US", { method: "POST", headers: { "Content-Type": "audio/wav" }, body: new Uint8Array(64) });
	const response = await transcribeResponse(request, () => LOCAL, send);
	assert.deepEqual(await response.json(), { text: "two x" });
	assert.equal(calls[0]!.url, "http://127.0.0.1:3901/v1/audio/transcriptions");
	const form = calls[0]!.init.body as FormData;
	assert.deepEqual([form.get("model"), form.get("language")], ["small", "en"]);
	assert.equal((form.get("file") as File).size, 64);
});

test("speech routes refuse honestly: no endpoint, empty audio, over-long text, backend failure", async () => {
	const { send } = recordingFetch(() => Response.json({ error: { message: "engine not ready" } }, { status: 500 }));
	const audio = () => new Request("http://localhost/api/stt/transcribe", { method: "POST", body: new Uint8Array(8) });
	assert.equal((await transcribeResponse(audio(), () => undefined, send)).status, 409);
	assert.equal((await transcribeResponse(new Request("http://localhost/x", { method: "POST" }), () => LOCAL, send)).status, 413);
	const failed = await transcribeResponse(audio(), () => LOCAL, send);
	assert.deepEqual([failed.status, await failed.json()], [502, { message: "engine not ready" }]);
	const long = new Request("http://localhost/api/tts/speak", { method: "POST", body: JSON.stringify({ text: "a".repeat(SPEECH_TEXT_LIMIT + 1) }) });
	assert.equal((await speakResponse(long, () => LOCAL, send)).status, 400);
});

test("reading aloud sends the chosen voice and streams the endpoint's audio back", async () => {
	const { calls, send } = recordingFetch(() => new Response(new Uint8Array([1, 2, 3]), { headers: { "Content-Type": "audio/wav" } }));
	const request = new Request("http://localhost/api/tts/speak", { method: "POST", body: JSON.stringify({ text: " Hello. " }) });
	const response = await speakResponse(request, () => LOCAL, send);
	assert.equal(response.headers.get("content-type"), "audio/wav");
	assert.equal((await response.arrayBuffer()).byteLength, 3);
	assert.deepEqual(JSON.parse(calls[0]!.init.body as string), { model: "tts-1", input: "Hello.", response_format: "wav", voice: "piper/lessac-medium" });
});

test("voices: the three list shapes servers use all become id/name pairs", async () => {
	const shapes = [{ voices: [{ voice_id: "alloy", name: "Alloy" }] }, { data: [{ id: "alloy", name: "Alloy" }] }, [{ id: "alloy", name: "Alloy" }]];
	for (const shape of shapes) {
		const { send } = recordingFetch(() => Response.json(shape));
		assert.deepEqual(await (await voicesResponse(() => LOCAL, send)).json(), { voices: [{ id: "alloy", name: "Alloy" }] });
	}
});

test("a WAV built from PCM frames declares 16 kHz mono 16-bit and the right length", async () => {
	const wav = new DataView(await toWav([frame(0.5), frame(0.5)]).arrayBuffer());
	assert.equal(wav.byteLength, 44 + 6400);
	assert.deepEqual([wav.getUint16(22, true), wav.getUint32(24, true), wav.getUint16(34, true), wav.getUint32(40, true)], [1, 16000, 16, 6400]);
});

test("dictation is cut at a pause, never mid-speech before the limit, and silence is not sent", async () => {
	const sent: number[] = [];
	const transcriber = new LocalTranscriber("en", async (wav) => { sent.push(wav.size); return `piece ${sent.length}`; });
	for (let i = 0; i < 4000 / FRAME_MS; i++) transcriber.push(frame(0.3)); // 4 s of speech: no cut yet
	assert.equal(sent.length, 0);
	for (let i = 0; i < 700 / FRAME_MS; i++) transcriber.push(frame(0)); // the pause cuts it
	assert.equal(sent.length, 1);
	for (let i = 0; i < 5000 / FRAME_MS; i++) transcriber.push(frame(0)); // silence only: dropped
	for (let i = 0; i < 1000 / FRAME_MS; i++) transcriber.push(frame(0.3));
	assert.deepEqual(await transcriber.finish(), { texts: ["piece 1", "piece 2"], error: null });
});

test("unbroken speech is cut at 14 s; a failed piece keeps the others and reports why", async () => {
	let count = 0;
	const transcriber = new LocalTranscriber("en", async () => {
		if (++count === 2) throw new Error("engine not ready");
		return `piece ${count}`;
	});
	for (let i = 0; i < 29_000 / FRAME_MS; i++) transcriber.push(frame(0.3));
	assert.equal(count, 2);
	assert.deepEqual(await transcriber.finish(), { texts: ["piece 1", "piece 3"], error: "engine not ready" });
});

test("spoken text drops code, markup and link targets", () => {
	const spoken = toSpeakable("## Step 1\n\nUse **the chain rule** on `f(g(x))` — see [notes](http://x/y).\n\n```js\nlet a = 1;\n```\n\n$$x^2$$ done");
	assert.equal(spoken, "Step 1 Use the chain rule on f(g(x)) — see notes. formula done");
});

test("long replies are split at sentence ends into short pieces", () => {
	const text = `${"First sentence here. ".repeat(10)}${"word ".repeat(100)}`;
	const pieces = splitForSpeech(text, 120);
	assert.ok(pieces.length > 3);
	assert.ok(pieces.every((piece) => piece.length <= 120 && piece.length > 0));
	assert.ok(pieces[0]!.endsWith("."));
	assert.deepEqual(splitForSpeech(""), []);
});
