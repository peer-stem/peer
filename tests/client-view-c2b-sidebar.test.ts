import assert from "node:assert/strict";
import test from "node:test";
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

function fillInput(dom: InstalledDom, el: Element | null, value: string): void {
	assert.notEqual(el, null);
	const input = el as HTMLInputElement;
	input.value = value;
	input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
}

function fireContextMenu(dom: InstalledDom, el: Element | null): void {
	assert.notEqual(el, null);
	el!.dispatchEvent(new dom.window.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 60, clientY: 90 }));
}

function makeSidebarFixture() {
	const nowIso = new Date(Date.now() - 120_000).toISOString();
	const organization = {
		version: 1 as const,
		folders: [{ id: "f_math", name: "Mathematics", parentId: null, createdAt: nowIso }],
		placements: { c_calc: { folderId: "f_math" }, n_notes: { folderId: "f_math" } },
	};
	const sources = [
		{ id: "c_calc", kind: "chat", label: "Multivariable Calculus", createdAt: nowIso },
		{ id: "c_prob", kind: "chat", label: "Probability Drills", createdAt: nowIso },
		{ id: "n_notes", kind: "notes", label: "calc-notes.md", createdAt: nowIso },
	];
	const calcCoverage = {
		totalMessages: 10, coveredCount: 6, uncoveredCount: 4,
		coveredTokens: 3200, uncoveredTokens: 1500, running: false, lastFoldedAt: nowIso,
	};
	return {
		sessions: [
			{ id: "c_calc", title: "Multivariable Calculus", kind: "teach", updatedAt: nowIso, busy: false },
			{ id: "c_prob", title: "Probability Drills", kind: "practice", updatedAt: nowIso, pendingProblem: true },
		],
		directory: { organization, sources },
		coverageByChatId: { c_calc: calcCoverage },
	};
}

function makeActivityFixture(now: number) {
	const researchJob = {
		id: "job_1", kind: "research", chatId: "c1", toolCallId: "tc1", status: "running",
		title: "Topology Research", activity: "searching papers", costUsd: 0.0025, contextLimit: 100_000,
		createdAt: new Date(now - 30_000).toISOString(), updatedAt: new Date(now).toISOString(),
		usage: { model: "anthropic:claude", steps: 2, lastStep: { inputTokens: 4000, outputTokens: 500 } },
	};
	const pluginWorker = {
		id: "plug:w1", taskId: "w1", pluginId: "plug", definitionId: "grader", status: "running",
		title: "Flashcard Grader", createdAt: new Date(now - 20_000).toISOString(), updatedAt: new Date(now).toISOString(),
		model: { provider: "openai", id: "gpt-5" }, costUsd: 0.0015, contextLimit: null,
	};
	const extractionRun = {
		id: "c2#1", chatId: "c2", title: "Algebra Notes", phase: "auditing", startedAt: now - 50_000,
	};
	return { jobs: [researchJob], pluginWorkers: [pluginWorker], extractions: [extractionRun] };
}

function createSimpleStore<M>(initial: M, reduce?: (cur: M, intent: Record<string, unknown>) => M) {
	let val = initial;
	const subs = new Set<(m: M) => void>();
	const intents: Array<Record<string, unknown>> = [];
	return {
		intents,
		get: () => val,
		set: (next: M) => { val = next; for (const fn of [...subs]) fn(val); },
		subscribe: (fn: (m: M) => void) => { subs.add(fn); return () => subs.delete(fn); },
		send: async (intent: Record<string, unknown>) => {
			intents.push(intent);
			if (reduce) { val = reduce(val, intent); for (const fn of [...subs]) fn(val); }
		},
		dispose: () => subs.clear(),
	};
}

