import {
	activeProblemOf,
	copyImmutableData,
	failedResponseAtEnd,
	measuredContextTokens,
	pendingQuestionOf,
	pluginQuestionCallsOf,
	pluginQuestionOccurrenceKey,
	projectView,
	type LhMessage,
} from "../../../core/index.ts";
import { absorbed, STREAM_DROPPED, StreamReadError } from "./sse.ts";
import type {
	PluginProblemAvailability,
	PluginQuestionAvailability,
	SessionInternals,
	SessionRecordReadOptions,
	SessionRecordSnapshot,
	SessionState,
	SessionStatsSnapshot,
} from "./types.ts";

export async function fetchSessionView(
	s: SessionInternals,
	url: string,
	signal: AbortSignal | undefined,
	recoveringDrop: boolean,
): Promise<Response> {
	try {
		const res = await s.getFetch()(url, { signal });
		if (recoveringDrop && !res.ok) throw new Error((await res.text()) || STREAM_DROPPED);
		return res;
	} catch (err) {
		if (recoveringDrop && !signal?.aborted) throw new StreamReadError(err);
		throw err;
	}
}

export function computeSessionState(s: SessionInternals): SessionState {
	const live =
		s.statusValue === "submitted" || s.statusValue === "streaming"
			? { executions: s.executions, inFlight: true, streamingIds: s.streamingIds }
			: undefined;
	const messages = s.nativeHistory();
	const latest = failedResponseAtEnd(messages);
	const providerError =
		latest !== undefined && !s.incompleteUsageIds.has(latest.id) && (!live || latest.id === s.liveFailureId)
			? { message: latest.errorMessage ?? "An error occurred." }
			: null;
	return {
		messages: projectView(messages, live),
		nativeMessages: messages,
		canonicalMessages: s.base,
		hasConfirmedConversation: s.base.some((m) => m.role === "user" || m.role === "assistant"),
		contextTokens: measuredContextTokens(messages, s.incompleteUsageIds),
		status: s.statusValue,
		evaluating: s.statusValue === "submitted" && s.evaluationOwner !== null && s.evaluationOwner === s.consumeAbort,
		reconciliation: s.reconciliationValue,
		pluginQuestionAvailability: s.pluginQuestionAvailability,
		pluginProblemAvailability: s.pluginProblemAvailability,
		error: s.errorValue ?? providerError,
		steerQueue: s.steerQueueValue,
	};
}

function forgetResolvedDrafts(s: SessionInternals, record: readonly LhMessage[]): void {
	const pendingKey = pendingQuestionOf(record)?.key;
	for (const key of s.questionDrafts.keys()) {
		if (key !== pendingKey) s.questionDrafts.delete(key);
	}
	for (const [id, key] of s.unconfirmedAnswers) {
		if (key !== pendingKey) s.unconfirmedAnswers.delete(id);
	}
}

export function replaceSessionMessages(
	s: SessionInternals,
	record: LhMessage[],
	turnError?: string,
	availability?: PluginQuestionAvailability,
	problemAvailability?: PluginProblemAvailability,
): void {
	if (s.imagePostOwner) return;
	const copied = copyImmutableData(record);
	s.mutate(() => {
		s.base = copied;
		s.pluginQuestionAvailability = availability;
		s.pluginProblemAvailability = problemAvailability;
		const problemId = activeProblemOf(copied)?.pluginProblem?.problemId;
		for (const key of s.pluginProblemDrafts.keys()) {
			if (key !== problemId) s.pluginProblemDrafts.delete(key);
		}
		if (turnError !== undefined) {
			s.errorValue = { message: turnError };
			s.automaticContinuationBlocked = true;
		}
		forgetResolvedDrafts(s, copied);
		const pluginKeys = new Set(pluginQuestionCallsOf(copied).map((call) => pluginQuestionOccurrenceKey(call.occurrence)));
		for (const key of s.pluginQuestionDrafts.keys()) {
			if (!pluginKeys.has(key)) s.pluginQuestionDrafts.delete(key);
		}
		s.incompleteUsageIds.clear();
		s.tail = [];
		s.imagePreview = null;
		s.streamingMessageId = null;
	});
}

export function appendSessionMessages(
	s: SessionInternals,
	record: LhMessage[],
	availability?: PluginQuestionAvailability,
	updateAvailability = false,
	problemAvailability?: PluginProblemAvailability,
): boolean {
	if (s.imagePostOwner) return false;
	const copied = copyImmutableData(record);
	const recordIds = new Set(copied.map((m) => (m as { id?: string }).id));
	if (s.base.some((m) => !recordIds.has((m as { id?: string }).id))) return false;
	s.mutate(() => {
		s.base = copied;
		if (updateAvailability) {
			s.pluginQuestionAvailability = availability;
			s.pluginProblemAvailability = problemAvailability;
		}
		forgetResolvedDrafts(s, copied);
		s.tail = s.tail.filter((m) => !(typeof m.id === "string" && recordIds.has(m.id)) && !absorbed(m, copied));
	});
	return true;
}

