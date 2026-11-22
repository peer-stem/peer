import {
	activeProblemOccurrenceOf,
	activeProblemOf,
	newAnswerResult,
	newNextMessage,
	newProblemDismissedMarker,
	newThinkingMessage,
	newUserMessage,
	pendingPluginQuestionOf,
	pendingQuestionOf,
	pluginQuestionCallsOf,
	samePluginQuestionOccurrence,
	type ChatInput,
	type LhMessage,
	type PluginQuestionOccurrence,
	type PluginSubmissionContent,
	type QuestionAnswerData,
} from "../../../core/index.ts";
import { delay, localId, pendingCallTool } from "./sse.ts";
import type { SessionInternals } from "./types.ts";

async function turnInFlight(s: SessionInternals): Promise<boolean | null> {
	try {
		const res = await s.getFetch()(`/api/jobs?chatId=${encodeURIComponent(s.chatId)}`);
		if (!res.ok) return null;
		return ((await res.json()) as { turnInFlight?: boolean }).turnInFlight === true;
	} catch {
		return null;
	}
}

export async function postSessionInputEvent(
	s: SessionInternals,
	input: ChatInput,
	signal?: AbortSignal,
	onPostPending?: (pending: boolean) => void,
): Promise<Response> {
	const init: RequestInit = {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ chatId: s.chatId, input }),
		signal,
	};
	const post = async () => {
		onPostPending?.(true);
		try {
			return await s.getFetch()("/api/chat", init);
		} finally {
			onPostPending?.(false);
		}
	};
	let response = await post();
	if (input.type === "plugin-question-answer" || input.type === "plugin-problem-submission") return response;
	let waited = 0;
	while (response.status === 409) {
		await response.body?.cancel().catch(() => {});
		if (signal?.aborted || waited >= s.waitMaxMs) return response;
		await delay(s.pollMs, signal);
		waited += s.pollMs;
		if (signal?.aborted) return response;
		if ((await turnInFlight(s)) !== false) continue;
		response = await post();
	}
	return response;
}

function validateSendEligibility(
	s: SessionInternals,
	input: ChatInput,
	questionKey?: string,
): { ok: boolean; expectedKey?: string; pluginPending: ReturnType<typeof pendingPluginQuestionOf> } {
	const pluginPending = pendingPluginQuestionOf(s.base);
	const recovering = s.statusValue === "error";
	if (s.reconciliationValue !== "ready" || (!s.getReadyRef() && !recovering)) return { ok: false, pluginPending };
	if (!pluginPending && pluginQuestionCallsOf(s.base).some((call) => call.status === "unreadable")) return { ok: false, pluginPending };
	if (pluginPending) {
		if (s.pluginQuestionAvailability?.questionId !== pluginPending.questionId || s.pluginQuestionAvailability.status !== "available") return { ok: false, pluginPending };
		if (input.type !== "plugin-question-answer" || input.questionId !== pluginPending.questionId || !samePluginQuestionOccurrence(input.occurrence, pluginPending.occurrence)) return { ok: false, pluginPending };
	} else if (input.type === "plugin-question-answer") {
		return { ok: false, pluginPending };
	}
	if (input.type === "plugin-problem-submission") {
		const active = activeProblemOf(s.base)?.pluginProblem;
		const occurrence = activeProblemOccurrenceOf(s.base);
		if (!active || active.problemId !== input.problemId || !occurrence || !samePluginQuestionOccurrence(occurrence, input.occurrence)) return { ok: false, pluginPending };
		if (s.pluginProblemAvailability?.problemId !== active.problemId || s.pluginProblemAvailability.status !== "available") return { ok: false, pluginPending };
	}
	if (input.type === "thinking" && activeProblemOf(s.base)?.pluginProblem) return { ok: false, pluginPending };
	const subject = input.type === "answer" ? pendingQuestionOf(s.nativeHistory()) : null;
	if (input.type === "answer" && questionKey !== undefined && (subject?.key !== questionKey || subject.toolCallId !== input.toolCallId)) {
		return { ok: false, pluginPending };
	}
	const expectedKey = questionKey ?? (input.type === "answer" && subject?.toolCallId === input.toolCallId ? subject.key : undefined);
	return { ok: true, expectedKey, pluginPending };
}

