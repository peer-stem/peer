/**
 * Per-chat session store (`client-contract-state §2.3, §3`, `C-15`).
 * Wraps `SessionModel` (`components/session-core.ts`) in C1 read-only + live
 * SSE stream attach mode and hydrates `/objects`-backed `ImageSnapshot` entries.
 */

import {
	SessionModel,
	type PluginProblemAvailability,
	type PluginQuestionAvailability,
	type SessionState,
} from "../../../components/session-core.ts";
import type { ChatKind, ImageSnapshot } from "../../core/contracts/chat.ts";
import type { LhMessage } from "../../core/native-messages.ts";
import type { LhViewMessage } from "../../core/view.ts";
import { ApiError, apiPath, isAbortError, type ApiClient } from "./api.ts";
import type { Events } from "./events.ts";
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
}

export type SessionIntent = { readonly type: "reload" };

export interface CreateSessionStoreOptions {
	chatId: string;
	api: ApiClient;
	events: Events;
}

interface ChatRecordPayload {
	title?: string;
	kind?: ChatKind;
	messages: LhMessage[];
	turnInFlight?: boolean;
	turnError?: string;
	compacting?: boolean;
	pluginQuestionAvailability?: PluginQuestionAvailability;
	pluginProblemAvailability?: PluginProblemAvailability;
}

interface SessionContext {
	readonly chatId: string;
	readonly api: ApiClient;
	readonly cell: Cell<SessionStoreModel>;
	readonly seenSnapshots: Set<string>;
	readonly imageControllers: Set<AbortController>;
	disposed: boolean;
	loadTicket: number;
	activeLoad: AbortController | null;
	load: LoadState;
	error: string | null;
	title: string;
	kind: ChatKind;
	compacting: boolean;
	serverTurnError: string | null;
	imageSnapshots: Readonly<Record<string, ImageSnapshotEntry>>;
	model: SessionModel | null;
}

const HEX64_RE = /^[a-f0-9]{64}$/;

function extractSnapshotIdsFromPayload(value: unknown, out: Set<string>): void {
	if (!value || typeof value !== "object") return;
	const rec = value as Record<string, unknown>;
	if (typeof rec.snapshotId === "string" && HEX64_RE.test(rec.snapshotId)) {
		out.add(rec.snapshotId);
	}
	const img = rec.image as { snapshotId?: unknown } | null | undefined;
	if (typeof img?.snapshotId === "string" && HEX64_RE.test(img.snapshotId)) {
		out.add(img.snapshotId);
	}
	const nested = rec.result as { snapshotId?: unknown; image?: { snapshotId?: unknown } } | null | undefined;
	if (typeof nested?.snapshotId === "string" && HEX64_RE.test(nested.snapshotId)) {
		out.add(nested.snapshotId);
	}
	if (typeof nested?.image?.snapshotId === "string" && HEX64_RE.test(nested.image.snapshotId)) {
		out.add(nested.image.snapshotId);
	}
}

function collectSnapshotIds(messages: readonly LhViewMessage[]): string[] {
	const found = new Set<string>();
	for (const message of messages) {
		for (const part of message.parts) {
			extractSnapshotIdsFromPayload(part.output, found);
			extractSnapshotIdsFromPayload(part.data, found);
		}
	}
	return [...found];
}

function isValidImageSnapshot(raw: unknown): raw is ImageSnapshot {
	if (!raw || typeof raw !== "object") return false;
	const img = raw as Partial<ImageSnapshot>;
	return (
		(img.mimeType === "image/png" || img.mimeType === "image/jpeg") &&
		typeof img.data === "string" &&
		typeof img.width === "number" &&
		Number.isInteger(img.width) &&
		img.width > 0 &&
		typeof img.height === "number" &&
		Number.isInteger(img.height) &&
		img.height > 0
	);
}

function isModelBusy(model: SessionModel | null): boolean {
	return model !== null && (model.status === "submitted" || model.status === "streaming");
}

