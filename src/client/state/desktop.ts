/**
 * Desktop Electron preload bridge store (`c2a-frozen-contracts §3.2`).
 * Wraps optional `globalThis.window?.lh` and degrades cleanly to browser-safe
 * no-ops (`electron: false`, `platform: "web"`) when absent.
 */

import type { ShellIntent, ShellModel } from "./shell.ts";
import {
	assertNeverIntent,
	createCell,
	createStoreFromCell,
	type Cell,
	type Store,
	type Unsubscribe,
} from "./store.ts";

export interface DesktopModel {
	readonly electron: boolean;
	readonly platform: "mac" | "win" | "linux" | "web";
	readonly zoom: number;
	readonly update: null | { readonly status: string; readonly version: string };
}

export type DesktopIntent =
	| { readonly type: "pick-directory" }
	| { readonly type: "pick-files" }
	| { readonly type: "check-updates" }
	| { readonly type: "install-update" }
	| { readonly type: "set-zoom"; readonly zoom: number }
	| { readonly type: "dismiss-startup-message"; readonly id: string };

export type DesktopStore = Store<DesktopModel, DesktopIntent> & {
	pickDirectory(): Promise<string | null>;
	pickFiles(): Promise<readonly string[]>;
	dismissStartupMessage(id: string): Promise<void>;
};

export interface DesktopStartupMessageOffer {
	message: { id: string; title: string; publishedAt: string; bodyMarkdown: string };
	deadlineAt: number;
}

export interface DesktopBridge {
	platform?: string;
	getPathForFile?: (file: File) => string;
	chooseAttachmentFolder?: () => Promise<string | null>;
	pickDirectory?: () => Promise<string | null>;
	pickFiles?: () => Promise<readonly string[] | null>;
	getZoom?: () => Promise<number>;
	onZoom?: (cb: (factor: number) => void) => () => void;
	getUpdateState?: () => Promise<{ status?: unknown; version?: unknown } | null>;
	onUpdateStatus?: (cb: (status: { status?: unknown; version?: unknown } | null) => void) => () => void;
	checkForUpdates?: () => Promise<void>;
	installUpdate?: () => void;
	onOpenSettings?: (cb: (section: string) => void) => () => void;
	takeStartupMessage?: () => Promise<DesktopStartupMessageOffer | null>;
	dismissStartupMessage?: (id: string) => Promise<boolean> | boolean;
}

export interface CreateDesktopStoreOptions {
	bridge?: DesktopBridge | null;
	shell?: Store<ShellModel, ShellIntent>;
}

function readWindowBridge(): DesktopBridge | null {
	try {
		const win = globalThis.window as (Window & { lh?: DesktopBridge }) | undefined;
		return win?.lh && typeof win.lh === "object" ? win.lh : null;
	} catch {
		return null;
	}
}

function normalizePlatform(raw: string | undefined, hasBridge: boolean): DesktopModel["platform"] {
	if (!hasBridge) return "web";
	if (raw === "darwin" || raw === "mac") return "mac";
	if (raw === "win32" || raw === "win") return "win";
	return "linux";
}

function normalizeUpdatePayload(
	raw: { status?: unknown; version?: unknown } | null | undefined,
): DesktopModel["update"] {
	if (!raw || typeof raw !== "object" || typeof raw.status !== "string" || !raw.status) {
		return null;
	}
	return {
		status: raw.status,
		version: typeof raw.version === "string" ? raw.version : "",
	};
}

function applyZoomUpdate(
	cell: Cell<DesktopModel>,
	shell: Store<ShellModel, ShellIntent> | undefined,
	factor: number,
): void {
	if (!Number.isFinite(factor) || factor <= 0) return;
	const cur = cell.get();
	if (cur.zoom !== factor) cell.set({ ...cur, zoom: factor });
	void shell?.send({ type: "set-zoom", zoom: factor });
}

function applyUpdaterSnapshot(
	cell: Cell<DesktopModel>,
	shell: Store<ShellModel, ShellIntent> | undefined,
	raw: { status?: unknown; version?: unknown } | null | undefined,
): void {
	const update = normalizeUpdatePayload(raw);
	cell.set({ ...cell.get(), update });
	void shell?.send({ type: "set-update", update });
}

function pollInitialStartupMessage(
	bridge: DesktopBridge | null,
	shell: Store<ShellModel, ShellIntent> | undefined,
	isDisposed: () => boolean,
): void {
	if (typeof bridge?.takeStartupMessage !== "function" || !shell) return;
	void bridge
		.takeStartupMessage()
		.then((result) => {
			if (isDisposed() || !result?.message || Date.now() >= result.deadlineAt) return;
			const sm = shell.get();
			if (sm.settings.open || sm.setupOpen || sm.cheatSheet) return;
			void shell.send({ type: "set-startup-message", message: { ...result.message } });
		})
		.catch(() => {});
}

