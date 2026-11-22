import type { ToolResultMessage } from "@earendil-works/pi-ai";
import type { LhMarkerMessage, LhMessage } from "../../../core/index.ts";
import type { SteerQueueItem } from "./types.ts";

let localSeq = 0;

export function localId(): string {
	return `c_${Date.now().toString(36)}_${(localSeq++).toString(36)}`;
}

export function delay(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const t = setTimeout(resolve, ms);
		const onAbort = () => {
			clearTimeout(t);
			reject(new DOMException("Aborted", "AbortError"));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

export const STREAM_DROPPED = "The connection dropped before the turn completed.";

export class StreamReadError extends Error {
	constructor(cause: unknown) {
		super(cause instanceof Error ? cause.message : String(cause), { cause });
	}
}

/** Wire events; return true ONLY for the explicit completion marker. */
export async function* sseEvents(
	reader: ReadableStreamDefaultReader<Uint8Array>,
): AsyncGenerator<Record<string, unknown>, boolean> {
	const decoder = new TextDecoder();
	let buf = "";
	for (;;) {
		let chunk: ReadableStreamReadResult<Uint8Array>;
		try {
			chunk = await reader.read();
		} catch (err) {
			throw new StreamReadError(err);
		}
		if (chunk.done) return false;
		buf += decoder.decode(chunk.value, { stream: true });
		for (let end = buf.indexOf("\n\n"); end !== -1; end = buf.indexOf("\n\n")) {
			const event = buf.slice(0, end);
			buf = buf.slice(end + 2);
			const dataLine = event.split("\n").find((l) => l.startsWith("data: "));
			if (!dataLine) continue;
			const data = dataLine.slice("data: ".length);
			if (data === "[DONE]") return true;
			yield JSON.parse(data) as Record<string, unknown>;
		}
	}
}

/** The dangling question call's tool name. */
export function pendingCallTool(messages: readonly LhMessage[], toolCallId: string): string | null {
	for (let mi = messages.length - 1; mi >= 0; mi--) {
		const m = messages[mi]!;
		if (m.role !== "assistant") continue;
		for (let bi = m.content.length - 1; bi >= 0; bi--) {
			const block = m.content[bi]!;
			if (block.type === "toolCall" && block.id === toolCallId) return block.name;
		}
	}
	return null;
}

function sameDetails(a: unknown, b: unknown): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

function sameUserContent(recordEntry: LhMessage, content: unknown): boolean {
	if ((recordEntry as { role?: string }).role !== "user") return false;
	const other = (recordEntry as { content?: unknown }).content;
	return Array.isArray(content) ? sameDetails(other, content) : other === content;
}

function sameCustomMarker(recordEntry: LhMessage, marker: LhMarkerMessage): boolean {
	if ((recordEntry as { role?: string }).role !== "custom") return false;
	const other = recordEntry as LhMarkerMessage;
	return other.customType === marker.customType && sameDetails(other.details, marker.details);
}

/** Has the record ABSORBED this optimistic tail entry? */
export function absorbed(m: LhMessage, record: readonly LhMessage[]): boolean {
	if (typeof m.id !== "string" || !m.id.startsWith("c_")) return false;
	const role = (m as { role?: string }).role;
	if (role === "user") {
		const content = (m as { content?: unknown }).content;
		return record.some((r) => sameUserContent(r, content));
	}
	if (role === "toolResult") {
		const toolCallId = (m as ToolResultMessage).toolCallId;
		return record.some((r) => (r as { role?: string }).role === "toolResult" && (r as ToolResultMessage).toolCallId === toolCallId);
	}
	if (role === "custom") {
		const marker = m as LhMarkerMessage;
		return record.some((r) => sameCustomMarker(r, marker));
	}
	return false;
}

export function visibleQueuedSteers(
	queue: readonly SteerQueueItem[],
	messages: readonly LhMessage[],
): SteerQueueItem[] {
	const ids = new Set(messages.map((m) => (m as { id?: string }).id));
	return queue.filter((s) => !ids.has(s.id));
}
