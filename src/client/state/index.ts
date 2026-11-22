/**
 * Public `peer-state` barrel and `createState()` composition root (`state §2.3`, `c2a §3`).
 */

import { createApiClient, type ApiClient } from "./api.ts";
import {
	createAppearanceStore,
	type AppearanceIntent,
	type AppearanceModel,
} from "./appearance.ts";
import {
	createDesktopStore,
	type DesktopBridge,
	type DesktopStore,
} from "./desktop.ts";
import {
	createEventsStore,
	type Events,
	type EventSourceLike,
} from "./events.ts";
import {
	createGraphStore,
	type GraphIntent,
	type GraphStoreModel,
} from "./graph.ts";
import {
	createModelsStore,
	type ModelsIntent,
	type ModelsStoreModel,
} from "./models.ts";
import {
	createPrefsStore,
	type PrefsIntent,
	type PrefsModel,
} from "./prefs.ts";
import {
	createRouterStore,
	type HistoryAdapter,
	type RouteModel,
	type RouterStore,
} from "./router.ts";
import { createHomeScreenStore } from "./screens/home.ts";
import { createNewSessionScreenStore } from "./screens/new-session.ts";
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
import type { Store, Unsubscribe } from "./store.ts";

export * from "./store.ts";
export * from "./api.ts";
export * from "./events.ts";
export * from "./router.ts";
export * from "./prefs.ts";
export * from "./desktop.ts";
export * from "./models.ts";
export * from "./settings.ts";
export * from "./appearance.ts";
export * from "./shell.ts";
export * from "./graph.ts";
export * from "./session.ts";
export * from "./screens/session.ts";
export * from "./screens/home.ts";
export * from "./screens/new-session.ts";
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
	storage?: Storage | null;
	desktopBridge?: DesktopBridge | null;
}

export interface PeerState {
	readonly api: ApiClient;
	readonly events: Events;
	readonly router: RouterStore;
	readonly prefs: Store<PrefsModel, PrefsIntent>;
	readonly desktop: DesktopStore;
	readonly models: Store<ModelsStoreModel, ModelsIntent>;
	readonly settings: Store<SettingsModel, SettingsIntent>;
	readonly appearance: Store<AppearanceModel, AppearanceIntent>;
	readonly shell: Store<ShellModel, ShellIntent>;
	readonly graph: Store<GraphStoreModel, GraphIntent>;
	openSession(id: string): Store<SessionStoreModel, SessionIntent>;
	screen(routeModel: RouteModel): Store<object, { readonly type: string }>;
	dispose(): void;
}

interface ActiveSessionEntry {
	store: Store<SessionStoreModel, SessionIntent>;
	refs: number;
}