function subscribeBridgeEvents(
	bridge: DesktopBridge | null,
	cell: Cell<DesktopModel>,
	shell: Store<ShellModel, ShellIntent> | undefined,
	isDisposed: () => boolean,
): Unsubscribe {
	if (!bridge) return () => {};
	const offs: Unsubscribe[] = [];
	if (typeof bridge.onZoom === "function") {
		offs.push(bridge.onZoom((f) => { if (!isDisposed()) applyZoomUpdate(cell, shell, f); }));
	}
	if (typeof bridge.getZoom === "function") {
		void bridge.getZoom().then((f) => { if (!isDisposed()) applyZoomUpdate(cell, shell, f); }).catch(() => {});
	}
	if (typeof bridge.onUpdateStatus === "function") {
		offs.push(bridge.onUpdateStatus((s) => { if (!isDisposed()) applyUpdaterSnapshot(cell, shell, s); }));
	}
	if (typeof bridge.getUpdateState === "function") {
		void bridge.getUpdateState().then((s) => { if (!isDisposed()) applyUpdaterSnapshot(cell, shell, s); }).catch(() => {});
	}
	if (typeof bridge.onOpenSettings === "function" && shell) {
		offs.push(bridge.onOpenSettings((section) => {
			if (!isDisposed()) void shell.send({ type: "open-settings", section: section || null });
		}));
	}
	pollInitialStartupMessage(bridge, shell, isDisposed);
	return () => {
		for (const off of offs) off();
	};
}

async function invokePickDirectory(bridge: DesktopBridge | null): Promise<string | null> {
	const fn = bridge?.chooseAttachmentFolder ?? bridge?.pickDirectory;
	if (typeof fn !== "function") return null;
	try {
		const res = await fn();
		return typeof res === "string" && res.length > 0 ? res : null;
	} catch {
		return null;
	}
}

function collectSelectedFilePaths(el: HTMLInputElement, resolvePath: (file: File) => string): readonly string[] {
	const out: string[] = [];
	for (const file of Array.from(el.files ?? [])) {
		try {
			const p = resolvePath(file);
			if (typeof p === "string" && p.length > 0) out.push(p);
		} catch {
			/* skip non-OS-backed file */
		}
	}
	return out;
}

function pickPathsViaDomInput(resolvePath: (file: File) => string): Promise<readonly string[]> {
	const doc = globalThis.document;
	if (!doc || typeof doc.createElement !== "function") return Promise.resolve([]);
	return new Promise<readonly string[]>((resolve) => {
		const el = doc.createElement("input");
		el.type = "file";
		el.multiple = true;
		el.hidden = true;
		let settled = false;
		const finish = (paths: readonly string[]) => {
			if (settled) return;
			settled = true;
			el.remove();
			resolve(paths);
		};
		el.addEventListener("change", () => finish(collectSelectedFilePaths(el, resolvePath)), { once: true });
		el.addEventListener("cancel", () => finish([]), { once: true });
		doc.body?.append(el);
		el.click();
	});
}

async function invokePickFiles(bridge: DesktopBridge | null): Promise<readonly string[]> {
	if (typeof bridge?.pickFiles === "function") {
		try {
			const res = await bridge.pickFiles();
			return Array.isArray(res) ? res.filter((p): p is string => typeof p === "string" && p.length > 0) : [];
		} catch {
			return [];
		}
	}
	if (typeof bridge?.getPathForFile === "function") {
		return pickPathsViaDomInput((file) => bridge.getPathForFile!(file));
	}
	return [];
}

async function invokeDismissStartupMessage(
	bridge: DesktopBridge | null,
	shell: Store<ShellModel, ShellIntent> | undefined,
	id: string,
): Promise<void> {
	try {
		await bridge?.dismissStartupMessage?.(id);
	} catch {
		/* best-effort local write */
	}
	await shell?.send({ type: "clear-startup-message" });
}

async function dispatchDesktopIntent(
	intent: DesktopIntent,
	bridge: DesktopBridge | null,
	cell: Cell<DesktopModel>,
	shell: Store<ShellModel, ShellIntent> | undefined,
	actions: {
		pickDirectory: () => Promise<string | null>;
		pickFiles: () => Promise<readonly string[]>;
		dismissStartupMessage: (id: string) => Promise<void>;
	},
): Promise<void> {
	switch (intent.type) {
		case "pick-directory":
			await actions.pickDirectory();
			return;
		case "pick-files":
			await actions.pickFiles();
			return;
		case "check-updates":
			await bridge?.checkForUpdates?.();
			return;
		case "install-update":
			bridge?.installUpdate?.();
			return;
		case "set-zoom":
			applyZoomUpdate(cell, shell, intent.zoom);
			return;
		case "dismiss-startup-message":
			await actions.dismissStartupMessage(intent.id);
			return;
		default:
			return assertNeverIntent(intent);
	}
}

export function createDesktopStore(options?: CreateDesktopStoreOptions): DesktopStore {
	const bridge = options?.bridge !== undefined ? options.bridge : readWindowBridge();
	const hasBridge = bridge !== null;
	const cell = createCell<DesktopModel>({
		electron: hasBridge,
		platform: normalizePlatform(bridge?.platform, hasBridge),
		zoom: 1,
		update: null,
	});
	let disposed = false;
	const offBridge = subscribeBridgeEvents(bridge, cell, options?.shell, () => disposed);
	const pickDirectory = () => invokePickDirectory(bridge);
	const pickFiles = () => invokePickFiles(bridge);
	const dismissStartupMessage = (id: string) => invokeDismissStartupMessage(bridge, options?.shell, id);
	const actions = { pickDirectory, pickFiles, dismissStartupMessage };

	const base = createStoreFromCell<DesktopModel, DesktopIntent>(cell, {
		onSend: (intent) => dispatchDesktopIntent(intent, bridge, cell, options?.shell, actions),
		onDispose() {
			disposed = true;
			offBridge();
		},
	});

	return { ...base, pickDirectory, pickFiles, dismissStartupMessage };
}
