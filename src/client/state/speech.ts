/**
 * Reactive speech & TTS store (`f4-c2c`).
 * Coordinates speech settings (`resolveSpeech`), `/api/tts/voices` discovery,
 * dictation language, and TTS playback (`speak` / `stopSpeaking`).
 */

import {
	FACTORY_SETTINGS,
	FACTORY_SPEECH,
	isDictationLanguage,
	resolveSpeech,
	speechEndpointReady,
	type DictationLanguage,
	type SpeechSettings,
	type UserSettings,
} from "../../core/index.ts";
import {
	SERVER_PLAYBACK_STATE,
	getSpeechPlaybackSnapshot,
	speak,
	stopSpeaking,
	subscribeSpeechPlayback,
	type PlaybackState,
	type ResolvedSpeech,
} from "../engine/index.ts";
import type { ApiClient } from "./api.ts";
import type { Events } from "./events.ts";
import type { SettingsIntent, SettingsModel } from "./settings.ts";
import { assertNeverIntent, createCell, createStoreFromCell, type Store, type Unsubscribe } from "./store.ts";

export interface SpeechModel {
	readonly speech: ResolvedSpeech;
	readonly language: DictationLanguage;
	readonly voices: readonly string[];
	readonly voicesLoading: boolean;
	readonly voicesError: string | null;
	readonly playback: PlaybackState;
	readonly saving: boolean;
	readonly error: string | null;
}

export type SpeechIntent =
	| { readonly type: "reload" }
	| { readonly type: "load-voices" }
	| { readonly type: "save-speech"; readonly speech: SpeechSettings }
	| { readonly type: "save-language"; readonly language: DictationLanguage }
	| { readonly type: "speak"; readonly id: string; readonly text: string }
	| { readonly type: "stop-speaking" };

export interface CreateSpeechStoreOptions {
	api: ApiClient;
	settings: Store<SettingsModel, SettingsIntent>;
	events?: Events;
}

interface SpeechLocalState {
	voices: readonly string[];
	voicesEndpoint: string;
	voicesLoading: boolean;
	voicesError: string | null;
	saving: boolean;
	error: string | null;
	disposed: boolean;
}

function readEffectiveSpeech(settings: SettingsModel): ResolvedSpeech {
	const raw = settings.record?.speech;
	return raw ? resolveSpeech(raw) : FACTORY_SPEECH;
}

function readEffectiveLanguage(settings: SettingsModel): DictationLanguage {
	const raw = settings.record?.dictation?.language ?? settings.effective?.dictation?.language;
	return isDictationLanguage(raw) ? raw : FACTORY_SETTINGS.dictation.language;
}

async function fetchTtsVoices(
	api: ApiClient,
	local: SpeechLocalState,
	endpoint: string,
	publish: () => void,
): Promise<void> {
	if (!endpoint) {
		local.voices = Object.freeze([]);
		local.voicesEndpoint = "";
		local.voicesLoading = false;
		local.voicesError = null;
		publish();
		return;
	}
	local.voicesLoading = true;
	local.voicesError = null;
	local.voicesEndpoint = endpoint;
	publish();
	try {
		const res = await api.json<{ voices?: unknown }>("/api/tts/voices");
		if (local.disposed || local.voicesEndpoint !== endpoint) return;
		const list = Array.isArray(res?.voices)
			? res.voices.filter((v): v is string => typeof v === "string" && v.trim().length > 0)
			: [];
		local.voices = Object.freeze(list);
		local.voicesLoading = false;
		publish();
	} catch (err) {
		if (local.disposed || local.voicesEndpoint !== endpoint) return;
		local.voices = Object.freeze([]);
		local.voicesLoading = false;
		local.voicesError = err instanceof Error ? err.message : "Could not load voices.";
		publish();
	}
}

