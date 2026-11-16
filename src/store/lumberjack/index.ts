import type {
	GraphStore,
	JobStore,
	PluginAgentRecordStore,
	PluginTaskRecordStore,
	PromptOverrideStore,
	SettingsStore,
	SourceOrganizationStore,
	ThemeStore,
} from "../../core/ports.ts";
import type { FileAccessSettingsResult } from "../../core/file-access.ts";
import { LumberJackForest } from "./binding.ts";
import { createLumberJackChatStore, type LumberJackChatStore } from "./chat-store.ts";
import {
	createLumberJackPluginAgentStore,
	createLumberJackPluginTaskStore,
	createLumberJackPromptOverrideStore,
	createLumberJackSettingsStore,
	createLumberJackThemeStore,
} from "./config-stores.ts";
import { createLumberJackGraphStores, type LumberJackLearnerStore } from "./graph-store.ts";
import { createLumberJackJobStore } from "./job-store.ts";
import { startLumberJackStreamBridge } from "./stream-events.ts";

export interface LumberJackStoreBundle {
	forest: LumberJackForest;
	chatStore: LumberJackChatStore;
	graphStore: GraphStore;
	sourceOrganizationStore: SourceOrganizationStore;
	learnerStore: LumberJackLearnerStore;
	jobStore: JobStore;
	settingsStore: SettingsStore & { readFileAccessSettings(): FileAccessSettingsResult };
	themeStore: ThemeStore;
	promptOverrides: PromptOverrideStore;
	pluginAgentStore(pluginScope: string): PluginAgentRecordStore;
	pluginTaskStore(pluginScope: string): PluginTaskRecordStore;
	startStreamBridge(intervalMs?: number): { stop(): void };
	close(): void;
}

export function createLumberJackStores(forestDirectory: string): LumberJackStoreBundle {
	const forest = new LumberJackForest(forestDirectory);
	const chatStore = createLumberJackChatStore(forest);
	const { graphStore, sourceOrganizationStore, learnerStore } = createLumberJackGraphStores(forest);
	const jobStore = createLumberJackJobStore(forest);
	const settingsStore = createLumberJackSettingsStore(forest);
	const themeStore = createLumberJackThemeStore(forest);
	const promptOverrides = createLumberJackPromptOverrideStore(forest);
	return {
		forest,
		chatStore,
		graphStore,
		sourceOrganizationStore,
		learnerStore,
		jobStore,
		settingsStore,
		themeStore,
		promptOverrides,
		pluginAgentStore: (scope) => createLumberJackPluginAgentStore(forest, scope),
		pluginTaskStore: (scope) => createLumberJackPluginTaskStore(forest, scope),
		startStreamBridge: (ms) => startLumberJackStreamBridge(forest, ms),
		close: () => forest.close(),
	};
}

export { LumberJackForest, LJ_STATUS } from "./binding.ts";
export type { FsrsCardSchedule, FlashcardDeckRecord, LearnerProfileRecord, LumberJackLearnerStore } from "./graph-store.ts";
export { pollLumberJackMutations, startLumberJackStreamBridge } from "./stream-events.ts";
