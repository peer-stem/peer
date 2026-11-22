/**
 * Plugin full-page view screen store (`/plugins/:pluginId/:viewId`, `f4-c2c`).
 */

import type { PluginView } from "../../../core/index.ts";
import type { FrontendPlugin, PluginFrontendManager, PluginSnapshot } from "../../engine/index.ts";
import type { PluginsStore } from "../plugins.ts";
import type { Route, RouteModel, RouterStore } from "../router.ts";
import type { ShellIntent, ShellModel } from "../shell.ts";
import { assertNeverIntent, createCell, createStoreFromCell, type Store } from "../store.ts";

export type PluginViewRoute = Extract<Route, { readonly name: "plugin-view" }>;

export interface PluginViewScreenModel {
	readonly route: PluginViewRoute;
	readonly pluginId: string;
	readonly viewId: string;
	readonly loading: boolean;
	readonly error: string | null;
	readonly plugin: FrontendPlugin | null;
	readonly view: PluginView | null;
	readonly unavailableReason: string | null;
	readonly plugins: PluginSnapshot;
	readonly manager: PluginFrontendManager;
}

export type PluginViewScreenIntent =
	| { readonly type: "sync-route"; readonly routeModel: RouteModel }
	| { readonly type: "open-settings"; readonly section?: string }
	| { readonly type: "navigate-home" };

export interface CreatePluginViewScreenStoreOptions {
	routeModel: RouteModel;
	router: RouterStore;
	plugins: PluginsStore;
	shell: Store<ShellModel, ShellIntent>;
}

function resolvePluginViewRoute(rm: RouteModel): PluginViewRoute {
	if (rm.route.name === "plugin-view") return rm.route;
	return { name: "plugin-view", pluginId: "", viewId: "" };
}

function deriveUnavailableReason(
	snap: PluginSnapshot,
	plugin: FrontendPlugin | null,
	view: PluginView | null,
): string | null {
	if (snap.loading && !plugin) return "Loading plugin view…";
	if (!plugin) return "Plugin is not installed.";
	if (!plugin.info.enabled || plugin.phase === "disabled") return "Plugin is disabled.";
	if (plugin.phase === "error" || plugin.info.status === "error") {
		return plugin.error ?? plugin.info.error ?? "Plugin failed to load.";
	}
	if (plugin.phase === "loading") return "Loading plugin view…";
	if (!view) return "Plugin view was not registered.";
	return null;
}

function projectPluginViewScreen(route: PluginViewRoute, plugins: PluginsStore): PluginViewScreenModel {
	const snap = plugins.get();
	const plugin = snap.plugins.find((p) => p.info.id === route.pluginId) ?? null;
	const view = plugin?.views.find((v) => v.id === route.viewId) ?? null;
	return {
		route,
		pluginId: route.pluginId,
		viewId: route.viewId,
		loading: snap.loading || plugin?.phase === "loading",
		error: snap.error ?? plugin?.error ?? null,
		plugin,
		view,
		unavailableReason: deriveUnavailableReason(snap, plugin, view),
		plugins: snap,
		manager: plugins.manager,
	};
}

async function handlePluginViewIntent(
	intent: PluginViewScreenIntent,
	options: CreatePluginViewScreenStoreOptions,
	getPluginId: () => string,
	onRoute: (route: PluginViewRoute) => void,
): Promise<void> {
	switch (intent.type) {
		case "sync-route":
			if (intent.routeModel.route.name === "plugin-view") onRoute(intent.routeModel.route);
			return;
		case "open-settings":
			return options.shell.send({ type: "open-settings", section: intent.section ?? `plugin:${getPluginId()}` });
		case "navigate-home":
			return options.router.send({ type: "navigate", to: { name: "home" } });
		default:
			return assertNeverIntent(intent);
	}
}

export function createPluginViewScreenStore(
	options: CreatePluginViewScreenStoreOptions,
): Store<PluginViewScreenModel, PluginViewScreenIntent> {
	let currentRoute = resolvePluginViewRoute(options.routeModel);
	let disposed = false;
	const compute = () => projectPluginViewScreen(currentRoute, options.plugins);
	const cell = createCell<PluginViewScreenModel>(compute());
	const publish = () => { if (!disposed) cell.set(compute()); };
	const offPlugins = options.plugins.subscribe(publish);
	const offRouter = options.router.subscribe((rm) => {
		if (rm.route.name !== "plugin-view") return;
		if (rm.route.pluginId === currentRoute.pluginId && rm.route.viewId === currentRoute.viewId) return;
		currentRoute = rm.route;
		publish();
	});

	return createStoreFromCell<PluginViewScreenModel, PluginViewScreenIntent>(cell, {
		onSend: (intent) => handlePluginViewIntent(intent, options, () => currentRoute.pluginId, (r) => { currentRoute = r; publish(); }),
		onDispose() { disposed = true; offRouter(); offPlugins(); },
	});
}
