import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import { citationsToReadableText } from "../../core/citations.ts";
import { compactionCutIndex, planTreeToText } from "../../core/compaction.ts";
import type { PlanTree } from "../../core/contracts/plan.ts";
import { sendToUserText, type LhMarkerMessage, type LhMessage } from "../../core/native-messages.ts";
import { QUESTION_TOOLS } from "../../core/pending.ts";
import { MfnApiError, type MfnClient } from "./client.ts";
import { isValidCallerMemoryId, messageMemoryId, mintUuidV7 } from "./ids.ts";
import { isPerItemPoisonMfnError, isRetryableMfnError, type MfnIngestOutbox } from "./outbox.ts";
import type {
	LexicalSearchMatch, MfnMemoryPutPayload, RecalledAnticipations, RecalledMemory, RecalledTheme,
	TurnIngestDelivered, TurnIngestMemory, TurnIngestPayload, TurnRecallLimits, TurnRecallPayload,
} from "./types.ts";

export const LIVE_TAIL_DEFAULT_TOKENS = 5_000;
const TOOL_TEXT_CAP = 2_000;
const CONTROL_RE = /[\x00-\x1f\x7f]/g;
const LEXICAL_RETRY_DELAYS_MS = [30, 60] as const;

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
	queuedLexicalWrites: number;
	flushedFromOutbox: number;
	memoryIds: string[];
}

function utf8Slice(text: string, maxBytes: number): string {
	if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
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
	if (assistant.stopReason === "error" || assistant.stopReason === "aborted") return "";
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
	if (message.role === "assistant") return extractAssistantText(message as AssistantMessage);
	if (message.role === "toolResult") {
		const res = message as ToolResultMessage;
		if (!res.isError && res.details === null && (QUESTION_TOOLS as readonly string[]).includes(res.toolName)) {
			return "";
		}
		const text = res.content.map((c) => (c.type === "text" ? c.text : "")).join("\n").trim();
		return text.length > TOOL_TEXT_CAP ? `${text.slice(0, TOOL_TEXT_CAP)}…` : text;
	}
	return (message as LhMarkerMessage).content.trim();
}

function collectTailMemoryIds(
	chatId: string,
	liveTail: readonly LhMessage[],
): { windowIds: string[]; excludeIds: string[] } {
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
	return { windowIds: newestFirst.slice(0, 64), excludeIds: newestFirst.slice(0, 256) };
}

function selectRecallQuery(messages: readonly LhMessage[]): { text: string; context: string | null } | null {
	const texts: string[] = [];
	for (let i = messages.length - 1; i >= 0 && texts.length < 3; i--) {
		const text = extractMessageText(messages[i]!);
		if (text) texts.push(text);
	}
	const primary = texts[0] ? utf8Slice(texts[0], 8_192) : "";
	if (!primary) return null;
	const ctxJoined = texts.slice(1).reverse().join("\n");
	return { text: primary, context: ctxJoined ? utf8Slice(ctxJoined, 2_048) : null };
}

interface RecallBundle {
	memories: RecalledMemory[];
	supplements: LexicalSearchMatch[];
	themes: RecalledTheme[];
	anticipations: RecalledAnticipations;
	degraded: string[];
}

function formatMfnSections(planText: string | null, input: RecallBundle): string | null {
	const sections: string[] = [];
	if (planText) sections.push(`## Plan dependency tree\n${planText}`);
	if (input.memories.length > 0 || input.supplements.length > 0) {
		const lines = input.memories.map(
			(m) => `- [${m.memory_id}] (activation ${m.activation.total.toFixed(3)}): ${m.content}`,
		);
		for (const sup of input.supplements) {
			lines.push(`- [${sup.memory_id}] (lexical ${sup.score.toFixed(3)}): ${sup.content}`);
		}
		sections.push(`## Recalled memories\n${lines.join("\n")}`);
	}
	if (input.themes.length > 0) {
		const lines = input.themes.map(
			(t) => `- ${t.label} (${t.pattern_id}, confidence ${t.confidence.toFixed(2)}): ${t.summary}`,
		);
		sections.push(`## Active themes (L5)\n${lines.join("\n")}`);
	}
	const antLines = [
		...input.anticipations.actors.map((a) => `- [actor] ${a.label} (confidence ${a.confidence.toFixed(2)})`),
		...input.anticipations.entities.map((e) => `- [entity] ${e.label} (confidence ${e.confidence.toFixed(2)})`),
		...input.anticipations.topics.map((t) => `- [topic] ${t.label} (confidence ${t.confidence.toFixed(2)})`),
	];
	if (antLines.length > 0) sections.push(`## Context anticipations (L4)\n${antLines.join("\n")}`);
	return sections.length > 0 ? sections.join("\n\n") : null;
}

