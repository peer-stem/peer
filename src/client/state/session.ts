/**
 * Per-chat session store (`c2a-frozen-contracts §3.6`, `client-contract-state §2.3, §3`).
 * Wraps `SessionModel` (`peer-engine`), hydrates `/objects` snapshots,
 * manages `opening-prompt.ts` handoff, and gates `continue-if-owed` on `configured`.
 */

import {
	activeProblemOf,
	pendingQuestionOf,
	type ChatKind,
	type ChatSettings,
	type ImageSnapshot,
	type LhMessage,
	type PlanTree,
	type QuestionAnswerData,
	type QuestionDraft,
	type SessionPricing,
} from "../../core/index.ts";
import {
	clearOpeningPrompt,
	SessionModel,
	visibleQueuedSteers,
	type PluginProblemAvailability,
	type PluginQuestionAvailability,
	type SessionState,
	type SteerQueueItem,
} from "../engine/index.ts";
import { ApiError, apiPath, isAbortError, type ApiClient } from "./api.ts";
import type { Events } from "./events.ts";
import {
	handleDockOrRecoveryIntent,
	latestTreeFromMessages,
	runInitialMountHandoff,
	scanAndHydrateImages,
	sendComposerIntent,
	settlePendingMountWork,
	type SessionHydrationTarget,
} from "./session-helpers.ts";
import type { SettingsIntent, SettingsModel } from "./settings.ts";
import {
	assertNeverIntent,
	createCell,
	createStoreFromCell,
	type Cell,
	type LoadState,
	type Store,
	type Unsubscribe,
} from "./store.ts";

export interface ImageSnapshotEntry {
	readonly status: "loading" | "ready" | "error";
	readonly image?: ImageSnapshot;
}

export interface AttachedImageInput {
	readonly type: "image";
	readonly mimeType: string;
	readonly data: string;
}

export interface SessionStoreModel {
	readonly load: LoadState;
	readonly error: string | null;
	readonly chatId: string;
	readonly title: string;
	readonly kind: ChatKind;
	readonly compacting: boolean;
	readonly state: SessionState | null;
	readonly turnError: string | null;
	readonly imageSnapshots: Readonly<Record<string, ImageSnapshotEntry>>;
	readonly tree?: PlanTree | null;
	readonly chatSettings?: ChatSettings | null;
	readonly pricing?: SessionPricing | null;
	readonly coverage?: Readonly<Record<string, unknown>> | null;
	readonly queuedSteers?: readonly SteerQueueItem[];
	readonly pendingQuestion?: ReturnType<typeof pendingQuestionOf> | null;
	readonly activeProblem?: ReturnType<typeof activeProblemOf> | null;
	readonly questionDraft?: QuestionDraft | null;
	readonly openingDraft?: string | null;
}

export type SessionIntent =
	| { readonly type: "reload" }
	| { readonly type: "send-text"; readonly text: string; readonly images?: readonly AttachedImageInput[] }
	| { readonly type: "steer"; readonly text: string; readonly images?: readonly AttachedImageInput[] }
	| { readonly type: "stop" }
	| {
			readonly type: "answer-question";
			readonly tool: string;
			readonly toolCallId: string;
			readonly answer: QuestionAnswerData;
			readonly questionKey?: string;
	  }
	| {
			readonly type: "dismiss-question";
			readonly toolCallId: string;
			readonly answer: QuestionAnswerData;
			readonly questionKey?: string;
	  }
	| { readonly type: "dismiss-problem"; readonly problemCallId: string }
	| {
			readonly type: "submit-thinking";
			readonly problemCallId: string;
			readonly text: string;
			readonly images?: readonly AttachedImageInput[];
	  }
	| { readonly type: "next-problem" }
	| { readonly type: "retry" }
	| {
			readonly type: "retry-question";
			readonly messageId?: string;
			readonly contentIndex?: number;
			readonly toolCallId?: string;
	  }
	| { readonly type: "continue-if-owed" }
	| { readonly type: "save-question-draft"; readonly questionKey: string; readonly draft: Partial<QuestionDraft> }
	| { readonly type: "rename"; readonly title: string }
	| { readonly type: "save-chat-settings"; readonly settings: ChatSettings }
	| { readonly type: "clear-error" };

