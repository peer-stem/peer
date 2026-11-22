import { SPEECH_SAMPLE_RATE } from "../../../core/index.ts";

const MIN_CHUNK_MS = 3_000;
const MAX_CHUNK_MS = 14_000;
const PAUSE_MS = 700;
const QUIET_RMS = 0.012;
const WAV_HEADER_BYTES = 44;

export type ChunkSender = (wav: Blob, language: string, signal: AbortSignal) => Promise<string>;
export type LocalTranscript = { texts: string[]; error: string | null };

function rmsOf(frame: ArrayBuffer): number {
	const samples = new Int16Array(frame, 0, Math.floor(frame.byteLength / 2));
	if (samples.length === 0) return 0;
	let sum = 0;
	for (const sample of samples) sum += (sample / 32768) ** 2;
	return Math.sqrt(sum / samples.length);
}

/** 16-bit mono PCM frames → one WAV file. */
export function toWav(frames: ArrayBuffer[], rate: number = SPEECH_SAMPLE_RATE): Blob {
	const dataBytes = frames.reduce((total, frame) => total + frame.byteLength, 0);
	const header = new DataView(new ArrayBuffer(WAV_HEADER_BYTES));
	const ascii = (offset: number, text: string) => {
		for (let i = 0; i < text.length; i++) header.setUint8(offset + i, text.charCodeAt(i));
	};
	ascii(0, "RIFF");
	header.setUint32(4, 36 + dataBytes, true);
	ascii(8, "WAVEfmt ");
	header.setUint32(16, 16, true);
	header.setUint16(20, 1, true);
	header.setUint16(22, 1, true);
	header.setUint32(24, rate, true);
	header.setUint32(28, rate * 2, true);
	header.setUint16(32, 2, true);
	header.setUint16(34, 16, true);
	ascii(36, "data");
	header.setUint32(40, dataBytes, true);
	return new Blob([header.buffer, ...frames], { type: "audio/wav" });
}

export const postChunk: ChunkSender = async (wav, language, signal) => {
	const response = await fetch(`/api/stt/transcribe?language=${encodeURIComponent(language)}`, {
		method: "POST",
		headers: { "Content-Type": "audio/wav" },
		body: wav,
		signal,
	});
	const body = (await response.json().catch(() => null)) as { text?: unknown; message?: unknown } | null;
	if (!response.ok) throw new Error(typeof body?.message === "string" ? body.message : "Local dictation failed");
	return typeof body?.text === "string" ? body.text : "";
};

export class LocalTranscriber {
	private frames: ArrayBuffer[] = [];
	private chunkMs = 0;
	private quietMs = 0;
	private voiced = false;
	private finished = false;
	private readonly parts: Promise<string>[] = [];
	private readonly requests = new AbortController();

	constructor(private readonly language: string, private readonly send: ChunkSender = postChunk) {}

	push(frame: ArrayBuffer): void {
		if (this.finished) return;
		const ms = (frame.byteLength / 2 / SPEECH_SAMPLE_RATE) * 1000;
		const quiet = rmsOf(frame) < QUIET_RMS;
		this.frames.push(frame);
		this.chunkMs += ms;
		this.quietMs = quiet ? this.quietMs + ms : 0;
		this.voiced ||= !quiet;
		const paused = this.chunkMs >= MIN_CHUNK_MS && this.quietMs >= PAUSE_MS;
		if (paused || this.chunkMs >= MAX_CHUNK_MS) this.cut();
	}

	async finish(): Promise<LocalTranscript> {
		this.cut();
		this.finished = true;
		const settled = await Promise.allSettled(this.parts);
		const failed = settled.find((result): result is PromiseRejectedResult => result.status === "rejected");
		return {
			texts: settled.flatMap((result) => (result.status === "fulfilled" && result.value ? [result.value] : [])),
			error: failed ? (failed.reason instanceof Error ? failed.reason.message : "Local dictation failed") : null,
		};
	}

	discard(): void {
		this.finished = true;
		this.reset();
		this.requests.abort();
	}

	private cut(): void {
		const { frames, voiced } = this;
		this.reset();
		if (frames.length === 0 || !voiced) return;
		const part = this.send(toWav(frames), this.language, this.requests.signal);
		part.catch(() => {});
		this.parts.push(part);
	}

	private reset(): void {
		this.frames = [];
		this.chunkMs = 0;
		this.quietMs = 0;
		this.voiced = false;
	}
}
