import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import { citationsToReadableText } from "../../core/citations.ts";
import { compactionCutIndex, planTreeToText } from "../../core/compaction.ts";
import type { PlanTree } from "../../core/contracts/plan.ts";
import {
	sendToUserText,
	type LhMarkerMessage,
	type LhMessage,
} from "../../core/native-messages.ts";
import { QUESTION_TOOLS } from "../../core/pending.ts";
import { MfnApiError, type MfnClient } from "./client.ts";
import { isValidCallerMemoryId, messageMemoryId, mintUuidV7 } from "./ids.ts";
import { isRetryableMfnError, type MfnIngestOutbox } from "./outbox.ts";
import type {
	LexicalSearchMatch,
	RecalledAnticipations,
	RecalledMemory,
	RecalledTheme,
	TurnIngestDelivered,
	TurnIngestMemory,
	TurnIngestPayload,
	TurnRecallLimits,
	TurnRecallPayload,
} from "./types.ts";

export const LIVE_TAIL_DEFAULT_TOKENS = 5_000;

const TOOL_TEXT_CAP = 2_000;
const CONTROL_RE = /[\x00-\x1f\x7f]/g;

export interface PrepareTurnContextOptions {
	client: MfnClient;
	chatId: string;
	messages: readonly LhMessage[];
	tree?: PlanTree;
	mainPoolId: string;
	lexicalPoolId: string;
	liveTailTokens?: number;
	actorKey?: string | null;
	limits?: TurnRecallLimits;
	weights?: { tags?: Record<string, number> };
}

export interface PreparedTurnContext {
	agentMessages: LhMessage[];
	liveTail: LhMessage[];
	cutIndex: number;
	marker: LhMarkerMessage | null;
	recalledMemories: RecalledMemory[];
	lexicalSupplements: LexicalSearchMatch[];
	themes: RecalledTheme[];
	anticipations: RecalledAnticipations;
	degraded: string[];
}

export interface IngestSettledTurnOptions {
	client: MfnClient;
	outbox: MfnIngestOutbox;
	chatId: string;
	turnMessages: readonly LhMessage[];
	mainPoolId: string;
	lexicalPoolId: string;
	recalledMemories?: readonly RecalledMemory[];
	predecessorMemoryId?: string | null;
	occurredAtMs?: number;
	sessionTags?: readonly string[];
}

export interface IngestSettledTurnResult {
	ingestedBatches: number;
	queuedBatches: number;
	lexicalWrites: number;
	flushedFromOutbox: number;
	memoryIds: string[];
}

function utf8Slice(text: string, maxBytes: number): string {
	if (Buffer.byteLength(text, "utf8") <= maxBytes) {
		return text;
	}
	let used = 0;
	let out = "";
	for (const ch of text) {
		const len = Buffer.byteLength(ch, "utf8");
		if (used + len > maxBytes) break;
		out += ch;
		used += len;
	}
	return out;
}

function sanitizeMfnId(raw: string, fallback = "default"): string {
	const cleaned = raw.replace(CONTROL_RE, "").trim();
	return utf8Slice(cleaned || fallback, 128);
}

function sanitizeCallerTags(tags: readonly string[]): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	for (const raw of tags) {
		const cleaned = utf8Slice(raw.replace(CONTROL_RE, "").trim(), 128);
		if (!cleaned || cleaned.startsWith("mfn.") || seen.has(cleaned)) continue;
		seen.add(cleaned);
		out.push(cleaned);
		if (out.length >= 32) break;
	}
	return out;
}

function isSkippedMarker(message: LhMessage): boolean {
	if (message.role !== "custom") return false;
	const marker = message as LhMarkerMessage;
	if (["plan-block", "problem-dismissed", "compaction"].includes(marker.customType)) return true;
	const details = marker.details as { source?: unknown } | null;
	return details?.source === "mfn";
}

function extractAssistantText(assistant: AssistantMessage): string {
	if (assistant.stopReason === "error" || assistant.stopReason === "aborted") {
		return "";
	}
	const parts: string[] = [];
	for (const block of assistant.content) {
		if (block.type === "text" && block.text.trim()) {
			parts.push(block.text.trim());
		} else if (block.type === "toolCall") {
			const prose = sendToUserText(block);
			parts.push(prose ?? `[tool ${block.name}] ${JSON.stringify(block.arguments ?? {}).slice(0, 800)}`);
		}
	}
	return parts.join("\n").trim();
}

