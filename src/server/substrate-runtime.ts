import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "../../config.ts";
import { emit } from "../core/events.ts";
import type { PluginTaskRecord } from "../core/plugin-workers.ts";
import { sanitizeRenderSettings, type GraphRenderSettings } from "../core/render-settings.ts";
import type { UserSettings } from "../core/settings.ts";
import { effectiveColors, isBuiltinThemeId, resolveTheme } from "../core/themes.ts";
import { writeFileAtomicSync } from "../store/atomic-write.ts";
import { importLearnHarnessData, type LearnHarnessImportReport } from "../store/import-learnharness.ts";
import {
	createLumberJackStores,
	startLumberJackStreamBridge,
	type LumberJackStoreBundle,
} from "../store/lumberjack/index.ts";
import type { ParsedMutationBatch } from "../store/lumberjack/stream-events.ts";
import {
	startMfnBinding,
	stopMfnBinding,
	type StartedMfnBinding,
	type SubstrateMfnOptions,
} from "./substrate-mfn.ts";
import {
	effectiveLumberJackPromptSegments,
	readPluginTaskFromBundle,
	recoverPluginTasksInBundle,
	type CorePluginDataLocation,
} from "./substrate-plugin-tasks.ts";

export { effectiveLumberJackPromptSegments, type CorePluginDataLocation };
export type { ParsedMutationBatch } from "../store/lumberjack/stream-events.ts";
export type { LearnHarnessImportReport } from "../store/import-learnharness.ts";
export type { LumberJackStoreBundle } from "../store/lumberjack/index.ts";

export interface ActivateLumberJackOptions extends SubstrateMfnOptions {
	forestDir: string;
	stateRoot?: string;
	legacyDataDir?: string;
	streamIntervalMs?: number;
	onChange?: () => void;
}

export interface ActiveLumberJackSubstrate {
	readonly bundle: LumberJackStoreBundle;
	pollStreamOnce(): ParsedMutationBatch;
	close(): Promise<void>;
}

interface FallbackBundleState {
	key: string;
	stateRoot: string | null;
	bundle: LumberJackStoreBundle;
}

const ACTIVE_LJ_BUNDLE_KEY = Symbol.for("peer.lumberjack.activeBundle");
const ACTIVE_LJ_STATE_ROOT_KEY = Symbol.for("peer.lumberjack.activeStateRoot");
const ACTIVE_LJ_SUBSTRATE_KEY = Symbol.for("peer.lumberjack.activeSubstrate");
const FALLBACK_LJ_STATE_KEY = Symbol.for("peer.lumberjack.fallbackState");
const SUBSTRATE_LISTENERS_KEY = Symbol.for("peer.lumberjack.listeners");

type GlobalWithSubstrate = typeof globalThis & {
	[ACTIVE_LJ_BUNDLE_KEY]?: LumberJackStoreBundle | null;
	[ACTIVE_LJ_STATE_ROOT_KEY]?: string | null;
	[ACTIVE_LJ_SUBSTRATE_KEY]?: ActiveLumberJackSubstrate | null;
	[FALLBACK_LJ_STATE_KEY]?: FallbackBundleState | null;
	[SUBSTRATE_LISTENERS_KEY]?: Set<() => void>;
};

let ephemeralTestRoot: string | null = null;
let exitHookRegistered = false;

function holderOf(): GlobalWithSubstrate {
	return globalThis as GlobalWithSubstrate;
}

function substrateListeners(): Set<() => void> {
	const holder = holderOf();
	return (holder[SUBSTRATE_LISTENERS_KEY] ??= new Set());
}

export function onSubstrateStoreChanged(listener: () => void): void {
	substrateListeners().add(listener);
}

function notifySubstrateChanged(onChange?: () => void): void {
	onChange?.();
	for (const listener of substrateListeners()) listener();
}

export function getActiveLumberJackBundle(): LumberJackStoreBundle | null {
	return holderOf()[ACTIVE_LJ_BUNDLE_KEY] ?? null;
}

export function peekOpenLumberJackBundle(): LumberJackStoreBundle | null {
	const holder = holderOf();
	return holder[ACTIVE_LJ_BUNDLE_KEY] ?? holder[FALLBACK_LJ_STATE_KEY]?.bundle ?? null;
}

function setActiveLumberJackBundle(bundle: LumberJackStoreBundle | null, stateRoot: string | null = null): void {
	const holder = holderOf();
	holder[ACTIVE_LJ_BUNDLE_KEY] = bundle;
	holder[ACTIVE_LJ_STATE_ROOT_KEY] = stateRoot;
}

