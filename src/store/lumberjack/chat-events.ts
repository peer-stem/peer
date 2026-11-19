import type { ExtractionRunUsage, SideChatMessage, SideChatThread, TurnUsage } from "../../core/contracts.ts";
import type { LhMessage } from "../../core/native-messages.ts";
import type { EntryWire, EventSnapshot, LumberJackForest } from "./binding.ts";

export interface ReconstructedSessionEvents {
	messages: LhMessage[];
	sideChats?: SideChatThread[];
	turns?: TurnUsage[];
	extractions?: ExtractionRunUsage[];
}

const SIDE_EVENT_PREFIX = "side:";

function rankForIndex(index: number): string {
	return String(index).padStart(8, "0");
}

function toMainMessageWire(msg: LhMessage, index: number): EntryWire {
	return {
		id: msg.id || `msg_${index}`,
		rank: rankForIndex(index),
		content: msg,
		metadata: { channel: "main", role: (msg as { role?: string }).role ?? "unknown" },
	};
}

function jsonEqual(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
	if (Array.isArray(a) || Array.isArray(b)) {
		if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
		return a.every((item, idx) => jsonEqual(item, b[idx]));
	}
	const recA = a as Record<string, unknown>;
	const recB = b as Record<string, unknown>;
	const keysA = Object.keys(recA).filter((k) => recA[k] !== undefined);
	const keysB = Object.keys(recB).filter((k) => recB[k] !== undefined);
	if (keysA.length !== keysB.length) return false;
	return keysA.every((k) => Object.prototype.hasOwnProperty.call(recB, k) && jsonEqual(recA[k], recB[k]));
}

function isStrictAppendPrefix(existing: readonly EntryWire[], next: readonly LhMessage[]): boolean {
	if (next.length < existing.length) return false;
	for (let i = 0; i < existing.length; i++) {
		const prev = existing[i]!;
		const msg = next[i]!;
		const expectedId = msg.id || `msg_${i}`;
		if (prev.id !== expectedId) return false;
		if (!jsonEqual(prev.content, msg)) return false;
	}
	return true;
}

export function syncSessionMainEntries(forest: LumberJackForest, nodePath: string, messages: readonly LhMessage[]): void {
	const existing = forest.getEntries(nodePath, "main");
	if (existing.length === 0 && messages.length === 0) {
		forest.setEntries(nodePath, "main", []);
		return;
	}
	if (existing.length > 0 && isStrictAppendPrefix(existing, messages)) {
		if (messages.length === existing.length) return;
		const delta: EntryWire[] = [];
		for (let i = existing.length; i < messages.length; i++) {
			delta.push(toMainMessageWire(messages[i]!, i));
		}
		forest.appendEntries(nodePath, "main", delta);
		return;
	}
	forest.setEntries(
		nodePath,
		"main",
		messages.map((msg, idx) => toMainMessageWire(msg, idx)),
	);
}

function buildSideThreadMeta(thread: SideChatThread, order: number): Record<string, unknown> {
	return {
		threadId: thread.id,
		order,
		anchor: thread.anchor,
		open: thread.open,
		createdAt: thread.createdAt,
		...(thread.contextSnapshot !== undefined ? { contextSnapshot: thread.contextSnapshot } : {}),
	};
}

function toSideMessageWire(thread: SideChatThread, sm: SideChatMessage, idx: number): EntryWire {
	const anchorId = thread.anchor?.messageId ?? "";
	return {
		id: sm.id || `${thread.id}_${idx}`,
		parent_id: anchorId,
		rank: `${thread.id}:${rankForIndex(idx)}`,
		content: sm,
		metadata: { channel: "side-chat", threadId: thread.id, role: sm.role },
	};
}

