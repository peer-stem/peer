/**
 * Session screen projection store (`R3`, `c2a-frozen-contracts §3.6`, `f3-c2b §4`).
 * Composes `SessionStore`, `SideThreadStore`, `AppearanceStore`, `SettingsStore`,
 * `ModelsStore`, `PrefsStore`, `ShellStore`, and `RouterStore` into a flat `SessionScreenModel`.
 */

import {
	dismissedAnswer,
	resolveConversationSpec,
	sideSegmentId,
	toolQuestionKind,
	type ChatKind,
	type EffectiveSettings,
	type JobRecord,
	type LhViewMessage,
} from "../../../core/index.ts";
import type { SessionStatus } from "../../engine/index.ts";
import type { AppearanceIntent, AppearanceModel } from "../appearance.ts";
import type { CatalogModelEntry, ModelsIntent, ModelsStoreModel } from "../models.ts";
import type { PrefsIntent, PrefsModel } from "../prefs.ts";
import type { Route, RouteModel, RouterStore } from "../router.ts";
import type { ImageSnapshotEntry, SessionIntent, SessionStoreModel } from "../session.ts";
import type { SettingsIntent, SettingsModel } from "../settings.ts";
import type { ShellIntent, ShellModel } from "../shell.ts";
import type { SideThreadIntent, SideThreadStoreModel } from "../side-thread.ts";
import {
	createCell,
	createStoreFromCell,
	type LoadState,
	type Store,
	type Unsubscribe,
} from "../store.ts";

export type SessionRoute = Extract<Route, { readonly name: "session" }>;
export type SessionAbortMode = "turn" | "question" | "problem";

export interface SessionEffectiveModel {
	readonly provider: string;
	readonly id: string;
	readonly thinkingLevel?: string;
}

export interface SessionScreenModel {
	readonly route: SessionRoute;
	readonly hash: string;
	readonly load: LoadState;
	readonly error: string | null;
	readonly chatId: string;
	readonly title: string;
	readonly kind: ChatKind;
	readonly compacting: boolean;
	readonly mode: "dark" | "light";
	readonly configured: boolean;
	readonly appearanceSettings: EffectiveSettings["appearance"];
	readonly graphEnabled: boolean;
	readonly extractionChunkTokens: number;
	readonly planOpen: boolean;
	readonly abortDialogMode: SessionAbortMode | null;
	readonly messages: readonly LhViewMessage[];
	readonly status: SessionStatus;
	readonly contextTokens: number | null;
	readonly turnError: string | null;
	readonly imageSnapshots: Readonly<Record<string, ImageSnapshotEntry>>;
	readonly jobs: readonly JobRecord[];
	readonly sideThread: SideThreadStoreModel | null;
	readonly state?: SessionStoreModel["state"];
	readonly tree?: SessionStoreModel["tree"];
	readonly chatSettings?: SessionStoreModel["chatSettings"];
	readonly pricing?: SessionStoreModel["pricing"];
	readonly coverage?: SessionStoreModel["coverage"];
	readonly queuedSteers?: SessionStoreModel["queuedSteers"];
	readonly pendingQuestion?: SessionStoreModel["pendingQuestion"];
	readonly activeProblem?: SessionStoreModel["activeProblem"];
	readonly questionDraft?: SessionStoreModel["questionDraft"];
	readonly openingDraft?: SessionStoreModel["openingDraft"];
	readonly effectiveModel?: SessionEffectiveModel | null;
	readonly availableModels?: readonly CatalogModelEntry[];
	readonly userThinkingOpen?: boolean;
}

export type SessionScreenIntent =
	| SessionIntent
	| { readonly type: "side-thread"; readonly action: SideThreadIntent }
	| { readonly type: "sync-route"; readonly routeModel: RouteModel }
	| { readonly type: "open-setup" }
	| { readonly type: "open-settings"; readonly section?: string }
	| { readonly type: "toggle-user-thinking" }
	| { readonly type: "toggle-plan" }
	| { readonly type: "set-plan-open"; readonly open: boolean }
	| { readonly type: "request-abort"; readonly mode: SessionAbortMode }
	| { readonly type: "cancel-abort" }
	| { readonly type: "confirm-abort" };

export interface CreateSessionScreenStoreOptions {
	routeModel?: RouteModel;
	router?: RouterStore;
	chatId?: string;
	openSession: (id: string) => Store<SessionStoreModel, SessionIntent>;
	openSideThread?: (id: string) => Store<SideThreadStoreModel, SideThreadIntent>;
	appearance: Store<AppearanceModel, AppearanceIntent>;
	settings: Store<SettingsModel, SettingsIntent>;
	models?: Store<ModelsStoreModel, ModelsIntent>;
	prefs?: Store<PrefsModel, PrefsIntent>;
	shell?: Store<ShellModel, ShellIntent>;
}

