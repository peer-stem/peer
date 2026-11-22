import type {
	PluginNativeQuestionViewDraft,
	PluginSessionViewInput,
	PluginSubmissionTarget,
	QuestionData,
} from "../../../core/index.ts";

export interface ViewReaderRef<T> {
	current: (() => T) | null;
	changed?(): void;
}

export interface NativeQuestionViewState {
	question: QuestionData;
	draft: Omit<PluginNativeQuestionViewDraft, "readingThinking">;
}

export type SessionInputViewReader = ViewReaderRef<PluginSessionViewInput>;

export interface SessionViewTargets {
	text: Extract<PluginSubmissionTarget, { type: "text" }>;
	answer(question: QuestionData): Extract<PluginSubmissionTarget, { type: "answer" }> | undefined;
	thinking?: Extract<PluginSubmissionTarget, { type: "thinking" }>;
	pluginQuestion?: Extract<PluginSubmissionTarget, { type: "plugin-question-answer" }>;
	pluginProblem?: Extract<PluginSubmissionTarget, { type: "plugin-problem-submission" }>;
}
