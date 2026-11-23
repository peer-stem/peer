/**
 * Snapshot hydration, job status sync, artifact UI persistence, extraction,
 * live plan-tree extraction, and opening-prompt handoff helpers for `SessionStore`.
 */

import {
	pluginQuestionOccurrenceKey,
	setSteerUiInverted,
	type ChatSettings,
	type ImageSnapshot,
	type JobRecord,
	type LhMessage,
	type LhViewMessage,
	type PlanTree,
} from "../../core/index.ts";
import {
	clearOpeningPrompt,
	readOpeningPromptEntry,
	stashOpeningPrompt,
	type SessionModel,
} from "../engine/index.ts";
import { ApiError, apiPath, isAbortError, type ApiClient } from "./api.ts";
import type { ImageSnapshotEntry, SessionIntent } from "./session.ts";
import type { SettingsIntent, SettingsModel } from "./settings.ts";
import type { Store } from "./store.ts";

export interface SessionHydrationTarget {
	readonly chatId: string;
	readonly api: ApiClient;
	readonly seenSnapshots: Set<string>;
	readonly imageControllers: Set<AbortController>;
	readonly jobStatuses: Map<string, string>;
	readonly settings?: Store<SettingsModel, SettingsIntent>;
	disposed: boolean;
	title: string;
	chatSettings: ChatSettings | null;
	serverTurnError: string | null;
	imageSnapshots: Readonly<Record<string, ImageSnapshotEntry>>;
	jobs: readonly JobRecord[];
	activeJobsLoad: AbortController | null;
	inFlightJobs: Promise<void> | null;
	pendingJobsReload: boolean;
	model: SessionModel | null;
	openingDraft: string | null;
	initialHandled: boolean;
	pendingAutoPrompt: string | null;
	deferredMountContinue: boolean;
	initialPrompt?: string;
	publish: () => void;
	reloadRecord: () => Promise<void>;
}

const HEX64_RE = /^[a-f0-9]{64}$/;

function isHydrationModelBusy(model: SessionModel | null): boolean {
	return model !== null && (model.status === "submitted" || model.status === "streaming");
}

function extractSnapshotIdsFromPayload(value: unknown, out: Set<string>): void {
	if (!value || typeof value !== "object") return;
	const rec = value as Record<string, unknown>;
	if (typeof rec.snapshotId === "string" && HEX64_RE.test(rec.snapshotId)) {
		out.add(rec.snapshotId);
	}
	const img = rec.image as { snapshotId?: unknown } | null | undefined;
	if (typeof img?.snapshotId === "string" && HEX64_RE.test(img.snapshotId)) {
		out.add(img.snapshotId);
	}
	const nested = rec.result as { snapshotId?: unknown; image?: { snapshotId?: unknown } } | null | undefined;
	if (typeof nested?.snapshotId === "string" && HEX64_RE.test(nested.snapshotId)) {
		out.add(nested.snapshotId);
	}
	if (typeof nested?.image?.snapshotId === "string" && HEX64_RE.test(nested.image.snapshotId)) {
		out.add(nested.image.snapshotId);
	}
}

function collectSnapshotIds(messages: readonly LhViewMessage[]): string[] {
	const found = new Set<string>();
	for (const message of messages) {
		for (const part of message.parts) {
			extractSnapshotIdsFromPayload(part.output, found);
			extractSnapshotIdsFromPayload(part.data, found);
		}
	}
	return [...found];
}

function isValidImageSnapshot(raw: unknown): raw is ImageSnapshot {
	if (!raw || typeof raw !== "object") return false;
	const img = raw as Partial<ImageSnapshot>;
	return (
		(img.mimeType === "image/png" || img.mimeType === "image/jpeg") &&
		typeof img.data === "string" &&
		typeof img.width === "number" &&
		Number.isInteger(img.width) &&
		img.width > 0 &&
		typeof img.height === "number" &&
		Number.isInteger(img.height) &&
		img.height > 0
	);
}