function extractMessageText(message: LhMessage): string {
	if (isSkippedMarker(message)) return "";
	if (message.role === "user") {
		if (typeof message.content === "string") return citationsToReadableText(message.content).trim();
		const texts = message.content.filter((b) => b.type === "text").map((b) => citationsToReadableText(b.text));
		return texts.join("\n").trim();
	}
	if (message.role === "assistant") {
		return extractAssistantText(message as AssistantMessage);
	}
	if (message.role === "toolResult") {
		const res = message as ToolResultMessage;
		if (!res.isError && res.details === null && (QUESTION_TOOLS as readonly string[]).includes(res.toolName)) return "";
		const text = res.content.map((c) => (c.type === "text" ? c.text : "")).join("\n").trim();
		return text.length > TOOL_TEXT_CAP ? `${text.slice(0, TOOL_TEXT_CAP)}…` : text;
	}
	return (message as LhMarkerMessage).content.trim();
}

function collectTailMemoryIds(chatId: string, liveTail: readonly LhMessage[]): { windowIds: string[]; excludeIds: string[] } {
	const newestFirst: string[] = [];
	const seen = new Set<string>();
	for (let i = liveTail.length - 1; i >= 0; i--) {
		const msg = liveTail[i]!;
		if (isSkippedMarker(msg)) continue;
		const memId = messageMemoryId(chatId, msg.id);
		if (!seen.has(memId)) {
			seen.add(memId);
			newestFirst.push(memId);
		}
	}
	return {
		windowIds: newestFirst.slice(0, 64),
		excludeIds: newestFirst.slice(0, 256),
	};
}

function selectRecallQuery(messages: readonly LhMessage[]): { text: string; context: string | null } | null {
	const texts: string[] = [];
	for (let i = messages.length - 1; i >= 0 && texts.length < 3; i--) {
		const text = extractMessageText(messages[i]!);
		if (text) texts.push(text);
	}
	if (texts.length === 0) return null;
	const primary = utf8Slice(texts[0]!, 8_192);
	if (!primary) return null;
	const ctxJoined = texts.slice(1).reverse().join("\n");
	const context = ctxJoined ? utf8Slice(ctxJoined, 2_048) : null;
	return { text: primary, context };
}

function formatMfnSections(input: {
	planText: string | null;
	memories: readonly RecalledMemory[];
	supplements: readonly LexicalSearchMatch[];
	themes: readonly RecalledTheme[];
	anticipations: RecalledAnticipations;
}): string | null {
	const sections: string[] = [];
	if (input.planText) {
		sections.push(`## Plan dependency tree\n${input.planText}`);
	}
	if (input.memories.length > 0 || input.supplements.length > 0) {
		const lines = input.memories.map((m) => `- [${m.memory_id}] (activation ${m.activation.total.toFixed(3)}): ${m.content}`);
		for (const sup of input.supplements) {
			lines.push(`- [${sup.memory_id}] (lexical ${sup.score.toFixed(3)}): ${sup.content}`);
		}
		sections.push(`## Recalled memories\n${lines.join("\n")}`);
	}
	if (input.themes.length > 0) {
		const lines = input.themes.map((t) => `- ${t.label} (${t.pattern_id}, confidence ${t.confidence.toFixed(2)}): ${t.summary}`);
		sections.push(`## Active themes (L5)\n${lines.join("\n")}`);
	}
	const antLines = [
		...input.anticipations.actors.map((a) => `- [actor] ${a.label} (confidence ${a.confidence.toFixed(2)})`),
		...input.anticipations.entities.map((e) => `- [entity] ${e.label} (confidence ${e.confidence.toFixed(2)})`),
		...input.anticipations.topics.map((t) => `- [topic] ${t.label} (confidence ${t.confidence.toFixed(2)})`),
	];
	if (antLines.length > 0) {
		sections.push(`## Context anticipations (L4)\n${antLines.join("\n")}`);
	}
	return sections.length > 0 ? sections.join("\n\n") : null;
}

