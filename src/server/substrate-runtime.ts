import fs from "node:fs";
import path from "node:path";
import { GRAPH_FORMAT_FILE, PATHS, RENDER_SETTINGS_FILE, ROOT } from "../../config.ts";
import { listSourceSegments } from "../agent/prompt-segments.ts";
import { emit } from "../core/events.ts";
import type { PluginTaskRecord } from "../core/plugin-workers.ts";
import type { PromptAgent, PromptSegmentInfo } from "../core/prompt-segments.ts";
import { sanitizeRenderSettings, type GraphRenderSettings } from "../core/render-settings.ts";
import type {
	MfnActiveRuntime,
	MfnClient,
	MfnSupervisor,
} from "../memory/mfn/index.ts";
import { assertGraphFormat } from "../store/graph-format.ts";
import { importLearnHarnessData, type LearnHarnessImportReport } from "../store/import-learnharness.ts";
import {
	createLumberJackStores,
	startLumberJackStreamBridge,
	type LumberJackStoreBundle,
} from "../store/lumberjack/index.ts";
import type { ParsedMutationBatch } from "../store/lumberjack/stream-events.ts";
import type { CorePluginDataLocation } from "../store/plugin-data-paths.ts";
import { readPluginTaskRecord, recoverPluginTaskRecords } from "../store/plugin-task-records.ts";
import {
	readRenderSettings as flatReadRenderSettings,
	writeRenderSettings as flatWriteRenderSettings,
} from "../store/render-settings.ts";
import { resolveComputeBackend, sanitizeComputeEnv, type ComputeBackend } from "../substrate/hardware-guard.ts";

export type { ParsedMutationBatch } from "../store/lumberjack/stream-events.ts";
export type { LearnHarnessImportReport } from "../store/import-learnharness.ts";
export type { LumberJackStoreBundle } from "../store/lumberjack/index.ts";

export interface ActivateLumberJackOptions {
	forestDir: string;
	streamIntervalMs?: number;
	repoRoot?: string;
	mfnStateRoot?: string;
	mfnBinDir?: string;
	mfnPort?: number;
	mfnEndpoint?: string;
	mfnToken?: string;
	mfnClient?: MfnClient;
	mfnBackend?: ComputeBackend;
	mfnEmbeddersFile?: string;
	mfnAlmConfigFile?: string;
	mfnStartupTimeoutMs?: number;
	mfnShutdownTimeoutMs?: number;
	mfnEnv?: NodeJS.ProcessEnv;
	mainPoolId?: string;
	lexicalPoolId?: string;
	liveTailTokens?: number;
	autoFlushMs?: number;
	onChange?: () => void;
}

export interface ActiveLumberJackSubstrate {
	readonly bundle: LumberJackStoreBundle;
	pollStreamOnce(): ParsedMutationBatch;
	close(): Promise<void>;
}

interface StartedMfnBinding {
	runtime: MfnActiveRuntime;
	stopAutoFlush: () => void;
	supervisor?: MfnSupervisor;
}

const ACTIVE_LJ_BUNDLE_KEY = Symbol.for("peer.lumberjack.activeBundle");
const ACTIVE_LJ_SUBSTRATE_KEY = Symbol.for("peer.lumberjack.activeSubstrate");
const SAFE_TASK_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

type GlobalWithSubstrate = typeof globalThis & {
	[ACTIVE_LJ_BUNDLE_KEY]?: LumberJackStoreBundle | null;
	[ACTIVE_LJ_SUBSTRATE_KEY]?: ActiveLumberJackSubstrate | null;
};

export function getActiveLumberJackBundle(): LumberJackStoreBundle | null {
	return (globalThis as GlobalWithSubstrate)[ACTIVE_LJ_BUNDLE_KEY] ?? null;
}

function setActiveLumberJackBundle(bundle: LumberJackStoreBundle | null): void {
	(globalThis as GlobalWithSubstrate)[ACTIVE_LJ_BUNDLE_KEY] = bundle;
}

function defaultMfnBinDir(sourceEnv?: NodeJS.ProcessEnv): string {
	const persistRoot = sourceEnv?.PEER_PERSIST_ROOT?.trim() || process.env.PEER_PERSIST_ROOT?.trim() || "/usr/lib/persist/peer";
	return path.join(persistRoot, "build", "mfn", "bin");
}

async function loadMfnRuntimeModule(): Promise<typeof import("../memory/mfn/index.ts")> {
	const spec = "../memory/mfn/index.ts";
	return import(/* turbopackIgnore: true */ spec) as Promise<typeof import("../memory/mfn/index.ts")>;
}

