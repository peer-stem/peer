/**
 * Per-chat durable side-thread store (`f3-c2b §3`).
 * Wraps `sideThreadReducer` and `consumeSideThreadStream` (`peer-engine`),
 * hydrates `/api/chats/[id]/side-chats`, attaches NDJSON answer streams,
 * and handles open/close/mode/draft/ask/stop intents.
 */

import {
	serializeCitation,
	sideSegmentId,
	type LhMessage,
	type SideChatThread,
} from "../../core/index.ts";
import {
	consumeSideThreadStream,
	sideThreadReducer,
	type SidePassage,
	type SideThreadAction,
	type SideThreadAnchor,
	type SideThreadOpenArgs,
	type SideThreadState,
} from "../engine/index.ts";
import { apiPath, isAbortError, type ApiClient } from "./api.ts";
import type { Events } from "./events.ts";
import {
	assertNeverIntent,
	createCell,
	createStoreFromCell,
	type Cell,
	type Store,
	type Unsubscribe,
} from "./store.ts";

export type { SidePassage, SideThreadAnchor, SideThreadOpenArgs, SideThreadState };

export interface SideThreadStoreModel {
	readonly chatId: string;
	readonly threads: readonly SideChatThread[];
	readonly active: SideThreadState | null;
	readonly drafts: Readonly<Record<string, string>>;
	readonly currentSegmentId: string | undefined;
}

export type SideThreadIntent =
	| { readonly type: "refresh" }
	| { readonly type: "open"; readonly args: SideThreadOpenArgs }
	| { readonly type: "close"; readonly expectedThreadId?: string }
	| { readonly type: "set-mode"; readonly mode: "popover" | "panel" }
	| { readonly type: "set-draft"; readonly threadId: string; readonly text: string }
	| {
			readonly type: "ask";
			readonly text: string;
			readonly retry?: boolean;
			readonly expectedThreadId?: string;
	  }
	| { readonly type: "stop" };

export interface CreateSideThreadStoreOptions {
	chatId: string;
	api: ApiClient;
	events: Events;
	getMessages?: () => readonly LhMessage[];
	getWorking?: () => string | undefined;
}

interface SideThreadContext {
	readonly chatId: string;
	readonly api: ApiClient;
	readonly cell: Cell<SideThreadStoreModel>;
	readonly getMessages: () => readonly LhMessage[];
	readonly getWorking?: () => string | undefined;
	disposed: boolean;
	threads: readonly SideChatThread[];
	active: SideThreadState | null;
	drafts: Readonly<Record<string, string>>;
	connection: { controller: AbortController; token: number } | null;
	serial: number;
	revision: number;
	refreshSerial: number;
	uncertain: { segmentId: string; text: string; quote?: string; requestId: string } | null;
}

function publishSideThread(ctx: SideThreadContext): void {
	if (ctx.disposed) return;
	const currentSegmentId = sideSegmentId(ctx.getMessages()) ?? undefined;
	ctx.cell.set({
		chatId: ctx.chatId,
		threads: ctx.threads,
		active: ctx.active,
		drafts: ctx.drafts,
		currentSegmentId,
	});
}

function dispatchSideAction(ctx: SideThreadContext, action: SideThreadAction): void {
	ctx.active = sideThreadReducer(ctx.active, action);
	publishSideThread(ctx);
}

function abortSideConnection(ctx: SideThreadContext): void {
	ctx.connection?.controller.abort();
	ctx.connection = null;
}

function adoptThreadInList(ctx: SideThreadContext, thread: SideChatThread): void {
	ctx.revision += 1;
	const exists = ctx.threads.some((entry) => entry.id === thread.id);
	const next = exists
		? ctx.threads.map((entry) => (entry.id === thread.id ? thread : entry))
		: [...ctx.threads, thread];
	ctx.threads = Object.freeze(next);
	if (
		ctx.active &&
		ctx.active.threadId !== thread.id &&
		ctx.active.segmentId === thread.anchor.messageId
	) {
		ctx.active = { ...ctx.active, threadId: thread.id };
	}
}