function publishSession(ctx: SessionContext): void {
	if (ctx.disposed) return;
	const state = ctx.model ? ctx.model.getState() : null;
	if (state) scanAndHydrateImages(ctx, state.messages);
	const turnError = state?.error?.message ?? ctx.serverTurnError;
	ctx.cell.set({
		load: ctx.load,
		error: ctx.error,
		chatId: ctx.chatId,
		title: ctx.title,
		kind: ctx.kind,
		compacting: ctx.compacting,
		state,
		turnError,
		imageSnapshots: ctx.imageSnapshots,
	});
}

function scanAndHydrateImages(ctx: SessionContext, messages: readonly LhViewMessage[]): void {
	for (const snapshotId of collectSnapshotIds(messages)) {
		if (ctx.seenSnapshots.has(snapshotId)) continue;
		ctx.seenSnapshots.add(snapshotId);
		ctx.imageSnapshots = { ...ctx.imageSnapshots, [snapshotId]: { status: "loading" } };
		void hydrateOneSnapshot(ctx, snapshotId);
	}
}

async function hydrateOneSnapshot(ctx: SessionContext, snapshotId: string): Promise<void> {
	const controller = new AbortController();
	ctx.imageControllers.add(controller);
	try {
		const path = apiPath`/api/chats/${ctx.chatId}/images/${snapshotId}`;
		const raw = await ctx.api.json<ImageSnapshot>(path, { signal: controller.signal });
		if (ctx.disposed || controller.signal.aborted) return;
		if (!isValidImageSnapshot(raw)) throw new Error("Invalid image snapshot");
		ctx.imageSnapshots = { ...ctx.imageSnapshots, [snapshotId]: { status: "ready", image: raw } };
		publishSession(ctx);
	} catch (err) {
		if (ctx.disposed || controller.signal.aborted || isAbortError(err)) return;
		ctx.imageSnapshots = { ...ctx.imageSnapshots, [snapshotId]: { status: "error" } };
		publishSession(ctx);
	} finally {
		ctx.imageControllers.delete(controller);
	}
}

function applyChatPayload(ctx: SessionContext, data: ChatRecordPayload): void {
	ctx.load = "ready";
	ctx.error = null;
	ctx.title = typeof data.title === "string" ? data.title : "";
	ctx.kind = data.kind === "practice" ? "practice" : "teach";
	ctx.compacting = data.compacting === true;
	ctx.serverTurnError = typeof data.turnError === "string" ? data.turnError : null;
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
		model.setReattachSettled(() => publishSession(ctx));
		ctx.model = model;
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
			if (chatId === ctx.chatId && ctx.model && !isModelBusy(ctx.model)) {
				void ctx.model.resumeStream(true);
			}
		}),
		events.on("turn-settled", ({ chatId }) => {
			if (chatId === ctx.chatId && !isModelBusy(ctx.model)) void loadChatRecord(ctx);
		}),
		events.onResync(() => {
			if (!isModelBusy(ctx.model)) void loadChatRecord(ctx);
		}),
	];
	return () => {
		for (const off of offs) off();
	};
}

function createSessionContext(chatId: string, api: ApiClient): SessionContext {
	const cell = createCell<SessionStoreModel>({
		load: "loading",
		error: null,
		chatId,
		title: "",
		kind: "teach",
		compacting: false,
		state: null,
		turnError: null,
		imageSnapshots: {},
	});
	return {
		chatId,
		api,
		cell,
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
		imageSnapshots: {},
		model: null,
	};
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

export function createSessionStore({
	chatId,
	api,
	events,
}: CreateSessionStoreOptions): Store<SessionStoreModel, SessionIntent> {
	const ctx = createSessionContext(chatId, api);
	const offEvents = wireSessionEvents(ctx, events);
	void loadChatRecord(ctx);

	return createStoreFromCell<SessionStoreModel, SessionIntent>(ctx.cell, {
		async onSend(intent) {
			if (intent.type === "reload") return loadChatRecord(ctx);
			assertNeverIntent(intent);
		},
		onDispose: () => disposeSessionContext(ctx, offEvents),
	});
}