async function hydrateOneSnapshot(ctx: SessionHydrationTarget, snapshotId: string): Promise<void> {
	const controller = new AbortController();
	ctx.imageControllers.add(controller);
	try {
		const path = apiPath`/api/chats/${ctx.chatId}/images/${snapshotId}`;
		const raw = await ctx.api.json<ImageSnapshot>(path, { signal: controller.signal });
		if (ctx.disposed || controller.signal.aborted) return;
		if (!isValidImageSnapshot(raw)) throw new Error("Invalid image snapshot");
		ctx.imageSnapshots = { ...ctx.imageSnapshots, [snapshotId]: { status: "ready", image: raw } };
		ctx.publish();
	} catch (err) {
		if (ctx.disposed || controller.signal.aborted || isAbortError(err)) return;
		ctx.imageSnapshots = { ...ctx.imageSnapshots, [snapshotId]: { status: "error" } };
		ctx.publish();
	} finally {
		ctx.imageControllers.delete(controller);
	}
}

export function scanAndHydrateImages(
	ctx: SessionHydrationTarget,
	messages: readonly LhViewMessage[],
): void {
	for (const snapshotId of collectSnapshotIds(messages)) {
		if (ctx.seenSnapshots.has(snapshotId)) continue;
		ctx.seenSnapshots.add(snapshotId);
		ctx.imageSnapshots = { ...ctx.imageSnapshots, [snapshotId]: { status: "loading" } };
		void hydrateOneSnapshot(ctx, snapshotId);
	}
}

async function runSingleJobsFetch(ctx: SessionHydrationTarget): Promise<void> {
	const controller = new AbortController();
	ctx.activeJobsLoad = controller;
	try {
		const data = await ctx.api.json<{ jobs?: unknown; turnInFlight?: boolean }>("/api/jobs", {
			query: { chatId: ctx.chatId },
			signal: controller.signal,
		});
		if (ctx.disposed || controller.signal.aborted) return;
		if (!data || !Array.isArray(data.jobs)) return;
		const list = Object.freeze([...(data.jobs as JobRecord[])]);
		let anySettled = false;
		for (const job of list) {
			const prev = ctx.jobStatuses.get(job.id);
			if (prev === "running" && job.status !== "running") anySettled = true;
			ctx.jobStatuses.set(job.id, job.status);
		}
		ctx.jobs = list;
		ctx.publish();
		if (anySettled && !isHydrationModelBusy(ctx.model) && data.turnInFlight !== true) {
			void ctx.reloadRecord();
		}
	} catch {
		/* optional aux endpoint or transient blip */
	} finally {
		if (ctx.activeJobsLoad === controller) ctx.activeJobsLoad = null;
	}
}

export function loadSessionJobs(ctx: SessionHydrationTarget): Promise<void> {
	if (ctx.disposed) return Promise.resolve();
	if (ctx.inFlightJobs) {
		ctx.pendingJobsReload = true;
		return ctx.inFlightJobs;
	}
	const drain = async (): Promise<void> => {
		do {
			ctx.pendingJobsReload = false;
			await runSingleJobsFetch(ctx);
		} while (!ctx.disposed && ctx.pendingJobsReload);
	};
	ctx.inFlightJobs = drain().finally(() => {
		ctx.inFlightJobs = null;
	});
	return ctx.inFlightJobs;
}

export async function handleSessionMetadataIntent(
	ctx: SessionHydrationTarget,
	intent: Extract<SessionIntent, { type: "rename" | "save-chat-settings" }>,
): Promise<void> {
	if (intent.type === "rename") {
		const trimmed = intent.title.trim();
		if (!trimmed) return;
		const res = await ctx.api.json<{ title?: string }>(apiPath`/api/chats/${ctx.chatId}`, {
			method: "PUT",
			json: { title: trimmed },
		});
		if (ctx.disposed) return;
		ctx.title = typeof res.title === "string" ? res.title : trimmed;
		ctx.publish();
		return;
	}
	const res = await ctx.api.json<{ settings?: ChatSettings }>(apiPath`/api/chats/${ctx.chatId}/settings`, {
		method: "PUT",
		json: intent.settings,
	});
	if (ctx.disposed) return;
	ctx.chatSettings = res.settings ?? intent.settings;
	ctx.publish();
}

export async function setSessionArtifactInverted(
	ctx: SessionHydrationTarget,
	messageId: string,
	inverted: boolean,
): Promise<void> {
	if (ctx.model && !isHydrationModelBusy(ctx.model)) {
		const cur = ctx.model.getState().canonicalMessages;
		const next = setSteerUiInverted(cur, messageId, inverted);
		if (next !== cur) {
			ctx.model.setMessages(next, ctx.serverTurnError ?? undefined);
		}
	}
	try {
		await ctx.api.json(apiPath`/api/chats/${ctx.chatId}/artifact-ui`, {
			method: "POST",
			json: { input: { messageId, inverted } },
		});
	} catch (err) {
		if (!ctx.disposed && !isHydrationModelBusy(ctx.model)) void ctx.reloadRecord();
		throw err;
	}
}