export interface CreateSessionStoreOptions {
	chatId: string;
	api: ApiClient;
	events: Events;
	settings?: Store<SettingsModel, SettingsIntent>;
	initialPrompt?: string;
}

interface ChatRecordPayload {
	title?: string;
	kind?: ChatKind;
	messages: LhMessage[];
	tree?: PlanTree;
	settings?: ChatSettings;
	pricing?: SessionPricing;
	coverage?: Record<string, unknown>;
	turnInFlight?: boolean;
	turnError?: string;
	compacting?: boolean;
	pluginQuestionAvailability?: PluginQuestionAvailability;
	pluginProblemAvailability?: PluginProblemAvailability;
}

interface SessionContext extends SessionHydrationTarget {
	readonly cell: Cell<SessionStoreModel>;
	loadTicket: number;
	activeLoad: AbortController | null;
	load: LoadState;
	error: string | null;
	title: string;
	kind: ChatKind;
	compacting: boolean;
	serverTurnError: string | null;
	serverTree: PlanTree | null;
	chatSettings: ChatSettings | null;
	pricing: SessionPricing | null;
	coverage: Readonly<Record<string, unknown>> | null;
}

function isModelBusy(model: SessionModel | null): boolean {
	return model !== null && (model.status === "submitted" || model.status === "streaming");
}

function publishSession(ctx: SessionContext): void {
	if (ctx.disposed) return;
	const state = ctx.model ? ctx.model.getState() : null;
	if (state) {
		scanAndHydrateImages(ctx, state.messages);
		if (state.hasConfirmedConversation && ctx.openingDraft !== null) {
			clearOpeningPrompt(ctx.chatId);
			ctx.openingDraft = null;
		}
	}
	const pendingQuestion = state ? pendingQuestionOf(state.nativeMessages) : null;
	const activeProblem = state ? activeProblemOf(state.nativeMessages) ?? null : null;
	const questionDraft =
		pendingQuestion && ctx.model ? ctx.model.questionDraft(pendingQuestion.key) ?? null : null;
	const queuedSteers = state ? visibleQueuedSteers(state.steerQueue, state.nativeMessages) : [];
	const tree = (state ? latestTreeFromMessages(state.messages) : null) ?? ctx.serverTree;
	ctx.cell.set({
		load: ctx.load,
		error: ctx.error,
		chatId: ctx.chatId,
		title: ctx.title,
		kind: ctx.kind,
		compacting: ctx.compacting,
		state,
		turnError: state?.error?.message ?? ctx.serverTurnError,
		imageSnapshots: ctx.imageSnapshots,
		tree,
		chatSettings: ctx.chatSettings,
		pricing: ctx.pricing,
		coverage: ctx.coverage,
		queuedSteers,
		pendingQuestion,
		activeProblem,
		questionDraft,
		openingDraft: ctx.openingDraft,
	});
}