interface SessionScreenLocalState {
	routeInfo: { route: SessionRoute; hash: string };
	planOpen: boolean;
	abortDialogMode: SessionAbortMode | null;
	disposed: boolean;
}

const EMPTY_MESSAGES: readonly LhViewMessage[] = Object.freeze([]);
const EMPTY_MODELS: readonly CatalogModelEntry[] = Object.freeze([]);
const EMPTY_JOBS: readonly JobRecord[] = Object.freeze([]);

function resolveSessionRouteInfo(
	routeModel: RouteModel | undefined,
	chatId: string,
): { route: SessionRoute; hash: string } {
	if (routeModel && routeModel.route.name === "session" && routeModel.route.id === chatId) {
		return { route: routeModel.route, hash: routeModel.hash };
	}
	return { route: { name: "session", id: chatId }, hash: "" };
}

function computeEffectiveModel(
	session: SessionStoreModel,
	settings: SettingsModel,
): SessionEffectiveModel | null {
	const spec = resolveConversationSpec(
		session.chatSettings ?? undefined,
		settings.effective.models.strong,
	);
	if (!spec) return null;
	return {
		provider: spec.provider,
		id: spec.id,
		...(spec.thinkingLevel !== undefined ? { thinkingLevel: spec.thinkingLevel } : {}),
	};
}

function projectSideThread(
	sideThread: Store<SideThreadStoreModel, SideThreadIntent> | null,
	session: SessionStoreModel,
): SideThreadStoreModel | null {
	if (!sideThread) return null;
	const raw = sideThread.get();
	if (!session.state) return raw;
	const liveSeg = sideSegmentId(session.state.nativeMessages) ?? undefined;
	return raw.currentSegmentId === liveSeg ? raw : { ...raw, currentSegmentId: liveSeg };
}

function projectSessionScreen(
	local: SessionScreenLocalState,
	session: SessionStoreModel,
	sideThread: Store<SideThreadStoreModel, SideThreadIntent> | null,
	appearance: AppearanceModel,
	settings: SettingsModel,
	models?: Store<ModelsStoreModel, ModelsIntent>,
	prefs?: Store<PrefsModel, PrefsIntent>,
): SessionScreenModel {
	return {
		route: local.routeInfo.route,
		hash: local.routeInfo.hash,
		load: session.load,
		error: session.error,
		chatId: session.chatId,
		title: session.title,
		kind: session.kind,
		compacting: session.compacting,
		mode: appearance.theme.mode,
		configured: settings.configured,
		appearanceSettings: settings.effective.appearance,
		graphEnabled: settings.effective.graph.enabled,
		extractionChunkTokens: settings.effective.graph.extractionChunkTokens,
		planOpen: local.planOpen,
		abortDialogMode: local.abortDialogMode,
		messages: session.state?.messages ?? EMPTY_MESSAGES,
		status: session.state?.status ?? "ready",
		contextTokens: session.state?.contextTokens ?? null,
		turnError: session.turnError,
		imageSnapshots: session.imageSnapshots,
		jobs: session.jobs ?? EMPTY_JOBS,
		sideThread: projectSideThread(sideThread, session),
		state: session.state,
		tree: session.tree ?? null,
		chatSettings: session.chatSettings ?? null,
		pricing: session.pricing ?? null,
		coverage: session.coverage ?? null,
		queuedSteers: session.queuedSteers ?? [],
		pendingQuestion: session.pendingQuestion ?? null,
		activeProblem: session.activeProblem ?? null,
		questionDraft: session.questionDraft ?? null,
		openingDraft: session.openingDraft ?? null,
		effectiveModel: computeEffectiveModel(session, settings),
		availableModels: models ? models.get().models : EMPTY_MODELS,
		userThinkingOpen: prefs ? prefs.get().userThinkingOpen : true,
	};
}

function applyRouteSync(
	routeModel: RouteModel,
	chatId: string,
	local: SessionScreenLocalState,
	publish: () => void,
): void {
	if (routeModel.route.name !== "session" || routeModel.route.id !== chatId) return;
	local.routeInfo = { route: routeModel.route, hash: routeModel.hash };
	publish();
}

async function confirmSessionAbort(
	mode: SessionAbortMode | null,
	session: Store<SessionStoreModel, SessionIntent>,
): Promise<void> {
	if (!mode) return;
	if (mode === "turn") {
		await session.send({ type: "stop" });
		return;
	}
	const snap = session.get();
	const busy = snap.state?.status === "submitted" || snap.state?.status === "streaming";
	if (mode === "question") {
		const pq = snap.pendingQuestion;
		if (pq) {
			const rawQ = (pq.input as { question?: unknown } | null)?.question;
			const qText = typeof rawQ === "string" ? rawQ : "";
			const base = dismissedAnswer(toolQuestionKind(pq.tool), qText);
			const reading = snap.questionDraft?.readingThinking?.trim();
			const answer = reading ? { ...base, readingThinking: reading } : base;
			await session.send({ type: "dismiss-question", toolCallId: pq.toolCallId, answer, questionKey: pq.key });
		}
		if (busy) await session.send({ type: "stop" });
		return;
	}
	const prob = snap.activeProblem;
	if (prob) await session.send({ type: "dismiss-problem", problemCallId: prob.toolCallId });
	if (busy) await session.send({ type: "stop" });
}

