/**
 * Session screen projection store (`R3`, `views §2.4`).
 * Composes `SessionStore`, `AppearanceStore`, `SettingsStore`, and `RouterStore`
 * into a flat read-only `SessionScreenModel` for `views/session/session-view.js`.
 */

import type { SessionStatus } from "../../../../components/session-core.ts";
import type { ChatKind } from "../../../core/contracts/chat.ts";
import type { LhViewMessage } from "../../../core/view.ts";
import type { AppearanceIntent, AppearanceModel } from "../appearance.ts";
import type { Route, RouteModel, RouterStore } from "../router.ts";
import type { ImageSnapshotEntry, SessionIntent, SessionStoreModel } from "../session.ts";
import type { SettingsIntent, SettingsModel } from "../settings.ts";
import {
	assertNeverIntent,
	createCell,
	createStoreFromCell,
	type LoadState,
	type Store,
	type Unsubscribe,
} from "../store.ts";

export type SessionRoute = Extract<Route, { readonly name: "session" }>;

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
	readonly messages: readonly LhViewMessage[];
	readonly status: SessionStatus;
	readonly contextTokens: number | null;
	readonly turnError: string | null;
	readonly imageSnapshots: Readonly<Record<string, ImageSnapshotEntry>>;
}

export type SessionScreenIntent =
	| { readonly type: "reload" }
	| { readonly type: "sync-route"; readonly routeModel: RouteModel };

export interface CreateSessionScreenStoreOptions {
	routeModel?: RouteModel;
	router?: RouterStore;
	chatId?: string;
	openSession: (id: string) => Store<SessionStoreModel, SessionIntent>;
	appearance: Store<AppearanceModel, AppearanceIntent>;
	settings: Store<SettingsModel, SettingsIntent>;
}

const EMPTY_MESSAGES: readonly LhViewMessage[] = Object.freeze([]);

function resolveSessionRouteInfo(
	routeModel: RouteModel | undefined,
	chatId: string,
): { route: SessionRoute; hash: string } {
	if (routeModel && routeModel.route.name === "session" && routeModel.route.id === chatId) {
		return { route: routeModel.route, hash: routeModel.hash };
	}
	return { route: { name: "session", id: chatId }, hash: "" };
}

function projectSessionScreen(
	routeInfo: { route: SessionRoute; hash: string },
	session: SessionStoreModel,
	appearance: AppearanceModel,
	settings: SettingsModel,
): SessionScreenModel {
	return {
		route: routeInfo.route,
		hash: routeInfo.hash,
		load: session.load,
		error: session.error,
		chatId: session.chatId,
		title: session.title,
		kind: session.kind,
		compacting: session.compacting,
		mode: appearance.theme.mode,
		configured: settings.configured,
		messages: session.state?.messages ?? EMPTY_MESSAGES,
		status: session.state?.status ?? "ready",
		contextTokens: session.state?.contextTokens ?? null,
		turnError: session.turnError,
		imageSnapshots: session.imageSnapshots,
	};
}

function applyRouteSync(
	routeModel: RouteModel,
	chatId: string,
	updateRoute: (info: { route: SessionRoute; hash: string }) => void,
): void {
	if (routeModel.route.name !== "session" || routeModel.route.id !== chatId) return;
	updateRoute({ route: routeModel.route, hash: routeModel.hash });
}

export function createSessionScreenStore(
	options: CreateSessionScreenStoreOptions,
): Store<SessionScreenModel, SessionScreenIntent> {
	const seedModel = options.routeModel ?? options.router?.get();
	const chatId = options.chatId ?? (seedModel?.route.name === "session" ? seedModel.route.id : "");
	if (!chatId) {
		throw new Error("createSessionScreenStore requires a session route or chatId");
	}
	let routeInfo = resolveSessionRouteInfo(seedModel, chatId);
	const session = options.openSession(chatId);

	const compute = () =>
		projectSessionScreen(routeInfo, session.get(), options.appearance.get(), options.settings.get());
	const cell = createCell<SessionScreenModel>(compute());
	const updateRoute = (info: { route: SessionRoute; hash: string }) => {
		routeInfo = info;
		cell.set(compute());
	};

	const offs: Unsubscribe[] = [
		session.subscribe(() => cell.set(compute())),
		options.appearance.subscribe(() => cell.set(compute())),
		options.settings.subscribe(() => cell.set(compute())),
		options.router
			? options.router.subscribe((next) => applyRouteSync(next, chatId, updateRoute))
			: () => {},
	];

	return createStoreFromCell<SessionScreenModel, SessionScreenIntent>(cell, {
		async onSend(intent) {
			if (intent.type === "reload") return session.send({ type: "reload" });
			if (intent.type === "sync-route") {
				applyRouteSync(intent.routeModel, chatId, updateRoute);
				return;
			}
			assertNeverIntent(intent);
		},
		onDispose() {
			for (const off of offs) off();
			session.dispose();
		},
	});
}
