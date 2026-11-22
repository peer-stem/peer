"use client";

import { useSyncExternalStore } from "react";
import {
	dictationLanguageStore,
	subscribeDictationLanguage,
} from "../src/client/engine/speech/dictation-preference.ts";

export * from "../src/client/engine/speech/dictation-preference.ts";

export function useDictationLanguage() {
	const snapshot = useSyncExternalStore(
		subscribeDictationLanguage,
		dictationLanguageStore.getSnapshot,
		dictationLanguageStore.getServerSnapshot,
	);
	return {
		...snapshot,
		load: dictationLanguageStore.load,
		save: dictationLanguageStore.save,
		getLanguage: dictationLanguageStore.getLanguage,
	};
}