function applyChatPayload(ctx: SessionContext, data: ChatRecordPayload): void {
	ctx.load = "ready";
	ctx.error = null;
	ctx.title = typeof data.title === "string" ? data.title : "";
	ctx.kind = data.kind === "practice" ? "practice" : "teach";
	ctx.compacting = data.compacting === true;
	ctx.serverTurnError = typeof data.turnError === "string" ? data.turnError : null;
	ctx.serverTree = data.tree ?? null;
	ctx.chatSettings = data.settings ?? null;
	ctx.pricing = data.pricing ?? null;
	ctx.coverage = data.coverage ? Object.freeze({ ...data.coverage }) : null;
	const messages = Array.isArray(data.messages) ? data.messages : [];
	if (!ctx.model) {
		const model = new SessionModel({
			chatId: ctx.chatId,
			initialMessages: messages,
			initialError: data.turnError,
			fetch: ctx.api.fetch,
		});
		if (data.pluginQuestionAvailability || data.pluginProblemAvailability) {
			model.setMessages(messages, data.turnError, data.pluginQuestionAvailability, data.pluginProblemAvailability);
		}
		model.onChange = () => publishSession(ctx);
		model.setReattachSettled(() => { void loadChatRecord(ctx); });
		ctx.model = model;
		runInitialMountHandoff(ctx, messages, data.turnInFlight === true);
		publishSession(ctx);
		if (data.turnInFlight === true) void model.resumeStream(false);
		return;
	}
	if (!isModelBusy(ctx.model)) {
		if (data.turnError === undefined) ctx.model.clearError();
		ctx.model.setMessages(messages, data.turnError, data.pluginQuestionAvailability, data.pluginProblemAvailability);
		if (data.turnInFlight === true) void ctx.model.resumeStream(false);
	}
	publishSession(ctx);
}

async function loadChatRecord(ctx: SessionContext): Promise<void> {
	if (ctx.disposed) return;
	const ticket = ++ctx.loadTicket;
	ctx.activeLoad?.abort();
	const controller = new AbortController();
	ctx.activeLoad = controller;
	try {
		const data = await ctx.api.json<ChatRecordPayload>(apiPath`/api/chats/${ctx.chatId}`, {
			signal: controller.signal,
		});
		if (ctx.disposed || ticket !== ctx.loadTicket) return;
		applyChatPayload(ctx, data);
	} catch (err) {
		if (ctx.disposed || ticket !== ctx.loadTicket || isAbortError(err)) return;
		if (err instanceof ApiError && err.status === 404) {
			ctx.model?.stop();
			ctx.model = null;
			ctx.load = "not-found";
			ctx.error = null;
			ctx.serverTurnError = null;
			publishSession(ctx);
			return;
		}
		ctx.load = "error";
		ctx.error = err instanceof Error ? err.message : String(err);
		publishSession(ctx);
	}
}

async function handleMetadataIntent(
	ctx: SessionContext,
	intent: Extract<SessionIntent, { type: "rename" | "save-chat-settings" }>,
): Promise<void> {
	if (intent.type === "rename") {
		const trimmed = intent.title.trim();
		if (!trimmed) return;
		const res = await ctx.api.json<{ title?: string }>(apiPath`/api/chats/${ctx.chatId}`, {
			method: "PUT",
			json: { title: trimmed },
		});
		if (ctx.disposed) return;
		ctx.title = typeof res.title === "string" ? res.title : trimmed;
		publishSession(ctx);
		return;
	}
	const res = await ctx.api.json<{ settings?: ChatSettings }>(apiPath`/api/chats/${ctx.chatId}/settings`, {
		method: "PUT",
		json: intent.settings,
	});
	if (ctx.disposed) return;
	ctx.chatSettings = res.settings ?? intent.settings;
	publishSession(ctx);
}

function abortActiveSessionTurn(ctx: SessionContext): void {
	ctx.model?.stop();
	const body = { kind: "turn", id: ctx.chatId };
	void ctx.api.json("/api/activity/abort", { method: "POST", json: body }).catch(() => {});
	publishSession(ctx);
}

async function handleTurnActionIntent(ctx: SessionContext, intent: SessionIntent): Promise<void> {
	switch (intent.type) {
		case "reload":
			return loadChatRecord(ctx);
		case "send-text":
		case "steer":
		case "submit-thinking":
			return sendComposerIntent(ctx, intent);
		case "stop":
			abortActiveSessionTurn(ctx);
			return;
		case "answer-question":
		case "dismiss-question":
		case "dismiss-problem":
		case "next-problem":
		case "retry":
		case "retry-question":
		case "continue-if-owed":
			return handleDockOrRecoveryIntent(ctx, intent);
		case "save-question-draft":
			ctx.model?.saveQuestionDraft(intent.questionKey, intent.draft);
			publishSession(ctx);
			return;
		case "rename":
		case "save-chat-settings":
			return handleMetadataIntent(ctx, intent);
		case "clear-error":
			ctx.serverTurnError = null;
			ctx.error = null;
			ctx.model?.clearError();
			publishSession(ctx);
			return;
		default:
			return assertNeverIntent(intent);
	}
}

