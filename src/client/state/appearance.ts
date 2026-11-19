/**
 * Appearance store (`client-contract-state §2.3, §8.1`).
 * Fetches `GET /api/themes` (falling back to `BUILTIN_THEMES`), resolves the
 * active `Theme` against `settings.effective.appearance`, and projects
 * `--cc-*` and `--peer-*` tokens via `buildThemeTokens`.
 */

import {
	BUILTIN_THEMES,
	resolveTheme,
	type Theme,
} from "../../core/themes.ts";
import {
	buildThemeTokens,
	type ThemeTokens,
} from "../theme/tokens.ts";
import { isAbortError, type ApiClient } from "./api.ts";
import type { Events } from "./events.ts";
import type { SettingsIntent, SettingsModel } from "./settings.ts";
import type { ShellIntent, ShellModel } from "./shell.ts";
import {
	assertNeverIntent,
	createCell,
	createStoreFromCell,
	type Cell,
	type LoadState,
	type Store,
} from "./store.ts";

export type { ThemeTokens };

export interface AppearanceModel {
	readonly load: LoadState;
	readonly theme: Theme;
	readonly themes: readonly Theme[];
	readonly tokens: ThemeTokens;
}

export type AppearanceIntent = { readonly type: "reload" };

export interface CreateAppearanceStoreOptions {
	api: ApiClient;
	settings: Store<SettingsModel, SettingsIntent>;
	shell: Store<ShellModel, ShellIntent>;
	events: Events;
}

interface AppearanceContext {
	readonly api: ApiClient;
	readonly settings: Store<SettingsModel, SettingsIntent>;
	readonly shell: Store<ShellModel, ShellIntent>;
	readonly cell: Cell<AppearanceModel>;
	load: LoadState;
	catalog: readonly Theme[];
	lastZoom: number;
	disposed: boolean;
	ticketSeq: number;
	activeLoad: AbortController | null;
}

function computeAppearanceModel(
	load: LoadState,
	themes: readonly Theme[],
	settings: Store<SettingsModel, SettingsIntent>,
	shell: Store<ShellModel, ShellIntent>,
): AppearanceModel {
	const customThemes = themes.filter((t) => !t.builtin);
	const effectiveAppearance = settings.get().effective.appearance;
	const theme = resolveTheme(effectiveAppearance.theme, customThemes);
	const tokens = buildThemeTokens(theme, effectiveAppearance, shell.get().zoom);
	return { load, theme, themes, tokens };
}

function publishAppearance(ctx: AppearanceContext): void {
	if (ctx.disposed) return;
	ctx.lastZoom = ctx.shell.get().zoom;
	ctx.cell.set(computeAppearanceModel(ctx.load, ctx.catalog, ctx.settings, ctx.shell));
}

async function fetchThemesCatalog(ctx: AppearanceContext): Promise<void> {
	if (ctx.disposed) return;
	const ticket = ++ctx.ticketSeq;
	ctx.activeLoad?.abort();
	const controller = new AbortController();
	ctx.activeLoad = controller;
	try {
		const res = await ctx.api.json<{ themes?: Theme[] }>("/api/themes", {
			signal: controller.signal,
		});
		if (ctx.disposed || ticket !== ctx.ticketSeq) return;
		ctx.catalog = Array.isArray(res.themes) && res.themes.length > 0 ? res.themes : BUILTIN_THEMES;
		ctx.load = "ready";
		publishAppearance(ctx);
	} catch (err) {
		if (ctx.disposed || ticket !== ctx.ticketSeq || isAbortError(err)) return;
		ctx.catalog = BUILTIN_THEMES;
		ctx.load = "error";
		publishAppearance(ctx);
	}
}

export function createAppearanceStore({
	api,
	settings,
	shell,
	events,
}: CreateAppearanceStoreOptions): Store<AppearanceModel, AppearanceIntent> {
	const cell = createCell<AppearanceModel>(
		computeAppearanceModel("loading", BUILTIN_THEMES, settings, shell),
	);
	const ctx: AppearanceContext = {
		api,
		settings,
		shell,
		cell,
		load: "loading",
		catalog: BUILTIN_THEMES,
		lastZoom: shell.get().zoom,
		disposed: false,
		ticketSeq: 0,
		activeLoad: null,
	};

	const offSettings = settings.subscribe(() => publishAppearance(ctx));
	const offShell = shell.subscribe(() => {
		if (shell.get().zoom !== ctx.lastZoom) publishAppearance(ctx);
	});
	const offResync = events.onResync(() => {
		void fetchThemesCatalog(ctx);
	});
	void fetchThemesCatalog(ctx);

	return createStoreFromCell<AppearanceModel, AppearanceIntent>(cell, {
		async onSend(intent) {
			if (intent.type === "reload") return fetchThemesCatalog(ctx);
			assertNeverIntent(intent);
		},
		onDispose() {
			ctx.disposed = true;
			offSettings();
			offShell();
			offResync();
			ctx.activeLoad?.abort();
		},
	});
}