async function resolveMfnClientAndSupervisor(
	mfnMod: typeof import("../memory/mfn/index.ts"),
	options: ActivateLumberJackOptions,
): Promise<{ client: MfnClient; supervisor?: MfnSupervisor } | null> {
	if (options.mfnClient) return { client: options.mfnClient };
	if (options.mfnEndpoint && options.mfnToken) {
		return { client: new mfnMod.MfnClient({ endpoint: options.mfnEndpoint, token: options.mfnToken }) };
	}
	if (!options.mfnStateRoot || options.mfnPort === undefined) return null;
	const backend = resolveComputeBackend(options.mfnBackend ?? "cpu");
	const env = sanitizeComputeEnv(options.mfnEnv ?? process.env, backend);
	const supervisor = new mfnMod.MfnSupervisor({
		repoRoot: options.repoRoot ?? ROOT,
		stateRoot: options.mfnStateRoot,
		binDir: options.mfnBinDir ?? defaultMfnBinDir(options.mfnEnv),
		port: options.mfnPort,
		backend,
		embeddersFile: options.mfnEmbeddersFile,
		almConfigFile: options.mfnAlmConfigFile,
		startupTimeoutMs: options.mfnStartupTimeoutMs,
		shutdownTimeoutMs: options.mfnShutdownTimeoutMs,
		env,
	});
	await supervisor.start();
	return { client: supervisor.createClient(), supervisor };
}

async function startMfnBinding(
	bundle: LumberJackStoreBundle,
	options: ActivateLumberJackOptions,
): Promise<StartedMfnBinding | null> {
	const hasMfnOpts = Boolean(
		options.mfnClient || (options.mfnEndpoint && options.mfnToken) || (options.mfnStateRoot && options.mfnPort !== undefined),
	);
	if (!hasMfnOpts) return null;
	const mfnMod = await loadMfnRuntimeModule();
	const resolved = await resolveMfnClientAndSupervisor(mfnMod, options);
	if (!resolved) return null;
	try {
		const outbox = new mfnMod.MfnIngestOutbox({ persistence: mfnMod.createLumberJackOutboxPersistence(bundle.forest) });
		const stopAutoFlush = outbox.startAutoFlush(resolved.client, options.autoFlushMs ?? 5_000);
		const runtime: MfnActiveRuntime = {
			client: resolved.client,
			outbox,
			mainPoolId: options.mainPoolId ?? "peer-main",
			lexicalPoolId: options.lexicalPoolId ?? "peer-lexical",
			...(options.liveTailTokens !== undefined ? { liveTailTokens: options.liveTailTokens } : {}),
			...(resolved.supervisor ? { supervisor: resolved.supervisor } : {}),
		};
		mfnMod.setActiveMfnRuntime(runtime);
		return { runtime, stopAutoFlush, supervisor: resolved.supervisor };
	} catch (err) {
		await resolved.supervisor?.stop();
		throw err;
	}
}

async function teardownSubstrateResources(
	bundle: LumberJackStoreBundle,
	stopBridge: () => void,
	mfn: StartedMfnBinding | null,
	onChange?: () => void,
): Promise<void> {
	mfn?.stopAutoFlush();
	if (mfn) {
		const mfnMod = await loadMfnRuntimeModule();
		if (mfnMod.getActiveMfnRuntime() === mfn.runtime) mfnMod.setActiveMfnRuntime(null);
		if (mfn.supervisor) await mfn.supervisor.stop();
	}
	stopBridge();
	if (getActiveLumberJackBundle() === bundle) setActiveLumberJackBundle(null);
	bundle.close();
	onChange?.();
}

export async function activateLumberJackSubstrate(
	options: ActivateLumberJackOptions,
): Promise<ActiveLumberJackSubstrate> {
	const holder = globalThis as GlobalWithSubstrate;
	if (holder[ACTIVE_LJ_SUBSTRATE_KEY]) {
		await holder[ACTIVE_LJ_SUBSTRATE_KEY].close();
	}
	const bundle = createLumberJackStores(options.forestDir);
	const bridge = startLumberJackStreamBridge(bundle.forest, options.streamIntervalMs);
	let mfn: StartedMfnBinding | null = null;
	try {
		mfn = await startMfnBinding(bundle, options);
	} catch (err) {
		bridge.stop();
		bundle.close();
		throw err;
	}
	setActiveLumberJackBundle(bundle);
	options.onChange?.();
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
	const active = getActiveLumberJackBundle();
	if (active) {
		const report = importLearnHarnessData(sourceDirectory, active);
		active.forest.noteStoreEmittedEvent("sources-changed");
		emit("chats-changed", {});
		emit("sources-changed", {});
		return report;
	}
	const dataDir = process.env.LH_DATA_DIR ? path.resolve(process.env.LH_DATA_DIR) : PATHS.data;
	const tempBundle = createLumberJackStores(path.join(dataDir, "forest"));
	try {
		const report = importLearnHarnessData(sourceDirectory, tempBundle);
		emit("chats-changed", {});
		emit("sources-changed", {});
		return report;
	} finally {
		tempBundle.close();
	}
}

