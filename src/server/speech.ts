import {
	SPEECH_AUDIO_LIMIT, SPEECH_TEXT_LIMIT, normalizeSpeechEndpoint, resolveSpeech,
	type SpeechSettings, type SpeechVoice,
} from "../core/contracts/speech.ts";
import { settingsStore } from "../store/settings.ts";

/** A cold local engine can spend minutes verifying and loading its weights. */
const SPEAK_TIMEOUT_MS = 10 * 60_000;
const TRANSCRIBE_TIMEOUT_MS = 3 * 60_000;
const VOICES_TIMEOUT_MS = 60_000;
const VOICE_LIST_LIMIT = 256;
const NO_STORE = { "Cache-Control": "no-store" };
const NOT_CONFIGURED = "No speech endpoint is set. Add one in Settings → Providers → Dictation.";

type Fetch = typeof fetch;
type Target = { base: string; settings: Required<SpeechSettings> };

function target(read: () => SpeechSettings | undefined): Target | undefined {
	const settings = resolveSpeech(read());
	const base = normalizeSpeechEndpoint(settings.endpoint);
	return base ? { base, settings } : undefined;
}

function savedSpeech(): SpeechSettings | undefined {
	return settingsStore.readSettings()?.speech;
}

function failure(status: number, message: string): Response {
	return Response.json({ message }, { status, headers: NO_STORE });
}

/** The backend's own words when it gave any, bounded; never its whole body. */
async function upstreamError(response: Response): Promise<string> {
	const text = (await response.text().catch(() => "")).slice(0, 2_000);
	try {
		const body = JSON.parse(text) as { error?: { message?: unknown } | string; message?: unknown };
		const detail = typeof body.error === "string" ? body.error : body.error?.message ?? body.message;
		if (typeof detail === "string" && detail.trim()) return detail.trim().slice(0, 300);
	} catch { /* not JSON */ }
	return `Speech endpoint answered ${response.status}`;
}

async function forward(url: string, init: RequestInit, timeoutMs: number, request: Fetch): Promise<Response | string> {
	try {
		const response = await request(url, { ...init, signal: AbortSignal.timeout(timeoutMs), redirect: "error" });
		return response.ok ? response : await upstreamError(response);
	} catch (error) {
		const timedOut = error instanceof DOMException && error.name === "TimeoutError";
		return timedOut ? "The speech endpoint did not answer in time." : "The speech endpoint could not be reached.";
	}
}

async function readAudio(request: Request): Promise<ArrayBuffer | undefined> {
	if (Number(request.headers.get("content-length")) > SPEECH_AUDIO_LIMIT) return undefined;
	const audio = await request.arrayBuffer();
	return audio.byteLength > 0 && audio.byteLength <= SPEECH_AUDIO_LIMIT ? audio : undefined;
}

function languageOf(request: Request): string | undefined {
	const language = new URL(request.url).searchParams.get("language") ?? "";
	// "multi" is a hosted-engine mode; a local recogniser detects on its own.
	return /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(language) ? language.slice(0, 2) : undefined;
}

/** POST audio/wav (16 kHz mono PCM16) → `{ text }`. */
export async function transcribeResponse(request: Request, read = savedSpeech, send: Fetch = fetch): Promise<Response> {
	const to = target(read);
	if (!to) return failure(409, NOT_CONFIGURED);
	const audio = await readAudio(request);
	if (!audio) return failure(413, "Dictation audio is missing or too large.");
	const form = new FormData();
	form.set("model", to.settings.sttModel);
	form.set("response_format", "json");
	const language = languageOf(request);
	if (language) form.set("language", language);
	form.set("file", new Blob([audio], { type: "audio/wav" }), "speech.wav");
	const result = await forward(`${to.base}/audio/transcriptions`, { method: "POST", body: form }, TRANSCRIBE_TIMEOUT_MS, send);
	if (typeof result === "string") return failure(502, result);
	const body = await result.json().catch(() => null) as { text?: unknown } | null;
	if (typeof body?.text !== "string") return failure(502, "The speech endpoint returned no transcript.");
	return Response.json({ text: body.text.trim() }, { headers: NO_STORE });
}

/** POST `{ text }` → the endpoint's audio, streamed through unchanged. */
export async function speakResponse(request: Request, read = savedSpeech, send: Fetch = fetch): Promise<Response> {
	const to = target(read);
	if (!to) return failure(409, NOT_CONFIGURED);
	const body = await request.json().catch(() => null) as { text?: unknown } | null;
	const text = typeof body?.text === "string" ? body.text.trim() : "";
	if (!text || text.length > SPEECH_TEXT_LIMIT) return failure(400, `Speech text must be 1–${SPEECH_TEXT_LIMIT} characters.`);
	const payload = { model: to.settings.ttsModel, input: text, response_format: "wav", ...(to.settings.ttsVoice ? { voice: to.settings.ttsVoice } : {}) };
	const init = { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) };
	const result = await forward(`${to.base}/audio/speech`, init, SPEAK_TIMEOUT_MS, send);
	if (typeof result === "string") return failure(502, result);
	return new Response(result.body, { headers: { ...NO_STORE, "Content-Type": result.headers.get("content-type") ?? "audio/wav" } });
}

function toVoice(entry: unknown): SpeechVoice[] {
	if (typeof entry === "string") return entry ? [{ id: entry, name: entry }] : [];
	if (entry === null || typeof entry !== "object") return [];
	const { id, voice_id: voiceId, name } = entry as Record<string, unknown>;
	const key = typeof id === "string" && id ? id : typeof voiceId === "string" ? voiceId : "";
	return key ? [{ id: key, name: typeof name === "string" && name ? name : key }] : [];
}

/** GET → `{ voices }`. Servers differ: a bare list, `voices` or `data`. */
export async function voicesResponse(read = savedSpeech, send: Fetch = fetch): Promise<Response> {
	const to = target(read);
	if (!to) return failure(409, NOT_CONFIGURED);
	const result = await forward(`${to.base}/audio/voices`, { method: "GET" }, VOICES_TIMEOUT_MS, send);
	if (typeof result === "string") return failure(502, result);
	const body = await result.json().catch(() => null) as { voices?: unknown; data?: unknown } | unknown[] | null;
	const list = Array.isArray(body) ? body : Array.isArray(body?.voices) ? body.voices : Array.isArray(body?.data) ? body.data : [];
	return Response.json({ voices: list.flatMap(toVoice).slice(0, VOICE_LIST_LIMIT) }, { headers: NO_STORE });
}
