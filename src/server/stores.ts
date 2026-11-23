/**
 * THE COMPOSITION ROOT for storage — every storage port delegates to the
 * active LumberJack DAG forest (`ensureActiveLumberJackBundle()`), keeping
 * `<stateRoot>/boot-appearance.json` synchronized for Electron pre-window
 * chrome & auto-update checks.
 */

import { setPromptOverrideReader } from "../agent/prompt-segments.ts";
import {
	configureWorkerRequestAdmission,
	refreshWorkerRequestAdmission,
} from "../agent/worker-request-admission.ts";
import type { FileAccessSettingsResult } from "../core/file-access.ts";
import type {
	ChatStore,
	GraphStore,
	JobStore,
	PluginAgentRecordStore,
	PluginTaskRecordStore,
	PromptOverrideStore,
	SettingsStore,
	SourceOrganizationStore,
	ThemeStore,
} from "../core/ports.ts";
import type { PromptAgent, PromptSegmentInfo } from "../core/prompt-segments.ts";
import type { GraphRenderSettings } from "../core/render-settings.ts";
import { FACTORY_SETTINGS, type UserSettings } from "../core/settings.ts";
import { resolveSettings, type EffectiveSettings } from "../core/settings-resolution.ts";
import { syncCustomProvider } from "./custom-provider.ts";
import {
	activateLumberJackSubstrate as activateSubstrateInternal,
	closeFallbackLumberJackBundle,
	effectiveLumberJackPromptSegments,
	ensureActiveLumberJackBundle,
	getActiveLumberJackBundle,
	onSubstrateStoreChanged,
	peekOpenLumberJackBundle,
	readActivePluginMetadata,
	readActivePluginTask as readActivePluginTaskRecord,
	readModelCatalogFromActiveStore,
	readRenderSettingsFromActiveStore,
	readSettingsRecordFromActiveStore,
	recoverActivePluginTasks as recoverActivePluginTaskRecords,
	resetActiveLumberJackForTests,
	resolveDefaultForestDir,
	resolveStateRoot,
	runLearnHarnessImportWithStores,
	syncBootAppearanceSidecar,
	writeModelCatalogToActiveStore,
	writeRenderSettingsToActiveStore,
	type ActivateLumberJackOptions,
	type ActiveLumberJackSubstrate,
	type CorePluginDataLocation,
	type LearnHarnessImportReport,
} from "./substrate-runtime.ts";

export {
	closeFallbackLumberJackBundle,
	ensureActiveLumberJackBundle,
	getActiveLumberJackBundle,
	peekOpenLumberJackBundle,
	readActivePluginMetadata,
	readActivePluginTaskRecord,
	readModelCatalogFromActiveStore,
	recoverActivePluginTaskRecords,
	resetActiveLumberJackForTests,
	resolveDefaultForestDir,
	resolveStateRoot,
	syncBootAppearanceSidecar,
	writeModelCatalogToActiveStore,
	type ActivateLumberJackOptions,
	type ActiveLumberJackSubstrate,
	type CorePluginDataLocation,
	type LearnHarnessImportReport,
};
export type { LumberJackStoreBundle } from "./substrate-runtime.ts";

const activeChat = (): ChatStore => ensureActiveLumberJackBundle().chatStore;
const activeGraph = (): GraphStore => ensureActiveLumberJackBundle().graphStore;
const activeSourceOrg = (): SourceOrganizationStore => ensureActiveLumberJackBundle().sourceOrganizationStore;
const activeJobs = (): JobStore => ensureActiveLumberJackBundle().jobStore;
const activeThemes = (): ThemeStore => ensureActiveLumberJackBundle().themeStore;
const activePrompts = (): PromptOverrideStore => ensureActiveLumberJackBundle().promptOverrides;

const FAIL_CLOSED_FILE_ACCESS_ERROR =
	"File-access configuration cannot be read reliably. Learner-file access is blocked. Repair File access in Settings → Agent → Tools.";

export function readSettingsRecord(): UserSettings | null {
	try {
		return readSettingsRecordFromActiveStore();
	} catch {
		return null;
	}
}

export function writeSettingsRecord(raw: unknown): UserSettings {
	const bundle = ensureActiveLumberJackBundle();
	const written = bundle.settingsStore.writeSettings(raw as UserSettings) as UserSettings | undefined;
	const resolved = written ?? bundle.settingsStore.readSettings()!;
	syncBootAppearanceSidecar(bundle);
	return resolved;
}

export const readSettings = readSettingsRecord;
export const writeSettings = writeSettingsRecord;

export function readFileAccessSettingsFromActiveStore(): FileAccessSettingsResult {
	try {
		return ensureActiveLumberJackBundle().settingsStore.readFileAccessSettings();
	} catch {
		return { ok: false, error: FAIL_CLOSED_FILE_ACCESS_ERROR };
	}
}

export const readFileAccessSettings = readFileAccessSettingsFromActiveStore;

export const settingsStore: SettingsStore = {
	readSettings: () => ensureActiveLumberJackBundle().settingsStore.readSettings(),
	writeSettings: (settings) => {
		writeSettingsRecord(settings);
	},
};

export const themeStore: ThemeStore = {
	listThemes: () => activeThemes().listThemes(),
	readTheme: (id) => activeThemes().readTheme(id),
	writeTheme: (id, theme) => {
		activeThemes().writeTheme(id, theme);
		syncBootAppearanceSidecar();
	},
	deleteTheme: (id) => {
		activeThemes().deleteTheme(id);
		syncBootAppearanceSidecar();
	},
};

