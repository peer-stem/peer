"use client";

import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { serializeCitation, sideSegmentId, type LhMessage, type SideChatThread } from "@/src/core";
import {
	consumeSideThreadStream,
	sideThreadReducer,
	type SideThreadOpenArgs,
} from "../src/client/engine/session/side-thread-state.ts";
import { useServerEvent, useServerResync } from "./server-events";

export * from "../src/client/engine/session/side-thread-state.ts";

export function useSideThread(chatId: string, messages: readonly LhMessage[], getWorking?: () => string) {
	const [state, dispatch] = useReducer(sideThreadReducer, null);
	const [threads, setThreads] = useState<SideChatThread[]>([]);
	const stateRef = useRef(state); stateRef.current = state;
	const messagesRef = useRef(messages); messagesRef.current = messages;
	const threadsRef = useRef(threads); threadsRef.current = threads;
	const workingRef = useRef(getWorking); workingRef.current = getWorking;
	const connection = useRef<{ controller: AbortController; token: number } | null>(null);
	const serial = useRef(0);
	const revision = useRef(0);
	const refreshSerial = useRef(0);
	const uncertain = useRef<{ segmentId: string; text: string; quote?: string; requestId: string } | null>(null);
	const drafts = useRef(new Map<string, string>());
	const [, syncExternalDraft] = useState(0);
	const draftFor = useCallback((threadId: string) => drafts.current.get(threadId) ?? "", []);
	const saveDraft = useCallback((threadId: string, text: string, notify = false) => {
		drafts.current.set(threadId, text);
		if (notify) syncExternalDraft((rev) => rev + 1);
	}, []);
	const adopt = useCallback((thread: SideChatThread) => {
		revision.current++;
		setThreads((current) => current.some((entry) => entry.id === thread.id)
			? current.map((entry) => (entry.id === thread.id ? thread : entry))
			: [...current, thread]);
	}, []);
	const refresh = useCallback(async () => {
		const request = ++refreshSerial.current;
		const before = revision.current;
		try {
			const response = await fetch(`/api/chats/${chatId}/side-chats`, { cache: "no-store" });
			if (!response.ok) return;
			const payload = (await response.json()) as { threads: SideChatThread[]; answering: Record<string, string> };
			if (request !== refreshSerial.current || before !== revision.current) return;
			setThreads(payload.threads);
			const current = stateRef.current;
			const thread = current && payload.threads.find((entry) => entry.id === current.threadId);
			if (thread) {
				dispatch({
					type: "snapshot",
					thread,
					answering: Object.hasOwn(payload.answering, thread.id),
					text: payload.answering[thread.id] ?? "",
				});
			}
		} catch { /* later change/resync retries */ }
	}, [chatId]);
	useEffect(() => {
		void refresh();
		return () => { refreshSerial.current++; connection.current?.controller.abort(); };
	}, [refresh]);
	useServerEvent("side-chats-changed", (event) => { if (event.chatId === chatId) void refresh(); });
	useServerEvent("record-changed", (event) => { if (event.chatId === chatId) void refresh(); });
	useServerResync(() => { void refresh(); });

	const consume = useCallback((response: Response, threadId: string, token: number) => consumeSideThreadStream({
		response,
		isCurrent: () => token === connection.current?.token,
		onThread: (thread, done) => {
			adopt(thread);
			dispatch({ type: done ? "done" : "snapshot", thread });
			uncertain.current = null;
		},
		onText: (text) => {
			revision.current++;
			dispatch({ type: "text", threadId, text });
		},
	}), [adopt]);

	const attach = useCallback((thread: SideChatThread) => {
		connection.current?.controller.abort();
		const controller = new AbortController();
		const token = ++serial.current;
		connection.current = { controller, token };
		void fetch(`/api/chats/${chatId}/side-chats/${thread.id}`, { cache: "no-store", signal: controller.signal })
			.then((response) => consume(response, thread.id, token))
			.catch((error) => {
				if (!controller.signal.aborted && token === connection.current?.token) {
					dispatch({ type: "error", threadId: thread.id, error: String(error.message ?? error) });
				}
			});
	}, [chatId, consume]);
	const open = useCallback(({ anchor, passage, sourceMessageId, questionCallId }: SideThreadOpenArgs) => {
		const source = sourceMessageId ?? passage?.sourceMessageId ?? (questionCallId
			? messagesRef.current.find((m) => m.role === "assistant" && m.content.some((b) => b.type === "toolCall" && b.id === questionCallId))?.id
			: undefined);
		const segmentId = sideSegmentId(messagesRef.current, source);
		if (!segmentId) return;
		const thread = threadsRef.current.find((entry) => entry.anchor.messageId === segmentId);
		dispatch({ type: "open", segmentId, anchor, passage, thread });
		if (thread) attach(thread);
		else { connection.current?.controller.abort(); connection.current = null; }
	}, [attach]);
	const close = useCallback((expectedThreadId?: string) => {
		if (expectedThreadId && stateRef.current?.threadId !== expectedThreadId) return;
		connection.current?.controller.abort();
		connection.current = null;
		dispatch({ type: "close" });
	}, []);
	const ask = useCallback(async (text: string, retry = false, expectedThreadId?: string): Promise<boolean> => {
		const current = stateRef.current;
		if (!current || (expectedThreadId && expectedThreadId !== current.threadId) || current.answering || (!text.trim() && !retry)) return false;
		const passage = current.pendingPassage;
		const quote = passage ? serializeCitation({
			version: 1, chatId, messageId: passage.sourceMessageId, text: passage.text,
			...(passage.selector ?? { start: 0, end: passage.text.length, prefix: "", suffix: "" }),
		}) : undefined;
		const previous = uncertain.current;
		const requestId = previous?.segmentId === current.segmentId && previous.text === text && previous.quote === quote
			? previous.requestId : `ask_${crypto.randomUUID().replaceAll("-", "")}`;
		uncertain.current = { segmentId: current.segmentId, text, quote, requestId };
		connection.current?.controller.abort();
		const controller = new AbortController();
		const token = ++serial.current;
		connection.current = { controller, token };
		revision.current++;
		dispatch({ type: "start", threadId: current.threadId });
		try {
			const existing = threadsRef.current.some((thread) => thread.id === current.threadId);
			const working = current.segmentId === sideSegmentId(messagesRef.current) ? workingRef.current?.() : undefined;
			const response = await fetch(`/api/chats/${chatId}/side-chats`, {
				method: "POST", headers: { "Content-Type": "application/json" }, signal: controller.signal,
				body: JSON.stringify({
					...(existing ? { threadId: current.threadId } : { anchor: { messageId: current.segmentId, partId: `${current.segmentId}-t0`, blockIndex: 0, blockText: "This teaching segment and its question." } }),
					text, quotes: passage ? [passage.text] : [], ...(quote ? { quoteCitations: [quote] } : {}), requestId,
					...(retry ? { retry: true, threadId: current.threadId } : {}), ...(working ? { working } : {}),
				}),
			});
			if (!response.ok) { await consume(response, current.threadId, token); return false; }
			dispatch({ type: "accepted", threadId: current.threadId });
			void consume(response, current.threadId, token).catch((error) => {
				if (!controller.signal.aborted && token === connection.current?.token) {
					dispatch({ type: "error", threadId: current.threadId, error: String(error.message ?? error) });
					void refresh();
				}
			});
			return true;
		} catch (error) {
			if (!controller.signal.aborted && token === connection.current?.token) {
				dispatch({ type: "error", threadId: current.threadId, error: String((error as Error).message ?? error), question: text });
			}
			return false;
		}
	}, [chatId, consume, refresh]);
	const stop = useCallback(() => {
		const current = stateRef.current;
		if (current) void fetch(`/api/chats/${chatId}/side-chats/${current.threadId}/stop`, { method: "POST" }).catch(() => {});
	}, [chatId]);
	return {
		state, threads, open, close, ask, stop, draftFor, saveDraft,
		currentSegmentId: sideSegmentId(messages),
		expand: () => dispatch({ type: "mode", mode: "panel" }),
		float: () => dispatch({ type: "mode", mode: "popover" }),
		hasHistory: (sourceMessageId: string) => {
			const segmentId = sideSegmentId(messages, sourceMessageId);
			return threads.some((thread) => thread.anchor.messageId === segmentId && thread.messages.length > 0);
		},
	};
}
