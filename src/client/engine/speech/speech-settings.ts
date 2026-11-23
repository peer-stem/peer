import { resolveSpeech, speechEndpointReady, type SpeechSettings, type UserSettings } from "../../../core/index.ts";
import { notifySettingsSaved, onSettingsSaved } from "../dom/settings-signal.ts";

export type ResolvedSpeech = Required<SpeechSettings>;

let cache: ResolvedSpeech | undefined;
let reading: Promise<ResolvedSpeech> | undefined;
let stopSignals: (() => void) | undefined;
let announcingSave = false;
const listeners = new Set<() => void>();

function publish(next: ResolvedSpeech): ResolvedSpeech {
	cache = next;
	for (const listener of listeners) listener();
	return next;
}

async function read(request: typeof fetch = fetch): Promise<ResolvedSpeech> {
	const response = await request("/api/settings", { cache: "no-store" });
	if (!response.ok) throw new Error("Could not load speech settings.");
	const body = (await response.json()) as { settings: UserSettings | null };
	return publish(resolveSpeech(body.settings?.speech));
}

export function loadSpeech(refresh = false, request: typeof fetch = fetch): Promise<ResolvedSpeech> {
	if (cache && !refresh) return Promise.resolve(cache);
	reading ??= read(request).finally(() => {
		reading = undefined;
	});
	return reading;
}

/** Replaces the whole section; unset fields return to their defaults. */
export async function saveSpeech(next: SpeechSettings, request: typeof fetch = fetch): Promise<boolean> {
	const response = await request("/api/settings/speech", {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(next),
	});
	if (!response.ok) return false;
	const body = (await response.json()) as { settings: UserSettings };
	publish(resolveSpeech(body.settings.speech));
	announcingSave = true;
	try {
		notifySettingsSaved("speech");
	} finally {
		announcingSave = false;
	}
	return true;
}

export async function usesLocalDictation(): Promise<boolean> {
	const speech = await loadSpeech();
	if (speech.dictation === "deepgram") return false;
	if (!speechEndpointReady(speech)) throw new Error("Local dictation needs a speech endpoint URL.");
	return true;
}

export function whenHostedDictation(warm: () => void): void {
	usesLocalDictation().then((local) => {
		if (!local) warm();
	}, () => {});
}

export function getSpeechSettingsSnapshot(): ResolvedSpeech | undefined {
	return cache;
}

export function subscribeSpeechSettings(listener: () => void): () => void {
	listeners.add(listener);
	stopSignals ??= onSettingsSaved((section) => {
		if (section === "speech" && !announcingSave) void loadSpeech(true).catch(() => {});
	});
	return () => {
		listeners.delete(listener);
		if (listeners.size === 0) {
			stopSignals?.();
			stopSignals = undefined;
		}
	};
}
