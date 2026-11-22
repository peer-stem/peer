import assert from "node:assert/strict";
import test from "node:test";
import { BUILTIN_THEMES, DEFAULT_RENDER_SETTINGS } from "../src/core/index.ts";

await import("./helpers/client-env.ts");

type AnyFn = (...args: any[]) => any;

interface StoreLike<M = any, I = any> {
	get(): M;
	subscribe(fn: (m: M) => void): () => void;
	send(intent: I): Promise<void>;
	dispose(): void;
}

interface StateMod {
	createApiClient: AnyFn;
	createEventsStore: AnyFn;
	createPrefsStore: AnyFn;
	createDesktopStore: AnyFn;
	createModelsStore: AnyFn;
	createSettingsStore: AnyFn;
	createShellStore: AnyFn;
	createGraphStore: AnyFn;
	createState: AnyFn;
}

interface RecordedCall {
	method: string;
	url: string;
	body: string;
}

const stateMod = (await import("../src/client/state/index.ts")) as unknown as StateMod;

function waitTicks(ms = 20): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function sawCall(calls: readonly RecordedCall[], method: string, urlMatch: string, prefix = false): boolean {
	for (const entry of calls) {
		if (entry.method !== method) continue;
		if (prefix && entry.url.startsWith(urlMatch)) return true;
		if (!prefix && entry.url === urlMatch) return true;
	}
	return false;
}

function createFakeEventSource() {
	let openCb: (() => void) | null = null;
	const handlers = new Map<string, (raw: string) => void>();
	return {
		open: () => openCb?.(),
		source: {
			close: () => {},
			onOpen: (cb: () => void) => { openCb = cb; },
			onEvent: (name: string, cb: (raw: string) => void) => { handlers.set(name, cb); },
		},
	};
}

function createStorageObject(map: Map<string, string>, throwOnAccess: boolean) {
	const fail = () => { throw new Error("Storage blocked"); };
	return {
		get length() { return map.size; },
		key: (idx: number) => [...map.keys()][idx] ?? null,
		getItem: (k: string) => (throwOnAccess ? fail() : (map.get(k) ?? null)),
		setItem: (k: string, v: string) => { if (throwOnAccess) fail(); map.set(k, String(v)); },
		removeItem: (k: string) => { if (throwOnAccess) fail(); map.delete(k); },
		clear: () => { if (throwOnAccess) fail(); map.clear(); },
	};
}

function installMemoryStorage(throwOnAccess = false): { map: Map<string, string>; restore: () => void } {
	const g = globalThis as Record<string, unknown>;
	const prevStorage = g.localStorage;
	const prevWindow = g.window;
	const map = new Map<string, string>();
	const storage = createStorageObject(map, throwOnAccess);
	g.localStorage = storage;
	g.window = { localStorage: storage, Event: globalThis.Event, dispatchEvent: () => true };
	return {
		map,
		restore: () => {
			if (prevStorage === undefined) delete g.localStorage;
			else g.localStorage = prevStorage;
			if (prevWindow === undefined) delete g.window;
			else g.window = prevWindow;
		},
	};
}

function installMockLhBridge(bridge: Record<string, unknown> | null): () => void {
	const g = globalThis as Record<string, unknown>;
	const prevWindow = g.window;
	g.window = bridge ? { lh: bridge } : {};
	return () => {
		if (prevWindow === undefined) delete g.window;
		else g.window = prevWindow;
	};
}

const CUSTOM_THEME_FILE = {
	name: "Nordic Ink",
	mode: "dark" as const,
	colors: { ...BUILTIN_THEMES[0]!.colors, accent: "#88c0d0" },
};

const SAMPLE_NODE = {
	id: "n_1",
	name: "Basis",
	statement: "Linearly independent spanning set.",
	aliases: [],
	createdAt: "2026-11-19T00:00:00Z",
	provenance: [{ chatId: "c1", messageId: "m1" }],
};

