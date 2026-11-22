import assert from "node:assert/strict";
import test from "node:test";
import { BUILTIN_THEMES, DEFAULT_RENDER_SETTINGS, resolveSettings } from "../src/core/index.ts";
import "./helpers/client-env.ts";
import { installDom, type InstalledDom } from "./helpers/client-dom.ts";

type AnyFn = (...args: any[]) => any;

interface MockStore<M, I = { readonly type: string }> {
	get(): M;
	set(next: M): void;
	intents: I[];
	subscribe(fn: (m: M) => void): () => void;
	send(intent: I): Promise<void>;
	dispose(): void;
}

function loadMod<T>(relPath: string): Promise<T> {
	return import(new URL(relPath, import.meta.url).href) as Promise<T>;
}

function createMockStore<M, I = { readonly type: string }>(
	initial: M,
	reducer?: (cur: M, intent: I) => M,
): MockStore<M, I> {
	let value = initial;
	const listeners = new Set<(m: M) => void>();
	const intents: I[] = [];
	const set = (next: M): void => {
		value = next;
		for (const fn of [...listeners]) fn(value);
	};
	return {
		get: () => value,
		set,
		intents,
		subscribe: (fn) => {
			listeners.add(fn);
			return () => { listeners.delete(fn); };
		},
		send: async (intent) => {
			intents.push(intent);
			if (reducer) set(reducer(value, intent));
		},
		dispose: () => { listeners.clear(); },
	};
}

function trackWindowListeners(win: Window & typeof globalThis): { activeCount(): number; restore(): void } {
	const origAdd = win.addEventListener.bind(win);
	const origRemove = win.removeEventListener.bind(win);
	const entries = new Map<string, { type: string; listener: unknown }>();
	let seq = 0;
	win.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject, opts?: boolean | AddEventListenerOptions) => {
		const sig = typeof opts === "object" && opts !== null ? opts.signal : undefined;
		if (sig?.aborted) return;
		const id = `l_${seq++}`;
		entries.set(id, { type, listener });
		if (sig) sig.addEventListener("abort", () => { entries.delete(id); }, { once: true });
		origAdd(type, listener, opts);
	}) as typeof win.addEventListener;
	win.removeEventListener = ((type: string, listener: EventListenerOrEventListenerObject, opts?: boolean | EventListenerOptions) => {
		for (const [id, item] of entries) {
			if (item.type === type && item.listener === listener) entries.delete(id);
		}
		origRemove(type, listener, opts);
	}) as typeof win.removeEventListener;
	return {
		activeCount: () => entries.size,
		restore: () => { win.addEventListener = origAdd; win.removeEventListener = origRemove; },
	};
}

function fireEscape(dom: InstalledDom): void {
	dom.window.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
}

interface C2aShellModel {
	platform: "mac" | "win" | "linux" | "web";
	electron: boolean;
	zoom: number;
	sidebar: { open: boolean; narrow: boolean };
	settings: { open: boolean; section: string | null };
	cheatSheet: boolean;
	setupOpen: boolean;
	startupMessage?: null | { id: string; title: string; publishedAt: string; bodyMarkdown: string };
	update: null | { status: string; version: string };
}

function makeC2aShellModel(overrides: Partial<C2aShellModel> = {}): C2aShellModel {
	return {
		platform: "linux",
		electron: true,
		zoom: 1,
		sidebar: { open: true, narrow: false },
		settings: { open: false, section: null },
		cheatSheet: false,
		setupOpen: false,
		startupMessage: null,
		update: null,
		...overrides,
	};
}

function reduceC2aShell(m: C2aShellModel, i: { type: string; section?: string | null }): C2aShellModel {
	if (i.type === "open-settings") return { ...m, settings: { open: true, section: i.section ?? null } };
	if (i.type === "close-settings") return { ...m, settings: { open: false, section: null } };
	if (i.type === "open-setup") return { ...m, setupOpen: true };
	if (i.type === "close-setup") return { ...m, setupOpen: false };
	if (i.type === "toggle-cheat-sheet") return { ...m, cheatSheet: !m.cheatSheet };
	if (i.type === "close-cheat-sheet") return { ...m, cheatSheet: false };
	if (i.type === "clear-startup-message") return { ...m, startupMessage: null };
	return m;
}

