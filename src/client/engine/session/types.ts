import type {
	ChatInput,
	LhMessage,
	LhViewMessage,
	LiveExecution,
	PluginProblemSubmissionState,
	PluginQuestionAnswerState,
	QuestionDraft,
	SessionPricing,
	TurnUsage,
} from "../../../core/index.ts";

export interface PluginProblemAvailability {
	problemId: string;
	status: "available" | "unavailable";
}

export interface PluginProblemDraft {
	submission: PluginProblemSubmissionState;
	thinking: string;
}

export interface PluginQuestionAvailability {
	questionId: string;
	status: "available" | "unavailable";
}

export interface SessionRecordSnapshot {
	pluginProblemAvailability?: PluginProblemAvailability;
	messages: LhMessage[];
	turnError?: string;
	pluginQuestionAvailability?: PluginQuestionAvailability;
	turnInFlight?: boolean;
	turns?: TurnUsage[];
	pricing?: SessionPricing;
}

export type SessionStatsSnapshot = Pick<SessionRecordSnapshot, "turns" | "pricing">;

export interface SessionRecordReadOptions {
	adoption?: "replace" | "append" | "none";
	signal?: AbortSignal;
	isCurrent?: () => boolean;
	allowInFlight?: boolean;
	recoveringDrop?: boolean;
	tolerateHttpFailure?: boolean;
}

export interface PluginQuestionDraft {
	answer: PluginQuestionAnswerState;
	thinking: string;
	readingThinking: string;
}

export type SessionStatus = "ready" | "submitted" | "streaming" | "error";

export const TURN_POLL_MS = 500;
export const TURN_WAIT_MAX_MS = 30_000;

export interface SessionModelDeps {
	fetch?: typeof globalThis.fetch;
	pollMs?: number;
	waitMaxMs?: number;
}

export interface SteerQueueItem {
	id: string;
	text: string;
}

export interface SessionState {
	pluginProblemAvailability?: PluginProblemAvailability;
	messages: LhViewMessage[];
	nativeMessages: LhMessage[];
	canonicalMessages: LhMessage[];
	hasConfirmedConversation: boolean;
	contextTokens: number | null;
	status: SessionStatus;
	evaluating: boolean;
	reconciliation: "ready" | "syncing" | "failed";
	pluginQuestionAvailability?: PluginQuestionAvailability;
	error: { message: string } | null;
	steerQueue: SteerQueueItem[];
}

export interface SessionModelOptions extends SessionModelDeps {
	chatId: string;
	initialMessages: LhMessage[];
	initialError?: string;
	onChange?: () => void;
	onReattachSettled?: () => void;
}

export interface SessionInternals {
	readonly chatId: string;
	readonly pollMs: number;
	readonly waitMaxMs: number;
	steerQueueValue: SteerQueueItem[];
	onReattachSettled?: () => void;
	base: LhMessage[];
	tail: LhMessage[];
	questionDrafts: Map<string, QuestionDraft>;
	pluginQuestionDrafts: Map<string, PluginQuestionDraft>;
	pluginProblemDrafts: Map<string, PluginProblemDraft>;
	pluginProblemAvailability?: PluginProblemAvailability;
	reconciliationValue: SessionState["reconciliation"];
	pluginQuestionAvailability?: PluginQuestionAvailability;
	reconciliationTask: Promise<boolean> | null;
	reconciliationOwner: AbortController | null;
	connectionGeneration: number;
	reconciliationConnectionGeneration: number;
	canonicalIssued: number;
	canonicalAcknowledged: number;
	canonicalEpoch: number;
	imagePostOwner: AbortController | null;
	imagePreview: { owner: AbortController; ids: ReadonlySet<string> } | null;
	unconfirmedAnswers: Map<string, string>;
	executions: Map<string, LiveExecution>;
	streamingIds: Set<string>;
	incompleteUsageIds: Set<string>;
	streamingMessageId: string | null;
	statusValue: SessionStatus;
	evaluationOwner: AbortController | null;
	errorValue: { message: string } | null;
	automaticContinuationBlocked: boolean;
	liveFailureId: string | null;
	consumeAbort: AbortController | null;
	latestRequest: AbortController | null;
	history?: { base: LhMessage[]; tail: LhMessage[]; messages: LhMessage[] };
	getFetch(): typeof globalThis.fetch;
	getReadyRef(): boolean;
	setReadyRef(ready: boolean): void;
	notifyChange(): void;
	nativeHistory(): LhMessage[];
	mutate(fn: () => void): void;
	setStatus(status: SessionStatus): void;
	setError(message: string | null): void;
	invalidateCanonicalReads(): void;
	releaseImagePost(owner: AbortController | null): void;
	retireImagePreview(owner: AbortController | null): void;
	imagePostPending(owner: AbortController, pending: boolean): void;
	applyWireEvent(event: Record<string, unknown>): boolean;
	consumeStream(res: Response, controller?: AbortController | null, allowRecovery?: boolean): Promise<void>;
	resumeStream(refetchRecordFirst?: boolean, allowRecovery?: boolean): Promise<void>;
	readRecord(options?: SessionRecordReadOptions): Promise<SessionRecordSnapshot | undefined>;
	reconcile(): Promise<boolean>;
	postInputEvent(input: ChatInput, signal?: AbortSignal, onPostPending?: (pending: boolean) => void): Promise<Response>;
	send(input: ChatInput, onAccepted?: () => void, questionKey?: string, onDeliverySettled?: () => void): Promise<boolean>;
}
