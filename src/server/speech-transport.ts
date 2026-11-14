/** Byte bounds and the HTTP client for the speech proxy. Bodies are counted
 * as they stream, never trusted from Content-Length alone, and the client
 * waits for response headers as long as the slowest speech call may take. */
import { Agent, fetch as undiciFetch } from "undici";

export class SpeechBodyLimitError extends Error {}

export type SpeechFetch = (url: string, init: RequestInit) => Promise<Response>;

/** The same bytes, erroring (and cancelling the source) once more than `limit` have passed. */
export function cappedStream(body: ReadableStream<Uint8Array>, limit: number): ReadableStream<Uint8Array> {
	let bytes = 0;
	return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
		transform(chunk, controller) {
			bytes += chunk.byteLength;
			if (bytes > limit) controller.error(new SpeechBodyLimitError("Speech body exceeds its byte limit"));
			else controller.enqueue(chunk);
		},
	}));
}

/** The whole request body; rejects as soon as it passes `limit` bytes. */
export async function readBoundedBytes(request: Request, limit: number): Promise<ArrayBuffer> {
	if (Number(request.headers.get("content-length")) > limit) {
		void request.body?.cancel().catch(() => undefined);
		throw new SpeechBodyLimitError("Speech body exceeds its byte limit");
	}
	if (!request.body) return new ArrayBuffer(0);
	return new Response(cappedStream(request.body, limit)).arrayBuffer();
}

/** Node's fetch gives up after 300 s without response headers (undici's
 * default `headersTimeout`). A speech server sends its headers only when the
 * job is done, so the per-call AbortSignal must be the only deadline. */
export function speechFetch(longestCallMs: number): SpeechFetch {
	const dispatcher = new Agent({ headersTimeout: longestCallMs });
	return async (url, init) => (await undiciFetch(url, { ...(init as object), dispatcher })) as unknown as Response;
}
