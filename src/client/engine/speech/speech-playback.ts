const PIECE_CHARS = 280;

export type PlaybackState = {
	speakingId: string | null;
	loading: boolean;
	error: string | null;
	errorId: string | null;
};

export const SERVER_PLAYBACK_STATE: PlaybackState = {
	speakingId: null,
	loading: false,
	error: null,
	errorId: null,
};

let state: PlaybackState = SERVER_PLAYBACK_STATE;
let generation = 0;
let abort: AbortController | null = null;
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
		.replace(/\$(?=\S)[^$\n]*?\S\$(?!\d)/g, " formula ")
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

async function fetchAudio(text: string, signal: AbortSignal, request: typeof fetch = fetch): Promise<string> {
	const response = await request("/api/tts/speak", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ text }),
		signal,
	});
	if (!response.ok) {
		const body = (await response.json().catch(() => null)) as { message?: unknown } | null;
		throw new Error(typeof body?.message === "string" ? body.message : "Reading aloud failed");
	}
	return URL.createObjectURL(await response.blob());
}

function playUrl(url: string, signal: AbortSignal): Promise<void> {
	const element = new Audio(url);
	let onAbort = () => {};
	const playing = new Promise<void>((resolve, reject) => {
		onAbort = () => { element.pause(); resolve(); };
		element.addEventListener("ended", () => resolve(), { once: true });
		element.addEventListener("error", () => reject(new Error("The audio could not be played")), { once: true });
		signal.addEventListener("abort", onAbort, { once: true });
		element.play().catch(reject);
	});
	return playing.finally(() => {
		signal.removeEventListener("abort", onAbort);
		element.removeAttribute("src");
		element.load();
		URL.revokeObjectURL(url);
	});
}

async function playPieces(pieces: string[], current: number, signal: AbortSignal, request: typeof fetch = fetch): Promise<void> {
	let next: Promise<string> | undefined = fetchAudio(pieces[0]!, signal, request);
	try {
		for (let index = 0; index < pieces.length && current === generation; index++) {
			const url = await next!;
			next = index + 1 < pieces.length ? fetchAudio(pieces[index + 1]!, signal, request) : undefined;
			next?.catch(() => {});
			if (current !== generation) return URL.revokeObjectURL(url);
			publish({ loading: false });
			await playUrl(url, signal);
		}
	} finally {
		next?.then(URL.revokeObjectURL, () => {});
	}
}

export function stopSpeaking(): void {
	generation++;
	abort?.abort();
	abort = null;
	if (state.speakingId !== null || state.loading) publish({ speakingId: null, loading: false });
}

export function speak(id: string, markdown: string, request: typeof fetch = fetch): void {
	stopSpeaking();
	const pieces = splitForSpeech(toSpeakable(markdown));
	if (pieces.length === 0) return;
	const current = ++generation;
	const controller = new AbortController();
	abort = controller;
	publish({ speakingId: id, loading: true, error: null, errorId: null });
	playPieces(pieces, current, controller.signal, request)
		.catch((error: unknown) => {
			if (current === generation) publish({ error: error instanceof Error ? error.message : "Reading aloud failed", errorId: id });
		})
		.finally(() => {
			controller.abort();
			if (abort === controller) abort = null;
			if (current === generation) publish({ speakingId: null, loading: false });
		});
}

export function getSpeechPlaybackSnapshot(): PlaybackState {
	return state;
}

export function subscribeSpeechPlayback(listener: () => void): () => void {
	listeners.add(listener);
	return () => { listeners.delete(listener); };
}
