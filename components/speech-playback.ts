"use client";

import { useSyncExternalStore } from "react";

/** Sentence-sized requests: a local engine on CPU answers a short piece in a
 * few seconds, so the first words start early and the rest is fetched ahead. */
const PIECE_CHARS = 280;

export type PlaybackState = { speakingId: string | null; loading: boolean; error: string | null };

let state: PlaybackState = { speakingId: null, loading: false, error: null };
let generation = 0;
let abort: AbortController | null = null;
let audio: HTMLAudioElement | null = null;
const listeners = new Set<() => void>();

function publish(patch: Partial<PlaybackState>): void {
	state = { ...state, ...patch };
	for (const listener of listeners) listener();
}

/** Markdown → what should be heard: no code, markup, link targets or raw formulas. */
export function toSpeakable(markdown: string): string {
	return markdown
		.replace(/```[\s\S]*?(```|$)/g, " ")
		.replace(/\$\$[\s\S]*?\$\$/g, " formula ")
		.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, "")
		.replace(/[*_~`|$\\{}]/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

/** Whole sentences per piece; an over-long sentence is cut at a space. */
export function splitForSpeech(text: string, limit: number = PIECE_CHARS): string[] {
	const pieces: string[] = [];
	let current = "";
	for (const sentence of text.match(/[^.!?]+[.!?]*\s*/g) ?? []) {
		if (current && current.length + sentence.length > limit) {
			pieces.push(current.trim());
			current = "";
		}
		current += sentence;
		while (current.length > limit) {
			const cut = current.lastIndexOf(" ", limit);
			const at = cut > 0 ? cut : limit;
			pieces.push(current.slice(0, at).trim());
			current = current.slice(at);
		}
	}
	if (current.trim()) pieces.push(current.trim());
	return pieces;
}

async function fetchAudio(text: string, signal: AbortSignal): Promise<string> {
	const response = await fetch("/api/tts/speak", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }), signal });
	if (!response.ok) {
		const body = await response.json().catch(() => null) as { message?: unknown } | null;
		throw new Error(typeof body?.message === "string" ? body.message : "Reading aloud failed");
	}
	return URL.createObjectURL(await response.blob());
}

function playUrl(url: string, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const element = new Audio(url);
		audio = element;
		const done = () => { URL.revokeObjectURL(url); resolve(); };
		element.addEventListener("ended", done, { once: true });
		element.addEventListener("error", () => { URL.revokeObjectURL(url); reject(new Error("The audio could not be played")); }, { once: true });
		signal.addEventListener("abort", () => { element.pause(); done(); }, { once: true });
		element.play().catch(reject);
	});
}

async function playPieces(pieces: string[], current: number, signal: AbortSignal): Promise<void> {
	let next: Promise<string> | undefined = fetchAudio(pieces[0]!, signal);
	for (let index = 0; index < pieces.length && current === generation; index++) {
		const url = await next!;
		// Fetch the following piece while this one plays.
		next = index + 1 < pieces.length ? fetchAudio(pieces[index + 1]!, signal) : undefined;
		next?.catch(() => {});
		if (current !== generation) { URL.revokeObjectURL(url); return; }
		publish({ loading: false });
		await playUrl(url, signal);
	}
}

export function stopSpeaking(): void {
	generation++;
	abort?.abort();
	abort = null;
	audio = null;
	if (state.speakingId !== null || state.loading) publish({ speakingId: null, loading: false });
}

/** One voice at a time: a new request replaces whatever is being read. */
export function speak(id: string, markdown: string): void {
	stopSpeaking();
	const pieces = splitForSpeech(toSpeakable(markdown));
	if (pieces.length === 0) return;
	const current = ++generation;
	abort = new AbortController();
	publish({ speakingId: id, loading: true, error: null });
	playPieces(pieces, current, abort.signal)
		.catch((error: unknown) => {
			if (current === generation) publish({ error: error instanceof Error ? error.message : "Reading aloud failed" });
		})
		.finally(() => {
			if (current === generation) publish({ speakingId: null, loading: false });
		});
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => { listeners.delete(listener); };
}

const SERVER_STATE: PlaybackState = { speakingId: null, loading: false, error: null };

export function useSpeechPlayback(): PlaybackState {
	return useSyncExternalStore(subscribe, () => state, () => SERVER_STATE);
}
