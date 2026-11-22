/**
 * Reactive dictation controller store (`f4-c2c`, `components/dictation.tsx` parity).
 * Supports hosted Deepgram WebSocket (`wss://api.deepgram.com/v1/listen`) with
 * warm `/api/stt/token` caching + keyless `503` detection, and local Whisper
 * (`LocalTranscriber` -> `POST /api/stt/transcribe`), enforcing a single active
 * recording session across all surfaces (`finish()` flush vs `cancel()` discard).
 */

import {
	SPEECH_SAMPLE_RATE,
	deepgramListenUrl,
	speechEndpointReady,
	type DictationLanguage,
} from "../../core/index.ts";
import {
	LocalTranscriber,
	rmsToMeter,
	setDictationActive,
	type ChunkSender,
} from "../engine/index.ts";
import type { ApiClient } from "./api.ts";
import type { SpeechIntent, SpeechModel } from "./speech.ts";
import { createCell, type Store } from "./store.ts";

export const DEEPGRAM_KEY_ID = "DEEPGRAM_API_KEY";
const TOKEN_REUSE_MS = 20_000;
const DEEPGRAM_FLUSH_MS = 1_500;

export type DictationPhase = "idle" | "connecting" | "recording" | "stopping";

export interface DictationModel {
	readonly phase: DictationPhase;
	readonly activeTargetId: string | null;
	readonly level: number;
	readonly error: string | null;
	readonly missingKey: boolean;
}

export interface AudioCaptureSession {
	stop(): void;
}

export type AudioCaptureFactory = (handlers: {
	onFrame: (pcm: ArrayBuffer) => void;
	onLevel: (level: number) => void;
}) => Promise<AudioCaptureSession>;

export interface WebSocketLike {
	readonly readyState: number;
	onopen: ((ev: unknown) => void) | null;
	onmessage: ((ev: { data: unknown }) => void) | null;
	onerror: ((ev: unknown) => void) | null;
	onclose: ((ev: unknown) => void) | null;
	send(data: string | ArrayBuffer): void;
	close(): void;
}

export interface DictationStartRequest {
	readonly targetId: string;
	readonly onTranscript: (text: string) => void;
}

export interface DictationStore extends Store<DictationModel, { readonly type: "cancel" | "warm-token" }> {
	start(req: DictationStartRequest): Promise<boolean>;
	finish(targetId?: string): Promise<void>;
	cancel(targetId?: string): void;
	warmToken(): void;
}

export interface CreateDictationStoreOptions {
	api: ApiClient;
	speech: Store<SpeechModel, SpeechIntent>;
	captureFactory?: AudioCaptureFactory;
	webSocketFactory?: (url: string, protocols: string[]) => WebSocketLike;
}

interface ActiveSession {
	readonly targetId: string;
	readonly cancel: () => void;
	readonly finish: () => Promise<void>;
}

const INITIAL_DICTATION: DictationModel = Object.freeze({
	phase: "idle",
	activeTargetId: null,
	level: 0,
	error: null,
	missingKey: false,
});

function wireWorkletPort(
	node: AudioWorkletNode,
	handlers: { onFrame: (pcm: ArrayBuffer) => void; onLevel: (level: number) => void },
): void {
	node.port.onmessage = (ev: MessageEvent<{ pcm?: ArrayBuffer; rms?: number }>) => {
		if (typeof ev.data?.rms === "number") handlers.onLevel(rmsToMeter(ev.data.rms));
		if (ev.data?.pcm instanceof ArrayBuffer) handlers.onFrame(ev.data.pcm);
	};
}

function makeCaptureSession(stream: MediaStream, ctx: AudioContext, source: MediaStreamAudioSourceNode, node: AudioWorkletNode): AudioCaptureSession {
	return {
		stop() {
			node.port.onmessage = null;
			source.disconnect();
			node.disconnect();
			for (const track of stream.getTracks()) track.stop();
			void ctx.close().catch(() => {});
		},
	};
}

