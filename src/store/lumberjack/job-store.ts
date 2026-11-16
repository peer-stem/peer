import type { JobRecord } from "../../core/contracts.ts";
import { emit } from "../../core/events.ts";
import type { CreateJobInit, JobPatch, JobStore } from "../../core/ports.ts";
import type { LumberJackForest } from "./binding.ts";

const VALID_JOB_ID_RE = /^[A-Za-z0-9_-]+$/;

function jobPathFor(id: string): string {
	if (!VALID_JOB_ID_RE.test(id)) {
		throw new Error(`Invalid job id: ${id}`);
	}
	return `jobs/${id}`;
}

function writeJobNode(forest: LumberJackForest, record: JobRecord): void {
	const parentPaths = VALID_JOB_ID_RE.test(record.chatId) ? [`sessions/${record.chatId}`] : [];
	forest.upsertNode({
		path: jobPathFor(record.id),
		type: "leaf",
		kind: "job",
		parent_paths: parentPaths,
		metadata: { chatId: record.chatId, status: record.status, kind: record.kind, updatedAt: record.updatedAt },
		slot: record,
	});
}

function readJobNode(forest: LumberJackForest, id: string): JobRecord | null {
	if (!VALID_JOB_ID_RE.test(id)) return null;
	const snap = forest.getNode(`jobs/${id}`);
	return (snap?.slot as JobRecord | undefined) ?? null;
}

function listChatJobs(forest: LumberJackForest, chatId: string): JobRecord[] {
	return forest
		.listChildren("jobs")
		.map((n) => n.slot as JobRecord | undefined)
		.filter((j): j is JobRecord => !!j && j.chatId === chatId)
		.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
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
	writeJobNode(forest, record);
	emit("jobs-changed", { chatId: init.chatId });
	return record;
}

function updateChatJob(forest: LumberJackForest, id: string, patch: JobPatch): JobRecord | null {
	const record = readJobNode(forest, id);
	if (!record) return null;
	const next: JobRecord = { ...record, ...patch, updatedAt: patch.updatedAt ?? new Date().toISOString() };
	writeJobNode(forest, next);
	emit("jobs-changed", { chatId: next.chatId });
	return next;
}

function removeChatJobs(forest: LumberJackForest, chatId: string): number {
	let removed = 0;
	for (const job of listChatJobs(forest, chatId)) {
		if (forest.deleteNode(`jobs/${job.id}`)) {
			removed++;
		}
	}
	if (removed > 0) emit("jobs-changed", { chatId });
	return removed;
}

export function createLumberJackJobStore(forest: LumberJackForest): JobStore {
	return {
		createJob: (init) => createChatJob(forest, init),
		getJob: (id) => readJobNode(forest, id),
		updateJob: (id, patch) => updateChatJob(forest, id, patch),
		listJobs: (chatId) => listChatJobs(forest, chatId),
		findJobByToolCallId: (chatId, toolCallId) => listChatJobs(forest, chatId).find((j) => j.toolCallId === toolCallId) ?? null,
		deleteJobsForChat: (chatId) => removeChatJobs(forest, chatId),
	};
}
