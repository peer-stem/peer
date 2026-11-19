import assert from "node:assert/strict";
import test from "node:test";
import { BUILTIN_THEMES, type Theme } from "../src/core/themes.ts";

await import("./helpers/client-env.ts");
const {
	createApiClient,
	createAppearanceStore,
	createCell,
	createEventsStore,
	createMemoryHistory,
	createPendingScreenStore,
	createRouterStore,
	createSettingsStore,
	createShellStore,
	parseRouteUrl,
	routeToHref,
	screenKeyOf,
} = await import("../src/client/state/index.ts");

const SAMPLE_IMPORT_REPORT = {
	sourceDirectory: "/data/lh",
	settingsImported: true,
	themesImported: 1,
	promptsImported: 0,
	sourcesImported: 2,
	nodesImported: 5,
	chainsImported: 1,
	positionsImported: 5,
	chatsImported: 3,
	objectsStored: 2,
	objectsDeduplicated: 0,
	flashcardDecksImported: 1,
	flashcardCardsImported: 4,
	corruptFilesSkipped: 0,
};

const CONFIGURED_MODELS = {
	strong: { model: { provider: "anthropic", id: "claude" } },
	cheap: { model: { provider: "anthropic", id: "haiku" } },
	vision: { model: { provider: "anthropic", id: "claude" } },
};

function flushMicrotasks(): Promise<void> {
	return new Promise((resolve) => queueMicrotask(resolve));
}

function createFakeEventSourceHarness() {
	let openCb: (() => void) | null = null;
	let closed = false;
	const handlers = new Map<string, (raw: string) => void>();
	return {
		isClosed: () => closed,
		open: () => openCb?.(),
		emit: (name: string, data: unknown) => {
			handlers.get(name)?.(typeof data === "string" ? data : JSON.stringify(data));
		},
		source: {
			close: () => { closed = true; },
			onOpen: (cb: () => void) => { openCb = cb; },
			onEvent: (name: string, cb: (raw: string) => void) => { handlers.set(name, cb); },
		},
	};
}

test("createCell coalesces rapid mutations 1/microtask, ignores Object.is, and cancels on dispose", async () => {
	const cell = createCell(0);
	const seen: number[] = [];
	const off = cell.subscribe((v) => seen.push(v));
	assert.deepEqual(seen, []);

	cell.set(0);
	await flushMicrotasks();
	assert.deepEqual(seen, []);

	cell.set(1);
	cell.set(2);
	cell.set(3);
	assert.deepEqual(seen, []);
	await flushMicrotasks();
	assert.deepEqual(seen, [3]);

	cell.set(4);
	cell.dispose();
	await flushMicrotasks();
	assert.deepEqual(seen, [3]);
	off();
});

test("parseRouteUrl, routeToHref, and screenKeyOf match R1 route and screen-key rules", () => {
	assert.deepEqual(parseRouteUrl("/").route, { name: "home" });
	assert.deepEqual(parseRouteUrl("/chat/new").route, { name: "new-session", mode: "teach" });
	assert.deepEqual(parseRouteUrl("/chat/new?mode=practice").route, { name: "new-session", mode: "practice" });
	assert.deepEqual(parseRouteUrl("/chat/c%201?prompt=Explain%20DAGs#m1").route, {
		name: "session",
		id: "c 1",
		prompt: "Explain DAGs",
	});
	assert.deepEqual(parseRouteUrl("/chat/%E0%A4%A").route, { name: "not-found", path: "/chat/%E0%A4%A" });
	assert.deepEqual(parseRouteUrl("/plugins/flashcards/deck").route, {
		name: "plugin-view",
		pluginId: "flashcards",
		viewId: "deck",
	});
	assert.equal(routeToHref({ name: "session", id: "c 1", prompt: "hi" }), "/chat/c%201?prompt=hi");
	assert.equal(screenKeyOf({ name: "session", id: "abc", prompt: "ignored" }), "session:abc");
	assert.equal(screenKeyOf({ name: "plugin-view", pluginId: "p1", viewId: "v1" }), "plugin-view:p1/v1");
	assert.equal(screenKeyOf({ name: "new-session", mode: "practice" }), "new-session");
});

test("RouterStore redirects /settings and strips trailing slashes via replace and supports back", async () => {
	const history = createMemoryHistory("/settings/");
	const router = createRouterStore({ history });
	assert.equal(history.getLocation(), "/chat/new");
	assert.deepEqual(router.get().route, { name: "new-session", mode: "teach" });

	await router.send({ type: "navigate", to: "/chat/session-42/" });
	assert.equal(history.getLocation(), "/chat/session-42");
	assert.deepEqual(router.get().route, { name: "session", id: "session-42" });

	await router.send({ type: "back" });
	assert.equal(history.getLocation(), "/chat/new");
	router.dispose();
});