function wireSessionEvents(ctx: SessionContext, events: Events): Unsubscribe {
	const offs: Unsubscribe[] = [
		events.on("record-changed", ({ chatId }) => {
			if (chatId === ctx.chatId && !isModelBusy(ctx.model)) void loadChatRecord(ctx);
		}),
		events.on("compaction-changed", ({ chatId, running }) => {
			if (chatId !== ctx.chatId) return;
			ctx.compacting = running;
			publishSession(ctx);
		}),
		events.on("turn-started", ({ chatId }) => {
			if (chatId === ctx.chatId && ctx.model && !isModelBusy(ctx.model)) void ctx.model.resumeStream(true);
		}),
		events.on("turn-settled", ({ chatId }) => {
			if (chatId === ctx.chatId && !isModelBusy(ctx.model)) void loadChatRecord(ctx);
		}),
		events.onResync(() => {
			if (!isModelBusy(ctx.model)) void loadChatRecord(ctx);
		}),
		ctx.settings ? ctx.settings.subscribe(() => settlePendingMountWork(ctx)) : () => {},
	];
	return () => {
		for (const off of offs) off();
	};
}

function createInitialSessionCell(chatId: string): Cell<SessionStoreModel> {
	return createCell<SessionStoreModel>({
		load: "loading",
		error: null,
		chatId,
		title: "",
		kind: "teach",
		compacting: false,
		state: null,
		turnError: null,
		imageSnapshots: {},
		tree: null,
		chatSettings: null,
		pricing: null,
		coverage: null,
		queuedSteers: [],
		pendingQuestion: null,
		activeProblem: null,
		questionDraft: null,
		openingDraft: null,
	});
}

function createSessionContext(opts: CreateSessionStoreOptions): SessionContext {
	const cell = createInitialSessionCell(opts.chatId);
	const ctx: SessionContext = {
		chatId: opts.chatId,
		api: opts.api,
		cell,
		settings: opts.settings,
		initialPrompt: opts.initialPrompt,
		seenSnapshots: new Set(),
		imageControllers: new Set(),
		disposed: false,
		loadTicket: 0,
		activeLoad: null,
		load: "loading",
		error: null,
		title: "",
		kind: "teach",
		compacting: false,
		serverTurnError: null,
		serverTree: null,
		chatSettings: null,
		pricing: null,
		coverage: null,
		imageSnapshots: {},
		model: null,
		openingDraft: null,
		initialHandled: false,
		pendingAutoPrompt: null,
		deferredMountContinue: false,
		publish: () => publishSession(ctx),
	};
	return ctx;
}

function disposeSessionContext(ctx: SessionContext, offEvents: Unsubscribe): void {
	ctx.disposed = true;
	offEvents();
	ctx.activeLoad?.abort();
	for (const c of ctx.imageControllers) c.abort();
	ctx.imageControllers.clear();
	if (!ctx.model) return;
	ctx.model.onChange = undefined;
	ctx.model.stop();
	ctx.model = null;
}

export function createSessionStore(
	options: CreateSessionStoreOptions,
): Store<SessionStoreModel, SessionIntent> {
	const ctx = createSessionContext(options);
	const offEvents = wireSessionEvents(ctx, options.events);
	void loadChatRecord(ctx);

	return createStoreFromCell<SessionStoreModel, SessionIntent>(ctx.cell, {
		onSend: (intent) => handleTurnActionIntent(ctx, intent),
		onDispose: () => disposeSessionContext(ctx, offEvents),
	});
}