interface ScreenFactoryDeps {
	readonly api: ApiClient;
	readonly router: RouterStore;
	readonly prefs: Store<PrefsModel, PrefsIntent>;
	readonly models: Store<ModelsStoreModel, ModelsIntent>;
	readonly settings: Store<SettingsModel, SettingsIntent>;
	readonly appearance: Store<AppearanceModel, AppearanceIntent>;
	readonly shell: Store<ShellModel, ShellIntent>;
	readonly openSession: (id: string) => Store<SessionStoreModel, SessionIntent>;
	readonly getGraph: () => Store<GraphStoreModel, GraphIntent>;
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

function createSessionPool(
	api: ApiClient,
	events: Events,
	router: RouterStore,
	settings: Store<SettingsModel, SettingsIntent>,
) {
	const active = new Map<string, ActiveSessionEntry>();
	let poolDisposed = false;

	const openSession = (id: string): Store<SessionStoreModel, SessionIntent> => {
		if (poolDisposed) throw new Error("State is disposed");
		let entry = active.get(id);
		if (!entry) {
			const r = router.get().route;
			const initialPrompt = r.name === "session" && r.id === id ? r.prompt : undefined;
			entry = { store: createSessionStore({ chatId: id, api, events, settings, initialPrompt }), refs: 0 };
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

function wireSidebarPrefs(
	shell: Store<ShellModel, ShellIntent>,
	prefs: Store<PrefsModel, PrefsIntent>,
): Unsubscribe {
	const offShell = shell.subscribe((sm) => {
		if (sm.sidebar.open !== prefs.get().sidebarOpen) {
			void prefs.send({ type: "set-sidebar-open", open: sm.sidebar.open });
		}
	});
	const offPrefs = prefs.subscribe((pm) => {
		if (pm.sidebarOpen !== shell.get().sidebar.open) {
			void shell.send({ type: "set-sidebar", open: pm.sidebarOpen });
		}
	});
	return () => {
		offShell();
		offPrefs();
	};
}

function asGenericScreen<M extends object, I extends { readonly type: string }>(
	store: Store<M, I>,
): Store<object, { readonly type: string }> {
	return store as unknown as Store<object, { readonly type: string }>;
}

function openScreenForRoute(
	routeModel: RouteModel,
	d: ScreenFactoryDeps,
): Store<object, { readonly type: string }> {
	const { api, router, prefs, models, settings, appearance, shell, openSession, getGraph } = d;
	if (routeModel.route.name === "home") {
		return asGenericScreen(
			createHomeScreenStore({ api, router, graph: getGraph(), settings, appearance, prefs, shell }),
		);
	}
	if (routeModel.route.name === "new-session") {
		return asGenericScreen(
			createNewSessionScreenStore({ api, router, graph: getGraph(), settings, models, appearance, shell, routeModel }),
		);
	}
	if (routeModel.route.name === "session") {
		return asGenericScreen(
			createSessionScreenStore({ routeModel, router, openSession, appearance, settings, models, prefs, shell }),
		);
	}
	return asGenericScreen(createPendingScreenStore({ routeModel, router, settings, shell }));
}

function resolveInitialShell(
	prefs: Store<PrefsModel, PrefsIntent>,
	overrides?: Partial<ShellModel>,
): Partial<ShellModel> {
	if (overrides?.sidebar) return overrides;
	return { ...overrides, sidebar: { open: prefs.get().sidebarOpen, narrow: false } };
}

function disposePeerStores(stores: readonly { dispose(): void }[], extraCleanup: () => void): void {
	extraCleanup();
	for (const store of stores) store.dispose();
}

export function createState(options?: CreateStateOptions): PeerState {
	const api = createApiClient({ fetch: options?.fetch });
	const events = createEventsStore({ createEventSource: options?.createEventSource, url: options?.eventsUrl });
	const router = createRouterStore({ history: options?.history, initialUrl: options?.initialUrl });
	const prefs = createPrefsStore({ storage: options?.storage });
	const shell = createShellStore(resolveInitialShell(prefs, options?.shell));
	const desktop = createDesktopStore({ bridge: options?.desktopBridge, shell });
	const models = createModelsStore({ api, events });
	let appearanceRef: Store<AppearanceModel, AppearanceIntent> | null = null;
	const settings = createSettingsStore({
		api,
		events,
		onModelsMayChange: () => { void models.send({ type: "reload" }); },
		onThemesMayChange: () => { void appearanceRef?.send({ type: "reload" }); },
	});
	const appearance = createAppearanceStore({ api, settings, shell, events });
	appearanceRef = appearance;
	const pool = createSessionPool(api, events, router, settings);
	const offSidebar = wireSidebarPrefs(shell, prefs);
	let graphInstance: Store<GraphStoreModel, GraphIntent> | null = null;
	const getGraph = () => (graphInstance ??= createGraphStore({ api, events }));
	const deps: ScreenFactoryDeps = {
		api, router, prefs, models, settings, appearance, shell, openSession: pool.openSession, getGraph,
	};
	const cleanupExtras = () => {
		offSidebar();
		pool.disposeAll();
		graphInstance?.dispose();
	};
	const ownedStores = [appearance, settings, models, desktop, prefs, shell, router, events];

	return {
		api, events, router, prefs, desktop, models, settings, appearance, shell,
		get graph() { return getGraph(); },
		openSession: pool.openSession,
		screen: (rm) => openScreenForRoute(rm, deps),
		dispose: () => disposePeerStores(ownedStores, cleanupExtras),
	};
}