export function resolveStateRoot(
	env: Record<string, string | undefined> = process.env,
	repoRoot: string = ROOT,
): string {
	const explicit = env.PEER_STATE_ROOT?.trim() || env.PEER_STATE_DIR?.trim() || env.LH_DATA_DIR?.trim();
	if (explicit) return path.resolve(explicit);
	return path.join(path.resolve(repoRoot), "data", "peer-state");
}

function ensureEphemeralTestStateRoot(repoRoot: string = ROOT): string {
	if (ephemeralTestRoot) return ephemeralTestRoot;
	const base = process.env.PEER_SCRATCH_DIR?.trim()
		? path.resolve(process.env.PEER_SCRATCH_DIR.trim())
		: path.join(path.resolve(repoRoot), ".test-scratch");
	fs.mkdirSync(base, { recursive: true, mode: 0o700 });
	ephemeralTestRoot = path.join(base, `unit-state-${process.pid}-${randomUUID().slice(0, 8)}`);
	fs.mkdirSync(ephemeralTestRoot, { recursive: true, mode: 0o700 });
	return ephemeralTestRoot;
}

export function resolveDefaultForestDir(
	env: Record<string, string | undefined> = process.env,
	repoRoot: string = ROOT,
): { forestDir: string; stateRoot: string; isEphemeralTest: boolean } {
	const explicitForest = env.PEER_FOREST_DIR?.trim();
	const hasExplicitPeerState = Boolean(env.PEER_STATE_ROOT?.trim() || env.PEER_STATE_DIR?.trim());
	const hasExplicitState = hasExplicitPeerState || Boolean(env.LH_DATA_DIR?.trim());
	if (explicitForest) {
		const forestDir = path.resolve(explicitForest);
		const stateRoot = hasExplicitPeerState ? resolveStateRoot(env, repoRoot) : path.dirname(forestDir);
		return { forestDir, stateRoot, isEphemeralTest: false };
	}
	const isTestRun = env.NODE_ENV === "test" || Boolean(env.NODE_TEST_CONTEXT);
	if (isTestRun && !hasExplicitState) {
		const stateRoot = ensureEphemeralTestStateRoot(repoRoot);
		return { forestDir: path.join(stateRoot, "lumberjack"), stateRoot, isEphemeralTest: true };
	}
	const stateRoot = resolveStateRoot(env, repoRoot);
	return { forestDir: path.join(stateRoot, "lumberjack"), stateRoot, isEphemeralTest: false };
}

function hasLegacyFlatFiles(dir: string): boolean {
	try {
		const st = fs.lstatSync(dir);
		if (st.isSymbolicLink() || !st.isDirectory()) return false;
	} catch {
		return false;
	}
	for (const rel of ["settings.json", "chats", "graph", "themes", "prompts"]) {
		if (fs.existsSync(path.join(dir, rel))) return true;
	}
	return false;
}

function isFreshEmptyForest(bundle: LumberJackStoreBundle): boolean {
	if (bundle.forest.getNode("config/migrated-lh")) return false;
	if (bundle.settingsStore.readSettings() !== null) return false;
	if (bundle.chatStore.listChats().length > 0) return false;
	if (bundle.graphStore.readNodes().length > 0) return false;
	return true;
}

function maybeAutoMigrateLegacyData(bundle: LumberJackStoreBundle, candidateDirs: readonly (string | undefined)[]): void {
	if (!isFreshEmptyForest(bundle)) return;
	for (const raw of candidateDirs) {
		const dir = raw?.trim() ? path.resolve(raw.trim()) : "";
		if (!dir || !hasLegacyFlatFiles(dir)) continue;
		try {
			importLearnHarnessData(dir, bundle);
			bundle.forest.upsertNode({
				path: "config/migrated-lh",
				type: "leaf",
				kind: "config",
				slot: { sourceDirectory: dir, migratedAt: new Date().toISOString() },
			});
		} catch {
			/* ignore partial/unreadable legacy dir during auto-migration */
		}
		return;
	}
}