async function queryRecallAndFallback(
	opts: PrepareTurnContextOptions,
	query: { text: string; context: string | null },
	windowIds: string[],
	excludeIds: string[],
): Promise<{
	memories: RecalledMemory[];
	supplements: LexicalSearchMatch[];
	themes: RecalledTheme[];
	anticipations: RecalledAnticipations;
	degraded: string[];
}> {
	const excludeSet = new Set(excludeIds);
	const recallPayload: TurnRecallPayload = {
		query,
		session: { kind: "chat", id: sanitizeMfnId(opts.chatId) },
		...(opts.actorKey !== undefined ? { actor: opts.actorKey ? { key: sanitizeMfnId(opts.actorKey) } : null } : {}),
		window: { memory_ids: windowIds, score: true },
		exclude_memory_ids: excludeIds,
		...(opts.limits ? { limits: opts.limits } : {}),
		...(opts.weights ? { weights: opts.weights } : {}),
	};
	let memories: RecalledMemory[] = [];
	let themes: RecalledTheme[] = [];
	let anticipations: RecalledAnticipations = { actors: [], entities: [], topics: [] };
	let degraded: string[] = [];
	try {
		const recalled = await opts.client.turnRecall(opts.mainPoolId, recallPayload);
		const seen = new Set<string>(excludeSet);
		memories = (recalled.result.memories ?? []).filter((m) => !seen.has(m.memory_id) && Boolean(seen.add(m.memory_id)));
		themes = recalled.result.themes ?? [];
		anticipations = recalled.result.anticipations ?? anticipations;
		degraded = [...(recalled.result.degraded ?? [])];
	} catch (err) {
		if (!isRetryableMfnError(err)) throw err;
		degraded = [err instanceof MfnApiError ? err.code : "embedder_unavailable"];
	}
	const needsLexical = degraded.includes("embedder_unavailable") || degraded.includes("embedder");
	let supplements: LexicalSearchMatch[] = [];
	if (needsLexical) {
		const recalledIds = new Set(memories.map((m) => m.memory_id));
		const hits = await opts.client.lexicalSearch(opts.lexicalPoolId, { query: query.text, top_k: opts.limits?.top_k ?? 8 });
		supplements = hits.filter((h) => !excludeSet.has(h.memory_id) && !recalledIds.has(h.memory_id));
	}
	return { memories, supplements, themes, anticipations, degraded };
}

function buildMfnContextMarker(
	body: string | null,
	memories: readonly RecalledMemory[],
	supplements: readonly LexicalSearchMatch[],
	degraded: readonly string[],
): LhMarkerMessage | null {
	if (!body) return null;
	return {
		id: `mfn_ctx_${mintUuidV7()}`,
		role: "custom",
		customType: "graph-context",
		content: `[MFN memory context] — recalled from associative memory for this turn:\n\n${body}`,
		display: false,
		details: {
			source: "mfn",
			propositions: [],
			chains: [],
			recalledMemoryIds: memories.map((m) => m.memory_id),
			lexicalMemoryIds: supplements.map((s) => s.memory_id),
			degraded: [...degraded],
		},
		timestamp: Date.now(),
	};
}

export async function prepareTurnContextWithMfn(opts: PrepareTurnContextOptions): Promise<PreparedTurnContext> {
	const liveTailTokens = opts.liveTailTokens ?? LIVE_TAIL_DEFAULT_TOKENS;
	const cutIndex = compactionCutIndex(opts.messages, liveTailTokens);
	const liveTail = opts.messages.slice(cutIndex).filter((m) => !isSkippedMarker(m));
	const { windowIds, excludeIds } = collectTailMemoryIds(opts.chatId, liveTail);
	const query = selectRecallQuery(liveTail.length > 0 ? liveTail : opts.messages);
	const emptyAnt: RecalledAnticipations = { actors: [], entities: [], topics: [] };
	const recalled = query
		? await queryRecallAndFallback(opts, query, windowIds, excludeIds)
		: { memories: [], supplements: [], themes: [], anticipations: emptyAnt, degraded: [] };
	const body = formatMfnSections({
		planText: planTreeToText(opts.tree, opts.messages),
		memories: recalled.memories,
		supplements: recalled.supplements,
		themes: recalled.themes,
		anticipations: recalled.anticipations,
	});
	const marker = buildMfnContextMarker(body, recalled.memories, recalled.supplements, recalled.degraded);
	return {
		agentMessages: marker ? [marker, ...liveTail] : [...liveTail],
		liveTail,
		cutIndex,
		marker,
		recalledMemories: recalled.memories,
		lexicalSupplements: recalled.supplements,
		themes: recalled.themes,
		anticipations: recalled.anticipations,
		degraded: recalled.degraded,
	};
}

function toIngestMemories(chatId: string, messages: readonly LhMessage[], extraTags: readonly string[]): TurnIngestMemory[] {
	const chatSlug = sanitizeMfnId(chatId);
	const items: TurnIngestMemory[] = [];
	const seenIds = new Set<string>();
	for (const msg of messages) {
		const text = extractMessageText(msg);
		if (!text) continue;
		const memId = messageMemoryId(chatId, msg.id);
		if (seenIds.has(memId)) continue;
		seenIds.add(memId);
		const isTutor = msg.role === "assistant";
		const tags = sanitizeCallerTags([`role:${msg.role}`, `chat:${chatSlug}`, ...extraTags]);
		items.push({
			memory_id: memId,
			content: `[${msg.role}] ${text}`,
			tags,
			metadata: { chat_id: chatSlug, message_id: sanitizeMfnId(msg.id), role: msg.role },
			association_keys: [`chat:${chatSlug}`],
			subjects: [{ kind: "actor", key: isTutor ? "actor:tutor" : "actor:learner", label: isTutor ? "Tutor" : "Learner" }],
		});
	}
	return items;
}