export async function requestSessionExtract(ctx: SessionHydrationTarget): Promise<void> {
	try {
		await ctx.api.json("/api/graph/coverage/extract", {
			method: "POST",
			json: { chatId: ctx.chatId },
		});
	} catch (err) {
		if (!(err instanceof ApiError) || err.status !== 409) throw err;
	}
	if (!ctx.disposed && !isHydrationModelBusy(ctx.model)) {
		await ctx.reloadRecord();
	}
}

function extractTreeFromMessage(msg: LhViewMessage): PlanTree | null {
	for (let p = msg.parts.length - 1; p >= 0; p--) {
		const part = msg.parts[p];
		if (!part || !part.type.startsWith("tool-plan_") || part.state !== "output-available") continue;
		const output = part.output as { tree?: PlanTree } | undefined;
		if (output?.tree && Array.isArray(output.tree.nodes)) return output.tree;
	}
	return null;
}

export function latestTreeFromMessages(messages: readonly LhViewMessage[]): PlanTree | null {
	for (let m = messages.length - 1; m >= 0; m--) {
		const msg = messages[m];
		if (!msg) continue;
		const found = extractTreeFromMessage(msg);
		if (found) return found;
	}
	return null;
}

export function hasUserOrAssistantTurn(messages: readonly LhMessage[]): boolean {
	return messages.some((m) => m.role === "user" || m.role === "assistant");
}

export function clearAcceptedOpeningPrompt(ctx: SessionHydrationTarget): void {
	clearOpeningPrompt(ctx.chatId);
	ctx.openingDraft = null;
	ctx.publish();
}

export function dispatchAutoOpeningPrompt(ctx: SessionHydrationTarget, prompt: string): void {
	if (ctx.disposed || !ctx.model) return;
	if (!stashOpeningPrompt(ctx.chatId, prompt, true)) {
		ctx.openingDraft = prompt;
		ctx.publish();
		return;
	}
	ctx.openingDraft = null;
	const onAccepted = () => clearAcceptedOpeningPrompt(ctx);
	void ctx.model.send({ type: "text", text: prompt }, onAccepted).then((accepted) => {
		if (ctx.disposed) return;
		const confirmed = ctx.model?.getState().hasConfirmedConversation ?? false;
		if (!accepted && !confirmed) {
			ctx.openingDraft = prompt;
			ctx.publish();
		}
	});
}

export function settlePendingMountWork(ctx: SessionHydrationTarget): void {
	if (ctx.disposed || !ctx.settings) return;
	const snap = ctx.settings.get();
	if (snap.load === "loading") return;
	if (ctx.pendingAutoPrompt !== null) {
		const prompt = ctx.pendingAutoPrompt;
		ctx.pendingAutoPrompt = null;
		if (snap.configured) dispatchAutoOpeningPrompt(ctx, prompt);
		else {
			ctx.openingDraft = prompt;
			ctx.publish();
		}
		return;
	}
	if (!ctx.deferredMountContinue) return;
	ctx.deferredMountContinue = false;
	if (snap.configured && ctx.model) {
		void ctx.model.continueIfOwed(ctx.model.getState().canonicalMessages);
	}
}

export function runInitialMountHandoff(
	ctx: SessionHydrationTarget,
	messages: readonly LhMessage[],
	turnInFlight: boolean,
): void {
	if (ctx.initialHandled) return;
	ctx.initialHandled = true;
	if (hasUserOrAssistantTurn(messages)) {
		clearOpeningPrompt(ctx.chatId);
		ctx.openingDraft = null;
		if (turnInFlight || !ctx.settings) return;
		const s = ctx.settings.get();
		if (s.load === "loading") ctx.deferredMountContinue = true;
		else if (s.configured && ctx.model) void ctx.model.continueIfOwed(messages);
		return;
	}
	const entry = readOpeningPromptEntry(ctx.chatId);
	const prompt = entry?.text ?? ctx.initialPrompt;
	if (!prompt || !prompt.trim()) return;
	if (entry?.attempted === true || turnInFlight) {
		ctx.openingDraft = prompt;
		return;
	}
	if (!ctx.settings) {
		dispatchAutoOpeningPrompt(ctx, prompt);
		return;
	}
	const s = ctx.settings.get();
	if (s.load === "loading") ctx.pendingAutoPrompt = prompt;
	else if (s.configured) dispatchAutoOpeningPrompt(ctx, prompt);
	else ctx.openingDraft = prompt;
}