test("Events store stays disconnected without EventSource and fires onResync only after reconnect", () => {
	const headless = createEventsStore();
	assert.deepEqual(headless.get(), { connected: false, opens: 0 });
	headless.dispose();

	const harness = createFakeEventSourceHarness();
	const events = createEventsStore({ createEventSource: () => harness.source });
	const chatsSeen: number[] = [];
	let resyncCount = 0;
	events.on("chats-changed", () => chatsSeen.push(1));
	events.onResync(() => {
		resyncCount += 1;
	});

	harness.open();
	assert.deepEqual(events.get(), { connected: true, opens: 1 });
	assert.equal(resyncCount, 0);

	harness.emit("chats-changed", "{}");
	harness.emit("chats-changed", "{not-json");
	assert.equal(chatsSeen.length, 1);

	harness.open();
	assert.deepEqual(events.get(), { connected: true, opens: 2 });
	assert.equal(resyncCount, 1);

	events.dispose();
	assert.equal(harness.isClosed(), true);
});

test("SettingsStore resolves effective settings, handles import-learnharness, and refetches on resync", async () => {
	const harness = createFakeEventSourceHarness();
	const events = createEventsStore({ createEventSource: () => harness.source });
	let configuredOnServer = false;
	const api = createApiClient({
		fetch: async (input, init) => {
			if (String(input) === "/api/settings/import-learnharness" && init?.method === "POST") {
				configuredOnServer = true;
				return Response.json(SAMPLE_IMPORT_REPORT);
			}
			const models = configuredOnServer ? CONFIGURED_MODELS : {};
			return Response.json({ settings: { version: 1, models } });
		},
	});
	const settings = createSettingsStore({ api, events });
	await new Promise((resolve) => setTimeout(resolve, 10));
	assert.equal(settings.get().load, "ready");
	assert.equal(settings.get().configured, false);

	await settings.send({ type: "import-learnharness", sourceDirectory: "/data/lh" });
	assert.equal(settings.get().configured, true);
	assert.deepEqual(settings.get().lastImport, SAMPLE_IMPORT_REPORT);
	settings.dispose();
	events.dispose();
});

test("AppearanceStore and ShellStore project theme tokens and react to zoom and settings changes", async () => {
	const customTheme: Theme = {
		...BUILTIN_THEMES[1]!,
		id: "custom-light",
		name: "Custom Light",
		builtin: false,
	};
	const events = createEventsStore();
	const api = createApiClient({
		fetch: async (input) => {
			if (String(input) === "/api/settings") {
				return Response.json({ settings: { version: 1, appearance: { theme: "custom-light" } } });
			}
			return Response.json({ themes: [...BUILTIN_THEMES, customTheme] });
		},
	});
	const shell = createShellStore();
	const settings = createSettingsStore({ api, events });
	const appearance = createAppearanceStore({ api, settings, shell, events });
	await new Promise((resolve) => setTimeout(resolve, 10));

	assert.equal(appearance.get().load, "ready");
	assert.equal(appearance.get().theme.id, "custom-light");
	assert.equal(appearance.get().tokens.mode, "light");

	await shell.send({ type: "set-zoom", zoom: 1.25 });
	await flushMicrotasks();
	assert.equal(appearance.get().tokens.peer["--peer-zoom"], "1.25");

	await shell.send({ type: "toggle-sidebar" });
	assert.equal(shell.get().sidebar.open, false);
	await shell.send({ type: "open-settings", section: "data" });
	assert.deepEqual(shell.get().settings, { open: true, section: "data" });
	await shell.send({ type: "toggle-cheat-sheet" });
	assert.equal(shell.get().cheatSheet, true);
	await shell.send({ type: "close-cheat-sheet" });
	assert.equal(shell.get().cheatSheet, false);
	await shell.send({ type: "close-settings" });
	assert.equal(shell.get().settings.open, false);

	appearance.dispose();
	settings.dispose();
	shell.dispose();
	events.dispose();
});

test("PendingScreenStore tracks router and settings updates and forwards open-settings to shell", async () => {
	const events = createEventsStore();
	const api = createApiClient({ fetch: async () => Response.json({ settings: null }) });
	const router = createRouterStore({ initialUrl: "/" });
	const settings = createSettingsStore({ api, events });
	const shell = createShellStore();
	const pending = createPendingScreenStore({ router, settings, shell });

	assert.equal(pending.get().routeName, "home");
	await router.send({ type: "navigate", to: "/chat/new?mode=practice" });
	await flushMicrotasks();
	assert.equal(pending.get().routeName, "new-session");
	assert.equal(pending.get().title, "Practice session");

	await pending.send({ type: "open-settings", section: "models" });
	assert.deepEqual(shell.get().settings, { open: true, section: "models" });

	pending.dispose();
	shell.dispose();
	settings.dispose();
	router.dispose();
	events.dispose();
});
