"use client";

import { useSyncExternalStore } from "react";
import { isDictationActive, subscribeDictationActive } from "../src/client/engine/speech/dictation-state.ts";

export * from "../src/client/engine/speech/dictation-state.ts";

export function useDictationActive(): boolean {
	return useSyncExternalStore(subscribeDictationActive, isDictationActive, () => false);
}