function buildDeliveredRefs(
	recalled: readonly RecalledMemory[] | undefined,
	anchorId: string,
	batchIds: ReadonlySet<string>,
): TurnIngestDelivered[] {
	if (!recalled || recalled.length === 0) return [];
	const out: TurnIngestDelivered[] = [];
	const seen = new Set<string>();
	for (const mem of recalled) {
		if (!isValidCallerMemoryId(mem.memory_id) || batchIds.has(mem.memory_id) || seen.has(mem.memory_id)) continue;
		seen.add(mem.memory_id);
		const rawTotal = mem.activation?.total ?? 1;
		const activation = Math.min(1, Math.max(0.0001, Number.isFinite(rawTotal) && rawTotal > 0 ? rawTotal : 1));
		out.push({ memory_id: mem.memory_id, anchor: anchorId, used: false, activation });
		if (out.length >= 32) break;
	}
	return out;
}

async function ingestSingleBatch(
	opts: IngestSettledTurnOptions,
	batch: TurnIngestMemory[],
	batchIndex: number,
	prevMemId: string | null,
): Promise<"ingested" | "queued"> {
	const anchorId = batch[0]!.memory_id;
	const batchIds = new Set(batch.map((m) => m.memory_id));
	const delivered = batchIndex === 0 ? buildDeliveredRefs(opts.recalledMemories, anchorId, batchIds) : [];
	const baseUs = Math.floor((opts.occurredAtMs ?? Date.now()) * 1_000);
	const payload: TurnIngestPayload = {
		turn_id: mintUuidV7(),
		session: { kind: "chat", id: sanitizeMfnId(opts.chatId) },
		occurred_at_us: baseUs + batchIndex,
		predecessor_memory_id: prevMemId && isValidCallerMemoryId(prevMemId) ? prevMemId : null,
		memories: batch,
		...(delivered.length > 0 ? { delivered } : {}),
	};
	const opId = mintUuidV7();
	try {
		await opts.client.turnIngest(opts.mainPoolId, payload, opId);
		return "ingested";
	} catch (err) {
		if (!opts.outbox.isRetryableIngestError(err)) throw err;
		opts.outbox.enqueue({
			operationId: opId,
			poolId: opts.mainPoolId,
			payload,
			errorCode: err instanceof MfnApiError ? err.code : "transport_error",
		});
		return "queued";
	}
}

async function writeLexicalBestEffort(
	client: MfnClient,
	lexicalPoolId: string,
	items: readonly TurnIngestMemory[],
): Promise<number> {
	let writes = 0;
	for (const item of items) {
		const putBody = { memory_id: item.memory_id, content: item.content, tags: item.tags, metadata: item.metadata };
		try {
			await client.lexicalPut(lexicalPoolId, putBody);
			writes++;
		} catch (err) {
			if (!isRetryableMfnError(err)) throw err;
		}
	}
	return writes;
}

export async function ingestSettledTurnWithMfn(opts: IngestSettledTurnOptions): Promise<IngestSettledTurnResult> {
	const items = toIngestMemories(opts.chatId, opts.turnMessages, opts.sessionTags ?? []);
	const lexicalWrites = await writeLexicalBestEffort(opts.client, opts.lexicalPoolId, items);
	let ingestedBatches = 0;
	let queuedBatches = 0;
	let prevMemId = opts.predecessorMemoryId ?? null;
	for (let i = 0; i < items.length; i += 4) {
		const batch = items.slice(i, i + 4);
		const outcome = await ingestSingleBatch(opts, batch, Math.floor(i / 4), prevMemId);
		if (outcome === "ingested") ingestedBatches++;
		else queuedBatches++;
		prevMemId = batch[batch.length - 1]!.memory_id;
	}
	let flushedFromOutbox = 0;
	if (ingestedBatches > 0 && queuedBatches === 0 && opts.outbox.size() > 0) {
		const flushed = await opts.outbox.flush(opts.client);
		flushedFromOutbox = flushed.flushed;
	}
	return {
		ingestedBatches,
		queuedBatches,
		lexicalWrites,
		flushedFromOutbox,
		memoryIds: items.map((m) => m.memory_id),
	};
}