function syncRefreshedActiveThread(
	ctx: SideThreadContext,
	answering: Record<string, string>,
): void {
	if (!ctx.active) return;
	const matched = ctx.threads.find((entry) => entry.id === ctx.active!.threadId);
	if (!matched) return;
	const isAnswering = Object.hasOwn(answering, matched.id);
	const text = answering[matched.id] ?? "";
	ctx.active = sideThreadReducer(ctx.active, {
		type: "snapshot",
		thread: matched,
		answering: isAnswering,
		text,
	});
}

async function refreshSideThreads(ctx: SideThreadContext): Promise<void> {
	if (ctx.disposed) return;
	const request = ++ctx.refreshSerial;
	const before = ctx.revision;
	try {
		const payload = await ctx.api.json<{
			threads?: unknown;
			answering?: Record<string, string>;
		}>(apiPath`/api/chats/${ctx.chatId}/side-chats`);
		if (ctx.disposed || request !== ctx.refreshSerial || before !== ctx.revision) return;
		if (!payload || !Array.isArray(payload.threads)) return;
		ctx.threads = Object.freeze([...(payload.threads as SideChatThread[])]);
		const answering =
			payload.answering && typeof payload.answering === "object" ? payload.answering : {};
		syncRefreshedActiveThread(ctx, answering);
		publishSideThread(ctx);
	} catch {
		/* later side-chats-changed or resync retries */
	}
}

function consumeSideStream(
	ctx: SideThreadContext,
	response: Response,
	initialThreadId: string,
	token: number,
): Promise<void> {
	let liveThreadId = initialThreadId;
	return consumeSideThreadStream({
		response,
		isCurrent: () => !ctx.disposed && token === ctx.connection?.token,
		onThread(thread, done) {
			liveThreadId = thread.id;
			adoptThreadInList(ctx, thread);
			ctx.uncertain = null;
			dispatchSideAction(ctx, { type: done ? "done" : "snapshot", thread });
		},
		onText(text) {
			ctx.revision += 1;
			dispatchSideAction(ctx, { type: "text", threadId: liveThreadId, text });
		},
	});
}

async function handleWatchResponse(
	ctx: SideThreadContext,
	response: Response,
	threadId: string,
	token: number,
): Promise<void> {
	const ct = response.headers.get("content-type") ?? "";
	if (response.ok && ct.includes("application/json") && !ct.includes("ndjson")) {
		const json = (await response.json().catch(() => null)) as { thread?: SideChatThread } | null;
		if (json?.thread && !ctx.disposed && token === ctx.connection?.token) {
			adoptThreadInList(ctx, json.thread);
			dispatchSideAction(ctx, { type: "snapshot", thread: json.thread });
		}
		return;
	}
	await consumeSideStream(ctx, response, threadId, token);
}

function attachToExistingThread(ctx: SideThreadContext, thread: SideChatThread): void {
	abortSideConnection(ctx);
	const controller = new AbortController();
	const token = ++ctx.serial;
	ctx.connection = { controller, token };
	const path = apiPath`/api/chats/${ctx.chatId}/side-chats/${thread.id}`;
	void ctx.api
		.request(path, { method: "GET", signal: controller.signal })
		.then((res) => handleWatchResponse(ctx, res, thread.id, token))
		.catch((err) => {
			if (ctx.disposed || controller.signal.aborted || isAbortError(err)) return;
			if (token !== ctx.connection?.token) return;
			const msg = err instanceof Error ? err.message : String(err);
			dispatchSideAction(ctx, { type: "error", threadId: thread.id, error: msg });
		});
}

function findMessageWithQuestionCall(
	messages: readonly LhMessage[],
	questionCallId: string,
): string | undefined {
	for (const m of messages) {
		if (m.role !== "assistant") continue;
		if (m.content.some((b) => b.type === "toolCall" && b.id === questionCallId)) return m.id;
	}
	return undefined;
}

