import type { AgentEvent } from "@earendil-works/pi-agent-core";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import type { LhMessage } from "../../../core/index.ts";
import { fetchSessionView } from "./record-sync.ts";
import { localId, sseEvents, STREAM_DROPPED, StreamReadError } from "./sse.ts";
import type { SessionInternals } from "./types.ts";

function applyNonAssistantMessage(s: SessionInternals, message: LhMessage & { id?: string }): boolean {
	const mid = message.id;
	if (mid === undefined || s.base.some((m) => m.id === mid)) return false;
	s.mutate(() => {
		const idx = s.tail.findIndex((m) => m.id === mid);
		s.tail = idx === -1 ? [...s.tail, message] : s.tail.with(idx, message);
	});
	return true;
}

function applyAssistantMessage(
	s: SessionInternals,
	type: "message_start" | "message_update" | "message_end",
	message: LhMessage & { id?: string; role?: string; stopReason?: string },
): boolean {
	const id = message.id ?? s.streamingMessageId ?? localId();
	const withId = { ...message, id } as LhMessage;
	if (type === "message_end") {
		s.incompleteUsageIds.delete(id);
		if (message.role === "assistant" && message.stopReason === "error") {
			s.liveFailureId = id;
			s.errorValue = null;
		}
	} else {
		s.incompleteUsageIds.add(id);
	}
	if (type === "message_start") {
		s.streamingMessageId = id;
		s.streamingIds.add(id);
		s.mutate(() => { s.tail = [...s.tail, withId]; });
	} else {
		s.mutate(() => {
			const idx = s.tail.findIndex((m) => m.id === id);
			s.tail = idx === -1 ? [...s.tail, withId] : s.tail.with(idx, withId);
		});
	}
	if (type === "message_end") s.streamingMessageId = null;
	return true;
}

function applyToolExecutionEnd(
	s: SessionInternals,
	agent: Extract<AgentEvent, { type: "tool_execution_end" }>,
): boolean {
	const result = agent.result as Pick<ToolResultMessage, "content" | "details"> | null;
	const text = result?.content?.find((c) => c.type === "text")?.text ?? "The tool call failed.";
	s.mutate(() => {
		s.executions = new Map(s.executions).set(agent.toolCallId, {
			isError: agent.isError,
			output: result?.details,
			errorText: text,
			...(result ? { result: { content: result.content, details: result.details, isError: agent.isError } } : {}),
		});
	});
	return true;
}

function applyTurnEnd(s: SessionInternals, toolResults: readonly ToolResultMessage[]): boolean {
	const stamped = toolResults.map((r) => ({ ...r, id: localId() }) as unknown as LhMessage);
	s.mutate(() => { s.tail = [...s.tail, ...stamped]; });
	return true;
}

export function applyWireEventToSession(s: SessionInternals, event: Record<string, unknown>): boolean {
	if (event.type === "error") {
		s.setError(String(event.errorText ?? "An error occurred."));
		return false;
	}
	const agent = event as unknown as AgentEvent;
	switch (agent.type) {
		case "agent_start":
			s.automaticContinuationBlocked = false;
			if (s.errorValue !== null) s.setError(null);
			return false;
		case "message_start":
		case "message_update":
		case "message_end": {
			const msg = agent.message as LhMessage & { role?: string; id?: string; stopReason?: string };
			return msg.role === "assistant" ? applyAssistantMessage(s, agent.type, msg) : applyNonAssistantMessage(s, msg);
		}
		case "tool_execution_end":
			return applyToolExecutionEnd(s, agent);
		case "turn_end":
			return applyTurnEnd(s, agent.toolResults as ToolResultMessage[]);
		default:
			return false;
	}
}