export function syncBootAppearanceSidecar(
	bundle: LumberJackStoreBundle | null = getActiveLumberJackBundle() ?? holderOf()[FALLBACK_LJ_STATE_KEY]?.bundle ?? null,
	explicitStateRoot?: string | null,
): void {
	if (!bundle) return;
	const stateRoot =
		explicitStateRoot ??
		holderOf()[ACTIVE_LJ_STATE_ROOT_KEY] ??
		holderOf()[FALLBACK_LJ_STATE_KEY]?.stateRoot ??
		null;
	if (!stateRoot) return;
	try {
		const settings = bundle.settingsStore.readSettings();
		const appearance = settings?.appearance;
		const themeId = appearance?.theme;
		const custom = themeId && !isBuiltinThemeId(themeId) ? bundle.themeStore.readTheme(themeId) : null;
		const resolved = resolveTheme(themeId, custom ? [custom] : []);
		const background = effectiveColors(resolved, appearance).background;
		const autoUpdate = settings?.general?.autoUpdate !== false;
		fs.mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
		writeFileAtomicSync(
			path.join(stateRoot, "boot-appearance.json"),
			`${JSON.stringify({ mode: resolved.mode, background, autoUpdate })}\n`,
		);
	} catch {
		/* best-effort sidecar write */
	}
}

function cleanupExitState(): void {
	const fb = holderOf()[FALLBACK_LJ_STATE_KEY];
	if (fb) {
		holderOf()[FALLBACK_LJ_STATE_KEY] = null;
		try {
			fb.bundle.close();
		} catch {
			/* ignore exit close error */
		}
	}
	if (!ephemeralTestRoot) return;
	try {
		fs.rmSync(ephemeralTestRoot, { recursive: true, force: true });
	} catch {
		/* ignore exit cleanup error */
	}
	ephemeralTestRoot = null;
}

function registerFallbackExitCleanup(): void {
	if (exitHookRegistered) return;
	exitHookRegistered = true;
	process.once("exit", cleanupExitState);
}

export function ensureActiveLumberJackBundle(): LumberJackStoreBundle {
	const active = getActiveLumberJackBundle();
	if (active) return active;
	const explicitDataDir = process.env.LH_DATA_DIR?.trim();
	if (explicitDataDir) {
		const st = fs.lstatSync(path.resolve(explicitDataDir), { throwIfNoEntry: false });
		if (st?.isSymbolicLink()) fs.statSync(path.resolve(explicitDataDir));
	}
	const resolved = resolveDefaultForestDir(process.env, ROOT);
	const key = resolved.forestDir;
	const holder = holderOf();
	const existing = holder[FALLBACK_LJ_STATE_KEY];
	const dirExists = fs.existsSync(key);
	if (existing && existing.key === key && dirExists) return existing.bundle;
	if (existing) {
		const wipedWhileOpen = existing.key === key && !dirExists;
		holder[FALLBACK_LJ_STATE_KEY] = null;
		existing.bundle.close();
		if (wipedWhileOpen) fs.rmSync(key, { recursive: true, force: true });
	}
	registerFallbackExitCleanup();
	const bundle = createLumberJackStores(resolved.forestDir);
	maybeAutoMigrateLegacyData(bundle, [process.env.LH_DATA_DIR, resolved.isEphemeralTest ? undefined : resolved.stateRoot]);
	holder[FALLBACK_LJ_STATE_KEY] = {
		key,
		stateRoot: resolved.isEphemeralTest ? null : resolved.stateRoot,
		bundle,
	};
	if (!resolved.isEphemeralTest) syncBootAppearanceSidecar(bundle, resolved.stateRoot);
	if (bundle.settingsStore.readSettings() !== null) notifySubstrateChanged();
	return bundle;
}

export function closeFallbackLumberJackBundle(): void {
	const holder = holderOf();
	const fb = holder[FALLBACK_LJ_STATE_KEY];
	if (!fb) return;
	holder[FALLBACK_LJ_STATE_KEY] = null;
	fb.bundle.close();
}

export async function resetActiveLumberJackForTests(): Promise<void> {
	const holder = holderOf();
	if (holder[ACTIVE_LJ_SUBSTRATE_KEY]) {
		await holder[ACTIVE_LJ_SUBSTRATE_KEY].close();
	}
	closeFallbackLumberJackBundle();
}

async function teardownSubstrateResources(
	bundle: LumberJackStoreBundle,
	stopBridge: () => void,
	mfn: StartedMfnBinding | null,
	onChange?: () => void,
): Promise<void> {
	await stopMfnBinding(mfn);
	stopBridge();
	if (getActiveLumberJackBundle() === bundle) setActiveLumberJackBundle(null, null);
	bundle.close();
	notifySubstrateChanged(onChange);
}