const SAMPLE_GRAPH_SNAPSHOT = {
	nodes: [SAMPLE_NODE],
	propositions: [SAMPLE_NODE],
	edges: [],
	logicalEdges: [],
	impLinks: [],
	chains: [],
	sessions: { c1: "Algebra" },
	fileSources: {},
	nodeSessions: { n_1: ["c1"] },
	clusters: [],
	positions: { n_1: { x: 10, y: 20 } },
	learnerProgress: { n_1: { mastery: 0.8 } },
};

const EMPTY_GRAPH_SNAPSHOT = { ...SAMPLE_GRAPH_SNAPSHOT, nodes: [], propositions: [], positions: {} };

const SAMPLE_SOURCES = {
	organization: {
		version: 1 as const,
		folders: [{ id: "fld_1", name: "Linear Algebra", parentId: null, createdAt: "2026-11-19T00:00:00Z" }],
		placements: { c1: { folderId: "fld_1" } },
	},
	sources: [{ id: "c1", kind: "chat" as const, label: "Algebra", createdAt: "2026-11-19T00:00:00Z" }],
};

const SAMPLE_COSTS = {
	totalUsd: 0.04,
	totalInputTokens: 800,
	totalOutputTokens: 300,
	stages: { extractor: { calls: 1, usd: 0.02 }, auditor: { calls: 1, usd: 0.02 } },
	runs: [],
};

test("PrefsStore persists sidebar, thinking, camera, folder filter, and keybindings and tolerates blocked storage", async () => {
	const mem = installMemoryStorage(false);
	try {
		const prefs = stateMod.createPrefsStore();
		await prefs.send({ type: "set-sidebar-open", open: false });
		await prefs.send({ type: "toggle-user-thinking" });
		const cam = { k: 1.75, x: 40, y: -30 };
		await prefs.send({ type: "set-graph-camera", camera: cam });
		await prefs.send({ type: "set-graph-folder-filter", folderIds: ["fld_1", "fld_2", "fld_1"] });
		assert.deepEqual(prefs.get().graphFolderFilter, ["fld_1", "fld_2"]);
		assert.equal(mem.map.get("lh.graph.folder-filter.v1"), JSON.stringify(["fld_1", "fld_2"]));

		await prefs.send({ type: "set-keybinding", actionId: "find", binding: "mod+shift+k" });
		const rehydrated = stateMod.createPrefsStore();
		assert.equal(rehydrated.get().sidebarOpen, false);
		assert.deepEqual(rehydrated.get().graphCamera, cam);
		assert.deepEqual(rehydrated.get().graphFolderFilter, ["fld_1", "fld_2"]);
		rehydrated.dispose();

		await prefs.send({ type: "set-graph-folder-filter", folderIds: [] });
		assert.equal(mem.map.has("lh.graph.folder-filter.v1"), false);
		await prefs.send({ type: "reset-keybindings" });
		assert.deepEqual(prefs.get().keymapOverrides, {});
		prefs.dispose();
	} finally {
		mem.restore();
	}

	const blocked = installMemoryStorage(true);
	try {
		const safePrefs = stateMod.createPrefsStore();
		await safePrefs.send({ type: "set-graph-folder-filter", folderIds: ["fld_x"] });
		assert.deepEqual(safePrefs.get().graphFolderFilter, ["fld_x"]);
		safePrefs.dispose();
	} finally {
		blocked.restore();
	}
});

test("DesktopStore and ShellStore support web mode, startup announcements, and dismissal", async () => {
	const restoreWeb = installMockLhBridge(null);
	try {
		const webDesktop = stateMod.createDesktopStore();
		assert.equal(webDesktop.get().electron, false);
		assert.equal(webDesktop.get().platform, "web");
		assert.equal(await webDesktop.pickDirectory(), null);
		webDesktop.dispose();
	} finally {
		restoreWeb();
	}

	let dismissedId = "";
	const msg = { id: "ann_1", title: "Welcome", publishedAt: "2026-11-22", bodyMarkdown: "**Hello**" };
	const shell = stateMod.createShellStore();
	const desktop = stateMod.createDesktopStore({
		shell,
		bridge: {
			platform: "darwin",
			takeStartupMessage: async () => ({ message: msg, deadlineAt: Date.now() + 60_000 }),
			dismissStartupMessage: async (id: string) => { dismissedId = id; return true; },
		},
	});
	await waitTicks(15);
	assert.equal(desktop.get().platform, "mac");
	assert.deepEqual(shell.get().startupMessage, msg);

	await desktop.dismissStartupMessage("ann_1");
	assert.equal(dismissedId, "ann_1");
	assert.equal(shell.get().startupMessage, null);
	desktop.dispose();
	shell.dispose();
});

