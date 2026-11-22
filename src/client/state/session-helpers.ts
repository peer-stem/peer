/**
 * Snapshot hydration, live plan-tree extraction, and opening-prompt handoff
 * helpers for `SessionStore` (`c2a-frozen-contracts §3.6`).
 */

import type {
	ImageSnapshot,
	LhMessage,
	LhViewMessage,
	PlanTree,
} from "../../core/index.ts";
import {
	clearOpeningPrompt,
	readOpeningPromptEntry,
	stashOpeningPrompt,
	type SessionModel,
} from "../engine/index.ts";
import { apiPath, isAbortError, type ApiClient } from "./api.ts";
import type {
	ImageSnapshotEntry,
	SessionIntent,
} from "./session.ts";
import type { SettingsIntent, SettingsModel } from "./settings.ts";
import type { Store } from "./store.ts";

export interface SessionHydrationTarget {
	readonly chatId: string;
	readonly api: ApiClient;
	readonly seenSnapshots: Set<string>;
	readonly imageControllers: Set<AbortController>;
	readonly settings?: Store<SettingsModel, SettingsIntent>;
	disposed: boolean;
	imageSnapshots: Readonly<Record<string, ImageSnapshotEntry>>;
	model: SessionModel | null;
	openingDraft: string | null;
	initialHandled: boolean;
	pendingAutoPrompt: string | null;
	deferredMountContinue: boolean;
	initialPrompt?: string;
	publish: () => void;
}

const HEX64_RE = /^[a-f0-9]{64}$/;

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
			| "dismiss-question"
			| "dismiss-problem"
			| "next-problem"
			| "retry"
			| "retry-question"
			| "continue-if-owed";
	}
>;

export async function handleDockOrRecoveryIntent(
	ctx: SessionHydrationTarget,
	intent: DockOrRecoveryIntent,
): Promise<void> {
	switch (intent.type) {
		case "answer-question":
			await ctx.model?.submitAnswer(intent.tool, intent.toolCallId, intent.answer, intent.questionKey);
			return;
		case "dismiss-question":
			await ctx.model?.dismissQuestion(intent.toolCallId, intent.answer, intent.questionKey);
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
