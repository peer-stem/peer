"use client";

import { useEffect, useSyncExternalStore } from "react";
import {
	getSpeechSettingsSnapshot,
	loadSpeech,
	subscribeSpeechSettings,
	type ResolvedSpeech,
} from "../src/client/engine/speech/speech-settings.ts";

export * from "../src/client/engine/speech/speech-settings.ts";

export function useSpeechSettings(): ResolvedSpeech | undefined {
	const snapshot = useSyncExternalStore(subscribeSpeechSettings, getSpeechSettingsSnapshot, () => undefined);
	useEffect(() => {
		void loadSpeech().catch(() => {});
	}, []);
	return snapshot;
}