async function saveSpeechSection(
	api: ApiClient,
	settings: Store<SettingsModel, SettingsIntent>,
	local: SpeechLocalState,
	next: SpeechSettings,
	publish: () => void,
): Promise<void> {
	local.saving = true;
	local.error = null;
	publish();
	try {
		const res = await api.fetch("/api/settings/speech", {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(next),
		});
		if (!res.ok) {
			const body = (await res.json().catch(() => null)) as { error?: string; message?: string } | null;
			throw new Error(body?.error ?? body?.message ?? "Could not save speech settings.");
		}
		await settings.send({ type: "reload" });
	} catch (err) {
		local.error = err instanceof Error ? err.message : "Could not save speech settings.";
	} finally {
		local.saving = false;
		publish();
	}
}

async function saveLanguageSection(
	api: ApiClient,
	settings: Store<SettingsModel, SettingsIntent>,
	local: SpeechLocalState,
	language: DictationLanguage,
	publish: () => void,
): Promise<void> {
	local.saving = true;
	local.error = null;
	publish();
	try {
		const res = await api.fetch("/api/settings/dictation", {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ language }),
		});
		if (!res.ok) throw new Error("Could not save dictation language.");
		const body = (await res.json().catch(() => null)) as { settings?: UserSettings } | null;
		void body;
		await settings.send({ type: "reload" });
	} catch (err) {
		local.error = err instanceof Error ? err.message : "Could not save dictation language.";
	} finally {
		local.saving = false;
		publish();
	}
}

async function handleSpeechIntent(
	intent: SpeechIntent,
	options: CreateSpeechStoreOptions,
	local: SpeechLocalState,
	publish: () => void,
	syncVoicesIfNeeded: () => void,
): Promise<void> {
	switch (intent.type) {
		case "reload":
			await options.settings.send({ type: "reload" });
			syncVoicesIfNeeded();
			return;
		case "load-voices":
			return fetchTtsVoices(options.api, local, readEffectiveSpeech(options.settings.get()).endpoint, publish);
		case "save-speech":
			return saveSpeechSection(options.api, options.settings, local, intent.speech, publish);
		case "save-language":
			return saveLanguageSection(options.api, options.settings, local, intent.language, publish);
		case "speak":
			speak(intent.id, intent.text, options.api.fetch);
			return;
		case "stop-speaking":
			stopSpeaking();
			return;
		default:
			return assertNeverIntent(intent);
	}
}

export function createSpeechStore(options: CreateSpeechStoreOptions): Store<SpeechModel, SpeechIntent> {
	const local: SpeechLocalState = {
		voices: Object.freeze([]), voicesEndpoint: "", voicesLoading: false,
		voicesError: null, saving: false, error: null, disposed: false,
	};
	const compute = (): SpeechModel => ({
		speech: readEffectiveSpeech(options.settings.get()),
		language: readEffectiveLanguage(options.settings.get()),
		voices: local.voices, voicesLoading: local.voicesLoading, voicesError: local.voicesError,
		playback: local.disposed ? SERVER_PLAYBACK_STATE : getSpeechPlaybackSnapshot(),
		saving: local.saving, error: local.error,
	});
	const cell = createCell<SpeechModel>(compute());
	const publish = () => { if (!local.disposed) cell.set(compute()); };
	const syncVoicesIfNeeded = () => {
		const sp = readEffectiveSpeech(options.settings.get());
		if (sp.speak !== "off" && speechEndpointReady(sp) && sp.endpoint !== local.voicesEndpoint) {
			void fetchTtsVoices(options.api, local, sp.endpoint, publish);
		}
	};
	const offs: Unsubscribe[] = [
		options.settings.subscribe(() => { publish(); syncVoicesIfNeeded(); }),
		subscribeSpeechPlayback(publish),
	];
	syncVoicesIfNeeded();
	return createStoreFromCell<SpeechModel, SpeechIntent>(cell, {
		onSend: (intent) => handleSpeechIntent(intent, options, local, publish, syncVoicesIfNeeded),
		onDispose() { local.disposed = true; stopSpeaking(); for (const off of offs) off(); },
	});
}
