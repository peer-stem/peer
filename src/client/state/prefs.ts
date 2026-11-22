/**
 * Device-local UI preferences store (`c2a-frozen-contracts §3.1`).
 * Safely reads/writes `globalThis.localStorage` inside `try/catch` for sidebar,
 * user-thinking disclosure, graph camera transform, graph folder filter, and keybindings.
 */

import {
	loadOverrides,
	saveOverrides,
	type KeymapOverrides,
} from "../../core/index.ts";
import {
	assertNeverIntent,
	createCell,
	createStoreFromCell,
	type Store,
} from "./store.ts";

export interface GraphCamera {
	readonly k: number;
	readonly x: number;
	readonly y: number;
}

export interface PrefsModel {
	readonly sidebarOpen: boolean;
	readonly userThinkingOpen: boolean;
	readonly graphCamera: GraphCamera | null;
	readonly graphFolderFilter: readonly string[];
	readonly keymapOverrides: Readonly<Record<string, string>>;
}

export type PrefsIntent =
	| { readonly type: "set-sidebar-open"; readonly open: boolean }
	| { readonly type: "set-user-thinking-open"; readonly open: boolean }
	| { readonly type: "toggle-user-thinking" }
	| { readonly type: "set-graph-camera"; readonly camera: GraphCamera | null }
	| { readonly type: "set-graph-folder-filter"; readonly folderIds: readonly string[] }
	| { readonly type: "set-keybinding"; readonly actionId: string; readonly binding: string }
	| { readonly type: "reset-keybindings" };

export interface CreatePrefsStoreOptions {
	storage?: Storage | null;
	initial?: Partial<PrefsModel>;
}

const SIDEBAR_OPEN_KEY = "lh:sidebar-open";
const USER_THINKING_OPEN_KEY = "lh:user-thinking-open";
const GRAPH_CAMERA_KEY = "lh.graph.camera.v1";
const GRAPH_FOLDER_FILTER_KEY = "lh.graph.folder-filter.v1";
const KEYMAP_STORAGE_KEY = "lh:keymap";

function getSafeStorage(override?: Storage | null): Storage | null {
	if (override !== undefined) return override;
	try {
		return globalThis.localStorage ?? null;
	} catch {
		return null;
	}
}

function readRawItem(storage: Storage | null, key: string): string | null {
	if (!storage) return null;
	try {
		return storage.getItem(key);
	} catch {
		return null;
	}
}

function writeRawItem(storage: Storage | null, key: string, value: string | null): void {
	if (!storage) return;
	try {
		if (value === null) storage.removeItem(key);
		else storage.setItem(key, value);
	} catch {
		/* storage quota or sandbox error: best-effort */
	}
}

function parseBoolPref(raw: string | null, fallback: boolean): boolean {
	if (raw === "true" || raw === "1") return true;
	if (raw === "false" || raw === "0") return false;
	return fallback;
}

function sanitizeGraphCamera(value: unknown): GraphCamera | null {
	if (!value || typeof value !== "object") return null;
	const rec = value as { k?: unknown; x?: unknown; y?: unknown };
	const valid =
		typeof rec.k === "number" &&
		Number.isFinite(rec.k) &&
		rec.k > 0 &&
		typeof rec.x === "number" &&
		Number.isFinite(rec.x) &&
		typeof rec.y === "number" &&
		Number.isFinite(rec.y);
	return valid ? { k: rec.k as number, x: rec.x as number, y: rec.y as number } : null;
}

function readStoredCamera(storage: Storage | null): GraphCamera | null {
	const raw = readRawItem(storage, GRAPH_CAMERA_KEY);
	if (!raw) return null;
	try {
		return sanitizeGraphCamera(JSON.parse(raw));
	} catch {
		return null;
	}
}

function sanitizeFolderIds(value: unknown): readonly string[] {
	if (!Array.isArray(value)) return Object.freeze([]);
	const seen = new Set<string>();
	for (const item of value) {
		if (typeof item === "string" && item.length > 0) seen.add(item);
	}
	return Object.freeze([...seen]);
}

function readStoredFolderFilter(storage: Storage | null): readonly string[] {
	const raw = readRawItem(storage, GRAPH_FOLDER_FILTER_KEY);
	if (!raw) return Object.freeze([]);
	try {
		return sanitizeFolderIds(JSON.parse(raw));
	} catch {
		return Object.freeze([]);
	}
}

