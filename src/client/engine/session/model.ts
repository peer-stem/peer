import {
	copyImmutableData,
	needsContinuation,
	pluginQuestionCallsOf,
	pluginQuestionOccurrenceKey,
	type ChatInput,
	type LhMessage,
	type PluginProblemSnapshot,
	type PluginQuestionOccurrence,
	type PluginQuestionSnapshot,
	type PluginSubmissionContent,
	type QuestionAnswerData,
	type QuestionDraft,
} from "../../../core/index.ts";
import {
	appendSessionMessages,
	computeSessionState,
	readSessionRecord,
	readSessionStats,
	reconcileSession,
	replaceSessionMessages,
} from "./record-sync.ts";
import {
	dismissNativeProblem,
	dismissNativeQuestion,
	dismissSessionPluginQuestion,
	postSessionInputEvent,
	sendSessionInput,
	steerSessionInput,
} from "./send-steer.ts";
import {
	TURN_POLL_MS,
	TURN_WAIT_MAX_MS,
	type PluginProblemAvailability,
	type PluginProblemDraft,
	type PluginQuestionAvailability,
	type PluginQuestionDraft,
	type SessionInternals,
	type SessionModelOptions,
	type SessionRecordReadOptions,
	type SessionRecordSnapshot,
	type SessionState,
	type SessionStatsSnapshot,
	type SessionStatus,
} from "./types.ts";
import { applyWireEventToSession, consumeSessionStream, resumeSessionStream } from "./wire-events.ts";

export {
	TURN_POLL_MS,
	TURN_WAIT_MAX_MS,
	type PluginProblemAvailability,
	type PluginProblemDraft,
	type PluginQuestionAvailability,
	type PluginQuestionDraft,
	type SessionModelDeps,
	type SessionModelOptions,
	type SessionRecordReadOptions,
	type SessionRecordSnapshot,
	type SessionState,
	type SessionStatsSnapshot,
	type SessionStatus,
	type SteerQueueItem,
} from "./types.ts";
export { absorbed, pendingCallTool, sseEvents, visibleQueuedSteers } from "./sse.ts";

function retireSessionImagePreview(s: SessionInternals, owner: AbortController | null): void {
	if (!owner || s.imagePreview?.owner !== owner) return;
	const ids = s.imagePreview.ids;
	s.imagePreview = null;
	s.mutate(() => {
		s.tail = s.tail.filter((m) => !ids.has(m.id));
		for (const id of ids) s.unconfirmedAnswers.delete(id);
	});
}

type SessionStateActionKeys =
	| "getFetch" | "getReadyRef" | "setReadyRef" | "notifyChange" | "nativeHistory" | "mutate"
	| "setStatus" | "setError" | "invalidateCanonicalReads" | "releaseImagePost"
	| "retireImagePreview" | "imagePostPending";

type SessionDelegateKeys =
	| "applyWireEvent" | "consumeStream" | "resumeStream"
	| "readRecord" | "reconcile" | "postInputEvent" | "send";

function createSessionStateActions(model: SessionModel, getS: () => SessionInternals): Pick<SessionInternals, SessionStateActionKeys> {
	return {
		getFetch: () => model.fetch,
		getReadyRef: () => model.readyRef,
		setReadyRef: (ready) => { model.readyRef = ready; },
		notifyChange: () => model.onChange?.(),
		nativeHistory() {
			const s = getS();
			if (s.history?.base === s.base && s.history.tail === s.tail) return s.history.messages;
			const messages = copyImmutableData([...s.base, ...s.tail]);
			s.history = { base: s.base, tail: s.tail, messages };
			return messages;
		},
		mutate(fn) {
			const s = getS();
			fn();
			s.base = copyImmutableData(s.base);
			s.tail = copyImmutableData(s.tail);
			model.onChange?.();
		},
		setStatus(status) {
			const s = getS();
			if (status === "submitted") { s.liveFailureId = null; s.canonicalEpoch++; }
			s.statusValue = status;
			model.readyRef = status === "ready" && s.reconciliationValue === "ready";
			model.onChange?.();
		},
		setError(message) {
			const s = getS();
			s.errorValue = message === null ? null : { message };
			if (message !== null) s.automaticContinuationBlocked = true;
			model.onChange?.();
		},
		invalidateCanonicalReads() { getS().canonicalEpoch++; },
		releaseImagePost(owner) {
			const s = getS();
			if (owner && s.imagePostOwner === owner) { s.imagePostOwner = null; s.canonicalEpoch++; }
		},
		retireImagePreview: (owner) => retireSessionImagePreview(getS(), owner),
		imagePostPending(owner, pending) {
			const s = getS();
			if (!pending) { s.releaseImagePost(owner); return; }
			if (s.consumeAbort !== owner || s.latestRequest !== owner) return;
			s.imagePostOwner = owner;
			s.canonicalEpoch++;
		},
	};
}