async function drainWireEvents(
	s: SessionInternals,
	reader: ReadableStreamDefaultReader<Uint8Array>,
	controller: AbortController | null,
): Promise<{ sawDone: boolean; detached: boolean }> {
	let sawEvent = false;
	const events = sseEvents(reader);
	for (;;) {
		let next: IteratorResult<Record<string, unknown>, boolean>;
		try { next = await events.next(); }
		catch (err) {
			if (err instanceof StreamReadError) return { sawDone: false, detached: false };
			throw err;
		}
		if (s.consumeAbort !== controller) return { sawDone: false, detached: true };
		if (next.done) return { sawDone: next.value, detached: false };
		if (next.value.type === "turn-settled") return { sawDone: true, detached: false };
		const acted = s.applyWireEvent(next.value);
		if (!sawEvent && acted) {
			sawEvent = true;
			if (s.statusValue !== "error") s.setStatus("streaming");
		}
	}
}

async function settleConsumedStream(
	s: SessionInternals,
	controller: AbortController | null,
	sawDone: boolean,
): Promise<void> {
	if (s.consumeAbort !== controller) return;
	s.streamingIds = new Set();
	s.executions = new Map();
	if (!sawDone) return;
	await s.reconcile();
	if (s.consumeAbort === controller && s.statusValue !== "error") s.setStatus("ready");
	if (s.consumeAbort === controller && s.reconciliationValue === "ready") s.onReattachSettled?.();
}

export async function consumeSessionStream(
	s: SessionInternals,
	res: Response,
	controller = s.consumeAbort,
	allowRecovery = true,
): Promise<void> {
	if (!res.body) throw new Error("The turn stream body is empty.");
	const reader = res.body.getReader();
	let outcome = { sawDone: false, detached: false };
	try {
		outcome = await drainWireEvents(s, reader, controller);
	} finally {
		await reader.cancel().catch(() => {});
		reader.releaseLock();
		await settleConsumedStream(s, controller, outcome.sawDone);
	}
	if (outcome.detached || s.consumeAbort !== controller || outcome.sawDone) return;
	if (!allowRecovery) throw new StreamReadError(new Error(STREAM_DROPPED));
	await s.resumeStream(true, false);
}

function clearReplaySlate(s: SessionInternals): void {
	s.mutate(() => {
		s.incompleteUsageIds.clear();
		s.tail = [];
		s.streamingMessageId = null;
	});
}

async function refetchResumeRecord(
	s: SessionInternals,
	controller: AbortController,
	allowRecovery: boolean,
): Promise<boolean> {
	const record = await s.readRecord({
		signal: controller.signal,
		allowInFlight: true,
		recoveringDrop: !allowRecovery,
		tolerateHttpFailure: true,
		isCurrent: () => s.consumeAbort === controller,
	});
	if (s.consumeAbort !== controller) return false;
	if (!record) clearReplaySlate(s);
	return true;
}

export async function resumeSessionStream(
	s: SessionInternals,
	refetchRecordFirst = true,
	allowRecovery = true,
): Promise<void> {
	s.retireImagePreview(s.imagePostOwner);
	s.releaseImagePost(s.imagePostOwner);
	s.consumeAbort?.abort();
	const controller = new AbortController();
	s.consumeAbort = controller;
	s.latestRequest = controller;
	if (!refetchRecordFirst) clearReplaySlate(s);
	s.setStatus("submitted");
	try {
		if (refetchRecordFirst && !(await refetchResumeRecord(s, controller, allowRecovery))) return;
		const res = await fetchSessionView(s, `/api/chats/${encodeURIComponent(s.chatId)}/stream`, controller.signal, !allowRecovery);
		if (s.consumeAbort !== controller) return;
		if (!res.ok) throw new Error((await res.text()) || "Failed to attach to the running turn.");
		await s.consumeStream(res, controller, allowRecovery);
	} catch (err) {
		if (s.consumeAbort !== controller || controller.signal.aborted) return;
		s.retireImagePreview(s.imagePreview?.owner ?? null);
		s.mutate(() => {
			s.tail = s.tail.filter((m) => !s.unconfirmedAnswers.has(m.id));
			s.unconfirmedAnswers.clear();
		});
		s.setError(!allowRecovery && err instanceof StreamReadError ? STREAM_DROPPED : (err as Error).message);
		s.setStatus("error");
	}
}