async function createBrowserCapture(handlers: {
	onFrame: (pcm: ArrayBuffer) => void;
	onLevel: (level: number) => void;
}): Promise<AudioCaptureSession> {
	if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
		throw new Error("Microphone capture is unavailable in this environment.");
	}
	const stream = await navigator.mediaDevices.getUserMedia({
		audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
	});
	const ctx = new globalThis.AudioContext({ sampleRate: SPEECH_SAMPLE_RATE });
	try {
		await ctx.audioWorklet.addModule("/worklets/pcm-capture.js");
		const source = ctx.createMediaStreamSource(stream);
		const node = new AudioWorkletNode(ctx, "pcm-capture");
		wireWorkletPort(node, handlers);
		source.connect(node);
		return makeCaptureSession(stream, ctx, source, node);
	} catch (err) {
		for (const track of stream.getTracks()) track.stop();
		void ctx.close().catch(() => {});
		throw err;
	}
}

function makeChunkSender(api: ApiClient): ChunkSender {
	return async (wav, language, signal) => {
		const res = await api.fetch(`/api/stt/transcribe?language=${encodeURIComponent(language)}`, {
			method: "POST",
			headers: { "content-type": "audio/wav" },
			body: wav,
			signal,
		});
		const body = (await res.json().catch(() => null)) as { text?: unknown; message?: unknown; error?: unknown } | null;
		if (!res.ok) {
			const msg = typeof body?.message === "string" ? body.message : (typeof body?.error === "string" ? body.error : "Local dictation failed");
			throw new Error(msg);
		}
		return typeof body?.text === "string" ? body.text : "";
	};
}

function parseDeepgramTranscript(raw: unknown): string {
	if (typeof raw !== "string") return "";
	try {
		const msg = JSON.parse(raw) as {
			type?: string;
			is_final?: boolean;
			channel?: { alternatives?: { transcript?: string }[] };
		};
		if (msg.type !== "Results" || !msg.is_final) return "";
		return msg.channel?.alternatives?.[0]?.transcript?.trim() ?? "";
	} catch {
		return "";
	}
}

function flushDeepgramSocket(ws: WebSocketLike, isClosed: () => boolean, setWaiter: (fn: () => void) => void): Promise<void> {
	return new Promise<void>((done) => {
		if (isClosed()) { done(); return; }
		const timer = setTimeout(() => { ws.close(); done(); }, DEEPGRAM_FLUSH_MS);
		setWaiter(() => { clearTimeout(timer); done(); });
		try {
			ws.send(JSON.stringify({ type: "Finalize" }));
			ws.send(JSON.stringify({ type: "CloseStream" }));
		} catch { clearTimeout(timer); done(); }
	});
}

function connectDeepgramSocket(
	wsFactory: (url: string, protocols: string[]) => WebSocketLike,
	token: string,
	language: DictationLanguage,
	onTranscript: (text: string) => void,
	onFail: (message: string) => void,
): Promise<{ push: (pcm: ArrayBuffer) => void; finish: () => Promise<void>; abort: () => void }> {
	return new Promise((resolve, reject) => {
		const ws = wsFactory(deepgramListenUrl(language), ["bearer", token]);
		let opened = false;
		let closed = false;
		let closeWaiter: (() => void) | null = null;
		ws.onmessage = (ev) => { const text = parseDeepgramTranscript(ev.data); if (text) onTranscript(text); };
		ws.onerror = () => {
			if (!opened) reject(new Error("Could not connect to Deepgram."));
			else if (!closed) onFail("Deepgram connection interrupted.");
		};
		ws.onclose = () => { closed = true; closeWaiter?.(); };
		ws.onopen = () => {
			opened = true;
			const push = (pcm: ArrayBuffer) => { if (!closed && ws.readyState === 1) ws.send(pcm); };
			const finish = () => flushDeepgramSocket(ws, () => closed, (fn) => { closeWaiter = fn; });
			const abort = () => { closed = true; closeWaiter?.(); try { ws.close(); } catch { /* noop */ } };
			resolve({ push, finish, abort });
		};
	});
}

