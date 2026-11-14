"use client";

import { useEffect, useSyncExternalStore } from "react";
import { resolveSpeech, speechEndpointReady, type SpeechSettings, type UserSettings } from "@/src/core";
import { notifySettingsSaved, onSettingsSaved } from "@/components/settings-signal";

export type ResolvedSpeech = Required<SpeechSettings>;

/** One confirmed copy for the window: the recorder, the play controls and
 * the settings page must agree on the engine without each asking the server. */
let cache: ResolvedSpeech | undefined;
let reading: Promise<ResolvedSpeech> | undefined;
let stopSignals: (() => void) | undefined;
/** True while this module announces its own save: its readers already hold the PUT response. */
let announcingSave = false;
const listeners = new Set<() => void>();

function publish(next: ResolvedSpeech): ResolvedSpeech {
	cache = next;
	for (const listener of listeners) listener();
	return next;
}

async function read(): Promise<ResolvedSpeech> {
	const response = await fetch("/api/settings", { cache: "no-store" });
	if (!response.ok) throw new Error("Could not load speech settings.");
	const body = await response.json() as { settings: UserSettings | null };
	return publish(resolveSpeech(body.settings?.speech));
}

export function loadSpeech(refresh = false): Promise<ResolvedSpeech> {
	if (cache && !refresh) return Promise.resolve(cache);
	reading ??= read().finally(() => { reading = undefined; });
	return reading;
}

/** Replaces the whole section; unset fields return to their defaults. */
export async function saveSpeech(next: SpeechSettings): Promise<boolean> {
	const response = await fetch("/api/settings/speech", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(next) });
	if (!response.ok) return false;
	const body = await response.json() as { settings: UserSettings };
	publish(resolveSpeech(body.settings.speech));
	announcingSave = true;
	try { notifySettingsSaved("speech"); } finally { announcingSave = false; }
	return true;
}

/** Fails closed: true only for a usable local endpoint, false only when the
 * hosted engine is the one selected. An unreadable setting, or local with no
 * endpoint, throws, so microphone audio never reaches an engine not chosen. */
export async function usesLocalDictation(): Promise<boolean> {
	const speech = await loadSpeech();
	if (speech.dictation === "deepgram") return false;
	if (!speechEndpointReady(speech)) throw new Error("Local dictation needs a speech endpoint URL.");
	return true;
}

/** Runs `warm` only when the hosted engine is selected; never on doubt. */
export function whenHostedDictation(warm: () => void): void {
	usesLocalDictation().then((local) => { if (!local) warm(); }, () => {});
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	stopSignals ??= onSettingsSaved((section) => { if (section === "speech" && !announcingSave) void loadSpeech(true).catch(() => {}); });
	return () => {
		listeners.delete(listener);
		if (listeners.size === 0) { stopSignals?.(); stopSignals = undefined; }
	};
}

/** Undefined until the first read lands; callers treat that as "off". */
export function useSpeechSettings(): ResolvedSpeech | undefined {
	const snapshot = useSyncExternalStore(subscribe, () => cache, () => undefined);
	useEffect(() => { void loadSpeech().catch(() => {}); }, []);
	return snapshot;
}