test("extraction-coverage: ringFill, createCoverageRing, and createCoverageMenuBlock", async () => {
	const dom = installDom();
	const mod = await loadMod<{
		ringFill: (u: number, c: number) => number;
		createCoverageRing: AnyFn;
		createCoverageMenuBlock: AnyFn;
	}>("../src/client/views/sidebar/extraction-coverage.js");
	const tracker = trackWindowListeners(dom.window);
	try {
		assert.equal(mod.ringFill(0, 4096), 0);
		assert.equal(mod.ringFill(2048, 4096), 0.5);
		assert.equal(mod.ringFill(9000, 4096), 1);
		assert.equal(mod.ringFill(500, 0), 0);

		const ringHost = dom.document.createElement("div");
		dom.document.body.append(ringHost);
		const ringExtracts: string[] = [];
		const ring = mod.createCoverageRing(ringHost, { onExtract: (id: string) => ringExtracts.push(id) });
		ring.update({ chatId: "c1", graphEnabled: false, chunkTokens: 4096, coverage: null });
		assert.equal((ringHost.querySelector("[data-testid='coverage-ring']") as HTMLElement).hidden, true);

		const cov = {
			totalMessages: 8, coveredCount: 5, uncoveredCount: 3,
			coveredTokens: 2400, uncoveredTokens: 1024, running: false, lastFoldedAt: null,
		};
		ring.update({ chatId: "c1", graphEnabled: true, chunkTokens: 4096, coverage: cov });
		const ringBtn = ringHost.querySelector("[data-testid='coverage-ring']") as HTMLButtonElement;
		assert.equal(ringBtn.hidden, false);
		ringBtn.click();
		const pop = ringHost.querySelector("[data-testid='coverage-popover']") as HTMLElement;
		assert.equal(pop.hidden, false);
		assert.equal(pop.textContent?.includes("5 / 8"), true);
		(ringHost.querySelector("[data-testid='coverage-extract']") as HTMLButtonElement).click();
		assert.deepEqual(ringExtracts, ["c1"]);
		ring.update({ chatId: "c1", graphEnabled: true, chunkTokens: 4096, coverage: { ...cov, running: true } });
		assert.equal(ringBtn.getAttribute("data-peer-running"), "true");
		ring.destroy();

		const menuHost = dom.document.createElement("div");
		dom.document.body.append(menuHost);
		let menuExtracted = 0;
		const block = mod.createCoverageMenuBlock(menuHost, { onExtract: () => { menuExtracted += 1; } });
		block.update({ coverage: null, extracting: false });
		assert.equal(menuHost.querySelector("[data-testid='ctx-coverage']"), null);
		block.update({ coverage: cov, extracting: false });
		(menuHost.querySelector("[data-testid='ctx-extract']") as HTMLButtonElement).click();
		assert.equal(menuExtracted, 1);
		block.update({ coverage: { ...cov, uncoveredTokens: 0, uncoveredCount: 0 }, extracting: false });
		assert.equal((menuHost.querySelector("[data-testid='ctx-extract']") as HTMLButtonElement).disabled, true);
		block.update({ coverage: cov, extracting: true });
		assert.notEqual(menuHost.querySelector("[data-testid='ctx-coverage-running']"), null);
		block.destroy();
		assert.equal(tracker.activeCount(), 0);
	} finally {
		tracker.restore();
		await dom.cleanup();
	}
});

test("delete-session-dialog: preserve-graph vs delete-nodes, 409 retry, and folderDeleteCopy", async () => {
	const dom = installDom();
	const tracker = trackWindowListeners(dom.window);
	try {
		const { createDeleteSessionDialog, folderDeleteCopy } = await loadMod<{
			createDeleteSessionDialog: AnyFn;
			folderDeleteCopy: AnyFn;
		}>("../src/client/views/sidebar/delete-session-dialog.js");
		const host = dom.document.createElement("div");
		dom.document.body.append(host);
		const confirmed: Array<Record<string, unknown>> = [];
		let rejectOnce = true;
		let closed = 0;
		const onConfirm = async (payload: Record<string, unknown>) => {
			confirmed.push(payload);
			if (!rejectOnce) return;
			rejectOnce = false;
			throw { code: "turn_in_flight", error: "Wait for running work to finish." };
		};
		const dialog = createDeleteSessionDialog(host, { onClose: () => { closed += 1; }, onConfirm });

		dialog.update(null);
		assert.equal(host.querySelector("[data-testid='delete-session-dialog']"), null);
		dialog.update({ kind: "session", id: "c1", title: "Linear Algebra" });
		const modal = host.querySelector("[data-testid='delete-session-dialog']") as HTMLElement;
		assert.equal(modal.getAttribute("role"), "dialog");
		assert.equal(modal.getAttribute("aria-modal"), "true");
		assert.equal(host.querySelector("[data-testid='session-name-code']")?.textContent, "Linear Algebra");

		const checkbox = host.querySelector("[data-testid='delete-traces-checkbox']") as HTMLInputElement;
		assert.equal(checkbox.checked, false);
		(host.querySelector("[data-testid='delete-confirm']") as HTMLButtonElement).click();
		await new Promise((r) => setTimeout(r, 0));
		assert.deepEqual(confirmed[0], { kind: "session", id: "c1", mode: "preserve-graph" });
		assert.equal((host.querySelector("[data-testid='delete-failure']") as HTMLElement).hidden, false);

		checkbox.checked = true;
		checkbox.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
		(host.querySelector("[data-testid='delete-retry']") as HTMLButtonElement).click();
		await new Promise((r) => setTimeout(r, 0));
		assert.deepEqual(confirmed[1], { kind: "session", id: "c1", mode: "delete-nodes" });

		const copy = folderDeleteCopy({ sessions: 2, subfolders: 1, notes: 1, parentName: "STEM" });
		dialog.update({ kind: "folder", id: "f1", title: "Analysis", copy });
		const folderModal = host.querySelector("[data-testid='delete-folder-dialog']") as HTMLElement;
		assert.equal(folderModal.textContent?.includes("moves to “STEM”"), true);
		(host.querySelector("[data-testid='delete-cancel']") as HTMLButtonElement).click();
		assert.equal(closed, 1);
		dialog.destroy();
		assert.equal(tracker.activeCount(), 0);
	} finally {
		tracker.restore();
		await dom.cleanup();
	}
});