test("DesktopStore forwards Electron window.lh preload zoom, directory picker, and update events", async () => {
	let zoomListener = null as ((factor: number) => void) | null;
	let updateListener = null as ((u: { status: string; version: string }) => void) | null;
	let checkedUpdates = 0;
	let installedUpdate = 0;
	const restoreElectron = installMockLhBridge({
		platform: "linux",
		chooseAttachmentFolder: async () => "/workspace/sources",
		pickFiles: async () => ["/workspace/a.md"],
		getZoom: async () => 1.1,
		onZoom: (cb: (f: number) => void) => { zoomListener = cb; return () => { zoomListener = null; }; },
		onUpdateStatus: (cb: (u: { status: string; version: string }) => void) => { updateListener = cb; return () => { updateListener = null; }; },
		checkForUpdates: async () => { checkedUpdates += 1; },
		installUpdate: () => { installedUpdate += 1; },
	});
	try {
		const desktop = stateMod.createDesktopStore();
		await waitTicks(10);
		assert.equal(desktop.get().electron, true);
		assert.equal(await desktop.pickDirectory(), "/workspace/sources");
		zoomListener?.(1.5);
		updateListener?.({ status: "downloaded", version: "0.7.0" });
		await waitTicks(5);
		assert.equal(desktop.get().zoom, 1.5);
		assert.deepEqual(desktop.get().update, { status: "downloaded", version: "0.7.0" });
		await desktop.send({ type: "check-updates" });
		await desktop.send({ type: "install-update" });
		assert.equal(checkedUpdates, 1);
		assert.equal(installedUpdate, 1);
		desktop.dispose();
	} finally {
		restoreElectron();
	}
});

