import assert from "node:assert/strict";
import test from "node:test";
import "./helpers/client-env.ts";
import { installDom, type InstalledDom } from "./helpers/client-dom.ts";

interface MockStore<M, I = { readonly type: string }> {
	get(): M;
	set(next: M): void;
	intents: I[];
	disposed: () => boolean;
	subscribe(fn: (m: M) => void): () => void;
	send(intent: I): Promise<void>;
	dispose(): void;
}

type AnyFn = (...args: any[]) => any;

function createMockStore<M, I = { readonly type: string }>(
	initial: M,
	reducer?: (current: M, intent: I) => M,
): MockStore<M, I> {
	let value = initial;
	let isDisposed = false;
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
		disposed: () => isDisposed,
		subscribe: (fn) => {
			listeners.add(fn);
			return () => { listeners.delete(fn); };
		},
		send: async (intent) => {
			intents.push(intent);
			if (reducer) set(reducer(value, intent));
		},
		dispose: () => { isDisposed = true; listeners.clear(); },
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

function loadMod<T>(relPath: string): Promise<T> {
	return import(new URL(relPath, import.meta.url).href) as Promise<T>;
}

interface ShellModel {
	platform: "mac" | "win" | "linux" | "web";
	electron: boolean;
	zoom: number;
	sidebar: { open: boolean; narrow: boolean };
	settings: { open: boolean; section: string | null };
	cheatSheet: boolean;
	update: null | { status: string; version: string };
}

function makeShellModel(overrides: Partial<ShellModel> = {}): ShellModel {
	return {
		platform: "linux",
		electron: true,
		zoom: 1,
		sidebar: { open: true, narrow: false },
		settings: { open: false, section: null },
		cheatSheet: false,
		update: null,
		...overrides,
	};
}

function reduceShell(m: ShellModel, i: { type: string; open?: boolean; section?: string | null }): ShellModel {
	if (i.type === "toggle-sidebar") return { ...m, sidebar: { ...m.sidebar, open: !m.sidebar.open } };
	if (i.type === "set-sidebar") return { ...m, sidebar: { ...m.sidebar, open: Boolean(i.open) } };
	if (i.type === "open-settings") return { ...m, settings: { open: true, section: i.section ?? null } };
	if (i.type === "close-settings") return { ...m, settings: { open: false, section: null } };
	if (i.type === "toggle-cheat-sheet") return { ...m, cheatSheet: !m.cheatSheet };
	if (i.type === "close-cheat-sheet") return { ...m, cheatSheet: false };
	return m;
}

function nextFrame(win: Window & typeof globalThis): Promise<void> {
	return new Promise((resolve) => { win.requestAnimationFrame(() => resolve()); });
}

function mountSlotSpyView(
	doc: Document,
	routeName: string,
	host: HTMLElement,
	ctx: { navigate: (to: unknown) => void },
	events: string[],
) {
	const node = doc.createElement("section");
	if (routeName === "not-found") {
		const btn = doc.createElement("button");
		btn.textContent = "Back to Home";
		btn.addEventListener("click", () => ctx.navigate({ name: "home" }));
		node.append(btn);
	}
	host.append(node);
	return {
		update: (m: { key: string; prompt?: string }) => {
			events.push(`update:${m.key}:${m.prompt ?? ""}`);
			node.setAttribute("data-key", m.key);
		},
		destroy: () => { events.push(`destroy:${node.getAttribute("data-key")}`); node.remove(); },
	};
}

function createSlotSpyFactory(doc: Document, events: string[]) {
	return (route: { name: string }) => (host: HTMLElement, ctx: { navigate: (to: unknown) => void }) =>
		mountSlotSpyView(doc, route.name, host, ctx, events);
}

function mountThrowingView(doc: Document, host: HTMLElement, state: { fail: boolean; destroyed: boolean }) {
	const node = doc.createElement("div");
	node.setAttribute("data-testid", "ok-view");
	host.append(node);
	return {
		update: (m: { text: string }) => {
			if (state.fail) throw new Error("Render exploded");
			node.textContent = m.text;
		},
		destroy: () => { state.destroyed = true; node.remove(); },
	};
}

function createThrowingFactory(doc: Document, state: { fail: boolean; destroyed: boolean }) {
	return () => (host: HTMLElement) => mountThrowingView(doc, host, state);
}

function makeReadySessionFixture() {
	return {
		route: { name: "session", id: "c1" },
		hash: "",
		load: "ready",
		error: null,
		chatId: "c1",
		title: "Lesson 1",
		kind: "teach",
		compacting: false,
		mode: "dark",
		configured: true,
		status: "ready",
		contextTokens: 120,
		turnError: null,
		imageSnapshots: {},
		messages: [{ id: "a1", role: "assistant", parts: [{ type: "reasoning", id: "r1", text: "Step 1" }] }],
	};
}

function fireKey(dom: InstalledDom, key: string, ctrlKey = false, target?: EventTarget): KeyboardEvent {
	const ev = new dom.window.KeyboardEvent("keydown", { key, ctrlKey, bubbles: true, cancelable: true });
	(target ?? dom.window).dispatchEvent(ev);
	return ev;
}

test("createShell mounts exact DOM skeleton and never mutates <html> (R6)", async () => {
	const dom = installDom();
	try {
		const { createShell } = await loadMod<{ createShell: AnyFn }>("../src/client/views/shell/shell.js");
		const doc = dom.document;
		doc.documentElement.className = "dark";
		doc.documentElement.setAttribute("data-sentinel", "untouched");
		const host = doc.createElement("div");
		doc.body.append(host);

		const router = createMockStore({ route: { name: "home" }, pathname: "/", search: "", hash: "" });
		const shellStore = createMockStore(makeShellModel(), reduceShell);
		const pending = createMockStore({ routeName: "home", title: "Map", body: "Ready", path: "/", configured: true });
		const handle = createShell(host, { router, shell: shellStore, screen: () => pending });

		const root = host.querySelector(".peer-shell");
		assert.notEqual(root, null);
		assert.equal(root?.getAttribute("data-peer-platform"), "linux");
		assert.equal(root?.getAttribute("data-peer-electron"), "true");
		const side = host.querySelector("aside.peer-shell-side") as HTMLElement | null;
		assert.equal(side?.hidden, false);
		assert.notEqual(host.querySelector("main.peer-shell-content"), null);
		assert.notEqual(host.querySelector("div.peer-shell-layer"), null);

		await shellStore.send({ type: "toggle-sidebar" });
		assert.equal(side?.hidden, true);
		assert.equal(doc.documentElement.className, "dark");
		assert.equal(doc.documentElement.getAttribute("data-sentinel"), "untouched");
		assert.equal(doc.documentElement.getAttribute("style"), null);

		handle.destroy();
		assert.equal(host.childElementCount, 0);
	} finally {
		await dom.cleanup();
	}
});

test("mountClientApp applies appearance tokens onto <html> and cleans up on destroy (R5, R6)", async () => {
	const dom = installDom();
	try {
		const { mountClientApp } = await loadMod<{ mountClientApp: AnyFn }>("../src/client/main.js");
		const doc = dom.document;
		doc.documentElement.setAttribute("data-theme-pending", "");
		const darkTokens = { mode: "dark", cc: { "--cc-bg": "#0b1120" }, peer: { "--peer-font-title": "Georgia, serif" } };
		const lightTokens = { mode: "light", cc: { "--cc-bg": "#ffffff" }, peer: { "--peer-font-title": "serif" } };
		const appearance = createMockStore({ load: "ready", tokens: darkTokens });
		const router = createMockStore({ route: { name: "home" }, pathname: "/", search: "", hash: "" });
		const shell = createMockStore(makeShellModel(), reduceShell);
		const settings = createMockStore({ load: "ready", error: null, configured: true, lastImport: null });
		const pending = createMockStore({ routeName: "home", title: "Home", body: "Pending", path: "/", configured: true });

		const app = mountClientApp(doc, {
			state: { router, shell, settings, appearance, screen: () => pending, dispose: () => {} },
			blocks: { fenceFor: () => null, dispose: () => {} },
		});
		assert.equal(doc.documentElement.hasAttribute("data-theme-pending"), false);
		assert.equal(doc.documentElement.classList.contains("dark"), true);
		assert.equal(doc.documentElement.style.getPropertyValue("--peer-font-title"), "Georgia, serif");

		appearance.set({ load: "ready", tokens: lightTokens });
		assert.equal(doc.documentElement.classList.contains("light"), true);

		app.destroy();
		assert.equal(doc.body.childElementCount, 0);
	} finally {
		await dom.cleanup();
	}
});

test("createScreenSlot preserves same-key view across query/hash updates and unmounts on new key", async () => {
	const dom = installDom();
	try {
		const { createScreenSlot } = await loadMod<{ createScreenSlot: AnyFn }>("../src/client/views/shell/slot.js");
		const slotHost = dom.document.createElement("main");
		dom.document.body.append(slotHost);
		const navCalls: unknown[] = [];
		const stores = new Map<string, MockStore<Record<string, unknown>>>();
		const events: string[] = [];
		const getStore = (rm: { route: { name: string; id?: string } }) => {
			const key = rm.route.name === "session" ? `s:${rm.route.id}` : rm.route.name;
			const found = stores.get(key);
			if (found && !found.disposed()) return found;
			const created = createMockStore<Record<string, unknown>>({ key });
			stores.set(key, created);
			return created;
		};
		const slot = createScreenSlot(slotHost, {
			navigate: (to: unknown) => { navCalls.push(to); },
			screen: getStore,
			resolveFactory: createSlotSpyFactory(dom.document, events),
		});

		slot.syncRoute({ route: { name: "home" }, pathname: "/", search: "", hash: "" });
		slot.syncRoute({ route: { name: "session", id: "c1" }, pathname: "/chat/c1", search: "", hash: "" });
		assert.equal(stores.get("home")?.disposed(), true);

		stores.get("s:c1")?.set({ key: "s:c1", prompt: "hi" });
		slot.syncRoute({ route: { name: "session", id: "c1", prompt: "hi" }, pathname: "/chat/c1", search: "?prompt=hi", hash: "#m1" });
		await nextFrame(dom.window);
		assert.equal(events.includes("destroy:s:c1"), false);
		assert.equal(events.includes("update:s:c1:hi"), true);

		slot.syncRoute({ route: { name: "session", id: "c2" }, pathname: "/chat/c2", search: "", hash: "" });
		assert.equal(events.includes("destroy:s:c1"), true);
		assert.equal(stores.get("s:c1")?.disposed(), true);
		assert.equal(slotHost.childElementCount, 1);

		slot.syncRoute({ route: { name: "not-found", path: "/nope" }, pathname: "/nope", search: "", hash: "" });
		(slotHost.querySelector("button") as HTMLButtonElement).click();
		assert.equal(navCalls.length, 1);
		slot.destroy();
		assert.equal(slotHost.childElementCount, 0);
	} finally {
		await dom.cleanup();
	}
});

test("createScreenSlot coalesces burst emissions to 1/rAF and cancels frame on destroy", async () => {
	const dom = installDom();
	try {
		const { createScreenSlot } = await loadMod<{ createScreenSlot: AnyFn }>("../src/client/views/shell/slot.js");
		const slotHost = dom.document.createElement("main");
		dom.document.body.append(slotHost);
		const store = createMockStore({ seq: 0 });
		const seen: number[] = [];
		const factory = () => (host: HTMLElement) => {
			const el = dom.document.createElement("div");
			host.append(el);
			return { update: (m: { seq: number }) => { seen.push(m.seq); }, destroy: () => el.remove() };
		};
		const slot = createScreenSlot(slotHost, { screen: () => store, resolveFactory: factory });

		slot.syncRoute({ route: { name: "home" }, pathname: "/", search: "", hash: "" });
		assert.equal(seen.length, 1);

		store.set({ seq: 1 });
		store.set({ seq: 2 });
		store.set({ seq: 3 });
		assert.equal(seen.length, 1);
		await nextFrame(dom.window);
		assert.equal(seen.length, 2);
		assert.equal(seen[1], 3);

		store.set({ seq: 4 });
		slot.destroy();
		await nextFrame(dom.window);
		assert.equal(seen.length, 2);
		assert.equal(slotHost.childElementCount, 0);
	} finally {
		await dom.cleanup();
	}
});

test("createScreenSlot error boundary renders createStatus error and Retry remounts", async () => {
	const dom = installDom();
	try {
		const { createScreenSlot } = await loadMod<{ createScreenSlot: AnyFn }>("../src/client/views/shell/slot.js");
		const slotHost = dom.document.createElement("main");
		dom.document.body.append(slotHost);
		const state = { fail: true, destroyed: false };
		const slot = createScreenSlot(slotHost, {
			screen: () => createMockStore({ text: "Recovered view" }),
			resolveFactory: createThrowingFactory(dom.document, state),
		});

		slot.syncRoute({ route: { name: "home" }, pathname: "/", search: "", hash: "" });
		assert.equal(state.destroyed, true);
		const statusEl = slotHost.querySelector(".cloudcanvas-ui-status");
		assert.equal(statusEl?.getAttribute("data-status"), "error");
		assert.equal(statusEl?.textContent?.includes("Render exploded"), true);

		state.fail = false;
		const retryBtn = slotHost.querySelector(".cloudcanvas-ui-status-retry") as HTMLButtonElement | null;
		assert.notEqual(retryBtn, null);
		retryBtn?.click();
		assert.equal(slotHost.querySelector("[data-testid='ok-view']")?.textContent, "Recovered view");
		slot.destroy();
	} finally {
		await dom.cleanup();
	}
});

test("createLayerStack pops Escape layers LIFO, honors defaultPrevented, and runs fallback", async () => {
	const dom = installDom();
	try {
		const { createLayerStack } = await loadMod<{ createLayerStack: AnyFn }>("../src/client/views/shell/layers.js");
		const order: string[] = [];
		const stack = createLayerStack(dom.window, {
			onUnhandledEscape: () => { order.push("fallback"); return true; },
		});
		stack.push({ id: "settings", kind: "modal", onEscape: () => order.push("settings") });
		stack.push({ id: "cheat-sheet", kind: "modal", onEscape: () => order.push("cheat-sheet") });
		assert.equal(stack.size(), 2);
		assert.equal(stack.top()?.id, "cheat-sheet");

		const claimed = new dom.window.KeyboardEvent("keydown", { key: "Escape", cancelable: true });
		claimed.preventDefault();
		assert.equal(stack.handleEscape(claimed), false);
		assert.equal(stack.size(), 2);

		fireKey(dom, "Escape");
		assert.equal(order[0], "cheat-sheet");
		assert.equal(stack.size(), 1);
		fireKey(dom, "Escape");
		assert.equal(order[1], "settings");
		assert.equal(stack.size(), 0);
		fireKey(dom, "Escape");
		assert.equal(order[2], "fallback");
		stack.destroy();
	} finally {
		await dom.cleanup();
	}
});

test("shell shortcuts route Mod+B, Mod+,, ?, Escape, typing guard, Tab, and Mod+T", async () => {
	const dom = installDom();
	try {
		const { createShell } = await loadMod<{ createShell: AnyFn }>("../src/client/views/shell/shell.js");
		const host = dom.document.createElement("div");
		dom.document.body.append(host);
		const router = createMockStore({ route: { name: "session", id: "c1" }, pathname: "/chat/c1", search: "", hash: "" });
		const shellStore = createMockStore(makeShellModel(), reduceShell);
		const sessionStore = createMockStore(makeReadySessionFixture());
		const handle = createShell(host, { router, shell: shellStore, screen: () => sessionStore });

		fireKey(dom, "b", true);
		assert.equal(shellStore.get().sidebar.open, false);

		fireKey(dom, ",", true);
		assert.equal(shellStore.get().settings.open, true);
		assert.notEqual(host.querySelector("[data-testid='settings-dialog']"), null);

		const importField = host.querySelector("[data-peer-import-input]") as HTMLInputElement;
		fireKey(dom, "?", false, importField);
		assert.equal(shellStore.get().cheatSheet, false);

		fireKey(dom, "?");
		assert.equal(shellStore.get().cheatSheet, true);
		assert.notEqual(host.querySelector("[data-testid='cheat-sheet']"), null);

		fireKey(dom, "Escape");
		assert.equal(shellStore.get().cheatSheet, false);
		assert.equal(shellStore.get().settings.open, true);
		fireKey(dom, "Escape");
		assert.equal(shellStore.get().settings.open, false);

		assert.equal(fireKey(dom, "Tab").defaultPrevented, true);
		const thinking = host.querySelector("[data-peer-thinking]") as HTMLDetailsElement;
		assert.equal(thinking.open, false);
		fireKey(dom, "t", true);
		assert.equal(thinking.open, true);

		handle.destroy();
	} finally {
		await dom.cleanup();
	}
});

test("Settings Data importer sends import-learnharness and destroy leaves zero window listeners", async () => {
	const dom = installDom();
	const tracker = trackWindowListeners(dom.window);
	try {
		const { createShell } = await loadMod<{ createShell: AnyFn }>("../src/client/views/shell/shell.js");
		const host = dom.document.createElement("div");
		dom.document.body.append(host);
		const router = createMockStore({ route: { name: "home" }, pathname: "/", search: "", hash: "" });
		const shellStore = createMockStore(makeShellModel({ settings: { open: true, section: "data" } }), reduceShell);
		const settingsStore = createMockStore<{ load: string; error: string | null; lastImport: Record<string, unknown> | null }>({
			load: "ready",
			error: null,
			lastImport: null,
		});
		const pending = createMockStore({ routeName: "home", title: "Map", body: "Empty", path: "/", configured: true });
		const handle = createShell(host, { router, shell: shellStore, settings: settingsStore, screen: () => pending });
		assert.equal(tracker.activeCount() > 0, true);

		const field = host.querySelector("[data-peer-import-input]") as HTMLInputElement;
		field.value = "/srv/learnharness/data";
		(host.querySelector("[data-peer-action='import-learnharness']") as HTMLButtonElement).click();
		assert.deepEqual(settingsStore.intents[0], { type: "import-learnharness", sourceDirectory: "/srv/learnharness/data" });

		settingsStore.set({ load: "ready", error: null, lastImport: { chatsImported: 7, nodesImported: 42 } });
		const reportEl = host.querySelector("[data-peer-import-report]") as HTMLElement;
		assert.equal(reportEl.hidden, false);
		assert.equal(reportEl.textContent?.includes("Chats imported: 7"), true);

		handle.destroy();
		assert.equal(host.childElementCount, 0);
		assert.equal(tracker.activeCount(), 0);
	} finally {
		tracker.restore();
		await dom.cleanup();
	}
});