function resolveOpenSegmentId(
	ctx: SideThreadContext,
	args: SideThreadOpenArgs,
): string | null {
	const messages = ctx.getMessages();
	const fromQuestion = args.questionCallId
		? findMessageWithQuestionCall(messages, args.questionCallId)
		: undefined;
	const source = args.sourceMessageId ?? args.passage?.sourceMessageId ?? fromQuestion;
	if (messages.length > 0) return sideSegmentId(messages, source);
	return source ?? ctx.threads[0]?.anchor.messageId ?? null;
}

function openSideConversation(ctx: SideThreadContext, args: SideThreadOpenArgs): void {
	const segmentId = resolveOpenSegmentId(ctx, args);
	if (!segmentId) return;
	const thread = ctx.threads.find((entry) => entry.anchor.messageId === segmentId);
	dispatchSideAction(ctx, {
		type: "open",
		segmentId,
		anchor: args.anchor,
		passage: args.passage,
		thread,
	});
	if (thread) attachToExistingThread(ctx, thread);
	else abortSideConnection(ctx);
}

function buildAskQuote(chatId: string, passage: SidePassage | undefined): string | undefined {
	if (!passage) return undefined;
	return serializeCitation({
		version: 1,
		chatId,
		messageId: passage.sourceMessageId,
		text: passage.text,
		...(passage.selector ?? { start: 0, end: passage.text.length, prefix: "", suffix: "" }),
	});
}

function nextAskRequestId(
	ctx: SideThreadContext,
	segmentId: string,
	text: string,
	quote: string | undefined,
): string {
	const prev = ctx.uncertain;
	const same = prev?.segmentId === segmentId && prev.text === text && prev.quote === quote;
	const requestId = same ? prev!.requestId : `ask_${crypto.randomUUID().replaceAll("-", "")}`;
	ctx.uncertain = { segmentId, text, quote, requestId };
	return requestId;
}

function buildAskRequestBody(
	ctx: SideThreadContext,
	current: SideThreadState,
	text: string,
	retry: boolean,
): Record<string, unknown> {
	const passage = current.pendingPassage;
	const quote = buildAskQuote(ctx.chatId, passage);
	const requestId = nextAskRequestId(ctx, current.segmentId, text, quote);
	const existing = ctx.threads.some((t) => t.id === current.threadId);
	const messages = ctx.getMessages();
	const activeSeg = messages.length > 0 ? sideSegmentId(messages) : current.segmentId;
	const working = current.segmentId === activeSeg ? ctx.getWorking?.() : undefined;
	const anchor = {
		messageId: current.segmentId,
		partId: `${current.segmentId}-t0`,
		blockIndex: 0,
		blockText: "This teaching segment and its question.",
	};
	return {
		...(existing ? { threadId: current.threadId } : { anchor }),
		text,
		quotes: passage ? [passage.text] : [],
		...(quote ? { quoteCitations: [quote] } : {}),
		requestId,
		...(retry ? { retry: true, threadId: current.threadId } : {}),
		...(working ? { working } : {}),
	};
}

async function askSideQuestion(
	ctx: SideThreadContext,
	text: string,
	retry = false,
	expectedThreadId?: string,
): Promise<void> {
	const current = ctx.active;
	if (!current || current.answering) return;
	if (expectedThreadId && expectedThreadId !== current.threadId) return;
	if (!text.trim() && !retry) return;
	const body = buildAskRequestBody(ctx, current, text, retry);
	abortSideConnection(ctx);
	const controller = new AbortController();
	const token = ++ctx.serial;
	ctx.connection = { controller, token };
	ctx.revision += 1;
	dispatchSideAction(ctx, { type: "start", threadId: current.threadId });
	try {
		const res = await ctx.api.request(apiPath`/api/chats/${ctx.chatId}/side-chats`, {
			method: "POST",
			json: body,
			signal: controller.signal,
		});
		if (!res.ok) {
			await consumeSideStream(ctx, res, current.threadId, token);
			return;
		}
		dispatchSideAction(ctx, { type: "accepted", threadId: current.threadId });
		await consumeSideStream(ctx, res, current.threadId, token);
	} catch (err) {
		if (ctx.disposed || controller.signal.aborted || isAbortError(err)) return;
		if (token !== ctx.connection?.token) return;
		const msg = err instanceof Error ? err.message : String(err);
		const targetId = ctx.active?.threadId ?? current.threadId;
		dispatchSideAction(ctx, { type: "error", threadId: targetId, error: msg, question: text });
		void refreshSideThreads(ctx);
	}
}