function hasInputImages(input: ChatInput): boolean {
	if (input.type === "text" || input.type === "thinking") return Boolean(input.images?.length);
	if (input.type === "answer") return Object.values(input.answer.images ?? {}).some((imgs) => imgs?.length);
	if (input.type === "plugin-question-answer" || input.type === "plugin-problem-submission") {
		return Object.values(input.images ?? {}).some((imgs) => imgs?.length);
	}
	return false;
}

async function verifyRecoveringAnswer(
	s: SessionInternals,
	controller: AbortController,
	toolCallId: string,
	expectedKey: string | undefined,
	settleDelivery: () => void,
): Promise<boolean> {
	try {
		const record = await s.readRecord({ signal: controller.signal, allowInFlight: true, isCurrent: () => s.consumeAbort === controller });
		if (s.consumeAbort !== controller || !record) return false;
		if (!Array.isArray(record.messages) || typeof record.turnInFlight !== "boolean") throw new Error("An error occurred.");
		if (record.turnInFlight) {
			settleDelivery();
			await s.resumeStream(false);
			return false;
		}
		const current = pendingQuestionOf(record.messages);
		if (current?.toolCallId !== toolCallId || (expectedKey !== undefined && current.key !== expectedKey)) {
			s.setStatus("ready");
			return false;
		}
		return true;
	} catch (err) {
		if (s.consumeAbort !== controller || controller.signal.aborted) return false;
		s.setError((err as Error).message);
		s.setStatus("error");
		return false;
	}
}

function buildOptimisticMessages(s: SessionInternals, input: ChatInput, expectedKey?: string): LhMessage[] {
	const optimistic: LhMessage[] = [];
	if (input.type === "text") {
		optimistic.push({ ...newUserMessage(input.text, input.images), id: localId() });
	} else if (input.type === "thinking") {
		optimistic.push({ ...newThinkingMessage(input.problemCallId, input.text, input.images), id: localId() });
	} else if (input.type === "next") {
		optimistic.push({ ...newNextMessage(), id: localId() });
	} else if (input.type === "answer") {
		const tool = pendingCallTool(s.nativeHistory(), input.toolCallId) ?? "quiz";
		const result = { ...newAnswerResult(input.toolCallId, tool, input.answer), id: localId() };
		optimistic.push(result);
		s.unconfirmedAnswers.set(result.id, expectedKey ?? input.toolCallId);
	}
	return optimistic;
}

async function readPostRefusalMessage(res: Response, input: ChatInput): Promise<string> {
	let message = (await res.text()) || `The send failed (${res.status}).`;
	if ((input.type === "retry" || input.type === "retry-question") && res.status === 400) {
		try {
			const refusal = JSON.parse(message) as { error?: unknown } | null;
			if (typeof refusal?.error === "string" && refusal.error.length > 0) message = refusal.error;
		} catch { /* keep raw text */ }
	}
	return message;
}

async function handleSendFailure(
	s: SessionInternals,
	err: unknown,
	ctx: {
		input: ChatInput;
		controller: AbortController;
		optimistic: readonly LhMessage[];
		imageBearing: boolean;
		accepted: boolean;
		hasOnAccepted: boolean;
	},
): Promise<boolean> {
	if (ctx.imageBearing && !ctx.accepted) s.retireImagePreview(ctx.controller);
	const failedOpening = ctx.input.type === "text" && ctx.hasOnAccepted && !ctx.accepted;
	if (failedOpening) {
		const ids = new Set(ctx.optimistic.map((m) => m.id));
		s.mutate(() => { s.tail = s.tail.filter((m) => !ids.has(m.id)); });
	}
	const detachedOpening = failedOpening && s.consumeAbort === null && s.latestRequest === ctx.controller;
	if ((s.consumeAbort !== ctx.controller || ctx.controller.signal.aborted) && !detachedOpening) return ctx.accepted;
	if (ctx.input.type === "answer") {
		const ids = new Set(ctx.optimistic.map((m) => m.id));
		s.mutate(() => {
			s.tail = s.tail.filter((m) => !ids.has(m.id));
			for (const id of ids) s.unconfirmedAnswers.delete(id);
		});
	}
	s.setError((err as Error).message);
	s.setStatus("error");
	if (ctx.imageBearing && !ctx.accepted && s.latestRequest === ctx.controller) {
		const checkCurrent = () => s.latestRequest === ctx.controller && (s.consumeAbort === ctx.controller || detachedOpening);
		await s.readRecord({ allowInFlight: true, isCurrent: checkCurrent }).catch(() => {});
	}
	return ctx.accepted;
}