test("activity-dock: renders job, plugin-worker, and extraction blobs, handles abort, and cleans up", async () => {
	const dom = installDom();
	const tracker = trackWindowListeners(dom.window);
	try {
		const { createActivityDock, formatElapsed } = await loadMod<{
			createActivityDock: AnyFn;
			formatElapsed: (ms: number) => string;
		}>("../src/client/views/sidebar/activity-dock.js");
		assert.equal(formatElapsed(45_000), "45s");
		assert.equal(formatElapsed(184_000), "3m 04s");

		const host = dom.document.createElement("div");
		dom.document.body.append(host);
		const aborts: Array<{ kind: string; id: string }> = [];
		const navigated: string[] = [];
		const dock = createActivityDock(host, {
			onAbort: (req: { kind: string; id: string }) => { aborts.push(req); },
			onNavigateSession: (id: string) => { navigated.push(id); },
		});
		dock.update({ jobs: [], pluginWorkers: [], extractions: [] });
		assert.equal(host.querySelector("[data-testid='activity-section']")?.textContent?.includes("Background agents"), true);

		dock.update(makeActivityFixture(Date.now()));
		assert.notEqual(host.querySelector("[data-testid='activity-blob-job']"), null);
		assert.notEqual(host.querySelector("[data-testid='activity-blob-plugin-worker']"), null);
		assert.notEqual(host.querySelector("[data-testid='activity-blob-extraction']"), null);
		assert.equal(host.querySelector("[data-testid='activity-total-cost']")?.textContent, "$0.0040");

		const jobBlob = host.querySelector("[data-testid='activity-blob-job']") as HTMLElement;
		(jobBlob.querySelector("button[aria-expanded]") as HTMLButtonElement).click();
		const detail = jobBlob.querySelector("[data-testid='activity-blob-detail']") as HTMLElement;
		assert.equal(detail.hidden, false);
		assert.equal(detail.querySelector("[data-testid='activity-blob-context']")?.textContent, "4.5k / 100k");
		(detail.querySelector("a") as HTMLAnchorElement).click();
		assert.deepEqual(navigated, ["c1"]);

		(host.querySelector("[data-testid='activity-blob-extraction'] [data-testid='activity-abort']") as HTMLButtonElement).click();
		assert.deepEqual(aborts[0], { kind: "extraction", id: "c2" });
		(host.querySelector("[data-testid='activity-blob-plugin-worker'] [data-testid='activity-abort']") as HTMLButtonElement).click();
		assert.deepEqual(aborts[1], { kind: "plugin-worker", id: "plug:w1" });

		dock.destroy();
		assert.equal(host.childElementCount, 0);
		assert.equal(tracker.activeCount(), 0);
	} finally {
		tracker.restore();
		await dom.cleanup();
	}
});

