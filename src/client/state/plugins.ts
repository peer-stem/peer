/**
 * Reactive plugin host store (`f4-c2c`).
 * Wraps `PluginFrontendManager` (`peer-engine`), `/plugin-loader.js` ESM loader,
 * `<link rel="stylesheet">` lifecycle, `Events` forwarding, and dynamic code-block
 * fence synchronization without importing `src/client/views/`.
 */

import {
	SERVER_EVENT_TYPES,
	type PluginAction,
	type PluginActionContext,
	type PluginCleanup,
	type PluginFrontendModule,
	type PluginUi,
	type ServerEvent,
} from "../../core/index.ts";
import {
	PluginFrontendManager,
	type CodeBlockRegistration,
	type PluginHost,
	type PluginSnapshot,
} from "../engine/index.ts";
import type { ApiClient } from "./api.ts";
import type { Events } from "./events.ts";
import type { RouterStore } from "./router.ts";
import type { ShellIntent, ShellModel } from "./shell.ts";
import { assertNeverIntent, createCell, type Store, type Unsubscribe } from "./store.ts";

export const RESERVED_CODE_BLOCK_LANGUAGES = Object.freeze(["mermaid"]);
export const RESERVED_TOOL_NAMES = Object.freeze([
	"research", "demo", "visual", "pdf", "probe_done", "problem", "conclude",
	"quiz", "probe", "ask_user_question", "explain", "recall", "plan_init",
]);

export type PluginUiFactory = (options: {
	signal: AbortSignal;
	pluginId?: string;
	onError: (error: unknown) => void;
}) => PluginUi;

export interface BlockRegistrySyncTarget {
	register(renderer: {
		language: string;
		mount: (container: HTMLElement, block: { source: string; meta?: string; incomplete?: boolean; signal?: AbortSignal }) => (() => void) | void;
	}): () => void;
}

export type PluginsIntent =
	| { readonly type: "reload"; readonly clearError?: boolean }
	| { readonly type: "refresh" }
	| { readonly type: "set-enabled"; readonly id: string; readonly enabled: boolean }
	| {
			readonly type: "run-action";
			readonly pluginId: string;
			readonly action: PluginAction;
			readonly context: PluginActionContext | (() => PluginActionContext | undefined);
	  };

export interface PluginsStore extends Store<PluginSnapshot, PluginsIntent> {
	readonly manager: PluginFrontendManager;
	start(): void;
	setUiFactory(factory: PluginUiFactory | null): void;
	bindBlockRegistry(blocks: BlockRegistrySyncTarget): Unsubscribe;
}

export interface CreatePluginsStoreOptions {
	api: ApiClient;
	events: Events;
	router: RouterStore;
	shell: Store<ShellModel, ShellIntent>;
	doc?: Document | null;
	importModule?: (url: string) => Promise<PluginFrontendModule>;
	autoStart?: boolean;
}

type LoaderWindow = typeof globalThis & {
	__lhImportPlugin?: (url: string) => Promise<PluginFrontendModule>;
};

let loaderPromise: Promise<void> | null = null;

function injectPluginLoaderScript(doc: Document, g: LoaderWindow): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		if (typeof g.__lhImportPlugin === "function") { resolve(); return; }
		const script = doc.createElement("script");
		script.type = "module";
		script.src = "/plugin-loader.js";
		script.addEventListener("load", () => resolve(), { once: true });
		script.addEventListener("error", () => {
			loaderPromise = null;
			reject(new Error("Could not load /plugin-loader.js"));
		}, { once: true });
		doc.head.appendChild(script);
	});
}

async function ensureBrowserPluginLoader(doc: Document | null | undefined): Promise<(url: string) => Promise<PluginFrontendModule>> {
	const g = globalThis as LoaderWindow;
	if (typeof g.__lhImportPlugin === "function") return g.__lhImportPlugin;
	if (doc?.head) {
		loaderPromise ??= injectPluginLoaderScript(doc, g);
		await loaderPromise;
	}
	if (typeof g.__lhImportPlugin === "function") return g.__lhImportPlugin;
	return (url: string) => import(/* @vite-ignore */ url) as Promise<PluginFrontendModule>;
}

function attachPluginStylesheet(doc: Document | null | undefined, url: string, onError: () => void): PluginCleanup {
	const targetDoc = doc ?? (typeof document !== "undefined" ? document : null);
	if (!targetDoc?.head) return () => {};
	const link = targetDoc.createElement("link");
	link.rel = "stylesheet";
	link.href = url;
	link.setAttribute("data-plugin-style", url);
	link.addEventListener("error", onError, { once: true });
	targetDoc.head.appendChild(link);
	return () => { link.remove(); };
}

function wireSingleEventType(events: Events, manager: PluginFrontendManager, type: (typeof SERVER_EVENT_TYPES)[number]): Unsubscribe {
	if (type === "plugin-message") return events.on("plugin-message", (ev) => manager.notify(ev));
	if (type === "plugins-changed") {
		return events.on("plugins-changed", (ev) => {
			manager.appEvent({ type: "plugins-changed", ...ev } as ServerEvent);
			void manager.reload();
		});
	}
	return events.on(type, (payload) => manager.appEvent({ type, ...(payload as object) } as ServerEvent));
}