async function dispatchAndAttachInput(
	s: SessionInternals,
	input: ChatInput,
	controller: AbortController,
	imageBearing: boolean,
	settle: () => void,
	onAccepted: (() => void) | undefined,
	markAccepted: () => void,
): Promise<boolean> {
	const onPending = imageBearing ? (pending: boolean) => s.imagePostPending(controller, pending) : undefined;
	let res: Response;
	try {
		res = await s.postInputEvent(input, undefined, onPending);
	} finally {
		if (s.evaluationOwner === controller) s.mutate(() => { s.evaluationOwner = null; });
	}
	if (res.status === 409) { settle(); throw new Error("A turn is already running — try again in a moment."); }
	if (!res.ok) { settle(); throw new Error(await readPostRefusalMessage(res, input)); }
	markAccepted();
	if (s.latestRequest === controller) s.invalidateCanonicalReads();
	onAccepted?.();
	settle();
	await res.text().catch(() => {});
	if (s.consumeAbort === controller) await s.resumeStream(true);
	return true;
}

export async function sendSessionInput(
	s: SessionInternals,
	input: ChatInput,
	onAccepted?: () => void,
	questionKey?: string,
	onDeliverySettled?: () => void,
): Promise<boolean> {
	let deliverySettled = false;
	const settle = () => { if (!deliverySettled) { deliverySettled = true; onDeliverySettled?.(); } };
	const refused = () => { settle(); return false; };
	const recovering = s.statusValue === "error";
	const check = validateSendEligibility(s, input, questionKey);
	if (!check.ok) return refused();
	const imageBearing = hasInputImages(input);
	s.retireImagePreview(s.imagePreview?.owner ?? null);
	s.releaseImagePost(s.imagePostOwner);
	s.consumeAbort?.abort();
	const controller = new AbortController();
	s.consumeAbort = controller;
	s.latestRequest = controller;
	const needsEval = (input.type === "plugin-question-answer" && check.pluginPending?.requiresGrading)
		|| (input.type === "plugin-problem-submission" && activeProblemOf(s.base)?.pluginProblem?.requiresProcessing);
	s.evaluationOwner = needsEval ? controller : null;
	s.setError(null);
	s.setStatus("submitted");
	if (recovering && input.type === "answer" && !(await verifyRecoveringAnswer(s, controller, input.toolCallId, check.expectedKey, settle))) {
		return refused();
	}
	if (input.type !== "continue") s.automaticContinuationBlocked = false;
	const optimistic = buildOptimisticMessages(s, input, check.expectedKey);
	if (optimistic.length > 0) s.mutate(() => { s.tail = [...s.tail, ...optimistic]; });
	if (imageBearing) s.imagePreview = { owner: controller, ids: new Set(optimistic.map((m) => m.id)) };
	let accepted = false;
	try {
		return await dispatchAndAttachInput(s, input, controller, imageBearing, settle, onAccepted, () => { accepted = true; });
	} catch (err) {
		settle();
		return handleSendFailure(s, err, { input, controller, optimistic, imageBearing, accepted, hasOnAccepted: onAccepted !== undefined });
	}
}

