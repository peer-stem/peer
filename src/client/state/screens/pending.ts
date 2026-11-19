/**
 * Pending & not-found screen projection store (`R3`, `views §2.3, §2.4`).
 * Backs routes whose interactive views land in C2 (`home`, `new-session`,
 * `plugin-view`) plus unmatched `not-found` routes in C1.
 */

import type { RouteModel, RouterStore } from "../router.ts";
import type { SettingsIntent, SettingsModel } from "../settings.ts";
import type { ShellIntent, ShellModel } from "../shell.ts";
import {
	assertNeverIntent,
	createCell,
	createStoreFromCell,
	type Store,
} from "../store.ts";

export type PendingRouteName = "home" | "new-session" | "plugin-view" | "not-found";

export interface PendingScreenModel {
	readonly routeName: PendingRouteName;
	readonly title: string;
	readonly body: string;
	readonly path: string;
	readonly configured: boolean;
}

export type PendingScreenIntent = {
	readonly type: "open-settings";
	readonly section?: string | null;
};

export interface CreatePendingScreenStoreOptions {
	router: RouterStore;
	settings: Store<SettingsModel, SettingsIntent>;
	shell: Store<ShellModel, ShellIntent>;
	routeModel?: RouteModel;
}

function projectPendingScreen(rm: RouteModel, configured: boolean): PendingScreenModel {
	const { route } = rm;
	if (route.name === "home") {
		return {
			routeName: "home",
			title: "Knowledge Map",
			body: configured
				? "Select or start a session from the sidebar."
				: "Configure your models in Settings to start learning.",
			path: rm.pathname,
			configured,
		};
	}
	if (route.name === "new-session") {
		return {
			routeName: "new-session",
			title: route.mode === "practice" ? "Practice session" : "New session",
			body: configured
				? "Interactive session launch lands in Sprint C2a."
				: "Configure your models in Settings before starting a session.",
			path: rm.pathname,
			configured,
		};
	}
	if (route.name === "plugin-view") {
		return {
			routeName: "plugin-view",
			title: `Plugin · ${route.pluginId}/${route.viewId}`,
			body: "Plugin screen views mount in Sprint C2c.",
			path: rm.pathname,
			configured,
		};
	}
	return {
		routeName: "not-found",
		title: "Page not found",
		body: `No screen matches ${rm.pathname}.`,
		path: rm.pathname,
		configured,
	};
}

export function createPendingScreenStore({
	router,
	settings,
	shell,
	routeModel,
}: CreatePendingScreenStoreOptions): Store<PendingScreenModel, PendingScreenIntent> {
	let currentRoute = routeModel ?? router.get();
	const compute = () => projectPendingScreen(currentRoute, settings.get().configured);
	const cell = createCell<PendingScreenModel>(compute());
	const publish = () => cell.set(compute());

	const offRouter = router.subscribe((next) => {
		if (next.route.name !== "session") {
			currentRoute = next;
			publish();
		}
	});
	const offSettings = settings.subscribe(publish);

	return createStoreFromCell<PendingScreenModel, PendingScreenIntent>(cell, {
		async onSend(intent) {
			if (intent.type === "open-settings") {
				await shell.send({ type: "open-settings", section: intent.section ?? null });
				return;
			}
			assertNeverIntent(intent);
		},
		onDispose() {
			offRouter();
			offSettings();
		},
	});
}
