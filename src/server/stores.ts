/**
 * THE COMPOSITION ROOT for storage — the single place concrete store
 * adapters are wired. By default, delegates to the flat-file adapters in
 * src/store/* so isolated LH_DATA_DIR workflows remain untouched. When
 * activateLumberJackSubstrate() is active, every port transparently delegates
 * to the open LumberJackStoreBundle.
 */

import {
	effectivePromptSegments as flatEffectivePromptSegments,
	readPromptOverride as flatReadPromptOverride,
} from "../agent/prompt-segments.ts";
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
import type { UserSettings } from "../core/settings.ts";
import { resolveSettings, type EffectiveSettings } from "../core/settings-resolution.ts";
import { chatStore as flatChatStore } from "../store/chats.ts";
import { graphStore as flatGraphStore } from "../store/graph.ts";
import { jobStore as flatJobStore } from "../store/jobs.ts";
import { createPluginAgentRecordStore } from "../store/plugin-agent-records.ts";
import { createPluginTaskRecordStore } from "../store/plugin-task-records.ts";
import { promptOverrides as flatPromptOverrides } from "../store/prompt-overrides.ts";
import {
	readFileAccessSettings as flatReadFileAccessSettings,
	settingsStore as flatSettingsStore,
	writeSettings as flatWriteSettings,
} from "../store/settings.ts";
import { sourceOrganizationStore as flatSourceOrganizationStore } from "../store/source-organization.ts";
import { themeStore as flatThemeStore } from "../store/themes.ts";
import { syncCustomProvider } from "./custom-provider.ts";
import {
	activateLumberJackSubstrate as activateSubstrateInternal,
	effectiveLumberJackPromptSegments,
	getActiveLumberJackBundle,
	readActivePluginMetadata,
	readActivePluginTask as readActivePluginTaskRecord,
	readModelCatalogFromActiveStore,
	readRenderSettingsFromActiveStore,
	readSettingsRecordFromActiveStore,
	recoverActivePluginTasks as recoverActivePluginTaskRecords,
	runLearnHarnessImportWithStores,
	writeModelCatalogToActiveStore,
	writeRenderSettingsToActiveStore,
	type ActivateLumberJackOptions,
	type ActiveLumberJackSubstrate,
	type LearnHarnessImportReport,
} from "./substrate-runtime.ts";

export {
	getActiveLumberJackBundle,
	readActivePluginMetadata,
	readActivePluginTaskRecord,
	readModelCatalogFromActiveStore,
	recoverActivePluginTaskRecords,
	writeModelCatalogToActiveStore,
	type ActivateLumberJackOptions,
	type ActiveLumberJackSubstrate,
	type LearnHarnessImportReport,
};
export type { LumberJackStoreBundle } from "./substrate-runtime.ts";

const activeChat = (): ChatStore => getActiveLumberJackBundle()?.chatStore ?? flatChatStore;
const activeGraph = (): GraphStore => getActiveLumberJackBundle()?.graphStore ?? flatGraphStore;
const activeSourceOrg = (): SourceOrganizationStore =>
	getActiveLumberJackBundle()?.sourceOrganizationStore ?? flatSourceOrganizationStore;
const activeJobs = (): JobStore => getActiveLumberJackBundle()?.jobStore ?? flatJobStore;
const activeThemes = (): ThemeStore => getActiveLumberJackBundle()?.themeStore ?? flatThemeStore;
const activePrompts = (): PromptOverrideStore => getActiveLumberJackBundle()?.promptOverrides ?? flatPromptOverrides;

export function readSettingsRecord(): UserSettings | null {
	return readSettingsRecordFromActiveStore();
}

export function writeSettingsRecord(raw: unknown): UserSettings {
	const bundle = getActiveLumberJackBundle();
	if (!bundle) return flatWriteSettings(raw);
	const written = bundle.settingsStore.writeSettings(raw as UserSettings) as UserSettings | undefined;
	return written ?? bundle.settingsStore.readSettings()!;
}