export async function activateLumberJackSubstrate(
	options: ActivateLumberJackOptions,
): Promise<ActiveLumberJackSubstrate> {
	const holder = holderOf();
	if (holder[ACTIVE_LJ_SUBSTRATE_KEY]) {
		await holder[ACTIVE_LJ_SUBSTRATE_KEY].close();
	}
	closeFallbackLumberJackBundle();
	const stateRoot = options.stateRoot ?? path.dirname(path.resolve(options.forestDir));
	const bundle = createLumberJackStores(options.forestDir);
	maybeAutoMigrateLegacyData(bundle, [options.legacyDataDir, stateRoot]);
	const bridge = startLumberJackStreamBridge(bundle.forest, options.streamIntervalMs);
	let mfn: StartedMfnBinding | null = null;
	try {
		mfn = await startMfnBinding(bundle, options);
	} catch (err) {
		bridge.stop();
		bundle.close();
		throw err;
	}
	setActiveLumberJackBundle(bundle, stateRoot);
	syncBootAppearanceSidecar(bundle, stateRoot);
	notifySubstrateChanged(options.onChange);
	let closing: Promise<void> | null = null;
	const handle: ActiveLumberJackSubstrate = {
		bundle,
		pollStreamOnce: () => bridge.pollOnce(),
		close: () => {
			closing ??= teardownSubstrateResources(bundle, () => bridge.stop(), mfn, options.onChange).finally(() => {
				if (holder[ACTIVE_LJ_SUBSTRATE_KEY] === handle) holder[ACTIVE_LJ_SUBSTRATE_KEY] = null;
			});
			return closing;
		},
	};
	holder[ACTIVE_LJ_SUBSTRATE_KEY] = handle;
	return handle;
}

export function runLearnHarnessImportWithStores(sourceDirectory: string): LearnHarnessImportReport {
	const bundle = ensureActiveLumberJackBundle();
	const report = importLearnHarnessData(sourceDirectory, bundle);
	bundle.forest.noteStoreEmittedEvent("sources-changed");
	syncBootAppearanceSidecar(bundle);
	emit("chats-changed", {});
	emit("sources-changed", {});
	return report;
}

export function readRenderSettingsFromActiveStore(): GraphRenderSettings | null {
	const bundle = ensureActiveLumberJackBundle();
	const snap = bundle.forest.getNode("config/render-settings");
	if (!snap || snap.slot === undefined) return null;
	return sanitizeRenderSettings(snap.slot);
}

export function readSettingsRecordFromActiveStore(): UserSettings | null {
	return ensureActiveLumberJackBundle().settingsStore.readSettings();
}

export function writeRenderSettingsToActiveStore(raw: unknown): GraphRenderSettings {
	const bundle = ensureActiveLumberJackBundle();
	const settings = sanitizeRenderSettings(raw);
	bundle.forest.upsertNode({ path: "config/render-settings", type: "leaf", kind: "config", slot: settings });
	return settings;
}

export function readModelCatalogFromActiveStore(maxBytes: number): unknown {
	const bundle = ensureActiveLumberJackBundle();
	const snap = bundle.forest.getNode("config/model-catalog");
	if (!snap || snap.slot === undefined) return null;
	if (Buffer.byteLength(JSON.stringify(snap.slot), "utf8") > maxBytes) return null;
	return snap.slot;
}

export function writeModelCatalogToActiveStore(payload: unknown, _text: string): void {
	const bundle = ensureActiveLumberJackBundle();
	bundle.forest.upsertNode({ path: "config/model-catalog", type: "leaf", kind: "config", slot: payload });
}

export function readActivePluginMetadata(name: "render-settings.json" | "format.json"): unknown {
	ensureActiveLumberJackBundle();
	return name === "format.json" ? { version: 1 } : readRenderSettingsFromActiveStore();
}

export function readActivePluginTask(
	_rootPluginsDirectory: string,
	pluginId: string,
	taskId?: string,
	requestId?: string,
	_core?: CorePluginDataLocation,
): PluginTaskRecord | null {
	return readPluginTaskFromBundle(ensureActiveLumberJackBundle(), pluginId, taskId, requestId);
}

export function recoverActivePluginTasks(
	_rootPluginsDirectory: string,
	_core?: CorePluginDataLocation,
): Record<string, string> {
	return recoverPluginTasksInBundle(ensureActiveLumberJackBundle());
}