function buildModelsResponse(count: number): Response {
	const first = {
		provider: "anthropic",
		id: "claude-sonnet-4",
		name: "Claude Sonnet 4",
		reasoning: true,
		supportedLevels: ["low", "high"],
		input: ["text"],
		cost: { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 8192,
	};
	const entries = count > 1 ? [first, { ...first, provider: "openai", id: "gpt-5", name: "GPT-5" }] : [first];
	const slots = { strong: { model: { provider: "anthropic", id: "claude-sonnet-4" }, thinkingLevel: "high" }, cheap: null };
	return Response.json({ models: entries, defaults: null, rolePins: {}, slots, providers: [{ id: "anthropic", keyPresent: true }] });
}

test("ModelsStore loads slots and refreshStatus and executes refresh-catalog POST /api/models", async () => {
	const sse = createFakeEventSource();
	const events = stateMod.createEventsStore({ createEventSource: () => sse.source });
	let modelCount = 1;
	let refreshOutcome = "updated";
	const fetchMock = async (input: unknown, init?: RequestInit) => {
		const url = String(input);
		if (url === "/api/models" && init?.method === "POST") {
			if (refreshOutcome === "error") return Response.json({ error: "Upstream failed" }, { status: 502 });
			if (refreshOutcome === "updated") modelCount = 2;
			return Response.json({ outcome: refreshOutcome });
		}
		if (url.startsWith("/api/models")) return buildModelsResponse(modelCount);
		return Response.json({ settings: null, themes: [] });
	};
	const api = stateMod.createApiClient({ fetch: fetchMock });
	const models: StoreLike = stateMod.createModelsStore({ api, events });
	await waitTicks();
	assert.equal(models.get().slots.strong?.model?.id, "claude-sonnet-4");
	assert.equal(models.get().refreshStatus, "idle");

	await models.send({ type: "refresh-catalog" });
	await waitTicks();
	assert.equal(models.get().refreshStatus, "updated");
	assert.equal(models.get().models.length, 2);

	refreshOutcome = "no-providers";
	await models.send({ type: "refresh-catalog" });
	assert.equal(models.get().refreshStatus, "no-providers");

	refreshOutcome = "error";
	await models.send({ type: "refresh-catalog" });
	assert.equal(models.get().refreshStatus, "failed");

	models.dispose();
	events.dispose();
});

const SAMPLE_PROMPTS = { prober: [], teacher: [{ path: "teacher/10-planning.md", sourceText: "Default", overrideText: null, enabled: false, shared: false }], practice: [] };
const SAMPLE_KEYS = { keys: [{ id: "ANTHROPIC_API_KEY", label: "Anthropic", present: true, masked: "••••1234", source: "file" }], providers: [{ id: "anthropic", envVar: "ANTHROPIC_API_KEY", label: "Anthropic" }] };

function createSettingsMockFetch(calls: RecordedCall[]) {
	let graphEnabled = true;
	let searchAvailable = false;
	return async (input: unknown, init?: RequestInit) => {
		const url = String(input);
		const method = init?.method ?? "GET";
		const body = typeof init?.body === "string" ? init.body : "";
		calls.push({ method, url, body });
		if (url === "/api/settings") return Response.json({ settings: { version: 1, graph: { enabled: graphEnabled } } });
		if (url.startsWith("/api/settings/") && !url.startsWith("/api/settings/prompts") && method === "PUT") {
			if (url.endsWith("/graph")) graphEnabled = (JSON.parse(body || "{}") as { enabled?: boolean }).enabled !== false;
			return Response.json({ settings: { version: 1, graph: { enabled: graphEnabled } } });
		}
		if (url === "/api/search") return Response.json({ available: searchAvailable, engine: searchAvailable ? "brave" : null, reason: "" });
		if (url === "/api/keys") return Response.json(SAMPLE_KEYS);
		if (url.startsWith("/api/keys/")) {
			searchAvailable = method === "PUT";
			return Response.json({ status: { id: "BRAVE_API_KEY", present: method === "PUT", source: null } });
		}
		if (url === "/api/settings/prompts") return Response.json(SAMPLE_PROMPTS);
		if (url.startsWith("/api/themes")) return Response.json({ theme: { ...CUSTOM_THEME_FILE, id: "nordic-ink", builtin: false } }, { status: 201 });
		if (url.startsWith("/api/subscriptions")) return Response.json({ providers: [{ id: "chatgpt", connected: method === "POST" }] });
		if (url.startsWith("/api/custom-provider")) return Response.json({ baseUrl: "", authMode: "keyless", models: [] });
		return Response.json({ state: "not-found", themes: BUILTIN_THEMES, models: [], providers: [] });
	};
}

test("SettingsStore defers load-aux, tracks searchStatus on key/agent updates, and runs subscription-action", async () => {
	const calls: RecordedCall[] = [];
	let modelChanges = 0;
	const events = stateMod.createEventsStore();
	const api = stateMod.createApiClient({ fetch: createSettingsMockFetch(calls) });
	const settings = stateMod.createSettingsStore({ api, events, onModelsMayChange: () => { modelChanges += 1; } });
	await waitTicks();

	assert.equal(sawCall(calls, "GET", "/api/search"), false);
	assert.equal(settings.get().searchStatus, null);

	await settings.send({ type: "load-aux" });
	await waitTicks();
	assert.equal(settings.get().searchStatus?.available, false);

	await settings.send({ type: "save-key", id: "BRAVE_API_KEY", value: "BSA-1234" });
	assert.equal(settings.get().searchStatus?.available, true);
	assert.equal(settings.get().searchStatus?.engine, "brave");

	await settings.send({ type: "save-section", section: "agent", value: { searchEngine: "brave" } });
	assert.equal(sawCall(calls, "PUT", "/api/settings/agent"), true);

	const beforeChanges = modelChanges;
	await settings.send({ type: "subscription-action", method: "POST", body: { provider: "chatgpt", action: "login" } });
	assert.equal(sawCall(calls, "POST", "/api/subscriptions"), true);
	assert.equal(modelChanges > beforeChanges, true);

	settings.dispose();
	events.dispose();
});

function createGraphMockFetch(calls: RecordedCall[]) {
	let nodeDeleted = false;
	let clusterLabels = true;
	let positions: Record<string, { x: number; y: number }> = { n_1: { x: 10, y: 20 } };
	return async (input: unknown, init?: RequestInit) => {
		const url = String(input);
		const method = init?.method ?? "GET";
		const body = typeof init?.body === "string" ? init.body : "";
		calls.push({ method, url, body });
		if (url === "/api/graph") return Response.json({ ...(nodeDeleted ? EMPTY_GRAPH_SNAPSHOT : SAMPLE_GRAPH_SNAPSHOT), positions });
		if (url === "/api/graph/sources") return Response.json(SAMPLE_SOURCES);
		if (url.startsWith("/api/graph/sources/folders/") && method === "DELETE") return Response.json({ ok: true });
		if (url === "/api/graph/render-settings" && method === "PUT") {
			clusterLabels = (JSON.parse(body || "{}") as { clusterLabels?: boolean }).clusterLabels ?? clusterLabels;
			return Response.json({ ...DEFAULT_RENDER_SETTINGS, clusterLabels });
		}
		if (url === "/api/graph/render-settings") return Response.json({ ...DEFAULT_RENDER_SETTINGS, clusterLabels });
		if (url === "/api/graph/positions" && method === "PUT") {
			positions = JSON.parse(body || "{}");
			return Response.json({ positions });
		}
		if (url === "/api/graph/costs") return Response.json(SAMPLE_COSTS);
		if (url === "/api/graph/status") return Response.json({ runs: [{ id: "c1", chatId: "c1", title: "Algebra", phase: "extracting", startedAt: "2026-11-19T12:00:00Z" }] });
		if (url.startsWith("/api/graph/nodes/") && method === "DELETE") {
			nodeDeleted = true;
			return Response.json({ stats: { removedNodes: 1, removedChains: 0 }, graphRevision: 5 });
		}
		if (url === "/api/graph/coverage/extract") return Response.json({ started: true }, { status: 202 });
		if (url === "/api/graph/import") return Response.json({ results: [{ filePath: "algebra.md", ok: true }] });
		return Response.json({ settings: null, themes: BUILTIN_THEMES, models: [], providers: [] });
	};
}

test("GraphStore hydrates sources and executes delete-folder, delete-nodes, positions, render, and import", async () => {
	const calls: RecordedCall[] = [];
	const state = stateMod.createState({ initialUrl: "/", fetch: createGraphMockFetch(calls) });
	const home = state.screen(state.router.get());
	await waitTicks(25);

	assert.equal(state.graph.get().sources?.organization.folders[0]?.id, "fld_1");
	assert.equal(state.graph.get().snapshot?.learnerProgress?.n_1?.mastery, 0.8);

	await state.graph.send({ type: "commit-positions", positions: { n_1: { x: 99, y: 42 } } });
	assert.deepEqual(state.graph.get().positions.n_1, { x: 99, y: 42 });

	await state.graph.send({ type: "delete-folder", folderId: "fld_1", deleteSessions: true });
	const folderDel = calls.find((c) => c.method === "DELETE" && c.url === "/api/graph/sources/folders/fld_1");
	assert.deepEqual(JSON.parse(folderDel!.body), { deleteSessions: true });

	const noteFile = new File(["# Basis notes"], "algebra.md", { type: "text/markdown" });
	await state.graph.send({ type: "import-notes", files: [noteFile] });
	assert.equal(state.graph.get().importResults[0]?.ok, true);

	await state.graph.send({ type: "delete-nodes", nodeIds: ["n_1"], folderIds: ["fld_empty"] });
	assert.equal(sawCall(calls, "DELETE", "/api/graph/nodes/n_1"), true);
	assert.equal(sawCall(calls, "DELETE", "/api/graph/sources/folders/fld_empty"), true);
	assert.equal(state.graph.get().snapshot?.propositions.length, 0);

	home.dispose();
	state.dispose();
});
