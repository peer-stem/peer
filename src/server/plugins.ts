import * as path from "node:path";
import { PATHS } from "../../config.ts";
import corePluginIds from "../../core-plugins.json";
import packageJson from "../../package.json";
import { createPluginAgentService } from "../agent/plugin-agents.ts";
import { createPluginWorkerService } from "../agent/plugin-workers.ts";
import { registerJobAbort, unregisterJobAbort } from "../agent/subagents/aborts.ts";
import type { AgentBuildOptions } from "../agent/teacher-agent.ts";
import { emit, subscribe } from "../core/events.ts";
import type { PluginLearningData } from "../core/plugins.ts";
import { compactionInFlight } from "./compaction.ts";
import { deliverJobResult, setPluginJobRecovery } from "./jobs.ts";
import { createPluginBackgroundTool, recoverPluginBackgroundJob } from "./plugin-background-tools.ts";
import { createPluginDocumentConverter } from "./plugin-documents.ts";
import { createPluginHost, type PluginHostDependencies } from "./plugin-host.ts";
import { createPluginInference } from "./plugin-inference.ts";
import { createPluginLearningData } from "./plugin-learning.ts";
import { createPluginTransport } from "./plugin-transport.ts";
import { registerPluginWorkerActivity } from "./plugin-worker-activity.ts";
import {
	createActivePluginAgentStore,
	createActivePluginTaskStore,
	readActivePluginMetadata,
	readActivePluginTaskRecord,
	recoverActivePluginTaskRecords,
	resolveStateRoot,
	stores,
} from "./stores.ts";
import { isTurnRunning } from "./turn-liveness.ts";

export const pluginDirectory = path.join(/* turbopackIgnore: true */ PATHS.data, "plugins");
// Explicitly staged by build-server, not discovered by Next's filesystem tracer.
const coreCodeDir = path.join(/* turbopackIgnore: true */ PATHS.root, "core-plugins");
type Host = ReturnType<typeof createPluginHost>;
interface Runtime {
	dataRoot?: string;
	host: Host;
	ready: Promise<void>;
}
interface PluginGlobal {
	__lhPlugins?: Runtime;
}

type ServiceInit = Parameters<PluginHostDependencies["createServices"]>[0];
type ServiceResult = ReturnType<PluginHostDependencies["createServices"]>;

function buildPluginServices(learning: PluginLearningData, { manifest, dataDirectory, signal }: ServiceInit): ServiceResult {
	const inference = createPluginInference({ signal, dataDirectory });
	const agents = createPluginAgentService({
		store: createActivePluginAgentStore(manifest.id, path.join(/* turbopackIgnore: true */ dataDirectory, "agents")),
		engineFor: inference.engineFor,
		onUsage: inference.onUsage,
		signal,
		onChange: () => {
			if (!signal.aborted) emit("plugin-message", { pluginId: manifest.id, topic: "agents-changed" });
		},
	});
	const workerActivity = registerPluginWorkerActivity({
		pluginId: manifest.id,
		pluginName: manifest.name,
		signal,
		cancel: (taskId) => workers.cancel(taskId),
	});
	const workers = createPluginWorkerService({
		store: createActivePluginTaskStore(manifest.id, path.join(/* turbopackIgnore: true */ dataDirectory, "tasks")),
		engineFor: inference.engineFor,
		onUsage: inference.onUsage,
		signal,
		onChange: workerActivity,
	});
	const createBackgroundTool: ServiceResult["createBackgroundTool"] = (context, definition) =>
		createPluginBackgroundTool({
			pluginId: manifest.id,
			context,
			definition,
			workers,
			signal,
			jobStore: stores.jobStore,
			deliver: deliverJobResult,
			isActive: () => !signal.aborted,
			registerAbort: registerJobAbort,
			unregisterAbort: unregisterJobAbort,
		});
	return { learning, inference: inference.inference, agents, workers, createBackgroundTool };
}