function extractMfnErrorCode(err: unknown, fallback: string): string {
	if (err instanceof MfnApiError) return err.code;
	if (err && typeof err === "object" && "code" in err) {
		const raw = (err as { code?: unknown }).code;
		if (typeof raw === "string" && raw.length > 0) return raw;
	}
	return fallback;
}

async function runLexicalSupplement(
	opts: PrepareTurnContextOptions,
	queryText: string,
	excludeSet: ReadonlySet<string>,
	recalledIds: ReadonlySet<string>,
	degraded: string[],
): Promise<LexicalSearchMatch[]> {
	try {
		const topK = opts.limits?.top_k ?? 8;
		const hits = await opts.client.lexicalSearch(opts.lexicalPoolId, { query: queryText, top_k: topK });
		return hits.filter((h) => !excludeSet.has(h.memory_id) && !recalledIds.has(h.memory_id));
	} catch (err) {
		const code = extractMfnErrorCode(err, "lexical_search_error");
		console.warn(`[mfn] lexicalSearch fallback degraded (${code}):`, err);
		if (!degraded.includes(code)) degraded.push(code);
		return [];
	}
}

async function queryRecallAndFallback(
	opts: PrepareTurnContextOptions,
	query: { text: string; context: string | null },
	windowIds: string[],
	excludeIds: string[],
): Promise<RecallBundle> {
	const excludeSet = new Set(excludeIds);
	const actor = opts.actorKey ? { key: sanitizeMfnId(opts.actorKey) } : null;
	const recallPayload: TurnRecallPayload = {
		query,
		session: { kind: "chat", id: sanitizeMfnId(opts.chatId) },
		...(opts.actorKey !== undefined ? { actor } : {}),
		window: { memory_ids: windowIds, score: true },
		exclude_memory_ids: excludeIds,
		...(opts.limits ? { limits: opts.limits } : {}),
		...(opts.weights ? { weights: opts.weights } : {}),
	};
	let memories: RecalledMemory[] = [];
	let themes: RecalledTheme[] = [];
	let anticipations: RecalledAnticipations = { actors: [], entities: [], topics: [] };
	let degraded: string[] = [];
	let embedderDegraded = false;
	try {
		const recalled = await opts.client.turnRecall(opts.mainPoolId, recallPayload);
		const seen = new Set<string>(excludeSet);
		const rawMems = recalled.result.memories ?? [];
		memories = rawMems.filter((m) => !seen.has(m.memory_id) && Boolean(seen.add(m.memory_id)));
		themes = recalled.result.themes ?? [];
		anticipations = recalled.result.anticipations ?? anticipations;
		degraded = [...(recalled.result.degraded ?? [])];
		embedderDegraded = degraded.includes("embedder_unavailable") || degraded.includes("embedder");
	} catch (err) {
		const code = extractMfnErrorCode(err, "recall_error");
		console.warn(`[mfn] turn.recall degraded (${code}):`, err);
		degraded = [code];
		embedderDegraded = err instanceof MfnApiError && (code === "embedder_unavailable" || code === "embedder");
	}
	const recalledIds = new Set(memories.map((m) => m.memory_id));
	const supplements = embedderDegraded
		? await runLexicalSupplement(opts, query.text, excludeSet, recalledIds, degraded)
		: [];
	return { memories, supplements, themes, anticipations, degraded };
}