interface SessionControllerState {
	cancelled: boolean;
	capture: AudioCaptureSession | null;
	localTx: LocalTranscriber | null;
	dgConn: Awaited<ReturnType<typeof connectDeepgramSocket>> | null;
}

async function finishSessionState(
	st: SessionControllerState,
	targetId: string,
	onTranscript: (text: string) => void,
	patch: (next: Partial<DictationModel>) => void,
	clearIfCurrent: () => boolean,
): Promise<void> {
	if (st.cancelled) return;
	patch({ phase: "stopping", level: 0 });
	st.capture?.stop();
	st.capture = null;
	let finishErr: string | null = null;
	if (st.localTx) {
		const out = await st.localTx.finish();
		for (const part of out.texts) onTranscript(part);
		finishErr = out.error;
	} else if (st.dgConn) {
		await st.dgConn.finish();
	}
	setDictationActive(false);
	if (clearIfCurrent()) {
		patch({ phase: "idle", activeTargetId: finishErr ? targetId : null, level: 0, error: finishErr });
	}
}

function createSessionController(
	targetId: string,
	onTranscript: (text: string) => void,
	patch: (next: Partial<DictationModel>) => void,
	getActive: () => ActiveSession | null,
	clearActive: (s: ActiveSession) => void,
) {
	const st: SessionControllerState = { cancelled: false, capture: null, localTx: null, dgConn: null };
	const cleanup = () => { st.capture?.stop(); st.capture = null; setDictationActive(false); };
	const session: ActiveSession = {
		targetId,
		cancel() {
			st.cancelled = true;
			st.localTx?.discard();
			st.dgConn?.abort();
			cleanup();
			if (getActive() === session) { clearActive(session); patch({ phase: "idle", activeTargetId: null, level: 0 }); }
		},
		finish: () => finishSessionState(st, targetId, onTranscript, patch, () => {
			if (getActive() !== session) return false;
			clearActive(session);
			return true;
		}),
	};
	return { st, session, cleanup };
}

interface DictationRuntimeDeps {
	speech: Store<SpeechModel, SpeechIntent>;
	captureFactory: AudioCaptureFactory;
	wsFactory: (url: string, protocols: string[]) => WebSocketLike;
	sendChunk: ChunkSender;
	mintToken: () => Promise<string>;
	patch: (next: Partial<DictationModel>) => void;
	getActive: () => ActiveSession | null;
	setActive: (next: ActiveSession | null) => void;
	isDisposed: () => boolean;
}

async function runDictationStart(deps: DictationRuntimeDeps, { targetId, onTranscript }: DictationStartRequest): Promise<boolean> {
	if (deps.isDisposed()) return false;
	deps.getActive()?.cancel();
	const spModel = deps.speech.get();
	const isLocal = spModel.speech.dictation === "local";
	if (isLocal && !speechEndpointReady(spModel.speech)) {
		deps.patch({ phase: "idle", activeTargetId: targetId, level: 0, missingKey: false, error: "Local dictation needs a speech endpoint URL." });
		return false;
	}
	const ctl = createSessionController(targetId, onTranscript, deps.patch, deps.getActive, (s) => { if (deps.getActive() === s) deps.setActive(null); });
	deps.setActive(ctl.session);
	deps.patch({ phase: "connecting", activeTargetId: targetId, level: 0, error: null, missingKey: false });
	try {
		if (isLocal) ctl.st.localTx = new LocalTranscriber(spModel.language, deps.sendChunk);
		else {
			const token = await deps.mintToken();
			if (ctl.st.cancelled) return false;
			const onSocketFail = (msg: string) => { ctl.session.cancel(); deps.patch({ activeTargetId: targetId, error: msg }); };
			ctl.st.dgConn = await connectDeepgramSocket(deps.wsFactory, token, spModel.language, onTranscript, onSocketFail);
		}
		if (ctl.st.cancelled) { ctl.st.dgConn?.abort(); ctl.st.localTx?.discard(); return false; }
		ctl.st.capture = await deps.captureFactory({
			onLevel: (level) => { if (deps.getActive() === ctl.session) deps.patch({ level }); },
			onFrame: (pcm) => { if (!ctl.st.cancelled) { if (ctl.st.localTx) ctl.st.localTx.push(pcm); else ctl.st.dgConn?.push(pcm); } },
		});
		if (ctl.st.cancelled) { ctl.cleanup(); ctl.st.dgConn?.abort(); ctl.st.localTx?.discard(); return false; }
		setDictationActive(true);
		deps.patch({ phase: "recording", activeTargetId: targetId });
		return true;
	} catch (err) {
		ctl.cleanup(); ctl.st.dgConn?.abort(); ctl.st.localTx?.discard();
		if (deps.getActive() === ctl.session) deps.setActive(null);
		const isMissing = Boolean((err as { missingKey?: boolean })?.missingKey);
		deps.patch({ phase: "idle", activeTargetId: targetId, level: 0, missingKey: isMissing, error: err instanceof Error ? err.message : "Dictation failed." });
		return false;
	}
}