export const promptOverrides: PromptOverrideStore = {
	listOverrides: () => activePrompts().listOverrides(),
	readOverride: (segmentPath) => activePrompts().readOverride(segmentPath),
	writeOverride: (segmentPath, text) => activePrompts().writeOverride(segmentPath, text),
	deleteOverride: (segmentPath) => activePrompts().deleteOverride(segmentPath),
};

export const chatStore: ChatStore = {
	createChat: (title, kind) => activeChat().createChat(title, kind),
	getChat: (id) => activeChat().getChat(id),
	listChats: () => activeChat().listChats(),
	saveMessages: (id, messages) => activeChat().saveMessages(id, messages),
	saveImageSnapshot: (id, snapshotId, image) => activeChat().saveImageSnapshot(id, snapshotId, image),
	saveTree: (id, tree) => activeChat().saveTree(id, tree),
	appendTurnUsage: (id, entry) => activeChat().appendTurnUsage(id, entry),
	appendExtractionUsage: (id, entry) => activeChat().appendExtractionUsage(id, entry),
	saveSettings: (id, settings) => activeChat().saveSettings(id, settings),
	renameChat: (id, title) => activeChat().renameChat(id, title),
	deleteChat: (id) => activeChat().deleteChat(id),
	updateSideChats: (id, update) => activeChat().updateSideChats(id, update),
};

export const graphStore: GraphStore = {
	appendNode: (node) => activeGraph().appendNode(node),
	readNodes: () => activeGraph().readNodes(),
	appendChain: (assertion) => activeGraph().appendChain(assertion),
	readChains: () => activeGraph().readChains(),
	appendCheckpoint: (checkpoint) => activeGraph().appendCheckpoint(checkpoint),
	readCheckpoints: () => activeGraph().readCheckpoints(),
	appendCoverage: (entry) => activeGraph().appendCoverage(entry),
	readCoverage: () => activeGraph().readCoverage(),
	upsertSource: (source) => activeGraph().upsertSource(source),
	readSources: () => activeGraph().readSources(),
	deleteSources: (ids) => activeGraph().deleteSources(ids),
	appendSourceUsage: (id, entry) => activeGraph().appendSourceUsage(id, entry),
	readPositions: () => activeGraph().readPositions(),
	writePositions: (positions) => activeGraph().writePositions(positions),
	rewriteLedgers: (next) => activeGraph().rewriteLedgers(next),
};

export const sourceOrganizationStore: SourceOrganizationStore = {
	read: () => activeSourceOrg().read(),
	write: (state) => activeSourceOrg().write(state),
};

export const jobStore: JobStore = {
	createJob: (init) => activeJobs().createJob(init),
	getJob: (id) => activeJobs().getJob(id),
	updateJob: (id, patch) => activeJobs().updateJob(id, patch),
	listJobs: (chatId) => activeJobs().listJobs(chatId),
	findJobByToolCallId: (chatId, toolCallId) => activeJobs().findJobByToolCallId(chatId, toolCallId),
	deleteJobsForChat: (chatId) => activeJobs().deleteJobsForChat(chatId),
};

export const stores = {
	chatStore,
	graphStore,
	sourceOrganizationStore,
	jobStore,
	settingsStore,
	themeStore,
};

export type Stores = typeof stores;

export function createActivePluginAgentStore(pluginScope: string, _directory?: string): PluginAgentRecordStore {
	const target = (): PluginAgentRecordStore => ensureActiveLumberJackBundle().pluginAgentStore(pluginScope);
	return {
		list: () => target().list(),
		get: (id) => target().get(id),
		save: (record) => target().save(record),
	};
}

export function createActivePluginTaskStore(pluginScope: string, _directory?: string): PluginTaskRecordStore {
	const target = (): PluginTaskRecordStore => ensureActiveLumberJackBundle().pluginTaskStore(pluginScope);
	return {
		list: () => target().list(),
		get: (id) => target().get(id),
		save: (record) => target().save(record),
	};
}

export const createPluginAgentRecordStore = createActivePluginAgentStore;
export const createPluginTaskRecordStore = createActivePluginTaskStore;

export function readRenderSettings(): GraphRenderSettings | null {
	return readRenderSettingsFromActiveStore();
}

export function writeRenderSettings(raw: unknown): GraphRenderSettings {
	return writeRenderSettingsToActiveStore(raw);
}

export function readPromptOverride(segmentPath: string): string | null {
	return ensureActiveLumberJackBundle().promptOverrides.readOverride(segmentPath);
}

export function effectivePromptSegments(
	agent: PromptAgent,
	switches: Record<string, boolean>,
): PromptSegmentInfo[] {
	return effectiveLumberJackPromptSegments(ensureActiveLumberJackBundle(), agent, switches);
}

export function effectiveSettings(): EffectiveSettings {
	return resolveSettings(readSettingsRecordFromActiveStore());
}

function syncActiveSettingsDependents(): void {
	refreshWorkerRequestAdmission();
	syncCustomProvider();
}

export function runLearnHarnessImport(sourceDirectory: string): LearnHarnessImportReport {
	const report = runLearnHarnessImportWithStores(sourceDirectory);
	if (report.settingsImported) {
		syncActiveSettingsDependents();
	}
	return report;
}

export function activateLumberJackSubstrate(
	options: Omit<ActivateLumberJackOptions, "onChange">,
): Promise<ActiveLumberJackSubstrate> {
	return activateSubstrateInternal(options);
}

setPromptOverrideReader((segmentPath) => ensureActiveLumberJackBundle().promptOverrides.readOverride(segmentPath));
onSubstrateStoreChanged(syncActiveSettingsDependents);
configureWorkerRequestAdmission(() =>
	peekOpenLumberJackBundle()
		? effectiveSettings().agent.workerRequestConcurrency
		: FACTORY_SETTINGS.agent.workerRequestConcurrency,
);