export async function steerSessionInput(
	s: SessionInternals,
	text: string,
	images?: PluginSubmissionContent["images"],
	onAccepted?: () => void,
	onDeliverySettled?: () => void,
): Promise<boolean> {
	let deliverySettled = false;
	const settle = () => { if (!deliverySettled) { deliverySettled = true; onDeliverySettled?.(); } };
	const t = text.trim();
	if (!t && !images?.length) { settle(); return false; }
	s.invalidateCanonicalReads();
	const id = `steer_${localId()}`;
	s.steerQueueValue = [...s.steerQueueValue, { id, text: t }];
	s.notifyChange();
	const dropSteer = () => {
		s.steerQueueValue = s.steerQueueValue.filter((item) => item.id !== id);
		s.notifyChange();
	};
	try {
		const res = await s.getFetch()(`/api/chats/${s.chatId}/steer`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ input: { type: "steer", id, text: t, ...(images?.length ? { images } : {}) } }),
		});
		if (res.ok) {
			s.invalidateCanonicalReads();
			onAccepted?.();
			settle();
			await res.text().catch(() => {});
			return true;
		}
		if (res.status === 409) {
			dropSteer();
			const payload: ChatInput = { type: "text", text: t, ...(images?.length ? { images: images.map((img) => ({ ...img })) } : {}) };
			return await s.send(payload, onAccepted, undefined, settle);
		}
		dropSteer();
		settle();
		s.setError((await res.text()) || `The steer failed (${res.status}).`);
	} catch (err) {
		dropSteer();
		settle();
		s.setError((err as Error).message);
	}
	return false;
}

export async function dismissNativeQuestion(
	s: SessionInternals,
	toolCallId: string,
	answer: QuestionAnswerData,
	questionKey?: string,
): Promise<void> {
	if (!s.getReadyRef() || pluginQuestionCallsOf(s.base).some((c) => c.status === "answerable" || c.status === "unreadable")) return;
	const subject = pendingQuestionOf(s.nativeHistory());
	if (questionKey !== undefined && (subject?.key !== questionKey || subject.toolCallId !== toolCallId)) return;
	const tool = pendingCallTool(s.nativeHistory(), toolCallId) ?? "quiz";
	s.invalidateCanonicalReads();
	s.mutate(() => { s.tail = [...s.tail, { ...newAnswerResult(toolCallId, tool, answer), id: localId() }]; });
	try {
		const res = await s.getFetch()(`/api/chats/${s.chatId}/dismiss`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ input: { type: "dismiss", toolCallId, answer } }),
		});
		if (!res.ok) throw new Error(`The dismissal failed (${res.status}).`);
		s.invalidateCanonicalReads();
	} catch (err) {
		s.setError((err as Error).message);
	}
}

export async function dismissNativeProblem(s: SessionInternals, problemCallId: string): Promise<void> {
	if (!s.getReadyRef()) return;
	s.invalidateCanonicalReads();
	s.mutate(() => { s.tail = [...s.tail, { ...newProblemDismissedMarker(problemCallId), id: localId() }]; });
	try {
		const res = await s.getFetch()(`/api/chats/${s.chatId}/dismiss`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ input: { type: "dismiss-problem", problemCallId } }),
		});
		if (!res.ok) throw new Error(`The dismissal failed (${res.status}).`);
		s.invalidateCanonicalReads();
	} catch (err) {
		s.setError((err as Error).message);
	}
}

export async function dismissSessionPluginQuestion(
	s: SessionInternals,
	occurrence: PluginQuestionOccurrence,
	questionId?: string,
): Promise<void> {
	if (!s.getReadyRef()) return;
	const current = pluginQuestionCallsOf(s.base).find(
		(call) => (call.status === "answerable" || call.status === "unreadable") && samePluginQuestionOccurrence(call.occurrence, occurrence),
	);
	if (!current) return;
	const expectedId = current.annotation.status === "unreadable"
		? current.annotation.binding?.questionId ?? current.annotation.identity?.questionId
		: undefined;
	const mismatched = current.snapshot
		? current.snapshot.questionId !== questionId
		: current.annotation.status !== "unreadable" || (questionId !== undefined && expectedId !== questionId);
	if (mismatched) return;
	s.setStatus("submitted");
	try {
		const res = await s.getFetch()(`/api/chats/${encodeURIComponent(s.chatId)}/dismiss`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ input: { type: "dismiss-plugin-question", occurrence, ...(questionId ? { questionId } : {}) } }),
		});
		if (!res.ok) throw new Error("The dismissal failed.");
		await res.text();
		s.invalidateCanonicalReads();
		await s.reconcile();
	} catch (error) {
		s.setError((error as Error).message);
	} finally {
		s.setStatus("ready");
	}
}
