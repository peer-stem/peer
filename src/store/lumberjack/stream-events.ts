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

function dispatchPathNotification(mutatedPath: string): void {
	const rel = normalizeMutatedPath(mutatedPath);
	if (rel.startsWith("sessions/")) {
		const chatId = rel.split("/")[1];
		if (chatId) emit("record-changed", { chatId });
	} else if (rel.startsWith("knowledge/sources")) {
		emit("sources-changed", {});
	} else if (rel.startsWith("knowledge")) {
		emit("activity-changed", {});
	} else if (rel.startsWith("jobs/")) {
		emit("jobs-changed", {});
	}
}

export function startLumberJackStreamBridge(
	forest: LumberJackForest,
	intervalMs = 250,
): { stop(): void; pollOnce(): ParsedMutationBatch } {
	let cursor: StreamPollCursor = { epoch: 0n, after: 0n };
	const pollOnce = (): ParsedMutationBatch => {
		if (!forest.isOpen) {
			return { status: LJ_STATUS.CLOSED, epoch: cursor.epoch, oldest: 0n, maxSequence: cursor.after, paths: [] };
		}
		const batch = pollLumberJackMutations(forest, cursor);
		if (batch.status === LJ_STATUS.GAP) {
			cursor = { epoch: batch.epoch, after: batch.oldest > 0n ? batch.oldest - 1n : 0n };
			emit("chats-changed", {});
			emit("sources-changed", {});
			return batch;
		}
		const nextAfter = batch.maxSequence > cursor.after ? batch.maxSequence : cursor.after;
		cursor = { epoch: batch.epoch, after: nextAfter };
		for (const p of batch.paths) {
			dispatchPathNotification(p);
		}
		return batch;
	};
	const timer = setInterval(() => {
		try {
			pollOnce();
		} catch (err) {
			console.error("[lumberjack-stream] poll error:", err);
		}
	}, intervalMs);
	timer.unref();
	return {
		pollOnce,
		stop() {
			clearInterval(timer);
		},
	};
}