export async function sendComposerIntent(
	ctx: SessionHydrationTarget,
	intent: Extract<SessionIntent, { type: "send-text" | "steer" | "submit-thinking" }>,
): Promise<void> {
	const imgs = intent.images?.length ? intent.images.map((i) => ({ ...i })) : undefined;
	if (intent.type === "send-text") {
		const payload = imgs
			? { type: "text" as const, text: intent.text, images: imgs }
			: { type: "text" as const, text: intent.text };
		await ctx.model?.send(payload, () => clearAcceptedOpeningPrompt(ctx));
		return;
	}
	if (intent.type === "steer") {
		await ctx.model?.steer(intent.text, imgs);
		return;
	}
	await ctx.model?.send({
		type: "thinking",
		problemCallId: intent.problemCallId,
		text: intent.text,
		...(imgs ? { images: imgs } : {}),
	});
}

async function runRetryQuestionIntent(
	ctx: SessionHydrationTarget,
	intent: Extract<SessionIntent, { type: "retry-question" }>,
): Promise<void> {
	if (intent.messageId !== undefined && intent.contentIndex !== undefined && intent.toolCallId !== undefined) {
		await ctx.model?.send({
			type: "retry-question",
			messageId: intent.messageId,
			contentIndex: intent.contentIndex,
			toolCallId: intent.toolCallId,
		});
		return;
	}
	await ctx.model?.send({ type: "retry" });
}

type DockOrRecoveryIntent = Extract<
	SessionIntent,
	{
		type:
			| "answer-question"
			| "answer-plugin-question"
			| "dismiss-question"
			| "dismiss-plugin-question"
			| "submit-plugin-problem"
			| "dismiss-problem"
			| "next-problem"
			| "retry"
			| "retry-question"
			| "continue-if-owed";
	}
>;

async function sendPluginQuestionAnswer(
	ctx: SessionHydrationTarget,
	intent: Extract<SessionIntent, { type: "answer-plugin-question" }>,
): Promise<void> {
	const payload = {
		type: "plugin-question-answer" as const,
		questionId: intent.questionId,
		occurrence: intent.occurrence,
		answer: intent.answer,
		...(intent.thinking ? { thinking: intent.thinking } : {}),
		...(intent.readingThinking ? { readingThinking: intent.readingThinking } : {}),
		...(intent.images ? { images: intent.images } : {}),
	};
	await ctx.model?.send(payload, undefined, pluginQuestionOccurrenceKey(intent.occurrence));
}

export async function handleDockOrRecoveryIntent(
	ctx: SessionHydrationTarget,
	intent: DockOrRecoveryIntent,
): Promise<void> {
	switch (intent.type) {
		case "answer-question":
			await ctx.model?.submitAnswer(intent.tool, intent.toolCallId, intent.answer, intent.questionKey);
			return;
		case "answer-plugin-question":
			return sendPluginQuestionAnswer(ctx, intent);
		case "dismiss-question":
			await ctx.model?.dismissQuestion(intent.toolCallId, intent.answer, intent.questionKey);
			return;
		case "dismiss-plugin-question":
			await ctx.model?.dismissPluginQuestion(intent.occurrence, intent.questionId);
			return;
		case "submit-plugin-problem":
			await ctx.model?.send({
				type: "plugin-problem-submission",
				problemId: intent.problemId,
				occurrence: intent.occurrence,
				submission: intent.submission,
				...(intent.thinking ? { thinking: intent.thinking } : {}),
				...(intent.images ? { images: intent.images } : {}),
			});
			return;
		case "dismiss-problem":
			await ctx.model?.dismissProblem(intent.problemCallId);
			return;
		case "next-problem":
			await ctx.model?.send({ type: "next" });
			return;
		case "retry":
			await ctx.model?.send({ type: "retry" });
			return;
		case "retry-question":
			await runRetryQuestionIntent(ctx, intent);
			return;
		case "continue-if-owed":
			if (ctx.settings && !ctx.settings.get().configured) return;
			if (ctx.model) await ctx.model.continueIfOwed(ctx.model.getState().canonicalMessages);
			return;
	}
}