function makeSettingsData() {
	return {
		load: "ready",
		error: null as string | null,
		saving: false,
		record: {
			version: 1,
			models: { strong: { model: { provider: "anthropic", id: "claude-sonnet-4" }, thinkingLevel: "high" as const } },
			appearance: { theme: "default" },
		},
		effective: resolveSettings(null),
		configured: true,
		lastImport: null as Record<string, unknown> | null,
		keys: [
			{ id: "ANTHROPIC_API_KEY", label: "Anthropic", present: true, masked: "••••1234", source: "file" },
			{ id: "TAVILY_API_KEY", label: "Tavily", present: true, masked: "••••9999", source: "file" },
		],
		providerKeys: [{ id: "anthropic", envVar: "ANTHROPIC_API_KEY", label: "Anthropic" }],
		searchStatus: { available: true, engine: "tavily", reason: "Using Tavily (API key configured)" },
		prompts: {
			prober: [{ path: "shared/05-tone.md", sourceText: "Be concise.", overrideText: null, enabled: false, shared: true }],
			teacher: [
				{ path: "teacher/10-planning.md", sourceText: "# Plan\nStep by step.", overrideText: "Custom plan", enabled: false, shared: false },
				{ path: "shared/05-tone.md", sourceText: "Be concise.", overrideText: null, enabled: false, shared: true },
			],
			practice: [],
		},
		claudeCode: { installed: true, version: "1.0.0" },
		externalCli: null,
		subscriptions: null,
		customProvider: null,
	};
}

function buildShellFixtures(shellOverrides: Partial<C2aShellModel> = {}) {
	const shell = createMockStore(makeC2aShellModel(shellOverrides), reduceC2aShell);
	const settings = createMockStore(makeSettingsData());
	const models = createMockStore({
		load: "ready",
		error: null,
		refreshStatus: "idle" as string,
		models: [{ provider: "anthropic", id: "claude-sonnet-4", name: "Claude Sonnet 4", reasoning: true, supportedThinkingLevels: ["low", "high"] }],
		providers: ["anthropic"],
	});
	const appearance = createMockStore({
		load: "ready",
		theme: BUILTIN_THEMES[0]!,
		themes: BUILTIN_THEMES,
		tokens: { mode: "dark", cc: { "--cc-bg": "#141414" }, peer: { "--peer-zoom": "1" } },
	});
	const desktop = Object.assign(
		createMockStore({ electron: true, platform: "linux", zoom: 1, update: null }),
		{ pickDirectory: async () => "/picked/folder", pickFiles: async () => [] as readonly string[] },
	);
	const prefs = createMockStore({ sidebarOpen: true, userThinkingOpen: false, graphCamera: null, keymapOverrides: {} });
	return { shell, settings, models, appearance, desktop, prefs };
}

const HOME_FIXTURE = {
	route: { name: "home" },
	configured: true,
	mode: "dark",
	graphEnabled: false,
	viewTab: "chains",
	selectedNodeId: null,
	searchQuery: "",
	pickedNodeIds: [],
	camera: null,
	graph: { load: "ready", error: null, snapshot: null, positions: {}, renderSettings: DEFAULT_RENDER_SETTINGS, costs: null, runs: [], importing: false, importResults: [] },
	themeColors: { node: "#88c0d0", edge: "#4c566a", label: "#eceff4", hoverText: "#ffffff" },
	fontFamily: "sans-serif",
	startError: null,
	starting: false,
};

