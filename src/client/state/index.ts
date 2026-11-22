/**
 * Public `peer-state` barrel and `createState()` composition root (`state §2.3`, `c2a §3`, `f3-c2b §4`).
 */

import {
	createActivityStore,
	type ActivityIntent,
	type ActivityStoreModel,
} from "./activity.ts";
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
	createSessionsStore,
	type SessionsIntent,
	type SessionsModel,
} from "./sessions.ts";
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
import {
	createSideThreadStore,
	type SideThreadIntent,
	type SideThreadStoreModel,
} from "./side-thread.ts";
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
export * from "./sessions.ts";
export * from "./activity.ts";
export * from "./side-thread.ts";
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
	readonly sessions: Store<SessionsModel, SessionsIntent>;
	readonly activity: Store<ActivityStoreModel, ActivityIntent>;
	openSession(id: string): Store<SessionStoreModel, SessionIntent>;
	openSideThread(chatId: string): Store<SideThreadStoreModel, SideThreadIntent>;
	screen(routeModel: RouteModel): Store<object, { readonly type: string }>;
	dispose(): void;
}

interface PooledEntry<M, I extends { readonly type: string }> {
	store: Store<M, I>;
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
	readonly openSideThread: (id: string) => Store<SideThreadStoreModel, SideThreadIntent>;
	readonly getGraph: () => Store<GraphStoreModel, GraphIntent>;
}

function createPooledHandle<M, I extends { readonly type: string }>(
	id: string,
	entry: PooledEntry<M, I>,
	active: Map<string, PooledEntry<M, I>>,
	disposedLabel: string,
): Store<M, I> {
	let handleDisposed = false;
	return {
		get: () => entry.store.get(),
		subscribe: (listener) => entry.store.subscribe(listener),
		send(intent) {
			if (handleDisposed) return Promise.reject(new Error(disposedLabel));
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
	const active = new Map<string, PooledEntry<SessionStoreModel, SessionIntent>>();
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
		return createPooledHandle(id, entry, active, "Session handle is disposed");
	};

	const peekSession = (id: string): Store<SessionStoreModel, SessionIntent> | undefined =>
		active.get(id)?.store;

	const disposeAll = () => {
		poolDisposed = true;
		for (const entry of active.values()) entry.store.dispose();
		active.clear();
	};

	return { openSession, peekSession, disposeAll };
}

function buildPooledSideThread(
	chatId: string,
	api: ApiClient,
	events: Events,
	peekSession: (id: string) => Store<SessionStoreModel, SessionIntent> | undefined,
): Store<SideThreadStoreModel, SideThreadIntent> {
	return createSideThreadStore({
		chatId,
		api,
		events,
		getMessages: () => peekSession(chatId)?.get().state?.nativeMessages ?? [],
		getWorking: () => peekSession(chatId)?.get().questionDraft?.readingThinking || undefined,
	});
}

function createSideThreadPool(
	api: ApiClient,
	events: Events,
	peekSession: (id: string) => Store<SessionStoreModel, SessionIntent> | undefined,
) {
	const active = new Map<string, PooledEntry<SideThreadStoreModel, SideThreadIntent>>();
	let poolDisposed = false;

	const openSideThread = (chatId: string): Store<SideThreadStoreModel, SideThreadIntent> => {
		if (poolDisposed) throw new Error("State is disposed");
		let entry = active.get(chatId);
		if (!entry) {
			entry = { store: buildPooledSideThread(chatId, api, events, peekSession), refs: 0 };
			active.set(chatId, entry);
		}
		entry.refs += 1;
		return createPooledHandle(chatId, entry, active, "SideThread handle is disposed");
	};

	const disposeAll = () => {
		poolDisposed = true;
		for (const entry of active.values()) entry.store.dispose();
		active.clear();
	};

	return { openSideThread, disposeAll };
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
	const { api, router, prefs, models, settings, appearance, shell, openSession, openSideThread, getGraph } = d;
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
		const sessionOpts = {
			routeModel, router, openSession, openSideThread, appearance, settings, models, prefs, shell,
		};
		return asGenericScreen(createSessionScreenStore(sessionOpts));
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
	const sessions = createSessionsStore({ api, events, storage: options?.storage });
	const activity = createActivityStore({ api, events });
	const pool = createSessionPool(api, events, router, settings);
	const sidePool = createSideThreadPool(api, events, pool.peekSession);
	const offSidebar = wireSidebarPrefs(shell, prefs);
	let graphInstance: Store<GraphStoreModel, GraphIntent> | null = null;
	const getGraph = () => (graphInstance ??= createGraphStore({ api, events }));
	const deps: ScreenFactoryDeps = {
		api, router, prefs, models, settings, appearance, shell,
		openSession: pool.openSession,
		openSideThread: sidePool.openSideThread,
		getGraph,
	};
	const cleanupExtras = () => {
		offSidebar();
		sidePool.disposeAll();
		pool.disposeAll();
		graphInstance?.dispose();
	};
	const ownedStores = [activity, sessions, appearance, settings, models, desktop, prefs, shell, router, events];

	return {
		api, events, router, prefs, desktop, models, settings, appearance, shell, sessions, activity,
		get graph() { return getGraph(); },
		openSession: pool.openSession,
		openSideThread: sidePool.openSideThread,
		screen: (rm) => openScreenForRoute(rm, deps),
		dispose: () => disposePeerStores(ownedStores, cleanupExtras),
	};
}
