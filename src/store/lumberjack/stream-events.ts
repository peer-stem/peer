import { emit } from "../../core/events.ts";
import { LJ_STATUS, type LumberJackForest } from "./binding.ts";

export interface StreamPollCursor {
	epoch: bigint;
	after: bigint;
}

export interface ParsedMutationBatch {
	status: number;
	epoch: bigint;
	oldest: bigint;
	maxSequence: bigint;
	paths: string[];
}

const REPLAY_RING_CAPACITY = 1024n;

function parseBigIntField(yaml: string, key: string): bigint {
	const re = new RegExp(`^${key}:\\s*([0-9]+)`, "m");
	const match = re.exec(yaml);
	return match?.[1] ? BigInt(match[1]) : 0n;
}

function normalizeMutatedPath(raw: string): string {
	const unquoted = raw.replace(/^["']|["']$/g, "").trim();
	if (!unquoted || unquoted === "null" || unquoted === "~") return "";
	const trimmed = unquoted.replace(/^\/+|\/+$/g, "");
	if (trimmed === "forest") return "";
	return trimmed.startsWith("forest/") ? trimmed.slice("forest/".length) : trimmed;
}

function parseMutationSequencesAndPaths(yaml: string): { maxSeq: bigint; paths: string[] } {
	let maxSeq = 0n;
	const paths: string[] = [];
	for (const rawLine of yaml.split(/\r?\n/)) {
		const seqMatch = /^\s*-?\s*sequence:\s*([0-9]+)/.exec(rawLine);
		if (seqMatch?.[1]) {
			const val = BigInt(seqMatch[1]);
			if (val > maxSeq) maxSeq = val;
		}
		const pathMatch = /^\s*(?:-\s*)?(?:node_path|path):\s*(.+?)\s*$/.exec(rawLine);
		if (pathMatch?.[1]) {
			const clean = normalizeMutatedPath(pathMatch[1]);
			if (clean) paths.push(clean);
		}
	}
	return { maxSeq, paths };
}

export function pollLumberJackMutations(forest: LumberJackForest, cursor: StreamPollCursor): ParsedMutationBatch {
	const res = forest.pollStream(cursor.after, cursor.epoch, 0);
	const epoch = parseBigIntField(res.yaml, "epoch");
	const oldest = parseBigIntField(res.yaml, "oldest");
	const { maxSeq, paths } = parseMutationSequencesAndPaths(res.yaml);
	return { status: res.status, epoch, oldest, maxSequence: maxSeq, paths };
}

type DispatchedStreamEvent =
	| { type: "record-changed"; chatId: string }
	| { type: "sources-changed" | "activity-changed" | "jobs-changed" };

function classifyMutatedPath(mutatedPath: string): { key: string; event: DispatchedStreamEvent } | null {
	const rel = normalizeMutatedPath(mutatedPath);
	if (rel.startsWith("sessions/")) {
		const chatId = rel.split("/")[1];
		return chatId ? { key: `record-changed:${chatId}`, event: { type: "record-changed", chatId } } : null;
	}
	if (rel.startsWith("knowledge/sources") || rel === "config/source-organization") {
		return { key: "sources-changed", event: { type: "sources-changed" } };
	}
	if (rel.startsWith("knowledge")) {
		return { key: "activity-changed", event: { type: "activity-changed" } };
	}
	if (rel.startsWith("jobs/")) {
		return { key: "jobs-changed", event: { type: "jobs-changed" } };
	}
	return null;
}

function dispatchBatchNotifications(forest: LumberJackForest, paths: readonly string[]): void {
	const uniqueKeys = new Map<string, DispatchedStreamEvent>();
	for (const mutatedPath of paths) {
		const mapped = classifyMutatedPath(mutatedPath);
		if (!mapped || uniqueKeys.has(mapped.key)) continue;
		uniqueKeys.set(mapped.key, mapped.event);
	}
	for (const [key, event] of uniqueKeys) {
		if (forest.consumeStoreEmittedEvent?.(key)) continue;
		if (event.type === "record-changed") {
			emit("record-changed", { chatId: event.chatId });
		} else {
			emit(event.type, {});
		}
	}
}

interface BridgeCursorState {
	cursor: StreamPollCursor;
	awaitingSeedOffset: boolean;
}

function syncInitialCursorToHead(forest: LumberJackForest): BridgeCursorState {
	if (!forest.isOpen) return { cursor: { epoch: 0n, after: 0n }, awaitingSeedOffset: false };
	try {
		const first = pollLumberJackMutations(forest, { epoch: 0n, after: 0n });
		if (first.status !== LJ_STATUS.GAP) {
			return {
				cursor: { epoch: first.epoch, after: first.maxSequence },
				awaitingSeedOffset: first.maxSequence === 0n && first.oldest === 0n,
			};
		}
		const resumeAfter = first.oldest > 0n ? first.oldest - 1n : 0n;
		const second = pollLumberJackMutations(forest, { epoch: first.epoch, after: resumeAfter });
		const headAfter = second.maxSequence > resumeAfter ? second.maxSequence : resumeAfter;
		return { cursor: { epoch: second.epoch || first.epoch, after: headAfter }, awaitingSeedOffset: false };
	} catch {
		return { cursor: { epoch: 0n, after: 0n }, awaitingSeedOffset: false };
	}
}

function handleGapPoll(forest: LumberJackForest, state: BridgeCursorState, batch: ParsedMutationBatch): ParsedMutationBatch {
	const resumeAfter = batch.oldest > 0n ? batch.oldest - 1n : 0n;
	const catchUp = pollLumberJackMutations(forest, { epoch: batch.epoch, after: resumeAfter });
	const nextAfter = catchUp.maxSequence > resumeAfter ? catchUp.maxSequence : resumeAfter;
	const sameEpoch = state.cursor.epoch === 0n || batch.epoch === state.cursor.epoch;
	const isPostReopenSeed =
		state.awaitingSeedOffset && sameEpoch && nextAfter - resumeAfter < REPLAY_RING_CAPACITY;
	state.cursor = { epoch: batch.epoch, after: nextAfter };
	state.awaitingSeedOffset = false;
	if (isPostReopenSeed) {
		dispatchBatchNotifications(forest, catchUp.paths);
		return catchUp;
	}
	emit("chats-changed", {});
	emit("sources-changed", {});
	return batch;
}

export function startLumberJackStreamBridge(
	forest: LumberJackForest,
	intervalMs = 250,
): { stop(): void; pollOnce(): ParsedMutationBatch } {
	const state = syncInitialCursorToHead(forest);
	const detachBridge = forest.registerStreamBridge?.() ?? (() => {});
	let stopped = false;

	const pollOnce = (): ParsedMutationBatch => {
		if (!forest.isOpen) {
			return { status: LJ_STATUS.CLOSED, epoch: state.cursor.epoch, oldest: 0n, maxSequence: state.cursor.after, paths: [] };
		}
		const batch = pollLumberJackMutations(forest, state.cursor);
		if (batch.status === LJ_STATUS.GAP) return handleGapPoll(forest, state, batch);
		if (batch.maxSequence > state.cursor.after) {
			state.cursor = { epoch: batch.epoch, after: batch.maxSequence };
			state.awaitingSeedOffset = false;
		} else {
			state.cursor = { epoch: batch.epoch, after: state.cursor.after };
		}
		dispatchBatchNotifications(forest, batch.paths);
		return batch;
	};

	const stop = (): void => {
		if (stopped) return;
		stopped = true;
		clearInterval(timer);
		detachClose();
		detachBridge();
	};
	const timer = setInterval(() => {
		try { pollOnce(); } catch (err) { console.error("[lumberjack-stream] poll error:", err); }
	}, intervalMs);
	timer.unref();
	const detachClose = forest.onClose?.(stop) ?? (() => {});
	return { pollOnce, stop };
}
