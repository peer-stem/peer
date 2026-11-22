import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_RENDER_SETTINGS } from "../src/core/index.ts";
import "./helpers/client-env.ts";
import { installDom, type InstalledDom } from "./helpers/client-dom.ts";

type AnyFn = (...args: any[]) => any;

function loadMod<T>(relPath: string): Promise<T> {
	return import(new URL(relPath, import.meta.url).href) as Promise<T>;
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

function createMock2dContext(canvas: HTMLCanvasElement, ops?: string[]): CanvasRenderingContext2D {
	const props: Record<string, unknown> = {
		canvas,
		clearRect: () => { ops?.push("clearRect"); },
		save: () => { ops?.push("save"); },
		measureText: (s: string) => ({ width: String(s).length * 6 }),
		createImageData: (w: number, h: number) => {
			const safeW = Math.max(1, Math.trunc(w));
			const safeH = Math.max(1, Math.trunc(h));
			return { width: safeW, height: safeH, data: new Uint8ClampedArray(safeW * safeH * 4) };
		},
		getImageData: (_x: number, _y: number, w: number, h: number) => {
			const safeW = Math.max(1, Math.trunc(w));
			const safeH = Math.max(1, Math.trunc(h));
			return { width: safeW, height: safeH, data: new Uint8ClampedArray(safeW * safeH * 4) };
		},
		createRadialGradient: () => ({ addColorStop: () => {} }),
		createLinearGradient: () => ({ addColorStop: () => {} }),
	};
	const noop = () => {};
	return new Proxy(props, {
		get(target, key: string) { return key in target ? target[key] : noop; },
		set(target, key: string, val: unknown) { target[key] = val; return true; },
	}) as unknown as CanvasRenderingContext2D;
}

function installMockCanvas2d(dom: InstalledDom, ops?: string[]): () => void {
	const proto = dom.window.HTMLCanvasElement.prototype;
	const origGetContext = proto.getContext;
	const hadPath2D = "Path2D" in globalThis;
	const origPath2D = (globalThis as Record<string, unknown>).Path2D;
	if (!hadPath2D) {
		(globalThis as Record<string, unknown>).Path2D = class MockPath2D {
			moveTo(): void {}
			lineTo(): void {}
			bezierCurveTo(): void {}
			quadraticCurveTo(): void {}
			arc(): void {}
			rect(): void {}
			closePath(): void {}
		};
	}
	proto.getContext = function mockGetContext(this: HTMLCanvasElement, kind: string) {
		if (kind === "2d") return createMock2dContext(this, ops);
		return null;
	} as typeof proto.getContext;
	return () => {
		proto.getContext = origGetContext;
		if (!hadPath2D) delete (globalThis as Record<string, unknown>).Path2D;
		else (globalThis as Record<string, unknown>).Path2D = origPath2D;
	};
}

function fillInput(dom: InstalledDom, el: Element | null, value: string): void {
	assert.notEqual(el, null);
	const target = el as HTMLElement & { value?: string };
	if ("value" in target) target.value = value;
	else target.textContent = value;
	target.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
}

function buildGraphSnapshotFixture(freezeNodes = false) {
	const rawNodes = [
		{ id: "n_compact", name: "Compactness", statement: "Every open cover admits a finite subcover.", aliases: [], createdAt: "2026-11-19T10:00:00Z", provenance: [{ chatId: "c1", messageId: "m1" }] },
		{ id: "n_cont", name: "Continuity", statement: "Preimages of open sets are open.", aliases: [], createdAt: "2026-11-19T10:01:00Z", provenance: [{ chatId: "c1", messageId: "m1" }] },
		{ id: "n_evt", name: "EVT", statement: "Continuous real function on compact set attains bounds.", aliases: ["Extreme Value"], createdAt: "2026-11-19T10:02:00Z", provenance: [{ chatId: "c1", messageId: "m2" }] },
		{ id: "n_alg", name: "Group Axiom", statement: "Associative binary operation with identity and inverses.", aliases: [], createdAt: "2026-11-19T11:00:00Z", provenance: [{ chatId: "c2", messageId: "m1" }] },
	];
	const impNode = { id: "arg_evt", name: "", statement: "", aliases: [], createdAt: "2026-11-19T10:03:00Z", provenance: [] };
	const props = freezeNodes ? rawNodes.map((n) => Object.freeze({ ...n })) : rawNodes;
	const canvasNodes = freezeNodes ? [...props, Object.freeze({ ...impNode })] : [...props, impNode];
	return {
		nodes: canvasNodes,
		propositions: props,
		edges: [
			{ from: "n_compact", to: "arg_evt" },
			{ from: "n_cont", to: "arg_evt" },
			{ from: "arg_evt", to: "n_evt" },
		],
		logicalEdges: [
			{ from: "n_compact", to: "n_evt" },
			{ from: "n_cont", to: "n_evt" },
		],
		impLinks: [{ id: "arg_evt", premises: ["n_compact", "n_cont"], conclusion: "n_evt" }],
		chains: [{ id: "arg_evt", premises: ["n_compact", "n_cont"], conclusion: "n_evt", provenance: [{ chatId: "c1", messageId: "m2" }], createdAt: "2026-11-19T10:03:00Z" }],
		sessions: { c1: "Real Analysis", c2: "Abstract Algebra" },
		fileSources: {},
		nodeSessions: { n_evt: ["c1"], n_alg: ["c2"] },
		clusters: [{ id: "cl_1", label: "Real Analysis", members: ["n_compact", "n_cont", "n_evt"] }],
		positions: { n_compact: { x: -80, y: -40 }, n_cont: { x: 80, y: -40 }, n_evt: { x: 0, y: 60 }, n_alg: { x: 140, y: 20 }, arg_evt: { x: 0, y: 10 } },
		learnerProgress: {
			n_evt: {
				mastery: 0.88,
				fsrs: { due: 1_765_000_000_000, stability: 7.5, difficulty: 2.9, reps: 5, lapses: 0, state: 2, last_review: 1_764_700_000_000 },
			},
		},
	};
}

function makeHomeModel(overrides: Record<string, unknown> = {}, freezeNodes = false): Record<string, unknown> {
	const snapshot = buildGraphSnapshotFixture(freezeNodes);
	return {
		route: { name: "home" },
		configured: true,
		mode: "dark",
		sessionMode: "teach",
		graphEnabled: true,
		viewTab: "graph",
		selectedNodeId: null,
		searchQuery: "",
		pickedNodeIds: [],
		camera: null,
		graph: {
			load: "ready",
			error: null,
			snapshot,
			positions: snapshot.positions,
			renderSettings: DEFAULT_RENDER_SETTINGS,
			costs: {
				totalDollars: 0.03,
				unpricedRuns: 0,
				stages: {
					extraction: { dollars: 0.015, unpricedRuns: 0, runs: 1, tokens: { inputTokens: 400, outputTokens: 150 } },
					audit: { dollars: 0.015, unpricedRuns: 0, runs: 1, tokens: { inputTokens: 200, outputTokens: 80 } },
				},
				runs: [{ startedAt: Date.now() - 60_000, at: "2026-11-22T04:00:00Z", durationMs: 800, kind: "extraction", title: "Real Analysis", dollars: 0.03, tokens: { inputTokens: 600, outputTokens: 230 }, merged: { nodes: 3 } }],
			},
			runs: [],
			importing: false,
			importResults: [],
		},
		themeColors: { node: "#88c0d0", edge: "#4c566a", label: "#eceff4", hoverText: "#ffffff" },
		fontFamily: "sans-serif",
		startError: null,
		starting: false,
		...overrides,
	};
}

test("GRAPH_WIDGET and createGraphStage degrade gracefully and skip GraphCanvasRenderer on empty data (Finding #7)", async () => {
	const dom = installDom();
	const { GRAPH_WIDGET } = await loadMod<{ GRAPH_WIDGET: { name: string } }>("../src/client/views/graph/graph-widget.js");
	const { createGraphStage } = await loadMod<{ createGraphStage: AnyFn }>("../src/client/views/graph/graph-stage.js");
	const { deriveGraphStageModel } = await loadMod<{ deriveGraphStageModel: AnyFn }>("../src/client/views/graph/graph-models.js");
	const tracker = trackWindowListeners(dom.window);
	try {
		assert.equal(GRAPH_WIDGET.name, "peer-graph");

		const fallbackHost = dom.document.createElement("div");
		dom.document.body.append(fallbackHost);
		const fallbackStage = createGraphStage(fallbackHost);
		assert.notEqual(fallbackHost.querySelector("[data-peer-graph-stage]"), null);
		assert.notEqual(fallbackHost.querySelector("[data-peer-canvas-fallback]"), null);
		fallbackStage.destroy();
		assert.equal(fallbackHost.childElementCount, 0);

		const ops: string[] = [];
		const restore2d = installMockCanvas2d(dom, ops);
		try {
			const stageHost = dom.document.createElement("div");
			dom.document.body.append(stageHost);
			const beforeListeners = tracker.activeCount();
			const stage = createGraphStage(stageHost);
			stage.update({ data: null, settings: DEFAULT_RENDER_SETTINGS, visible: null, camera: null, isEmpty: true });
			stage.update({ data: { nodes: [], edges: [], clusters: [] }, settings: DEFAULT_RENDER_SETTINGS, visible: null, camera: null, isEmpty: true });
			assert.equal(tracker.activeCount(), beforeListeners);
			assert.equal(ops.includes("save"), false);

			stage.update(deriveGraphStageModel(makeHomeModel()));
			ops.length = 0;
			stage.update({ data: null, settings: DEFAULT_RENDER_SETTINGS, visible: null, camera: null, isEmpty: true });
			assert.equal(ops.includes("clearRect"), true);
			stage.destroy();
			assert.equal(stageHost.childElementCount, 0);
		} finally {
			restore2d();
		}
		assert.equal(tracker.activeCount(), 0);
	} finally {
		tracker.restore();
		await dom.cleanup();
	}
});

test("createHomeView clones canvas nodes before d3-force setData and keeps sessionMode store-driven (Finding #1)", async () => {
	const dom = installDom();
	const tracker = trackWindowListeners(dom.window);
	const restore2d = installMockCanvas2d(dom);
	try {
		const { createHomeView } = await loadMod<{ createHomeView: AnyFn }>("../src/client/views/home/home-view.js");
		const host = dom.document.createElement("div");
		dom.document.body.append(host);
		const intents: Array<Record<string, unknown>> = [];
		const model = makeHomeModel({}, true);
		const graphSnapshot = (model.graph as { snapshot: ReturnType<typeof buildGraphSnapshotFixture> }).snapshot;
		const frozenPositions = Object.freeze({
			n_compact: Object.freeze({ x: -80, y: -40 }),
			n_cont: Object.freeze({ x: 80, y: -40 }),
			n_evt: Object.freeze({ x: 0, y: 60 }),
			n_alg: Object.freeze({ x: 140, y: 20 }),
			arg_evt: Object.freeze({ x: 0, y: 10 }),
		});
		(model.graph as Record<string, unknown>).positions = frozenPositions;

		const view = createHomeView(host, { send: (i: Record<string, unknown>) => { intents.push(i); } });
		view.update(model);

		const storeNode = graphSnapshot.nodes[0] as Record<string, unknown>;
		assert.equal(Object.isFrozen(storeNode), true);
		assert.equal("vx" in storeNode, false);
		assert.equal(frozenPositions.n_evt.y, 60);

		(host.querySelector("[data-peer-home-mode='practice']") as HTMLButtonElement).click();
		assert.deepEqual(intents.at(-1), { type: "set-session-mode", mode: "practice" });
		assert.equal(host.querySelector("[data-peer-home-mode='practice']")?.getAttribute("aria-pressed"), "false");

		view.update(makeHomeModel({ sessionMode: "practice", pickedNodeIds: ["n_evt"] }));
		assert.equal(host.querySelector("[data-peer-home-mode='practice']")?.getAttribute("aria-pressed"), "true");
		(host.querySelector("[data-peer-action='home-start']") as HTMLButtonElement).click();
		assert.deepEqual(intents.at(-1), {
			type: "start-session",
			prompt: "Practice: EVT",
			kind: "practice",
			nodeIds: ["n_evt"],
		});

		view.destroy();
		assert.equal(host.childElementCount, 0);
		assert.equal(tracker.activeCount(), 0);
	} finally {
		restore2d();
		tracker.restore();
		await dom.cleanup();
	}
});

test("createHomeView renders node-card, 409 DeleteNodeDialog retry, cost breakdown, chains-table, and minimal-home", async () => {
	const dom = installDom();
	const tracker = trackWindowListeners(dom.window);
	try {
		const { createHomeView } = await loadMod<{ createHomeView: AnyFn }>("../src/client/views/home/home-view.js");
		const { EXTRACTION_RETRY_LINE } = await loadMod<{ EXTRACTION_RETRY_LINE: string }>("../src/client/views/graph/delete-node-dialog.js");
		const host = dom.document.createElement("div");
		dom.document.body.append(host);
		const intents: Array<Record<string, unknown>> = [];
		let rejectNextDelete = false;
		const view = createHomeView(host, {
			send: (i: Record<string, unknown>) => {
				intents.push(i);
				if (i.type === "delete-node" && rejectNextDelete) {
					rejectNextDelete = false;
					return Promise.reject({ code: "extraction_running", error: "busy" });
				}
				return Promise.resolve();
			},
		});

		view.update(makeHomeModel({ selectedNodeId: "n_evt" }));
		const card = host.querySelector("[data-testid='node-card']") as HTMLElement | null;
		assert.notEqual(card, null);
		assert.notEqual(card?.querySelector("[data-peer-mastery]"), null);
		assert.notEqual(card?.querySelector("[data-peer-fsrs]"), null);

		rejectNextDelete = true;
		(card?.querySelector("[data-peer-action='delete-node']") as HTMLButtonElement).click();
		assert.deepEqual(intents[0], { type: "delete-node", nodeId: "n_evt" });
		await new Promise((r) => setTimeout(r, 0));
		const delDialog = host.querySelector("[data-testid='delete-node-dialog']");
		assert.notEqual(delDialog, null);
		assert.equal(delDialog?.textContent?.includes(EXTRACTION_RETRY_LINE), true);
		(host.querySelector("[data-testid='node-delete-retry']") as HTMLButtonElement).click();
		await new Promise((r) => setTimeout(r, 0));
		assert.equal(intents.filter((i) => i.type === "delete-node").length, 2);

		(host.querySelector("[data-testid='graph-costs-trigger']") as HTMLButtonElement).click();
		const costsPanel = host.querySelector("[data-testid='graph-costs-panel']") as HTMLElement;
		assert.equal(costsPanel.hidden, false);
		assert.equal(costsPanel.textContent?.includes("Extraction"), true);

		fillInput(dom, host.querySelector("[data-peer-home-input]"), "Explore Heine-Borel");
		(host.querySelector("[data-peer-action='home-start']") as HTMLButtonElement).click();
		assert.equal(intents.some((i) => i.type === "start-session"), true);

		view.update(makeHomeModel({ graphEnabled: false }));
		assert.notEqual(host.querySelector("[data-testid='minimal-home']"), null);
		assert.notEqual(host.querySelector("[data-testid='chains-table']"), null);

		view.destroy();
		assert.equal(host.childElementCount, 0);
		assert.equal(tracker.activeCount(), 0);
	} finally {
		tracker.restore();
		await dom.cleanup();
	}
});

test("v0.7.0 graph-folder-filter, source-folder-tree, and delete-source-dialog parity", async () => {
	const dom = installDom();
	const tracker = trackWindowListeners(dom.window);
	try {
		const { createHomeView } = await loadMod<{ createHomeView: AnyFn }>("../src/client/views/home/home-view.js");
		const { deriveGraphStageModel } = await loadMod<{ deriveGraphStageModel: AnyFn }>("../src/client/views/graph/graph-models.js");
		const host = dom.document.createElement("div");
		dom.document.body.append(host);
		const intents: Array<Record<string, unknown>> = [];
		const sourcesDir = {
			organization: {
				version: 1 as const,
				folders: [
					{ id: "f_analysis", name: "Analysis", parentId: null, createdAt: "2026-11-20T00:00:00Z" },
					{ id: "f_algebra", name: "Algebra", parentId: null, createdAt: "2026-11-20T00:00:00Z" },
				],
				placements: { c1: { folderId: "f_analysis" }, c2: { folderId: "f_algebra" } },
			},
			sources: [
				{ id: "c1", kind: "chat", label: "Real Analysis", createdAt: "2026-11-19T10:00:00Z" },
				{ id: "c2", kind: "chat", label: "Abstract Algebra", createdAt: "2026-11-19T11:00:00Z" },
			],
		};

		const filteredStage = deriveGraphStageModel(makeHomeModel({
			sources: sourcesDir,
			selectedFolderIds: ["f_analysis"],
			searchQuery: "EVT",
		}));
		assert.equal(filteredStage.visible.has("n_evt"), true);
		assert.equal(filteredStage.visible.has("n_alg"), false);
		assert.equal(filteredStage.visible.has("arg_evt"), false);

		const view = createHomeView(host, { send: (i: Record<string, unknown>) => { intents.push(i); return Promise.resolve(); } });
		view.update(makeHomeModel({ sources: sourcesDir, selectedFolderIds: ["f_analysis"] }));

		const filterBtn = host.querySelector("[data-testid='graph-folder-filter']") as HTMLButtonElement;
		assert.notEqual(filterBtn, null);
		filterBtn.click();
		assert.equal((host.querySelector("[data-testid='graph-folder-filter-panel']") as HTMLElement).hidden, false);
		(host.querySelector("[data-testid='graph-folder-filter-clear']") as HTMLButtonElement).click();
		assert.deepEqual(intents.at(-1), { type: "clear-graph-folders" });

		view.update(makeHomeModel({ viewTab: "chains", sources: sourcesDir }));
		(host.querySelector("[data-testid='add-source-folder']") as HTMLButtonElement).click();
		const nameInput = host.querySelector("[data-testid='source-name-input']") as HTMLInputElement;
		nameInput.value = "Topology";
		nameInput.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
		await new Promise((r) => setTimeout(r, 0));
		assert.deepEqual(intents.at(-1), {
			type: "source-action",
			method: "POST",
			body: { action: "create-folder", name: "Topology", parentId: null },
		});

		(host.querySelector("[data-testid='folder-name-f_analysis']") as HTMLButtonElement).click();
		const renameInput = host.querySelector("[data-testid='source-name-input']") as HTMLInputElement;
		renameInput.value = "Measure Theory";
		renameInput.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
		await new Promise((r) => setTimeout(r, 0));
		assert.deepEqual(intents.at(-1), {
			type: "source-action",
			method: "POST",
			body: { action: "rename-folder", id: "f_analysis", name: "Measure Theory" },
		});

		(host.querySelector("[data-testid='confirm-delete-source-c1']") as HTMLButtonElement).click();
		const srcDialog = host.querySelector("[data-testid='delete-source-dialog']");
		assert.notEqual(srcDialog, null);
		const sessBox = host.querySelector("[data-testid='delete-source-sessions']") as HTMLInputElement;
		sessBox.checked = true;
		sessBox.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
		(host.querySelector("[data-testid='source-delete-confirm']") as HTMLButtonElement).click();
		await new Promise((r) => setTimeout(r, 0));
		assert.deepEqual(intents.at(-1), {
			type: "source-action",
			method: "DELETE",
			body: { sourceIds: ["c1"], folderIds: [], deleteSessions: true },
		});

		view.destroy();
		assert.equal(host.childElementCount, 0);
		assert.equal(tracker.activeCount(), 0);
	} finally {
		tracker.restore();
		await dom.cleanup();
	}
});
