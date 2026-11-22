import type {
	PluginAction,
	PluginActionContext,
	PluginCleanup,
	PluginInfo,
} from "../../../core/index.ts";
import { buildPluginFrontendContext } from "./context.ts";
import {
	errorMessage,
	pluginAssetUrl,
	type FrontendPlugin,
	type ManagerBridge,
	type PluginLifecycle,
	type PluginMount,
} from "./types.ts";

export interface LifecycleStore {
	readonly bridge: ManagerBridge;
	readonly lives: Map<string, PluginLifecycle>;
	readonly teardowns: Map<string, Promise<void>>;
	readonly cleanupErrors: Map<string, string>;
	readonly pending: Set<string>;
	isDisposed(): boolean;
	track(life: PluginLifecycle, task: Promise<void>): void;
	disposeCallback(life: PluginLifecycle, cleanup: PluginCleanup): void;
}

export function createEmptyLifecycle(info: PluginInfo): PluginLifecycle {
	return {
		id: info.id,
		revision: info.revision,
		controller: new AbortController(),
		cleanups: new Set(),
		activation: Promise.resolve(),
		tasks: new Set(),
		views: new Map(),
		actions: new Map(),
		shortcuts: new Map(),
		placements: new Map(),
		actionBusy: new Set(),
		codeBlocks: new Map(),
		toolRenderers: new Map(),
		questionRenderers: new Map(),
		problemRenderers: new Map(),
		submissionInterceptors: new Map(),
		notifications: new Set(),
		events: new Set(),
		resyncs: new Set(),
		phase: "loading",
	};
}

export function buildFrontendPluginList(
	infos: readonly PluginInfo[],
	lives: ReadonlyMap<string, PluginLifecycle>,
	cleanupErrors: ReadonlyMap<string, string>,
	pending: ReadonlySet<string>,
): FrontendPlugin[] {
	return infos.map((info) => {
		const life = lives.get(info.id);
		return {
			info,
			phase: life?.phase ?? (info.enabled ? (info.status === "error" ? "error" : "active") : "disabled"),
			error: life?.error ?? cleanupErrors.get(info.id) ?? info.error,
			views: [...(life?.views.values() ?? [])],
			actions: [...(life?.actions.values() ?? [])],
			shortcuts: [...(life?.shortcuts ?? [])].map(([actionId, shortcut]) => ({ actionId, shortcut })),
			placements: [...(life?.placements.values() ?? [])],
			actionBusy: [...(life?.actionBusy ?? [])],
			settings: life?.settings,
			busy: pending.has(info.id),
		};
	});
}

function clearLifecycleCollections(life: PluginLifecycle): void {
	life.views.clear();
	life.actions.clear();
	life.placements.clear();
	life.actionBusy.clear();
	life.settings = undefined;
	life.codeBlocks.clear();
	life.toolRenderers.clear();
	life.questionRenderers.clear();
	life.problemRenderers.clear();
	life.submissionInterceptors.clear();
	life.notifications.clear();
	life.events.clear();
	life.resyncs.clear();
}

export function stopPluginLifecycle(store: LifecycleStore, life: PluginLifecycle): Promise<void> {
	if (store.lives.get(life.id) === life) store.lives.delete(life.id);
	if (life.teardown) return life.teardown;
	life.controller.abort();
	clearLifecycleCollections(life);
	const cleanups = [...life.cleanups].reverse();
	life.cleanups.clear();
	for (const cleanup of cleanups) store.disposeCallback(life, cleanup);
	const teardown = (async () => {
		await life.activation;
		while (life.tasks.size) await Promise.all([...life.tasks]);
	})();
	life.teardown = teardown;
	store.teardowns.set(life.id, teardown);
	void teardown.then(() => {
		if (store.teardowns.get(life.id) === teardown) store.teardowns.delete(life.id);
	});
	return teardown;
}

export async function activatePluginLifecycle(
	store: LifecycleStore,
	info: PluginInfo,
	life: PluginLifecycle,
): Promise<void> {
	const manifest = info.manifest!;
	const { bridge } = store;
	const context = buildPluginFrontendContext(bridge, info, life);
	try {
		if (manifest.styles && bridge.host.style) {
			const onErr = () => bridge.report(life, new Error("Plugin stylesheet could not be loaded"));
			bridge.addCleanup(life, bridge.host.style(pluginAssetUrl(info, manifest.styles), onErr));
		}
		const frontend = await bridge.host.importModule(pluginAssetUrl(info, manifest.main!));
		if (!bridge.current(life)) return;
		if (typeof frontend.activate !== "function") throw new Error("Plugin frontend must export activate(context)");
		const cleanup = await frontend.activate(context);
		if (typeof cleanup === "function") bridge.addCleanup(life, cleanup);
		if (!bridge.current(life)) return;
		life.phase = "active";
		bridge.publish();
	} catch (error) {
		if (!bridge.current(life)) return;
		void stopPluginLifecycle(store, life);
		life.phase = "error";
		life.error = errorMessage(error);
		store.lives.set(life.id, life);
		bridge.publish();
	}
}

async function executePluginAction(
	bridge: ManagerBridge,
	life: PluginLifecycle,
	action: PluginAction,
	captured: PluginActionContext,
): Promise<void> {
	try {
		bridge.publish();
		await action.run(captured);
	} catch (error) {
		bridge.report(life, error);
	} finally {
		if (life.actionBusy.delete(action.id) && bridge.current(life)) bridge.publish();
	}
}

export function startPluginAction(
	bridge: ManagerBridge,
	life: PluginLifecycle | undefined,
	action: PluginAction,
	context: PluginActionContext | (() => PluginActionContext | undefined),
): Promise<void> | undefined {
	if (!life || !bridge.current(life) || life.actions.get(action.id) !== action || life.actionBusy.has(action.id)) return;
	try {
		const captured = typeof context === "function" ? context() : context;
		if (!captured || (typeof action.disabled === "function" ? action.disabled(captured) : action.disabled)) return;
		life.actionBusy.add(action.id);
		return executePluginAction(bridge, life, action, captured);
	} catch (error) {
		bridge.report(life, error);
	}
}

export function mountPluginIntoContainer(
	store: LifecycleStore,
	life: PluginLifecycle,
	mount: PluginMount,
	container: HTMLElement,
	onError: (error: string) => void,
): () => void {
	const { bridge } = store;
	let alive = true;
	const controller = new AbortController();
	let returned: PluginCleanup | undefined;
	const child = container.ownerDocument.createElement("div");
	child.className = "min-h-0 min-w-0 flex-1";
	container.appendChild(child);
	const off = bridge.addCleanup(life, () => {
		alive = false;
		controller.abort();
		child.remove();
		if (returned) {
			const cleanup = returned;
			returned = undefined;
			store.disposeCallback(life, cleanup);
		}
	});
	const runMount = async () => {
		if (!alive || !bridge.current(life)) return;
		try {
			const cleanup = await mount(child, controller.signal);
			if (typeof cleanup !== "function") return;
			if (!alive || !bridge.current(life)) store.disposeCallback(life, cleanup);
			else returned = cleanup;
		} catch (error) {
			if (!alive || !bridge.current(life)) return;
			onError(errorMessage(error));
			bridge.report(life, error);
			off();
		}
	};
	store.track(life, Promise.resolve().then(runMount));
	return off;
}
