import type { JobRecord } from "../../core/contracts.ts";
import { emit } from "../../core/events.ts";
import type { CreateJobInit, JobPatch, JobStore } from "../../core/ports.ts";
import type { LumberJackForest } from "./binding.ts";

const VALID_JOB_ID_RE = /^[A-Za-z0-9_-]+$/;
const LIFECYCLE_EVENT = "lifecycle";

function jobPathFor(id: string): string {
	if (!VALID_JOB_ID_RE.test(id)) {
		throw new Error(`Invalid job id: ${id}`);
	}
	return `jobs/${id}`;
}

function isTerminalStatus(status: JobRecord["status"]): boolean {
	return status === "done" || status === "error";
}

function writeJobNodeMetadata(forest: LumberJackForest, record: JobRecord): void {
	const parentPaths = VALID_JOB_ID_RE.test(record.chatId) ? [`sessions/${record.chatId}`] : [];
	forest.upsertNode({
		path: jobPathFor(record.id),
		type: "leaf",
		kind: "job",
		parent_paths: parentPaths,
		clear_slot: true,
		metadata: {
			jobId: record.id,
			chatId: record.chatId,
			toolCallId: record.toolCallId,
			status: record.status,
			kind: record.kind,
			updatedAt: record.updatedAt,
		},
	});
}

function foldJobLifecycle(forest: LumberJackForest, id: string): JobRecord | null {
	if (!VALID_JOB_ID_RE.test(id)) return null;
	const nodePath = `jobs/${id}`;
	const snap = forest.getNode(nodePath);
	if (!snap) return null;
	const entries = forest.getEntries(nodePath, LIFECYCLE_EVENT);
	if (entries.length === 0) return null;
	let current = entries[0]!.content as JobRecord;
	for (let i = 1; i < entries.length; i++) {
		const patch = entries[i]!.content as Partial<JobRecord>;
		current = { ...current, ...patch };
	}
	return current;
}

function listChatJobs(forest: LumberJackForest, chatId: string): JobRecord[] {
	const out: JobRecord[] = [];
	for (const node of forest.listChildren("jobs")) {
		if (node.metadata?.chatId !== chatId) continue;
		const folded = foldJobLifecycle(forest, node.name);
		if (folded && folded.chatId === chatId) out.push(folded);
	}
	return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function createChatJob(forest: LumberJackForest, init: CreateJobInit): JobRecord {
	const now = new Date().toISOString();
	const record: JobRecord = {
		id: `job_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`,
		kind: init.kind,
		chatId: init.chatId,
		toolCallId: init.toolCallId,
		...(init.input !== undefined ? { input: init.input } : {}),
		status: "running",
		activity: init.activity ?? "starting",
		createdAt: now,
		updatedAt: now,
		...(init.plugin ? { plugin: init.plugin } : {}),
	};
	forest.noteStoreEmittedEvent("jobs-changed");
	writeJobNodeMetadata(forest, record);
	forest.appendEntries(jobPathFor(record.id), LIFECYCLE_EVENT, [
		{ id: `${record.id}:0`, content: record, metadata: { step: "create", status: record.status } },
	]);
	emit("jobs-changed", { chatId: init.chatId });
	return record;
}

function updateChatJob(forest: LumberJackForest, id: string, patch: JobPatch): JobRecord | null {
	const record = foldJobLifecycle(forest, id);
	if (!record) return null;
	const updatedAt = patch.updatedAt ?? new Date().toISOString();
	const next: JobRecord = { ...record, ...patch, updatedAt };
	const delta = { ...patch, updatedAt };
	const seq = forest.getEntries(jobPathFor(id), LIFECYCLE_EVENT).length;
	forest.noteStoreEmittedEvent("jobs-changed");
	writeJobNodeMetadata(forest, next);
	forest.appendEntries(
		jobPathFor(id),
		LIFECYCLE_EVENT,
		[{ id: `${id}:${seq}`, content: delta, metadata: { step: "patch", status: next.status } }],
		{ endEvent: isTerminalStatus(next.status) },
	);
	emit("jobs-changed", { chatId: next.chatId });
	return next;
}

function removeChatJobs(forest: LumberJackForest, chatId: string): number {
	let removed = 0;
	for (const node of forest.listChildren("jobs")) {
		if (node.metadata?.chatId !== chatId) continue;
		if (forest.deleteNode(node.path)) {
			removed++;
		}
	}
	if (removed > 0) {
		forest.noteStoreEmittedEvent("jobs-changed");
		emit("jobs-changed", { chatId });
	}
	return removed;
}

export function createLumberJackJobStore(forest: LumberJackForest): JobStore {
	return {
		createJob: (init) => createChatJob(forest, init),
		getJob: (id) => foldJobLifecycle(forest, id),
		updateJob: (id, patch) => updateChatJob(forest, id, patch),
		listJobs: (chatId) => listChatJobs(forest, chatId),
		findJobByToolCallId: (chatId, toolCallId) =>
			listChatJobs(forest, chatId).find((j) => j.toolCallId === toolCallId) ?? null,
		deleteJobsForChat: (chatId) => removeChatJobs(forest, chatId),
	};
}