test("createSettingsDialog derives tab strictly from model.section (Finding #4) and covers v0.7.0 Models & Agent parity", async () => {
	const dom = installDom();
	const { createSettingsDialog } = await loadMod<{ createSettingsDialog: AnyFn }>("../src/client/views/settings/settings-dialog.js");
	const tracker = trackWindowListeners(dom.window);
	try {
		const host = dom.document.createElement("div");
		dom.document.body.append(host);
		const settingsIntents: Array<Record<string, unknown>> = [];
		const modelsIntents: Array<Record<string, unknown>> = [];
		const selectedTabs: string[] = [];

		const dialog = createSettingsDialog(host, {
			onSelectSection: (tab: string) => { selectedTabs.push(tab); },
			onSettingsIntent: (i: Record<string, unknown>) => { settingsIntents.push(i); return Promise.resolve(); },
			onModelsIntent: (i: Record<string, unknown>) => { modelsIntents.push(i); },
			onPickDirectory: async () => "/home/learner/notes",
		});
		const fxSettings = makeSettingsData();
		const fxModels = {
			load: "ready", error: null, refreshStatus: "updated",
			models: [{ provider: "anthropic", id: "claude-sonnet-4", name: "Claude Sonnet 4", supportedThinkingLevels: ["low", "high"] }],
		};
		dialog.update({ section: "models", settings: fxSettings, models: fxModels, appearance: { themes: BUILTIN_THEMES } });
		assert.notEqual(host.querySelector("[data-peer-import-input]"), null);

		(host.querySelector("[data-testid='settings-tab-agent']") as HTMLButtonElement).click();
		assert.deepEqual(selectedTabs, ["agent"]);
		assert.equal((host.querySelector("[data-testid='settings-panel-models']") as HTMLElement).hidden, false);

		(host.querySelector("[data-testid='models-advanced']") as HTMLButtonElement).click();
		const cacheSelect = host.querySelector("[data-testid='slot-cache-strong']") as HTMLSelectElement;
		assert.equal(cacheSelect.hidden, false);
		cacheSelect.value = "long";
		cacheSelect.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
		assert.equal(settingsIntents.some((i) => i.section === "models" && (i.value as any)?.strong?.cacheRetention === "long"), true);

		const refreshRow = host.querySelector("[data-testid='model-catalog-refresh-row']");
		assert.notEqual(refreshRow, null);
		assert.equal(refreshRow?.textContent?.includes("Model catalog updated."), true);
		(host.querySelector("[aria-label='Refresh model catalog']") as HTMLButtonElement).click();
		assert.deepEqual(modelsIntents[0], { type: "refresh-catalog" });

		dialog.update({ section: "agent", settings: fxSettings, models: fxModels });
		assert.equal((host.querySelector("[data-testid='settings-panel-agent']") as HTMLElement).hidden, false);
		assert.equal(host.querySelector("[data-testid='search-engine-reason']")?.textContent, "Using Tavily (API key configured)");

		(host.querySelector("[data-testid='quiz-mechanics-free']") as HTMLButtonElement).click();
		assert.equal(settingsIntents.some((i) => i.section === "agent" && (i.value as any)?.tools?.explain === true), true);

		const compInput = host.querySelector("[data-testid='input-compaction-threshold']") as HTMLInputElement;
		compInput.value = "10000";
		compInput.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
		assert.equal(settingsIntents.some((i) => i.section === "compaction" && (i.value as any)?.thresholdTokens === 32000), true);

		const folderAdd = host.querySelector("[data-testid='file-access-add']") as HTMLInputElement;
		folderAdd.value = "relative/bad";
		(host.querySelector("[data-testid='file-access-add-button']") as HTMLButtonElement).click();
		assert.equal((host.querySelector("[data-testid='file-access-input-error']") as HTMLElement).hidden, false);

		(host.querySelector("[data-testid='file-access-pick-button']") as HTMLButtonElement).click();
		await new Promise((r) => setTimeout(r, 0));
		assert.equal(settingsIntents.some((i) => i.section === "agent" && (i.value as any)?.fileAccess?.folders?.includes("/home/learner/notes")), true);

		dialog.destroy();
		assert.equal(host.childElementCount, 0);
		assert.equal(tracker.activeCount(), 0);
	} finally {
		tracker.restore();
		await dom.cleanup();
	}
});

