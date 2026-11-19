/**
 * Shell UI store (`R4`, `client-contract-state §2.3`).
 * Owns chrome state (`platform`, `electron`, `zoom`, `sidebar`, `settings`,
 * `cheatSheet`, `update`) so views hold zero application state.
 */

import {
	assertNeverIntent,
	createCell,
	createStoreFromCell,
	type Store,
} from "./store.ts";

export interface ShellModel {
	readonly platform: "mac" | "win" | "linux" | "web";
	readonly electron: boolean;
	readonly zoom: number;
	readonly sidebar: { readonly open: boolean; readonly narrow: boolean };
	readonly settings: { readonly open: boolean; readonly section: string | null };
	readonly cheatSheet: boolean;
	readonly update: null | { readonly status: string; readonly version: string };
}

export type ShellIntent =
	| { readonly type: "toggle-sidebar" }
	| { readonly type: "set-sidebar"; readonly open: boolean }
	| { readonly type: "set-narrow"; readonly narrow: boolean }
	| { readonly type: "set-zoom"; readonly zoom: number }
	| { readonly type: "open-settings"; readonly section?: string | null }
	| { readonly type: "close-settings" }
	| { readonly type: "toggle-cheat-sheet" }
	| { readonly type: "close-cheat-sheet" };

export const DEFAULT_SHELL_MODEL: ShellModel = Object.freeze({
	platform: "web",
	electron: false,
	zoom: 1,
	sidebar: Object.freeze({ open: true, narrow: false }),
	settings: Object.freeze({ open: false, section: null }),
	cheatSheet: false,
	update: null,
});

function buildInitialShellModel(initial?: Partial<ShellModel>): ShellModel {
	if (!initial) return DEFAULT_SHELL_MODEL;
	return {
		platform: initial.platform ?? DEFAULT_SHELL_MODEL.platform,
		electron: initial.electron ?? DEFAULT_SHELL_MODEL.electron,
		zoom: initial.zoom ?? DEFAULT_SHELL_MODEL.zoom,
		sidebar: initial.sidebar ? { ...initial.sidebar } : DEFAULT_SHELL_MODEL.sidebar,
		settings: initial.settings ? { ...initial.settings } : DEFAULT_SHELL_MODEL.settings,
		cheatSheet: initial.cheatSheet ?? DEFAULT_SHELL_MODEL.cheatSheet,
		update: initial.update ? { ...initial.update } : null,
	};
}

function reduceShellIntent(cur: ShellModel, intent: ShellIntent): ShellModel {
	switch (intent.type) {
		case "toggle-sidebar":
			return { ...cur, sidebar: { ...cur.sidebar, open: !cur.sidebar.open } };
		case "set-sidebar":
			if (cur.sidebar.open === intent.open) return cur;
			return { ...cur, sidebar: { ...cur.sidebar, open: intent.open } };
		case "set-narrow":
			if (cur.sidebar.narrow === intent.narrow) return cur;
			return { ...cur, sidebar: { ...cur.sidebar, narrow: intent.narrow } };
		case "set-zoom": {
			if (!Number.isFinite(intent.zoom) || intent.zoom <= 0 || cur.zoom === intent.zoom) return cur;
			return { ...cur, zoom: intent.zoom };
		}
		case "open-settings": {
			const section = intent.section ?? null;
			if (cur.settings.open && cur.settings.section === section) return cur;
			return { ...cur, settings: { open: true, section } };
		}
		case "close-settings":
			if (!cur.settings.open && cur.settings.section === null) return cur;
			return { ...cur, settings: { open: false, section: null } };
		case "toggle-cheat-sheet":
			return { ...cur, cheatSheet: !cur.cheatSheet };
		case "close-cheat-sheet":
			if (!cur.cheatSheet) return cur;
			return { ...cur, cheatSheet: false };
		default:
			return assertNeverIntent(intent);
	}
}

export function createShellStore(initial?: Partial<ShellModel>): Store<ShellModel, ShellIntent> {
	const cell = createCell<ShellModel>(buildInitialShellModel(initial));
	return createStoreFromCell<ShellModel, ShellIntent>(cell, {
		onSend(intent) {
			cell.set(reduceShellIntent(cell.get(), intent));
		},
	});
}
