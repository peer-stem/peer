/** Speech options beside hosted dictation: any server that speaks the common
 * `/audio/transcriptions`, `/audio/speech` and `/audio/voices` routes, such as
 * a local model server. LearnHarness installs and starts no speech backend. */
export const DICTATION_ENGINES = ["deepgram", "local"] as const;
export type DictationEngine = (typeof DICTATION_ENGINES)[number];

/** `button` adds a play control to teacher text; `auto` also reads each reply aloud. */
export const SPEAK_MODES = ["off", "button", "auto"] as const;
export type SpeakMode = (typeof SPEAK_MODES)[number];

export interface SpeechSettings {
	dictation?: DictationEngine;
	/** Base URL including any version prefix, e.g. `http://127.0.0.1:3901/v1`. */
	endpoint?: string;
	sttModel?: string;
	speak?: SpeakMode;
	ttsModel?: string;
	ttsVoice?: string;
}

export const FACTORY_SPEECH: Required<SpeechSettings> = {
	dictation: "deepgram",
	endpoint: "",
	sttModel: "whisper-1",
	speak: "off",
	ttsModel: "tts-1",
	ttsVoice: "",
};

export interface SpeechVoice {
	id: string;
	name: string;
}

/** One request's text; the client splits longer replies at sentence ends. */
export const SPEECH_TEXT_LIMIT = 1200;
/** One dictation chunk: well above the 14 s the client records per chunk. */
export const SPEECH_AUDIO_LIMIT = 4 * 1024 * 1024;
export const SPEECH_SAMPLE_RATE = 16_000;

const NAME_LIMIT = 200;
const ENDPOINT_LIMIT = 1024;

function cleanName(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const name = value.trim();
	// Control characters never belong in a model or voice name.
	return name && name.length <= NAME_LIMIT && !/[\u0000-\u001f\u007f]/.test(name) ? name : undefined;
}

/** HTTP(S) only, private addresses allowed (that is the point), no embedded
 * credentials, query or fragment. Returns the canonical form without a
 * trailing slash, or undefined when unusable. */
export function normalizeSpeechEndpoint(value: unknown): string | undefined {
	if (typeof value !== "string" || !value.trim() || value.length > ENDPOINT_LIMIT) return undefined;
	let url: URL;
	try {
		url = new URL(value.trim());
	} catch {
		return undefined;
	}
	if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) return undefined;
	return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

/** Malformed fields are dropped; an empty endpoint clears it. */
export function sanitizeSpeechSettings(raw: unknown): SpeechSettings {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
	const r = raw as Record<string, unknown>;
	const out: SpeechSettings = {};
	if (DICTATION_ENGINES.includes(r.dictation as DictationEngine)) out.dictation = r.dictation as DictationEngine;
	if (SPEAK_MODES.includes(r.speak as SpeakMode)) out.speak = r.speak as SpeakMode;
	const endpoint = normalizeSpeechEndpoint(r.endpoint);
	if (endpoint) out.endpoint = endpoint;
	for (const key of ["sttModel", "ttsModel", "ttsVoice"] as const) {
		const name = cleanName(r[key]);
		if (name) out[key] = name;
	}
	return out;
}

export function resolveSpeech(settings: SpeechSettings | undefined): Required<SpeechSettings> {
	return { ...FACTORY_SPEECH, ...settings };
}

/** Local dictation and playback both need a usable endpoint. */
export function speechEndpointReady(settings: SpeechSettings | undefined): boolean {
	return normalizeSpeechEndpoint(settings?.endpoint) !== undefined;
}