test("sidebar-view: session rows, search, inline rename, Markdown export, and folder CRUD", async () => {
	const dom = installDom();
	const tracker = trackWindowListeners(dom.window);
	try {
		const { createSidebarView } = await loadMod<{ createSidebarView: AnyFn }>("../src/client/views/sidebar/sidebar-view.js");
		const host = dom.document.createElement("aside");
		dom.document.body.append(host);
		const intents: Array<Record<string, unknown>> = [];
		const navs: unknown[] = [];
		let settingsOpened = 0;
		const sidebar = createSidebarView(host, {
			onNavigate: (to: unknown) => navs.push(to),
			onOpenSettings: () => { settingsOpened += 1; },
			onSessionsIntent: (intent: Record<string, unknown>) => { intents.push(intent); return Promise.resolve(); },
		});
		sidebar.update({ ...makeSidebarFixture(), activeChatId: "c_calc", appearance: { sessionNameSerif: true } });
		assert.equal(host.querySelectorAll("[data-testid='session-row']").length, 2);
		assert.equal(host.querySelector("[data-chat-id='c_calc']")?.getAttribute("data-peer-active"), "true");
		(host.querySelector("[data-testid='settings-entry']") as HTMLButtonElement).click();
		assert.equal(settingsOpened, 1);

		const searchInput = host.querySelector("[data-testid='sidebar-search']") as HTMLInputElement;
		fillInput(dom, searchInput, "Probability");
		assert.deepEqual(intents.at(-1), { type: "set-search", query: "Probability" });
		assert.equal(host.querySelectorAll("[data-testid='session-row']").length, 1);
		fillInput(dom, searchInput, "");

		fireContextMenu(dom, host.querySelector("[data-chat-id='c_calc']"));
		assert.notEqual(host.querySelector("[data-testid='ctx-coverage']"), null);
		(host.querySelector("[data-testid='ctx-export-md']") as HTMLButtonElement).click();
		assert.equal(intents.some((i) => i.type === "export-markdown" && i.id === "c_calc"), true);

		fireContextMenu(dom, host.querySelector("[data-chat-id='c_calc']"));
		(host.querySelector("[data-testid='ctx-rename']") as HTMLButtonElement).click();
		const renameInput = host.querySelector("[data-testid='session-rename-input']") as HTMLInputElement;
		renameInput.value = "Vector Calculus";
		renameInput.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
		assert.equal(intents.some((i) => i.type === "rename-session" && i.title === "Vector Calculus"), true);

		fireContextMenu(dom, host.querySelector("[data-chat-id='c_prob']"));
		(host.querySelector("[data-testid='ctx-move-folder-f_math']") as HTMLButtonElement).click();
		assert.deepEqual(intents.at(-1), {
			type: "source-action", method: "POST", body: { action: "move", kind: "source", id: "c_prob", parentId: "f_math" },
		});
		(host.querySelector("[data-testid='new-folder-button']") as HTMLButtonElement).click();
		const newFolderInput = host.querySelector("[data-testid='sidebar-folder-name-input']") as HTMLInputElement;
		newFolderInput.value = "Physics";
		newFolderInput.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
		assert.deepEqual(intents.at(-1), {
			type: "source-action", method: "POST", body: { action: "create-folder", name: "Physics", parentId: null },
		});

		fireContextMenu(dom, host.querySelector("[data-testid='sidebar-folder']"));
		(host.querySelector("[data-testid='folder-ctx-delete']") as HTMLButtonElement).click();
		assert.notEqual(host.querySelector("[data-testid='delete-folder-dialog']"), null);
		(host.querySelector("[data-testid='delete-confirm']") as HTMLButtonElement).click();
		await new Promise((r) => setTimeout(r, 0));
		assert.equal(intents.some((i) => i.type === "delete-folder" && i.id === "f_math"), true);
		assert.deepEqual(navs.at(-1), { name: "home" });
		sidebar.destroy();
		assert.equal(tracker.activeCount(), 0);
	} finally {
		tracker.restore();
		await dom.cleanup();
	}
});

test("shell integration: sessions + activity stores, active route highlight, and sessions-search shortcut", async () => {
	const dom = installDom();
	const tracker = trackWindowListeners(dom.window);
	try {
		const { createShell } = await loadMod<{ createShell: AnyFn }>("../src/client/views/shell/shell.js");
		const host = dom.document.createElement("div");
		dom.document.body.append(host);
		const router = createSimpleStore({ route: { name: "session", id: "c_prob" }, pathname: "/chat/c_prob", search: "", hash: "" });
		const shellStore = createSimpleStore(
			{ platform: "linux", electron: false, zoom: 1, sidebar: { open: false, narrow: false }, settings: { open: false, section: null }, cheatSheet: false, update: null },
			(cur, i) => (i.type === "set-sidebar" ? { ...cur, sidebar: { ...cur.sidebar, open: Boolean(i.open) } } : cur),
		);
		const sessionsStore = createSimpleStore(makeSidebarFixture());
		const activityStore = createSimpleStore(makeActivityFixture(Date.now()));
		const prefsStore = createSimpleStore({ keymapOverrides: { "open-model-picker": "mod+m", "sessions-search": "mod+k" } });
		const screenStore = createSimpleStore({ routeName: "home", title: "Session", body: "Ready", path: "/chat/c_prob", configured: true });

		const handle = createShell(host, {
			router, shell: shellStore, sessions: sessionsStore, activity: activityStore, prefs: prefsStore, screen: () => screenStore,
		});
		assert.equal(host.querySelector("[data-chat-id='c_prob']")?.getAttribute("data-peer-active"), "true");
		assert.notEqual(host.querySelector("[data-testid='activity-blob-job']"), null);

		const ev = new dom.window.KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true, cancelable: true });
		dom.window.dispatchEvent(ev);
		await new Promise((r) => setTimeout(r, 0));
		assert.equal(shellStore.get().sidebar.open, true);
		assert.equal(dom.document.activeElement, host.querySelector("[data-testid='sidebar-search']"));

		handle.destroy();
		assert.equal(host.childElementCount, 0);
		assert.equal(tracker.activeCount(), 0);
	} finally {
		tracker.restore();
		await dom.cleanup();
	}
});
