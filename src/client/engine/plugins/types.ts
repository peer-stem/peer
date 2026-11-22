import type {
	PluginAction,
	PluginActionPlacement,
	PluginActionShortcut,
	PluginCleanup,
	PluginCodeBlockRenderer,
	PluginFrontendModule,
	PluginInfo,
	PluginNotification,
	PluginProblemRenderer,
	PluginQuestionRenderer,
	PluginSettingsRegistration,
	PluginToolRenderer,
	PluginUi,
	PluginView,
	ServerEvent,
} from "../../../core/index.ts";
import type { SubmissionInterceptorRegistration } from "./plugin-submission-runner.ts";

export type PluginMount = (container: HTMLElement, signal: AbortSignal) => ReturnType<PluginView["mount"]>;

export interface PluginRendererRegistration<T> {
	readonly pluginId: string;
	readonly renderer: T;
}

export type CodeBlockRegistration = PluginRendererRegistration<PluginCodeBlockRenderer>;
export type ToolRendererRegistration = PluginRendererRegistration<PluginToolRenderer>;
export type QuestionRendererRegistration = PluginRendererRegistration<PluginQuestionRenderer>;
export type ProblemRendererRegistration = PluginRendererRegistration<PluginProblemRenderer>;

export interface FrontendPlugin {
	info: PluginInfo;
	phase: "disabled" | "loading" | "active" | "error";
	error?: string;
	views: PluginView[];
	actions: PluginAction[];
	shortcuts?: readonly { actionId: string; shortcut: PluginActionShortcut }[];
	placements: PluginActionPlacement[];
	actionBusy: string[];
	settings?: PluginSettingsRegistration;
	busy: boolean;
}

export interface PluginSnapshot {
	plugins: FrontendPlugin[];
	readonly codeBlocks: readonly CodeBlockRegistration[];
	readonly toolRenderers: readonly ToolRendererRegistration[];
	readonly questionRenderers?: readonly QuestionRendererRegistration[];
	readonly problemRenderers?: readonly ProblemRendererRegistration[];
	directory: string;
	conflicts: readonly { id: string; error: string }[];
	loading: boolean;
	refreshing: boolean;
	error?: string;
}

export interface PluginLifecycle {
	id: string;
	revision: string;
	controller: AbortController;
	cleanups: Set<PluginCleanup>;
	activation: Promise<void>;
	tasks: Set<Promise<void>>;
	teardown?: Promise<void>;
	views: Map<string, PluginView>;
	actions: Map<string, PluginAction>;
	shortcuts: Map<string, PluginActionShortcut>;
	placements: Map<string, PluginActionPlacement>;
	actionBusy: Set<string>;
	codeBlocks: Map<string, CodeBlockRegistration>;
	toolRenderers: Map<string, ToolRendererRegistration>;
	questionRenderers: Map<string, QuestionRendererRegistration>;
	problemRenderers: Map<string, ProblemRendererRegistration>;
	submissionInterceptors: Map<string, SubmissionInterceptorRegistration>;
	settings?: PluginSettingsRegistration;
	notifications: Set<(event: PluginNotification) => void>;
	events: Set<(event: ServerEvent) => void>;
	resyncs: Set<() => void>;
	phase: "loading" | "active" | "error";
	error?: string;
}

export interface PluginHost {
	reservedCodeBlockLanguages?: readonly string[];
	reservedToolNames?: readonly string[];
	fetch: typeof fetch;
	importModule(url: string): Promise<PluginFrontendModule>;
	pathname(): string;
	navigate(path: string): void;
	openSettings?(pluginId: string): void;
	createUi?(options: { signal: AbortSignal; pluginId?: string; onError: (error: unknown) => void }): PluginUi;
	style?(url: string, onError: () => void): PluginCleanup;
}

export interface ManagerBridge {
	readonly host: PluginHost;
	readonly rendererMounts: WeakMap<object, Set<() => void>>;
	current(life: PluginLifecycle): boolean;
	publish(patch?: Partial<PluginSnapshot>): void;
	report(life: PluginLifecycle, error: unknown): void;
	addCleanup(life: PluginLifecycle, cleanup: PluginCleanup): () => void;
	json(url: string, init?: RequestInit): Promise<unknown>;
	getCodeBlock(language: string): CodeBlockRegistration | undefined;
	getToolRenderer(toolName: string): ToolRendererRegistration | undefined;
}

export function pluginViewPath(pluginId: string, viewId: string): string {
	return `/plugins/${encodeURIComponent(pluginId)}/${encodeURIComponent(viewId)}`;
}

export function pluginAssetUrl(info: PluginInfo, path: string): string {
	return `/api/plugins/${encodeURIComponent(info.id)}/assets/${encodeURIComponent(path)}?revision=${encodeURIComponent(info.revision)}`;
}

export const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));