function readStoredKeymap(storage: Storage | null): Readonly<Record<string, string>> {
	const fromCore = loadOverrides();
	const out: Record<string, string> = {};
	for (const [key, val] of Object.entries(fromCore)) {
		if (typeof val === "string" && val.length > 0) out[key] = val;
	}
	if (Object.keys(out).length > 0) return Object.freeze(out);
	const raw = readRawItem(storage, KEYMAP_STORAGE_KEY);
	if (!raw) return Object.freeze({});
	try {
		const parsed = JSON.parse(raw) as Record<string, unknown>;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return Object.freeze({});
		for (const [key, val] of Object.entries(parsed)) {
			if (typeof val === "string" && val.length > 0) out[key] = val;
		}
		return Object.freeze(out);
	} catch {
		return Object.freeze({});
	}
}

function persistKeymapOverrides(storage: Storage | null, next: Readonly<Record<string, string>>): void {
	const hasEntries = Object.keys(next).length > 0;
	writeRawItem(storage, KEYMAP_STORAGE_KEY, hasEntries ? JSON.stringify(next) : null);
	saveOverrides(next as KeymapOverrides);
}

function loadInitialPrefsModel(storage: Storage | null, initial?: Partial<PrefsModel>): PrefsModel {
	const graphCamera =
		initial?.graphCamera !== undefined
			? sanitizeGraphCamera(initial.graphCamera)
			: readStoredCamera(storage);
	const graphFolderFilter =
		initial?.graphFolderFilter !== undefined
			? sanitizeFolderIds(initial.graphFolderFilter)
			: readStoredFolderFilter(storage);
	const keymapOverrides = initial?.keymapOverrides
		? Object.freeze({ ...initial.keymapOverrides })
		: readStoredKeymap(storage);
	return {
		sidebarOpen: initial?.sidebarOpen ?? parseBoolPref(readRawItem(storage, SIDEBAR_OPEN_KEY), true),
		userThinkingOpen:
			initial?.userThinkingOpen ?? parseBoolPref(readRawItem(storage, USER_THINKING_OPEN_KEY), true),
		graphCamera,
		graphFolderFilter,
		keymapOverrides,
	};
}

function applyKeymapPrefIntent(
	cur: PrefsModel,
	intent: Extract<PrefsIntent, { type: "set-keybinding" | "reset-keybindings" }>,
	storage: Storage | null,
): PrefsModel {
	if (intent.type === "reset-keybindings") {
		const empty = Object.freeze({});
		persistKeymapOverrides(storage, empty);
		return { ...cur, keymapOverrides: empty };
	}
	const copy: Record<string, string> = { ...cur.keymapOverrides };
	const clean = intent.binding.trim();
	if (clean.length > 0) copy[intent.actionId] = clean;
	else delete copy[intent.actionId];
	const frozen = Object.freeze(copy);
	persistKeymapOverrides(storage, frozen);
	return { ...cur, keymapOverrides: frozen };
}

function applyPrefsIntent(cur: PrefsModel, intent: PrefsIntent, storage: Storage | null): PrefsModel {
	switch (intent.type) {
		case "set-sidebar-open":
			writeRawItem(storage, SIDEBAR_OPEN_KEY, String(intent.open));
			return cur.sidebarOpen === intent.open ? cur : { ...cur, sidebarOpen: intent.open };
		case "set-user-thinking-open":
			writeRawItem(storage, USER_THINKING_OPEN_KEY, String(intent.open));
			return cur.userThinkingOpen === intent.open ? cur : { ...cur, userThinkingOpen: intent.open };
		case "toggle-user-thinking": {
			const nextOpen = !cur.userThinkingOpen;
			writeRawItem(storage, USER_THINKING_OPEN_KEY, String(nextOpen));
			return { ...cur, userThinkingOpen: nextOpen };
		}
		case "set-graph-camera": {
			const cam = sanitizeGraphCamera(intent.camera);
			writeRawItem(storage, GRAPH_CAMERA_KEY, cam ? JSON.stringify(cam) : null);
			return { ...cur, graphCamera: cam };
		}
		case "set-graph-folder-filter": {
			const ids = sanitizeFolderIds(intent.folderIds);
			writeRawItem(storage, GRAPH_FOLDER_FILTER_KEY, ids.length > 0 ? JSON.stringify([...ids]) : null);
			return { ...cur, graphFolderFilter: ids };
		}
		case "set-keybinding":
		case "reset-keybindings":
			return applyKeymapPrefIntent(cur, intent, storage);
		default:
			return assertNeverIntent(intent);
	}
}

export function createPrefsStore(options?: CreatePrefsStoreOptions): Store<PrefsModel, PrefsIntent> {
	const storage = getSafeStorage(options?.storage);
	const cell = createCell<PrefsModel>(loadInitialPrefsModel(storage, options?.initial));
	return createStoreFromCell<PrefsModel, PrefsIntent>(cell, {
		onSend(intent) {
			cell.set(applyPrefsIntent(cell.get(), intent, storage));
		},
	});
}
