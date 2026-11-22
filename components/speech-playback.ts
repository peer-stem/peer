"use client";

import { useSyncExternalStore } from "react";
import {
	getSpeechPlaybackSnapshot,
	SERVER_PLAYBACK_STATE,
	subscribeSpeechPlayback,
	type PlaybackState,
} from "../src/client/engine/speech/speech-playback.ts";

export * from "../src/client/engine/speech/speech-playback.ts";

export function useSpeechPlayback(): PlaybackState {
	return useSyncExternalStore(subscribeSpeechPlayback, getSpeechPlaybackSnapshot, () => SERVER_PLAYBACK_STATE);
}