async function bootstrapPluginHost(
	host: Host,
	pluginsDir: string,
	coreData: { directory: string; ids: readonly string[] },
	installationErrors: Record<string, string>,
): Promise<void> {
	const recoveryDeps = {
		jobStore: stores.jobStore,
		deliver: deliverJobResult,
		readTask: (pluginId: string, taskId?: string, requestId?: string) =>
			readActivePluginTaskRecord(pluginsDir, pluginId, taskId, requestId, coreData),
		registerAbort: registerJobAbort,
		unregisterAbort: unregisterJobAbort,
	};
	setPluginJobRecovery((job) => recoverPluginBackgroundJob(job, recoveryDeps));
	for (const [id, error] of Object.entries(recoverActivePluginTaskRecords(pluginsDir, coreData))) {
		installationErrors[id] = `Task recovery failed: ${error}`;
	}
	await host.initialize();
}

function resolvePluginDataRoot(): string {
	const explicitData = process.env.LH_DATA_DIR?.trim();
	return explicitData ? path.resolve(explicitData) : resolveStateRoot();
}

/** Single composition per active state root. Importing this module does not load
 * plugin code or touch plugin storage; server startup (or a route) initializes it. */
function runtime(): Runtime {
	const global = globalThis as typeof globalThis & PluginGlobal;
	const dataRoot = resolvePluginDataRoot();
	if (global.__lhPlugins && (global.__lhPlugins.dataRoot === undefined || global.__lhPlugins.dataRoot === dataRoot)) {
		return global.__lhPlugins;
	}
	if (global.__lhPlugins) {
		void global.__lhPlugins.host.dispose().catch(() => {});
		delete global.__lhPlugins;
	}
	const pluginsDir = path.join(dataRoot, "plugins");
	const core = { directory: coreCodeDir, dataDirectory: path.join(dataRoot, "core-plugin-data"), ids: corePluginIds };
	const coreData = { directory: core.dataDirectory, ids: core.ids };
	const learning = createPluginLearningData({
		directory: dataRoot,
		chatStore: stores.chatStore,
		graphStore: stores.graphStore,
		isBusy: isTurnRunning,
		isCompacting: compactionInFlight,
		readMetadata: (name) => readActivePluginMetadata(name),
	});
	const installationErrors: Record<string, string> = Object.create(null);
	const host = createPluginHost({
		directory: pluginsDir,
		core,
		appVersion: packageJson.version,
		installationErrors,
		convertDocument: createPluginDocumentConverter().convert,
		createServices: (input) => buildPluginServices(learning, input),
		subscribeEvents: subscribe,
		onChange: () => emit("plugins-changed", {}),
		onNotification: (notification) => emit("plugin-message", notification),
	});
	const ready = Promise.resolve().then(() => bootstrapPluginHost(host, pluginsDir, coreData, installationErrors));
	global.__lhPlugins = { dataRoot, host, ready };
	return global.__lhPlugins;
}

export async function disposePluginsForShutdown(): Promise<void> {
	const global = globalThis as typeof globalThis & PluginGlobal;
	const active = global.__lhPlugins;
	if (!active) return;
	delete global.__lhPlugins;
	await active.host.dispose().catch(() => {});
}

export async function initializePlugins(): Promise<void> {
	await runtime().ready;
}

export async function getPluginHost(): Promise<Host> {
	const { host, ready } = runtime();
	await ready;
	return host;
}

/** Await startup once; actual factories run synchronously during per-turn Agent construction. */
export async function getPluginAgentContributions(): Promise<NonNullable<AgentBuildOptions["pluginContributions"]>> {
	return (await getPluginHost()).agentContributions;
}

/** Await startup before reading canonical truth; the returned resolver itself is synchronous. */
export async function getPluginQuestionTypeResolver(): Promise<Host["resolveQuestionType"]> {
	return (await getPluginHost()).resolveQuestionType;
}

export const pluginTransport = createPluginTransport({
	getHost: getPluginHost,
	directory: () => path.join(resolvePluginDataRoot(), "plugins"),
});