function buildMfnContextMarker(body: string | null, recalled: RecallBundle): LhMarkerMessage | null {
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
			recalledMemoryIds: recalled.memories.map((m) => m.memory_id),
			lexicalMemoryIds: recalled.supplements.map((s) => s.memory_id),
			degraded: [...recalled.degraded],
		},
		timestamp: Date.now(),
	};
}

export async function prepareTurnContextWithMfn(opts: PrepareTurnContextOptions): Promise<PreparedTurnContext> {
	const cutIndex = compactionCutIndex(opts.messages, opts.liveTailTokens ?? LIVE_TAIL_DEFAULT_TOKENS);
	const liveTail = opts.messages.slice(cutIndex).filter((m) => !isSkippedMarker(m));
	const { windowIds, excludeIds } = collectTailMemoryIds(opts.chatId, liveTail);
	const query = selectRecallQuery(liveTail.length > 0 ? liveTail : opts.messages);
	const emptyAnt: RecalledAnticipations = { actors: [], entities: [], topics: [] };
	const recalled = query
		? await queryRecallAndFallback(opts, query, windowIds, excludeIds)
		: { memories: [], supplements: [], themes: [], anticipations: emptyAnt, degraded: [] };
	const body = formatMfnSections(planTreeToText(opts.tree, opts.messages), recalled);
	const marker = buildMfnContextMarker(body, recalled);
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

function toIngestMemories(chatId: string, messages: readonly LhMessage[], tags: readonly string[]): TurnIngestMemory[] {
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
		const key = isTutor ? "actor:tutor" : "actor:learner";
		const label = isTutor ? "Tutor" : "Learner";
		items.push({
			memory_id: memId,
			content: `[${msg.role}] ${text}`,
			tags: sanitizeCallerTags([`role:${msg.role}`, `chat:${chatSlug}`, ...tags]),
			metadata: { chat_id: chatSlug, message_id: sanitizeMfnId(msg.id), role: msg.role },
			association_keys: [`chat:${chatSlug}`],
			subjects: [{ kind: "actor", key, label }],
		});
	}
	return items;
}

function buildDeliveredRefs(
	recalled: readonly RecalledMemory[] | undefined, anchorId: string, batchIds: ReadonlySet<string>,
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
	opts: IngestSettledTurnOptions, batch: TurnIngestMemory[], batchIndex: number, prevMemId: string | null,
): Promise<"ingested" | "queued" | "quarantined"> {
	const batchIds = new Set(batch.map((m) => m.memory_id));
	const delivered = batchIndex === 0 ? buildDeliveredRefs(opts.recalledMemories, batch[0]!.memory_id, batchIds) : [];
	const payload: TurnIngestPayload = {
		turn_id: mintUuidV7(),
		session: { kind: "chat", id: sanitizeMfnId(opts.chatId) },
		occurred_at_us: Math.floor((opts.occurredAtMs ?? Date.now()) * 1_000) + batchIndex,
		predecessor_memory_id: prevMemId && isValidCallerMemoryId(prevMemId) ? prevMemId : null,
		memories: batch,
		...(delivered.length > 0 ? { delivered } : {}),
	};
	const opId = mintUuidV7();
	try {
		await opts.client.turnIngest(opts.mainPoolId, payload, opId);
		return "ingested";
	} catch (err) {
		const errorCode = extractMfnErrorCode(err, "transport_error");
		const input = { kind: "turn_ingest" as const, operationId: opId, poolId: opts.mainPoolId, payload, errorCode };
		if (isPerItemPoisonMfnError(err)) {
			console.warn(`[mfn] Poison turn.ingest (${errorCode}); quarantining ${opId}:`, err);
			opts.outbox.quarantine(input, `turn.ingest rejected (${errorCode})`);
			return "quarantined";
		}
		console.warn(`[mfn] turn.ingest deferred (${errorCode}); queueing ${opId} in outbox:`, err);
		opts.outbox.enqueue(input);
		return "queued";
	}
}