export function syncSessionSideChatEvents(
	forest: LumberJackForest,
	nodePath: string,
	threads: readonly SideChatThread[],
): void {
	const currentEvents = forest.listEvents(nodePath).filter((ev) => ev.event_id.startsWith(SIDE_EVENT_PREFIX));
	const byEventId = new Map(currentEvents.map((ev) => [ev.event_id, ev]));
	const nextEventIds = new Set<string>();
	for (let order = 0; order < threads.length; order++) {
		const thread = threads[order]!;
		const eventId = `${SIDE_EVENT_PREFIX}${thread.id}`;
		nextEventIds.add(eventId);
		const prev = byEventId.get(eventId);
		const meta = buildSideThreadMeta(thread, order);
		const wires = thread.messages.map((sm, idx) => toSideMessageWire(thread, sm, idx));
		const canAppend =
			prev !== undefined &&
			thread.messages.length >= prev.entries.length &&
			prev.entries.every((e, i) => e.id === wires[i]?.id && jsonEqual(e.content, wires[i]?.content));
		if (canAppend) {
			const delta = wires.slice(prev.entries.length);
			forest.appendEntries(nodePath, eventId, delta, { eventMetadata: meta });
		} else {
			forest.setEntries(nodePath, eventId, wires, meta);
		}
	}
	for (const prev of currentEvents) {
		if (!nextEventIds.has(prev.event_id)) {
			forest.deleteEvent(nodePath, prev.event_id);
		}
	}
}

export function appendCanonicalTurnUsage(forest: LumberJackForest, nodePath: string, entry: TurnUsage): void {
	forest.appendEntries(nodePath, "turns", [
		{ id: `turn:${entry.id}`, content: entry, metadata: { channel: "turns", turnId: entry.id } },
	]);
}

export function appendCanonicalExtractionUsage(
	forest: LumberJackForest,
	nodePath: string,
	entry: ExtractionRunUsage,
): void {
	forest.appendEntries(nodePath, "extractions", [
		{
			id: `ext:${entry.startedAt}`,
			content: entry,
			metadata: { channel: "extractions", startedAt: entry.startedAt },
		},
	]);
}

function decodeSideThread(ev: EventSnapshot): { order: number; thread: SideChatThread } | null {
	const meta = ev.metadata ?? {};
	const threadId = typeof meta.threadId === "string" ? meta.threadId : ev.event_id.slice(SIDE_EVENT_PREFIX.length);
	if (!threadId || !meta.anchor || typeof meta.anchor !== "object") return null;
	const order = typeof meta.order === "number" ? meta.order : 0;
	const thread: SideChatThread = {
		id: threadId,
		anchor: meta.anchor as SideChatThread["anchor"],
		open: Boolean(meta.open),
		createdAt: typeof meta.createdAt === "string" ? meta.createdAt : "",
		messages: ev.entries.map((e) => e.content as SideChatMessage),
		...(Array.isArray(meta.contextSnapshot) ? { contextSnapshot: meta.contextSnapshot as SideChatMessage[] } : {}),
	};
	return { order, thread };
}

export function readCanonicalSessionEvents(forest: LumberJackForest, nodePath: string): ReconstructedSessionEvents {
	const events = forest.listEvents(nodePath);
	let messages: LhMessage[] = [];
	const sideDecoded: Array<{ order: number; thread: SideChatThread }> = [];
	let turns: TurnUsage[] | undefined;
	let extractions: ExtractionRunUsage[] | undefined;
	for (const ev of events) {
		if (ev.event_id === "main") {
			messages = ev.entries.map((e) => e.content as LhMessage);
		} else if (ev.event_id === "turns" && ev.entries.length > 0) {
			turns = ev.entries.map((e) => e.content as TurnUsage);
		} else if (ev.event_id === "extractions" && ev.entries.length > 0) {
			extractions = ev.entries.map((e) => e.content as ExtractionRunUsage);
		} else if (ev.event_id.startsWith(SIDE_EVENT_PREFIX)) {
			const parsed = decodeSideThread(ev);
			if (parsed) sideDecoded.push(parsed);
		}
	}
	sideDecoded.sort((a, b) => a.order - b.order);
	return {
		messages,
		...(sideDecoded.length > 0 ? { sideChats: sideDecoded.map((d) => d.thread) } : {}),
		...(turns ? { turns } : {}),
		...(extractions ? { extractions } : {}),
	};
}