function createSessionDelegates(model: SessionModel): Pick<SessionInternals, SessionDelegateKeys> {
	return {
		applyWireEvent: (event) => model.applyWireEvent(event),
		consumeStream: (res, ctrl, rec) => model.consumeStream(res, ctrl, rec),
		resumeStream: (refetch, rec) => model.resumeStream(refetch, rec),
		readRecord: (o) => model.readRecord(o),
		reconcile: () => model.reconcile(),
		postInputEvent: (input, sig, pend) => model.postInputEvent(input, sig, pend),
		send: (input, acc, key, set) => model.send(input, acc, key, set),
	};
}

function createSessionActions(
	model: SessionModel,
	getS: () => SessionInternals,
): Pick<SessionInternals, SessionStateActionKeys | SessionDelegateKeys> {
	return { ...createSessionStateActions(model, getS), ...createSessionDelegates(model) };
}

function createSessionInternals(model: SessionModel, opts: SessionModelOptions): SessionInternals {
	const base = copyImmutableData(opts.initialMessages);
	const initialSyncing = pluginQuestionCallsOf(base).some((c) => c.status === "answerable" || c.status === "unreadable");
	if (initialSyncing) model.readyRef = false;
	let s!: SessionInternals;
	s = {
		chatId: opts.chatId,
		pollMs: opts.pollMs ?? TURN_POLL_MS,
		waitMaxMs: opts.waitMaxMs ?? TURN_WAIT_MAX_MS,
		steerQueueValue: [],
		onReattachSettled: opts.onReattachSettled,
		base,
		tail: copyImmutableData([] as LhMessage[]),
		questionDrafts: new Map(),
		pluginQuestionDrafts: new Map(),
		pluginProblemDrafts: new Map(),
		reconciliationValue: initialSyncing ? "syncing" : "ready",
		reconciliationTask: null,
		reconciliationOwner: null,
		connectionGeneration: 0,
		reconciliationConnectionGeneration: 0,
		canonicalIssued: 0,
		canonicalAcknowledged: 0,
		canonicalEpoch: 0,
		imagePostOwner: null,
		imagePreview: null,
		unconfirmedAnswers: new Map(),
		executions: new Map(),
		streamingIds: new Set(),
		incompleteUsageIds: new Set(),
		streamingMessageId: null,
		statusValue: "ready",
		evaluationOwner: null,
		errorValue: opts.initialError === undefined ? null : { message: opts.initialError },
		automaticContinuationBlocked: opts.initialError !== undefined,
		liveFailureId: null,
		consumeAbort: null,
		latestRequest: null,
		...createSessionActions(model, () => s),
	};
	return s;
}

export class SessionModel {
	readonly chatId: string;
	fetch: typeof globalThis.fetch;
	onChange?: () => void;
	readyRef = true;
	private readonly s: SessionInternals;

	constructor(opts: SessionModelOptions) {
		this.chatId = opts.chatId;
		this.fetch = opts.fetch ?? ((...args) => globalThis.fetch(...args));
		this.onChange = opts.onChange;
		this.s = createSessionInternals(this, opts);
	}

	setReattachSettled(fn: () => void): void { this.s.onReattachSettled = fn; }
	getState(): SessionState { return computeSessionState(this.s); }
	get status(): SessionStatus { return this.s.statusValue; }
	readRecord(options?: SessionRecordReadOptions): Promise<SessionRecordSnapshot | undefined> { return readSessionRecord(this.s, options); }
	readStats(signal?: AbortSignal): Promise<SessionStatsSnapshot | undefined> { return readSessionStats(this.s, signal); }
	reconcile(): Promise<boolean> { return reconcileSession(this.s); }

