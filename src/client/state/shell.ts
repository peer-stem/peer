/**
 * Shell UI store (`R4`, `client-contract-state §2.3`).
 * Owns chrome state (`platform`, `electron`, `zoom`, `sidebar`, `settings`,
 * `setupOpen`, `cheatSheet`, `update`, `startupMessage`) so views hold zero application state.
 */

import {
	assertNeverIntent,
	createCell,
	createStoreFromCell,
	type Store,
} from "./store.ts";

export interface StartupMessageItem {
	readonly id: string;
	readonly title: string;
	readonly publishedAt: string;
	readonly bodyMarkdown: string;
}

export interface ShellModel {
	readonly platform: "mac" | "win" | "linux" | "web";
	readonly electron: boolean;
	readonly zoom: number;
	readonly sidebar: { readonly open: boolean; readonly narrow: boolean };
	readonly settings: { readonly open: boolean; readonly section: string | null };
	readonly setupOpen?: boolean;
	readonly cheatSheet: boolean;
	readonly update: null | { readonly status: string; readonly version: string };
	readonly startupMessage: null | StartupMessageItem;
}

export type ShellIntent =
	| { readonly type: "toggle-sidebar" }
	| { readonly type: "set-sidebar"; readonly open: boolean }
	| { readonly type: "set-narrow"; readonly narrow: boolean }
	| { readonly type: "set-zoom"; readonly zoom: number }
	| { readonly type: "open-settings"; readonly section?: string | null }
	| { readonly type: "close-settings" }
	| { readonly type: "open-setup" }
	| { readonly type: "close-setup" }
	| { readonly type: "set-update"; readonly update: ShellModel["update"] }
	| { readonly type: "set-startup-message"; readonly message: ShellModel["startupMessage"] }
	| { readonly type: "clear-startup-message" }
	| { readonly type: "toggle-cheat-sheet" }
	| { readonly type: "close-cheat-sheet" };

export const DEFAULT_SHELL_MODEL: ShellModel = Object.freeze({
	platform: "web",
	electron: false,
	zoom: 1,
	sidebar: Object.freeze({ open: true, narrow: false }),
	settings: Object.freeze({ open: false, section: null }),
	setupOpen: false,
	cheatSheet: false,
	update: null,
	startupMessage: null,
});

function cloneStartupMessage(msg: ShellModel["startupMessage"] | undefined): ShellModel["startupMessage"] {
	if (!msg) return null;
	return {
		id: msg.id,
		title: msg.title,
		publishedAt: msg.publishedAt,
		bodyMarkdown: msg.bodyMarkdown,
	};
}

export function makeShellModel(initial?: Partial<ShellModel>): ShellModel {
	if (!initial) return DEFAULT_SHELL_MODEL;
	return {
		platform: initial.platform ?? DEFAULT_SHELL_MODEL.platform,
		electron: initial.electron ?? DEFAULT_SHELL_MODEL.electron,
		zoom: initial.zoom ?? DEFAULT_SHELL_MODEL.zoom,
		sidebar: initial.sidebar ? { ...initial.sidebar } : DEFAULT_SHELL_MODEL.sidebar,
		settings: initial.settings ? { ...initial.settings } : DEFAULT_SHELL_MODEL.settings,
		setupOpen: initial.setupOpen ?? false,
		cheatSheet: initial.cheatSheet ?? DEFAULT_SHELL_MODEL.cheatSheet,
		update: initial.update ? { ...initial.update } : null,
		startupMessage: cloneStartupMessage(initial.startupMessage),
	};
}

type OverlayShellIntent = Extract<
	ShellIntent,
	{
		type:
			| "open-settings"
			| "close-settings"
			| "open-setup"
			| "close-setup"
			| "set-update"
			| "set-startup-message"
			| "clear-startup-message"
			| "toggle-cheat-sheet"
			| "close-cheat-sheet";
	}
>;

function reduceOverlayShellIntent(cur: ShellModel, intent: OverlayShellIntent): ShellModel {
	switch (intent.type) {
		case "open-settings": {
			const section = intent.section ?? null;
			if (cur.settings.open && cur.settings.section === section) return cur;
			return { ...cur, settings: { open: true, section } };
		}
		case "close-settings":
			if (!cur.settings.open && cur.settings.section === null) return cur;
			return { ...cur, settings: { open: false, section: null } };
		case "open-setup":
			return cur.setupOpen === true ? cur : { ...cur, setupOpen: true };
		case "close-setup":
			return !cur.setupOpen ? cur : { ...cur, setupOpen: false };
		case "set-update": {
			const update = intent.update ? { status: intent.update.status, version: intent.update.version } : null;
			return { ...cur, update };
		}
		case "set-startup-message":
			return { ...cur, startupMessage: cloneStartupMessage(intent.message) };
		case "clear-startup-message":
			return cur.startupMessage === null ? cur : { ...cur, startupMessage: null };
		case "toggle-cheat-sheet":
			return { ...cur, cheatSheet: !cur.cheatSheet };
		case "close-cheat-sheet":
			return !cur.cheatSheet ? cur : { ...cur, cheatSheet: false };
	}
}

function reduceShellIntent(cur: ShellModel, intent: ShellIntent): ShellModel {
	switch (intent.type) {
		case "toggle-sidebar":
			return { ...cur, sidebar: { ...cur.sidebar, open: !cur.sidebar.open } };
		case "set-sidebar":
			return cur.sidebar.open === intent.open ? cur : { ...cur, sidebar: { ...cur.sidebar, open: intent.open } };
		case "set-narrow":
			return cur.sidebar.narrow === intent.narrow ? cur : { ...cur, sidebar: { ...cur.sidebar, narrow: intent.narrow } };
		case "set-zoom":
			if (!Number.isFinite(intent.zoom) || intent.zoom <= 0 || cur.zoom === intent.zoom) return cur;
			return { ...cur, zoom: intent.zoom };
		case "open-settings":
		case "close-settings":
		case "open-setup":
		case "close-setup":
		case "set-update":
		case "set-startup-message":
		case "clear-startup-message":
		case "toggle-cheat-sheet":
		case "close-cheat-sheet":
			return reduceOverlayShellIntent(cur, intent);
		default:
			return assertNeverIntent(intent);
	}
}

export function createShellStore(initial?: Partial<ShellModel>): Store<ShellModel, ShellIntent> {
	const cell = createCell<ShellModel>(makeShellModel(initial));
	return createStoreFromCell<ShellModel, ShellIntent>(cell, {
		onSend(intent) {
			cell.set(reduceShellIntent(cell.get(), intent));
		},
	});
}