type LocalSessionScreenIntent = Extract<
	SessionScreenIntent,
	{ type: "toggle-plan" | "set-plan-open" | "request-abort" | "cancel-abort" }
>;

function applyLocalSessionScreenIntent(
	intent: LocalSessionScreenIntent,
	local: SessionScreenLocalState,
	publish: () => void,
): void {
	if (intent.type === "toggle-plan") local.planOpen = !local.planOpen;
	else if (intent.type === "set-plan-open") local.planOpen = intent.open;
	else if (intent.type === "request-abort") local.abortDialogMode = intent.mode;
	else local.abortDialogMode = null;
	publish();
}

async function handleSessionScreenIntent(
	intent: SessionScreenIntent,
	chatId: string,
	local: SessionScreenLocalState,
	session: Store<SessionStoreModel, SessionIntent>,
	sideThread: Store<SideThreadStoreModel, SideThreadIntent> | null,
	options: CreateSessionScreenStoreOptions,
	publish: () => void,
): Promise<void> {
	switch (intent.type) {
		case "side-thread":
			await sideThread?.send(intent.action);
			return;
		case "sync-route":
			applyRouteSync(intent.routeModel, chatId, local, publish);
			return;
		case "open-setup":
			await options.shell?.send({ type: "open-setup" });
			return;
		case "open-settings":
			await options.shell?.send({ type: "open-settings", section: intent.section ?? null });
			return;
		case "toggle-user-thinking":
			await options.prefs?.send({ type: "toggle-user-thinking" });
			return;
		case "toggle-plan":
		case "set-plan-open":
		case "request-abort":
		case "cancel-abort":
			applyLocalSessionScreenIntent(intent, local, publish);
			return;
		case "confirm-abort": {
			const mode = local.abortDialogMode;
			local.abortDialogMode = null;
			publish();
			await confirmSessionAbort(mode, session);
			return;
		}
		default:
			await session.send(intent);
	}
}

function wireSessionScreenSubscriptions(
	chatId: string,
	local: SessionScreenLocalState,
	session: Store<SessionStoreModel, SessionIntent>,
	sideThread: Store<SideThreadStoreModel, SideThreadIntent> | null,
	options: CreateSessionScreenStoreOptions,
	publish: () => void,
): Unsubscribe[] {
	return [
		session.subscribe(publish),
		sideThread ? sideThread.subscribe(publish) : () => {},
		options.appearance.subscribe(publish),
		options.settings.subscribe(publish),
		options.models ? options.models.subscribe(publish) : () => {},
		options.prefs ? options.prefs.subscribe(publish) : () => {},
		options.router
			? options.router.subscribe((next) => applyRouteSync(next, chatId, local, publish))
			: () => {},
	];
}

export function createSessionScreenStore(
	options: CreateSessionScreenStoreOptions,
): Store<SessionScreenModel, SessionScreenIntent> {
	const seedModel = options.routeModel ?? options.router?.get();
	const chatId = options.chatId ?? (seedModel?.route.name === "session" ? seedModel.route.id : "");
	if (!chatId) {
		throw new Error("createSessionScreenStore requires a session route or chatId");
	}
	const local: SessionScreenLocalState = {
		routeInfo: resolveSessionRouteInfo(seedModel, chatId),
		planOpen: true,
		abortDialogMode: null,
		disposed: false,
	};
	const session = options.openSession(chatId);
	const sideThread = options.openSideThread ? options.openSideThread(chatId) : null;
	const compute = () =>
		projectSessionScreen(
			local, session.get(), sideThread, options.appearance.get(),
			options.settings.get(), options.models, options.prefs,
		);
	const cell = createCell<SessionScreenModel>(compute());
	const publish = () => {
		if (!local.disposed) cell.set(compute());
	};
	const offs = wireSessionScreenSubscriptions(chatId, local, session, sideThread, options, publish);

	return createStoreFromCell<SessionScreenModel, SessionScreenIntent>(cell, {
		onSend: (intent) =>
			handleSessionScreenIntent(intent, chatId, local, session, sideThread, options, publish),
		onDispose() {
			local.disposed = true;
			for (const off of offs) off();
			sideThread?.dispose();
			session.dispose();
		},
	});
}