interface LexicalOutboxSeed {
	kind: "lexical_put";
	operationId: string;
	poolId: string;
	lexicalPayload: MfnMemoryPutPayload;
}

async function attemptLexicalPutOnce(
	opts: IngestSettledTurnOptions, seed: LexicalOutboxSeed,
): Promise<{ done: "written" | "queued" | "quarantined" } | { retryCode: string }> {
	try {
		await opts.client.lexicalPut(seed.poolId, seed.lexicalPayload, seed.operationId);
		return { done: "written" };
	} catch (err) {
		const errorCode = extractMfnErrorCode(err, "transport_error");
		if (isRetryableMfnError(err)) return { retryCode: errorCode };
		if (isPerItemPoisonMfnError(err)) {
			console.warn(`[mfn] Poison lexicalPut (${errorCode}); quarantining ${seed.operationId}:`, err);
			opts.outbox.quarantine({ ...seed, errorCode }, `memory.put rejected (${errorCode})`);
			return { done: "quarantined" };
		}
		console.warn(`[mfn] Systemic lexicalPut (${errorCode}); queueing ${seed.operationId} in outbox:`, err);
		opts.outbox.enqueue({ ...seed, errorCode });
		return { done: "queued" };
	}
}

async function writeSingleLexicalItem(
	opts: IngestSettledTurnOptions,
	item: TurnIngestMemory,
): Promise<"written" | "queued" | "quarantined"> {
	const putBody: MfnMemoryPutPayload = {
		memory_id: item.memory_id,
		content: item.content,
		tags: item.tags,
		metadata: item.metadata,
	};
	const seed: LexicalOutboxSeed = {
		kind: "lexical_put",
		operationId: mintUuidV7(),
		poolId: opts.lexicalPoolId,
		lexicalPayload: putBody,
	};
	let errorCode = "transport_error";
	for (let attempt = 0; attempt < 3; attempt++) {
		const step = await attemptLexicalPutOnce(opts, seed);
		if ("done" in step) return step.done;
		errorCode = step.retryCode;
		const delay = LEXICAL_RETRY_DELAYS_MS[attempt];
		if (delay !== undefined) await new Promise<void>((r) => setTimeout(r, delay));
	}
	console.warn(`[mfn] lexicalPut exhausted 3 attempts (${errorCode}); queueing ${seed.operationId} in outbox`);
	opts.outbox.enqueue({ ...seed, errorCode });
	return "queued";
}

export async function ingestSettledTurnWithMfn(opts: IngestSettledTurnOptions): Promise<IngestSettledTurnResult> {
	const items = toIngestMemories(opts.chatId, opts.turnMessages, opts.sessionTags ?? []);
	let lexicalWrites = 0;
	let queuedLexicalWrites = 0;
	for (const item of items) {
		const lexOutcome = await writeSingleLexicalItem(opts, item);
		if (lexOutcome === "written") lexicalWrites++;
		else if (lexOutcome === "queued") queuedLexicalWrites++;
	}
	let ingestedBatches = 0;
	let queuedBatches = 0;
	let prevMemId = opts.predecessorMemoryId ?? null;
	for (let i = 0; i < items.length; i += 4) {
		const batch = items.slice(i, i + 4);
		const outcome = await ingestSingleBatch(opts, batch, Math.floor(i / 4), prevMemId);
		if (outcome === "ingested") ingestedBatches++;
		else if (outcome === "queued") queuedBatches++;
		prevMemId = batch[batch.length - 1]!.memory_id;
	}
	let flushedFromOutbox = 0;
	if (ingestedBatches > 0 && queuedBatches === 0 && queuedLexicalWrites === 0 && opts.outbox.size() > 0) {
		flushedFromOutbox = (await opts.outbox.flush(opts.client)).flushed;
	}
	return {
		ingestedBatches, queuedBatches, lexicalWrites, queuedLexicalWrites, flushedFromOutbox,
		memoryIds: items.map((m) => m.memory_id),
	};
}
