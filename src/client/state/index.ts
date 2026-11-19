/**
 * Public `peer-state` barrel and `createState()` composition root (`state §2.3`).
 */

import { createApiClient, type ApiClient } from "./api.ts";
import {
	createAppearanceStore,
	type AppearanceIntent,
	type AppearanceModel,
} from "./appearance.ts";
import {
	createEventsStore,
	type Events,
	type EventSourceLike,
} from "./events.ts";
import {
	createRouterStore,
	type HistoryAdapter,
	type RouteModel,
	type RouterStore,
} from "./router.ts";
import { createPendingScreenStore } from "./screens/pending.ts";
import { createSessionScreenStore } from "./screens/session.ts";
import {
	createSessionStore,
	type SessionIntent,
	type SessionStoreModel,
} from "./session.ts";
import {
	createSettingsStore,
	type SettingsIntent,
	type SettingsModel,
} from "./settings.ts";
import {
	createShellStore,
	type ShellIntent,
	type ShellModel,
} from "./shell.ts";
import type { Store } from "./store.ts";

export * from "./store.ts";
export * from "./api.ts";
export * from "./events.ts";
export * from "./router.ts";
export * from "./settings.ts";
export * from "./appearance.ts";
export * from "./shell.ts";
export * from "./session.ts";
export * from "./screens/session.ts";
export * from "./screens/pending.ts";

export const APP_VERSION: string = process.env.APP_VERSION ?? "0.0.0";
export const APP_HOMEPAGE: string = process.env.APP_HOMEPAGE ?? "";

export interface CreateStateOptions {
	fetch?: typeof globalThis.fetch;
	createEventSource?: (url: string) => EventSourceLike;
	eventsUrl?: string;
	history?: HistoryAdapter;
	initialUrl?: string;
	shell?: Partial<ShellModel>;
}

export interface PeerState {
	readonly api: ApiClient;
	readonly events: Events;
	readonly router: RouterStore;
	readonly settings: Store<SettingsModel, SettingsIntent>;
	readonly appearance: Store<AppearanceModel, AppearanceIntent>;
	readonly shell: Store<ShellModel, ShellIntent>;
	openSession(id: string): Store<SessionStoreModel, SessionIntent>;
	screen(routeModel: RouteModel): Store<object, { readonly type: string }>;
	dispose(): void;
}

interface ActiveSessionEntry {
	store: Store<SessionStoreModel, SessionIntent>;
	refs: number;
}

function createSessionHandle(
	id: string,
	entry: ActiveSessionEntry,
	active: Map<string, ActiveSessionEntry>,
): Store<SessionStoreModel, SessionIntent> {
	let handleDisposed = false;
	return {
		get: () => entry.store.get(),
		subscribe: (listener) => entry.store.subscribe(listener),
		send(intent) {
			if (handleDisposed) return Promise.reject(new Error("Session handle is disposed"));
			return entry.store.send(intent);
		},
		dispose() {
			if (handleDisposed) return;
			handleDisposed = true;
			entry.refs -= 1;
			if (entry.refs > 0) return;
			active.delete(id);
			entry.store.dispose();
		},
	};
}

function createSessionPool(api: ApiClient, events: Events) {
	const active = new Map<string, ActiveSessionEntry>();
	let poolDisposed = false;

	const openSession = (id: string): Store<SessionStoreModel, SessionIntent> => {
		if (poolDisposed) throw new Error("State is disposed");
		let entry = active.get(id);
		if (!entry) {
			entry = { store: createSessionStore({ chatId: id, api, events }), refs: 0 };
			active.set(id, entry);
		}
		entry.refs += 1;
		return createSessionHandle(id, entry, active);
	};

	const disposeAll = () => {
		poolDisposed = true;
		for (const entry of active.values()) entry.store.dispose();
		active.clear();
	};

	return { openSession, disposeAll };
}

function openScreenForRoute(
	routeModel: RouteModel,
	router: RouterStore,
	openSession: (id: string) => Store<SessionStoreModel, SessionIntent>,
	appearance: Store<AppearanceModel, AppearanceIntent>,
	settings: Store<SettingsModel, SettingsIntent>,
	shell: Store<ShellModel, ShellIntent>,
): Store<object, { readonly type: string }> {
	if (routeModel.route.name === "session") {
		const s = createSessionScreenStore({ routeModel, router, openSession, appearance, settings });
		return s as unknown as Store<object, { readonly type: string }>;
	}
	const p = createPendingScreenStore({ routeModel, router, settings, shell });
	return p as unknown as Store<object, { readonly type: string }>;
}

export function createState(options?: CreateStateOptions): PeerState {
	const api = createApiClient({ fetch: options?.fetch });
	const events = createEventsStore({
		createEventSource: options?.createEventSource,
		url: options?.eventsUrl,
	});
	const router = createRouterStore({
		history: options?.history,
		initialUrl: options?.initialUrl,
	});
	const shell = createShellStore(options?.shell);
	const settings = createSettingsStore({ api, events });
	const appearance = createAppearanceStore({ api, settings, shell, events });
	const pool = createSessionPool(api, events);

	return {
		api,
		events,
		router,
		settings,
		appearance,
		shell,
		openSession: pool.openSession,
		screen: (rm) => openScreenForRoute(rm, router, pool.openSession, appearance, settings, shell),
		dispose() {
			pool.disposeAll();
			appearance.dispose();
			settings.dispose();
			shell.dispose();
			router.dispose();
			events.dispose();
		},
	};
}