	pluginProblemDraft(snapshot: PluginProblemSnapshot): PluginProblemDraft {
		let draft = this.s.pluginProblemDrafts.get(snapshot.problemId);
		if (!draft) {
			draft = { submission: { status: "empty" }, thinking: "" };
			this.s.pluginProblemDrafts.set(snapshot.problemId, draft);
		}
		return draft;
	}

	pluginQuestionDraft(snapshot: PluginQuestionSnapshot): PluginQuestionDraft {
		const key = pluginQuestionOccurrenceKey(snapshot.occurrence);
		let draft = this.s.pluginQuestionDrafts.get(key);
		if (!draft) {
			draft = { answer: { status: "empty" }, thinking: "", readingThinking: "" };
			this.s.pluginQuestionDrafts.set(key, draft);
		}
		return draft;
	}

	dismissPluginQuestion(occurrence: PluginQuestionOccurrence, questionId?: string): Promise<void> {
		return dismissSessionPluginQuestion(this.s, occurrence, questionId);
	}

	postInputEvent(input: ChatInput, signal?: AbortSignal, onPostPending?: (pending: boolean) => void): Promise<Response> {
		return postSessionInputEvent(this.s, input, signal, onPostPending);
	}

	applyWireEvent(event: Record<string, unknown>): boolean { return applyWireEventToSession(this.s, event); }
	consumeStream(res: Response, controller = this.s.consumeAbort, allowRecovery = true): Promise<void> {
		return consumeSessionStream(this.s, res, controller, allowRecovery);
	}
	resumeStream(refetchRecordFirst = true, allowRecovery = true): Promise<void> {
		return resumeSessionStream(this.s, refetchRecordFirst, allowRecovery);
	}
	send(input: ChatInput, onAccepted?: () => void, questionKey?: string, onDeliverySettled?: () => void): Promise<boolean> {
		return sendSessionInput(this.s, input, onAccepted, questionKey, onDeliverySettled);
	}
	steer(text: string, images?: PluginSubmissionContent["images"], onAccepted?: () => void, onDeliverySettled?: () => void): Promise<boolean> {
		return steerSessionInput(this.s, text, images, onAccepted, onDeliverySettled);
	}
	submitAnswer(tool: string, toolCallId: string, output: QuestionAnswerData, questionKey?: string): Promise<void> {
		void tool;
		return this.send({ type: "answer", toolCallId, answer: output }, undefined, questionKey).then(() => undefined);
	}
	dismissQuestion(toolCallId: string, answer: QuestionAnswerData, questionKey?: string): Promise<void> {
		return dismissNativeQuestion(this.s, toolCallId, answer, questionKey);
	}
	dismissProblem(problemCallId: string): Promise<void> { return dismissNativeProblem(this.s, problemCallId); }

	stop(): void {
		this.s.connectionGeneration++;
		this.s.retireImagePreview(this.s.imagePreview?.owner ?? null);
		this.s.releaseImagePost(this.s.imagePostOwner);
		this.s.invalidateCanonicalReads();
		this.s.consumeAbort?.abort();
		this.s.consumeAbort = null;
		this.s.streamingIds = new Set();
		this.s.streamingMessageId = null;
		this.s.executions = new Map();
		this.s.setStatus("ready");
	}

	questionDraft(questionKey: string): QuestionDraft | undefined { return this.s.questionDrafts.get(questionKey); }
	saveQuestionDraft(questionKey: string, draft: Partial<QuestionDraft>): void {
		this.s.questionDrafts.set(questionKey, { ...this.s.questionDrafts.get(questionKey), ...draft });
	}
	setMessages(record: LhMessage[], turnError?: string, availability?: PluginQuestionAvailability, problemAvailability?: PluginProblemAvailability): void {
		this.s.invalidateCanonicalReads();
		replaceSessionMessages(this.s, record, turnError, availability, problemAvailability);
	}
	adoptRecord(record: LhMessage[]): void {
		this.s.invalidateCanonicalReads();
		appendSessionMessages(this.s, record);
	}
	async continueIfOwed(record: readonly LhMessage[]): Promise<void> {
		if (this.readyRef && !this.s.automaticContinuationBlocked && this.getState().error === null && needsContinuation(record)) {
			await this.send({ type: "continue" });
		}
	}
	static needsContinuation = needsContinuation;
	clearError(): void { this.s.setError(null); }
}