export function readFileAccessSettingsFromActiveStore(): FileAccessSettingsResult {
	const bundle = getActiveLumberJackBundle();
	return bundle ? bundle.settingsStore.readFileAccessSettings() : flatReadFileAccessSettings();
}

export const settingsStore: SettingsStore = {
	readSettings: () => (getActiveLumberJackBundle()?.settingsStore ?? flatSettingsStore).readSettings(),
	writeSettings: (settings) => {
		writeSettingsRecord(settings);
	},
};

export const themeStore: ThemeStore = {
	listThemes: () => activeThemes().listThemes(),
	readTheme: (id) => activeThemes().readTheme(id),
	writeTheme: (id, theme) => activeThemes().writeTheme(id, theme),
	deleteTheme: (id) => activeThemes().deleteTheme(id),
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

const graphStore: GraphStore = {
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

const sourceOrganizationStore: SourceOrganizationStore = {
	read: () => activeSourceOrg().read(),
	write: (state) => activeSourceOrg().write(state),
};

const jobStore: JobStore = {
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

export function createActivePluginAgentStore(pluginScope: string, directory?: string): PluginAgentRecordStore {
	const dir = directory ?? pluginScope;
	let flatStore = getActiveLumberJackBundle() ? null : createPluginAgentRecordStore(dir);
	const ensureFlat = (): PluginAgentRecordStore => (flatStore ??= createPluginAgentRecordStore(dir));
	const target = (): PluginAgentRecordStore =>
		getActiveLumberJackBundle()?.pluginAgentStore(pluginScope) ?? ensureFlat();
	return {
		list: () => target().list(),
		get: (id) => target().get(id),
		save: (record) => target().save(record),
	};
}

export function createActivePluginTaskStore(pluginScope: string, directory?: string): PluginTaskRecordStore {
	const dir = directory ?? pluginScope;
	let flatStore = getActiveLumberJackBundle() ? null : createPluginTaskRecordStore(dir);
	const ensureFlat = (): PluginTaskRecordStore => (flatStore ??= createPluginTaskRecordStore(dir));
	const target = (): PluginTaskRecordStore =>
		getActiveLumberJackBundle()?.pluginTaskStore(pluginScope) ?? ensureFlat();
	return {
		list: () => target().list(),
		get: (id) => target().get(id),
		save: (record) => target().save(record),
	};
}

export function readRenderSettings(): GraphRenderSettings | null {
	return readRenderSettingsFromActiveStore();
}

export function writeRenderSettings(raw: unknown): GraphRenderSettings {
	return writeRenderSettingsToActiveStore(raw);
}

export function readPromptOverride(segmentPath: string): string | null {
	const bundle = getActiveLumberJackBundle();
	return bundle ? bundle.promptOverrides.readOverride(segmentPath) : flatReadPromptOverride(segmentPath);
}

export function effectivePromptSegments(
	agent: PromptAgent,
	switches: Record<string, boolean>,
): PromptSegmentInfo[] {
	const bundle = getActiveLumberJackBundle();
	return bundle
		? effectiveLumberJackPromptSegments(bundle, agent, switches)
		: flatEffectivePromptSegments(agent, switches);
}

export function effectiveSettings(): EffectiveSettings {
	return resolveSettings(settingsStore.readSettings());
}

function syncActiveSettingsDependents(): void {
	refreshWorkerRequestAdmission();
	syncCustomProvider();
}

export function runLearnHarnessImport(sourceDirectory: string): LearnHarnessImportReport {
	const report = runLearnHarnessImportWithStores(sourceDirectory);
	if (report.settingsImported && getActiveLumberJackBundle() !== null) {
		syncActiveSettingsDependents();
	}
	return report;
}

export function activateLumberJackSubstrate(
	options: Omit<ActivateLumberJackOptions, "onChange">,
): Promise<ActiveLumberJackSubstrate> {
	return activateSubstrateInternal({ ...options, onChange: syncActiveSettingsDependents });
}

configureWorkerRequestAdmission(() => effectiveSettings().agent.workerRequestConcurrency);
syncCustomProvider();