test("v0.7.0 Prompts (sectionedSegments + PromptSegmentDialog) and Appearance (12-color + transcriptWidth + adaptiveQuestions)", async () => {
	const dom = installDom();
	const tracker = trackWindowListeners(dom.window);
	try {
		const { createSettingsDialog } = await loadMod<{ createSettingsDialog: AnyFn }>("../src/client/views/settings/settings-dialog.js");
		const host = dom.document.createElement("div");
		dom.document.body.append(host);
		const intents: Array<Record<string, unknown>> = [];
		const dialog = createSettingsDialog(host, {
			onSettingsIntent: (i: Record<string, unknown>) => { intents.push(i); return Promise.resolve(); },
		});
		const fxSettings = makeSettingsData();
		dialog.update({ section: "prompts", settings: fxSettings, appearance: { themes: BUILTIN_THEMES } });

		const sharedSec = host.querySelector("[data-testid='prompt-section-shared']");
		assert.notEqual(sharedSec, null);
		assert.equal(sharedSec?.textContent?.includes("Used by Teacher and Prober"), true);

		(host.querySelector("[data-testid='prompt-edit-teacher/10-planning.md']") as HTMLButtonElement).click();
		const segModal = host.querySelector("[data-testid='prompt-segment-dialog']");
		assert.notEqual(segModal, null);
		const segArea = host.querySelector("[data-testid='prompt-segment-textarea']") as HTMLTextAreaElement;
		segArea.value = "Updated override markdown";
		segArea.dispatchEvent(new dom.window.Event("input", { bubbles: true }));

		(host.querySelector("[data-testid='prompt-display-preview']") as HTMLButtonElement).click();
		assert.equal((host.querySelector("[data-testid='prompt-segment-preview']") as HTMLElement).hidden, false);

		(host.querySelector("[data-testid='prompt-dialog-close']") as HTMLButtonElement).click();
		assert.equal((host.querySelector("[data-testid='prompt-discard-guard']") as HTMLElement).hidden, false);
		(host.querySelector("[data-testid='prompt-keep-editing']") as HTMLButtonElement).click();
		assert.equal((host.querySelector("[data-testid='prompt-discard-guard']") as HTMLElement).hidden, true);

		(host.querySelector("[data-testid='prompt-dialog-save']") as HTMLButtonElement).click();
		await new Promise((r) => setTimeout(r, 0));
		assert.equal(intents.some((i) => i.type === "save-prompt" && i.path === "teacher/10-planning.md" && i.text === "Updated override markdown"), true);
		assert.equal(intents.some((i) => i.type === "save-section" && i.section === "agent" && (i.value as any)?.prompts?.["teacher/10-planning.md"] === true), true);

		dialog.update({ section: "appearance", settings: fxSettings, appearance: { themes: BUILTIN_THEMES } });
		assert.equal(host.querySelectorAll("[data-peer-color-input]").length, 12);
		const accentInput = host.querySelector("[data-peer-color-input='accent']") as HTMLInputElement;
		accentInput.value = "#ff6600";
		accentInput.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
		assert.equal(intents.some((i) => i.section === "appearance" && (i.value as any)?.colors?.accent === "#ff6600"), true);

		const widthPreset = host.querySelector("[data-testid='select-transcript-width']") as HTMLSelectElement;
		widthPreset.value = "wide";
		widthPreset.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
		assert.equal(intents.some((i) => i.section === "appearance" && (i.value as any)?.transcriptMaxWidth === 96), true);

		assert.notEqual(host.querySelector("[data-testid='row-adaptive-questions']"), null);
		dialog.destroy();
		assert.equal(host.childElementCount, 0);
		assert.equal(tracker.activeCount(), 0);
	} finally {
		tracker.restore();
		await dom.cleanup();
	}
});

test("createShell mounts all 8 tabs, setup-dialog, cheat-sheet, startup-message, and resolveScreenFactory without __peerBundle", async () => {
	const dom = installDom();
	const tracker = trackWindowListeners(dom.window);
	try {
		const { createShell } = await loadMod<{ createShell: AnyFn }>("../src/client/views/shell/shell.js");
		const { resolveScreenFactory } = await loadMod<{ resolveScreenFactory: AnyFn }>("../src/client/views/shell/screens.js");
		const host = dom.document.createElement("div");
		dom.document.body.append(host);
		const router = createMockStore({ route: { name: "home" }, pathname: "/", search: "", hash: "" });
		const fx = buildShellFixtures({
			setupOpen: true,
			cheatSheet: true,
			startupMessage: { id: "msg_1", title: "Welcome", publishedAt: "2026-11-22", bodyMarkdown: "Hello!" },
		});
		const homeStore = createMockStore(HOME_FIXTURE);
		const handle = createShell(host, { ...fx, router, screen: () => homeStore });

		assert.notEqual(host.querySelector("[data-testid='setup-dialog']"), null);
		assert.notEqual(host.querySelector("[data-testid='cheat-sheet']"), null);

		fireEscape(dom);
		assert.equal(fx.shell.get().startupMessage, null);
		fireEscape(dom);
		assert.equal(fx.shell.get().cheatSheet, false);
		fireEscape(dom);
		assert.equal(fx.shell.get().setupOpen, false);

		await fx.shell.send({ type: "open-settings", section: "data" });
		assert.equal(fx.settings.intents.some((i) => i.type === "load-aux"), true);
		const importField = host.querySelector("[data-peer-import-input]") as HTMLInputElement;
		importField.value = "/workspace/lh-export";
		importField.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
		(host.querySelector("[data-peer-action='import-learnharness']") as HTMLButtonElement).click();
		assert.equal(fx.settings.intents.some((i) => i.type === "import-learnharness"), true);

		const routeHost = dom.document.createElement("div");
		dom.document.body.append(routeHost);
		const pluginView = resolveScreenFactory({ name: "plugin-view", pluginId: "flashcards", viewId: "deck" })(routeHost, {});
		pluginView.update({ routeName: "plugin-view", title: "Flashcards", body: "Pending", path: "/plugins/flashcards/deck", configured: true });
		assert.equal(routeHost.childElementCount, 1);
		pluginView.destroy();
		routeHost.remove();

		handle.destroy();
		assert.equal(host.childElementCount, 0);
		assert.equal(tracker.activeCount(), 0);
	} finally {
		tracker.restore();
		await dom.cleanup();
	}
});
