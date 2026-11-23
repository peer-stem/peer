/**
 * Type definitions and initial state factory for `SessionStore` (`src/client/state/session.ts`).
 */

import type {
	activeProblemOf,
	ChatKind,
	ChatSettings,
	ImageSnapshot,
	JobRecord,
	JsonValue,
	pendingQuestionOf,
	PlanTree,
	PluginProblemSnapshot,
	PluginProblemSubmissionImages,
	PluginQuestionOccurrence,
	PluginQuestionSnapshot,
	PluginSubmissionImages,
	PluginSubmissionOccurrence,
	QuestionAnswerData,
	QuestionDraft,
	SessionPricing,
} from "../../core/index.ts";
import type {
	PluginProblemDraft,
	PluginQuestionDraft,
	SessionState,
	SteerQueueItem,
} from "../engine/index.ts";
import { createCell, type Cell, type LoadState } from "./store.ts";

export interface ImageSnapshotEntry {
	readonly status: "loading" | "ready" | "error";
	readonly image?: ImageSnapshot;
}

export interface AttachedImageInput {
	readonly type: "image";
	readonly mimeType: string;
	readonly data: string;
}

export interface SessionStoreModel {
	readonly load: LoadState;
	readonly error: string | null;
	readonly chatId: string;
	readonly title: string;
	readonly kind: ChatKind;
	readonly compacting: boolean;
	readonly state: SessionState | null;
	readonly turnError: string | null;
	readonly imageSnapshots: Readonly<Record<string, ImageSnapshotEntry>>;
	readonly jobs: readonly JobRecord[];
	readonly tree?: PlanTree | null;
	readonly chatSettings?: ChatSettings | null;
	readonly pricing?: SessionPricing | null;
	readonly coverage?: Readonly<Record<string, unknown>> | null;
	readonly queuedSteers?: readonly SteerQueueItem[];
	readonly pendingQuestion?: ReturnType<typeof pendingQuestionOf> | null;
	readonly pendingPluginQuestion?: PluginQuestionSnapshot | null;
	readonly activeProblem?: ReturnType<typeof activeProblemOf> | null;
	readonly activeProblemOccurrence?: PluginSubmissionOccurrence | null;
	readonly questionDraft?: QuestionDraft | null;
	readonly pluginQuestionDraft?: PluginQuestionDraft | null;
	readonly pluginProblemDraft?: PluginProblemDraft | null;
	readonly openingDraft?: string | null;
}

export type SessionIntent =
	| { readonly type: "reload" }
	| { readonly type: "send-text"; readonly text: string; readonly images?: readonly AttachedImageInput[] }
	| { readonly type: "steer"; readonly text: string; readonly images?: readonly AttachedImageInput[] }
	| { readonly type: "stop" }
	| { readonly type: "answer-question"; readonly tool: string; readonly toolCallId: string; readonly answer: QuestionAnswerData; readonly questionKey?: string }
	| { readonly type: "answer-plugin-question"; readonly questionId: string; readonly occurrence: PluginQuestionOccurrence; readonly answer: JsonValue; readonly thinking?: string; readonly readingThinking?: string; readonly images?: PluginSubmissionImages }
	| { readonly type: "dismiss-question"; readonly toolCallId: string; readonly answer: QuestionAnswerData; readonly questionKey?: string }
	| { readonly type: "dismiss-plugin-question"; readonly occurrence: PluginQuestionOccurrence; readonly questionId?: string }
	| { readonly type: "submit-plugin-problem"; readonly problemId: string; readonly occurrence: PluginSubmissionOccurrence; readonly submission: JsonValue; readonly thinking?: string; readonly images?: PluginProblemSubmissionImages }
	| { readonly type: "dismiss-problem"; readonly problemCallId: string }
	| { readonly type: "submit-thinking"; readonly problemCallId: string; readonly text: string; readonly images?: readonly AttachedImageInput[] }
	| { readonly type: "next-problem" }
	| { readonly type: "retry" }
	| { readonly type: "retry-question"; readonly messageId?: string; readonly contentIndex?: number; readonly toolCallId?: string }
	| { readonly type: "continue-if-owed" }
	| { readonly type: "save-question-draft"; readonly questionKey: string; readonly draft: Partial<QuestionDraft> }
	| { readonly type: "save-plugin-question-draft"; readonly snapshot: PluginQuestionSnapshot; readonly patch: Partial<PluginQuestionDraft> }
	| { readonly type: "save-plugin-problem-draft"; readonly snapshot: PluginProblemSnapshot; readonly patch: Partial<PluginProblemDraft> }
	| { readonly type: "rename"; readonly title: string }
	| { readonly type: "save-chat-settings"; readonly settings: ChatSettings }
	| { readonly type: "set-artifact-inverted"; readonly messageId: string; readonly inverted: boolean }
	| { readonly type: "request-extract" }
	| { readonly type: "clear-error" };

export const EMPTY_SESSION_JOBS: readonly JobRecord[] = Object.freeze([]);

export function createInitialSessionCell(chatId: string): Cell<SessionStoreModel> {
	return createCell<SessionStoreModel>({
		load: "loading",
		error: null,
		chatId,
		title: "",
		kind: "teach",
		compacting: false,
		state: null,
		turnError: null,
		imageSnapshots: {},
		jobs: EMPTY_SESSION_JOBS,
		tree: null,
		chatSettings: null,
		pricing: null,
		coverage: null,
		queuedSteers: [],
		pendingQuestion: null,
		pendingPluginQuestion: null,
		activeProblem: null,
		activeProblemOccurrence: null,
		questionDraft: null,
		pluginQuestionDraft: null,
		pluginProblemDraft: null,
		openingDraft: null,
	});
}