function wireManagerEvents(events: Events, manager: PluginFrontendManager): Unsubscribe {
	const offs: Unsubscribe[] = SERVER_EVENT_TYPES.map((type) => wireSingleEventType(events, manager, type));
	offs.push(events.onResync(() => manager.resync()));
	return () => { for (const off of offs) off(); };
}

function mountPluginFence(
	manager: PluginFrontendManager,
	reg: CodeBlockRegistration,
	container: HTMLElement,
	block: { source: string; meta?: string; incomplete?: boolean; signal?: AbortSignal },
) {
	const propsBase = {
		language: reg.renderer.language,
		source: block.source ?? "",
		meta: block.meta ?? "",
		incomplete: Boolean(block.incomplete),
	};
	const off = manager.mountRenderer(reg, (child, signal) => reg.renderer.mount(child, { ...propsBase, signal }), container, () => {});
	block?.signal?.addEventListener("abort", () => off(), { once: true });
	return off;
}

function createFenceAdapter(manager: PluginFrontendManager, reg: CodeBlockRegistration) {
	return {
		language: reg.renderer.language,
		mount: (container: HTMLElement, block: { source: string; meta?: string; incomplete?: boolean; signal?: AbortSignal }) =>
			mountPluginFence(manager, reg, container, block),
	};
}

function syncCodeBlockRegistrations(
	manager: PluginFrontendManager,
	blocks: BlockRegistrySyncTarget,
	mounted: Map<CodeBlockRegistration, () => void>,
	nextList: readonly CodeBlockRegistration[],
): void {
	const keep = new Set(nextList);
	for (const [reg, release] of [...mounted.entries()]) {
		if (!keep.has(reg)) {
			mounted.delete(reg);
			release();
		}
	}
	for (const reg of nextList) {
		if (!mounted.has(reg)) {
			mounted.set(reg, blocks.register(createFenceAdapter(manager, reg)));
		}
	}
}

async function dispatchPluginsIntent(manager: PluginFrontendManager, intent: PluginsIntent): Promise<void> {
	switch (intent.type) {
		case "reload":
			return manager.reload(intent.clearError);
		case "refresh":
			return manager.refresh();
		case "set-enabled":
			return manager.setEnabled(intent.id, intent.enabled);
		case "run-action":
			return manager.runAction(intent.pluginId, intent.action, intent.context);
		default:
			return assertNeverIntent(intent);
	}
}

function buildPluginHost(
	options: CreatePluginsStoreOptions,
	targetDoc: Document | null,
	getUiFactory: () => PluginUiFactory | null,
): PluginHost {
	return {
		reservedCodeBlockLanguages: RESERVED_CODE_BLOCK_LANGUAGES,
		reservedToolNames: RESERVED_TOOL_NAMES,
		fetch: options.api.fetch,
		importModule: options.importModule ?? (async (url) => (await ensureBrowserPluginLoader(targetDoc))(url)),
		pathname: () => options.router.get().pathname,
		navigate: (path) => { void options.router.send({ type: "navigate", to: path }); },
		openSettings: (pluginId) => { void options.shell.send({ type: "open-settings", section: `plugin:${pluginId}` }); },
		createUi: (uiOpts) => {
			const factory = getUiFactory();
			if (!factory) throw new Error("Plugin UI host is unavailable");
			return factory(uiOpts);
		},
		style: (url, onError) => attachPluginStylesheet(targetDoc, url, onError),
	};
}

export function createPluginsStore(options: CreatePluginsStoreOptions): PluginsStore {
	let uiFactory: PluginUiFactory | null = null;
	let disposed = false;
	const targetDoc = options.doc ?? (typeof document !== "undefined" ? document : null);
	const manager = new PluginFrontendManager(buildPluginHost(options, targetDoc, () => uiFactory));
	const cell = createCell<PluginSnapshot>(manager.getSnapshot());
	const offMgr = manager.subscribe(() => { if (!disposed) cell.set(manager.getSnapshot()); });
	const offEv = wireManagerEvents(options.events, manager);
	if (options.autoStart !== false) queueMicrotask(() => { if (!disposed) manager.start(); });

	const bindBlockRegistry = (blocks: BlockRegistrySyncTarget): Unsubscribe => {
		const mounted = new Map<CodeBlockRegistration, () => void>();
		const sync = () => syncCodeBlockRegistrations(manager, blocks, mounted, manager.getSnapshot().codeBlocks);
		sync();
		const off = manager.subscribe(sync);
		return () => { off(); for (const release of mounted.values()) release(); mounted.clear(); };
	};

	return {
		manager,
		get: () => cell.get(),
		subscribe: (fn) => cell.subscribe(fn),
		send: (intent) => (disposed ? Promise.reject(new Error("PluginsStore is disposed")) : dispatchPluginsIntent(manager, intent)),
		start: () => { if (!disposed) manager.start(); },
		setUiFactory: (factory) => { uiFactory = factory; },
		bindBlockRegistry,
		dispose() { if (!disposed) { disposed = true; offEv(); offMgr(); void manager.dispose(); } },
	};
}