function createTokenMinter(api: ApiClient, speech: Store<SpeechModel, SpeechIntent>, isDisposed: () => boolean) {
	let cached: { token: string; mintedAt: number } | null = null;
	const mintToken = async (): Promise<string> => {
		if (cached && Date.now() - cached.mintedAt < TOKEN_REUSE_MS) {
			const tok = cached.token;
			cached = null;
			return tok;
		}
		const res = await api.fetch("/api/stt/token");
		const body = (await res.json().catch(() => null)) as { token?: string; message?: string; error?: string } | null;
		if (res.status === 503) {
			const err = new Error("Dictation needs a Deepgram key");
			(err as Error & { missingKey?: boolean }).missingKey = true;
			throw err;
		}
		if (!res.ok || typeof body?.token !== "string") throw new Error(body?.message ?? body?.error ?? "Could not start dictation.");
		return body.token;
	};
	const warmToken = () => {
		if (isDisposed() || speech.get().speech.dictation !== "deepgram") return;
		if (cached && Date.now() - cached.mintedAt < TOKEN_REUSE_MS) return;
		void mintToken().then((token) => { cached = { token, mintedAt: Date.now() }; }, () => {});
	};
	return { mintToken, warmToken };
}

export function createDictationStore(options: CreateDictationStoreOptions): DictationStore {
	const cell = createCell<DictationModel>(INITIAL_DICTATION);
	const captureFactory = options.captureFactory ?? createBrowserCapture;
	const wsFactory = options.webSocketFactory ?? ((url, protocols) => new WebSocket(url, protocols) as unknown as WebSocketLike);
	let active: ActiveSession | null = null;
	let disposed = false;
	const patch = (next: Partial<DictationModel>) => { if (!disposed) cell.set({ ...cell.get(), ...next }); };
	const { mintToken, warmToken } = createTokenMinter(options.api, options.speech, () => disposed);
	const deps: DictationRuntimeDeps = {
		speech: options.speech, captureFactory, wsFactory, sendChunk: makeChunkSender(options.api), mintToken, patch,
		getActive: () => active, setActive: (next) => { active = next; }, isDisposed: () => disposed,
	};
	return {
		get: () => cell.get(),
		subscribe: (fn) => cell.subscribe(fn),
		async send(intent) {
			if (intent.type === "cancel") active?.cancel();
			else if (intent.type === "warm-token") warmToken();
		},
		start: (req) => runDictationStart(deps, req),
		finish: async (targetId) => { if (active && (!targetId || active.targetId === targetId)) await active.finish(); },
		cancel: (targetId) => { if (active && (!targetId || active.targetId === targetId)) active.cancel(); },
		warmToken,
		dispose() { if (!disposed) { disposed = true; active?.cancel(); } },
	};
}