export async function readSessionRecord(
	s: SessionInternals,
	options: SessionRecordReadOptions = {},
): Promise<SessionRecordSnapshot | undefined> {
	const ticket = ++s.canonicalIssued;
	const epoch = s.canonicalEpoch;
	const response = await fetchSessionView(s, `/api/chats/${encodeURIComponent(s.chatId)}`, options.signal, options.recoveringDrop === true);
	if (!response.ok) {
		const detail = await response.text();
		if (options.tolerateHttpFailure) return undefined;
		throw new Error(detail || "Could not sync the saved session.");
	}
	let text: string;
	try {
		text = await response.text();
	} catch (error) {
		if (options.recoveringDrop && !options.signal?.aborted) throw new StreamReadError(error);
		throw error;
	}
	const record = JSON.parse(text) as SessionRecordSnapshot;
	if (!Array.isArray(record.messages)) throw new Error("Could not sync the saved session.");
	if (epoch !== s.canonicalEpoch || ticket < s.canonicalAcknowledged || options.signal?.aborted || options.isCurrent?.() === false) {
		return undefined;
	}
	const mode = options.adoption ?? "replace";
	if (mode !== "none" && s.imagePostOwner) return undefined;
	if (mode === "replace" && !options.allowInFlight && (s.statusValue === "submitted" || s.statusValue === "streaming")) {
		return undefined;
	}
	if (mode === "append") {
		if (!appendSessionMessages(s, record.messages, record.pluginQuestionAvailability, true, record.pluginProblemAvailability)) return undefined;
		s.canonicalAcknowledged = Math.max(s.canonicalAcknowledged, ticket);
	} else if (mode === "replace") {
		s.canonicalAcknowledged = Math.max(s.canonicalAcknowledged, ticket);
		replaceSessionMessages(s, record.messages, record.turnError, record.pluginQuestionAvailability, record.pluginProblemAvailability);
	}
	return record;
}

export async function readSessionStats(
	s: SessionInternals,
	signal?: AbortSignal,
): Promise<SessionStatsSnapshot | undefined> {
	const ticket = ++s.canonicalIssued;
	const epoch = s.canonicalEpoch;
	const response = await s.getFetch()(`/api/chats/${encodeURIComponent(s.chatId)}?view=stats`, { signal });
	if (!response.ok) throw new Error("Could not refresh session stats.");
	const stats = (await response.json()) as SessionStatsSnapshot;
	if (signal?.aborted || epoch !== s.canonicalEpoch || ticket < s.canonicalAcknowledged) return undefined;
	return stats;
}

async function runReconcileTask(
	s: SessionInternals,
	isCurrent: () => boolean,
	epoch: number,
	requiredTicket: number,
): Promise<boolean> {
	try {
		const record = await s.readRecord({ allowInFlight: true, isCurrent });
		if (!isCurrent()) return false;
		if (s.canonicalEpoch !== epoch) throw new Error("Canonical read was invalidated.");
		if (!record && s.canonicalAcknowledged < requiredTicket) return false;
		s.reconciliationValue = "ready";
		s.setReadyRef(s.statusValue === "ready");
		return true;
	} catch {
		if (!isCurrent()) return false;
		if (s.canonicalEpoch === epoch && s.canonicalAcknowledged >= requiredTicket) {
			s.reconciliationValue = "ready";
			s.setReadyRef(s.statusValue === "ready");
			return true;
		}
		s.reconciliationValue = "failed";
		s.setReadyRef(false);
		return false;
	}
}

export function reconcileSession(s: SessionInternals): Promise<boolean> {
	if (
		s.reconciliationTask &&
		s.reconciliationOwner === s.consumeAbort &&
		s.reconciliationConnectionGeneration === s.connectionGeneration
	) {
		return s.reconciliationTask;
	}
	s.reconciliationValue = "syncing";
	s.setReadyRef(false);
	s.notifyChange();
	const owner = s.consumeAbort;
	const connection = s.connectionGeneration;
	const isCurrent = () => s.consumeAbort === owner && s.connectionGeneration === connection;
	const epoch = s.canonicalEpoch;
	const requiredTicket = s.canonicalIssued + 1;
	s.reconciliationOwner = owner;
	s.reconciliationConnectionGeneration = connection;
	let task!: Promise<boolean>;
	task = runReconcileTask(s, isCurrent, epoch, requiredTicket).finally(() => {
		if (s.reconciliationTask === task) s.reconciliationTask = null;
		if (isCurrent()) s.notifyChange();
	});
	s.reconciliationTask = task;
	return task;
}