export function readRenderSettingsFromActiveStore(): GraphRenderSettings | null {
	const bundle = getActiveLumberJackBundle();
	if (!bundle) return flatReadRenderSettings();
	const snap = bundle.forest.getNode("config/render-settings");
	if (!snap || snap.slot === undefined) return null;
	return sanitizeRenderSettings(snap.slot);
}

export function writeRenderSettingsToActiveStore(raw: unknown): GraphRenderSettings {
	const bundle = getActiveLumberJackBundle();
	if (!bundle) return flatWriteRenderSettings(raw);
	const settings = sanitizeRenderSettings(raw);
	bundle.forest.upsertNode({ path: "config/render-settings", type: "leaf", kind: "config", slot: settings });
	return settings;
}

export function readActivePluginMetadata(name: "render-settings.json" | "format.json"): unknown {
	const bundle = getActiveLumberJackBundle();
	if (bundle) {
		return name === "format.json" ? { version: 1 } : readRenderSettingsFromActiveStore();
	}
	assertGraphFormat();
	try {
		return JSON.parse(fs.readFileSync(name === "format.json" ? GRAPH_FORMAT_FILE : RENDER_SETTINGS_FILE, "utf8"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
}

export function readActivePluginTask(
	rootPluginsDirectory: string,
	pluginId: string,
	taskId?: string,
	requestId?: string,
	core?: CorePluginDataLocation,
): PluginTaskRecord | null {
	const bundle = getActiveLumberJackBundle();
	if (!bundle) return readPluginTaskRecord(rootPluginsDirectory, pluginId, taskId, requestId, core);
	if (taskId !== undefined && !SAFE_TASK_ID_RE.test(taskId)) throw new Error("Invalid plugin task id");
	if (requestId !== undefined && (typeof requestId !== "string" || !requestId.length)) {
		throw new Error("Invalid plugin task request id");
	}
	if (taskId === undefined && requestId === undefined) throw new Error("A task id or request id is required");
	const store = bundle.pluginTaskStore(pluginId);
	if (taskId !== undefined) {
		const record = store.get(taskId);
		if (record && requestId !== undefined && record.requestId !== requestId) {
			throw new Error("Plugin task/request identity mismatch");
		}
		return record;
	}
	const matching = store.list().filter((record) => record.requestId === requestId);
	if (matching.length > 1) throw new Error("Duplicate plugin task request identity");
	return matching[0] ?? null;
}

function recoverOneLumberJackPluginScope(bundle: LumberJackStoreBundle, pluginId: string): void {
	const store = bundle.pluginTaskStore(pluginId);
	const records = store.list();
	const requests = new Set<string>();
	for (const record of records) {
		if (requests.has(record.requestId)) throw new Error("Duplicate plugin task request identity");
		requests.add(record.requestId);
	}
	for (const record of records) {
		if (record.status !== "queued" && record.status !== "running") continue;
		const now = new Date().toISOString();
		store.save({
			...record,
			status: "interrupted",
			completedAt: now,
			updatedAt: now,
			error: { code: "interrupted", message: "Task interrupted by server restart; no work was replayed" },
		});
	}
}

export function recoverActivePluginTasks(
	rootPluginsDirectory: string,
	core?: CorePluginDataLocation,
): Record<string, string> {
	const bundle = getActiveLumberJackBundle();
	if (!bundle) return recoverPluginTaskRecords(rootPluginsDirectory, core);
	const errors: Record<string, string> = Object.create(null);
	for (const node of bundle.forest.listChildren("config/plugins")) {
		const pluginId = Buffer.from(node.name, "hex").toString("utf8");
		try {
			recoverOneLumberJackPluginScope(bundle, pluginId);
		} catch (error) {
			errors[pluginId] = error instanceof Error ? error.message : String(error);
		}
	}
	return { ...errors };
}

export function effectiveLumberJackPromptSegments(
	bundle: LumberJackStoreBundle,
	agent: PromptAgent,
	switches: Record<string, boolean>,
): PromptSegmentInfo[] {
	return listSourceSegments(agent).map((segment) => {
		let sourceText = "";
		try {
			sourceText = fs.readFileSync(segment.file, "utf8");
		} catch {
			sourceText = "";
		}
		const overrideText = bundle.promptOverrides.readOverride(segment.path);
		return {
			path: segment.path,
			sourceText,
			overrideText,
			enabled: switches[segment.path] === true && overrideText !== null,
			shared: segment.shared,
		};
	});
}