async function stopSideAnswer(ctx: SideThreadContext): Promise<void> {
	const current = ctx.active;
	if (!current) return;
	const path = apiPath`/api/chats/${ctx.chatId}/side-chats/${current.threadId}/stop`;
	await ctx.api.request(path, { method: "POST" }).catch(() => {});
}

async function handleSideThreadIntent(
	ctx: SideThreadContext,
	intent: SideThreadIntent,
): Promise<void> {
	switch (intent.type) {
		case "refresh":
			return refreshSideThreads(ctx);
		case "open":
			openSideConversation(ctx, intent.args);
			return;
		case "close":
			if (intent.expectedThreadId && ctx.active?.threadId !== intent.expectedThreadId) return;
			abortSideConnection(ctx);
			dispatchSideAction(ctx, { type: "close" });
			return;
		case "set-mode":
			dispatchSideAction(ctx, { type: "mode", mode: intent.mode });
			return;
		case "set-draft":
			if (ctx.drafts[intent.threadId] === intent.text) return;
			ctx.drafts = Object.freeze({ ...ctx.drafts, [intent.threadId]: intent.text });
			publishSideThread(ctx);
			return;
		case "ask":
			return askSideQuestion(ctx, intent.text, intent.retry, intent.expectedThreadId);
		case "stop":
			return stopSideAnswer(ctx);
		default:
			return assertNeverIntent(intent);
	}
}

function wireSideThreadEvents(ctx: SideThreadContext, events: Events): Unsubscribe {
	const offs: Unsubscribe[] = [
		events.on("side-chats-changed", (ev) => {
			if (ev.chatId === ctx.chatId) void refreshSideThreads(ctx);
		}),
		events.on("record-changed", (ev) => {
			if (ev.chatId === ctx.chatId) void refreshSideThreads(ctx);
		}),
		events.onResync(() => {
			void refreshSideThreads(ctx);
		}),
	];
	return () => {
		for (const off of offs) off();
	};
}

export function createSideThreadStore(
	options: CreateSideThreadStoreOptions,
): Store<SideThreadStoreModel, SideThreadIntent> {
	const getMessages = options.getMessages ?? (() => []);
	const emptyThreads: readonly SideChatThread[] = Object.freeze([]);
	const emptyDrafts: Readonly<Record<string, string>> = Object.freeze({});
	const cell = createCell<SideThreadStoreModel>({
		chatId: options.chatId,
		threads: emptyThreads,
		active: null,
		drafts: emptyDrafts,
		currentSegmentId: sideSegmentId(getMessages()) ?? undefined,
	});
	const ctx: SideThreadContext = {
		chatId: options.chatId,
		api: options.api,
		cell,
		getMessages,
		getWorking: options.getWorking,
		disposed: false,
		threads: emptyThreads,
		active: null,
		drafts: emptyDrafts,
		connection: null,
		serial: 0,
		revision: 0,
		refreshSerial: 0,
		uncertain: null,
	};
	const offEvents = wireSideThreadEvents(ctx, options.events);
	void refreshSideThreads(ctx);

	return createStoreFromCell<SideThreadStoreModel, SideThreadIntent>(cell, {
		onSend: (intent) => handleSideThreadIntent(ctx, intent),
		onDispose() {
			ctx.disposed = true;
			ctx.refreshSerial += 1;
			offEvents();
			abortSideConnection(ctx);
		},
	});
}
