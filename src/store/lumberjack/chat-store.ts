import { createHash } from "node:crypto";
import type {
	ChatRecord,
	ChatSettings,
	ChatSummary,
	ExtractionRunUsage,
	ImageSnapshot,
	PlanTree,
	SideChatThread,
	TurnUsage,
} from "../../core/contracts.ts";
import { CURRENT_CHAT_VERSION } from "../../core/contracts.ts";
import { emit } from "../../core/events.ts";
import type { LhMessage } from "../../core/native-messages.ts";
import { activeProblemOf, danglingQuestionOf } from "../../core/native-messages.ts";
import { phaseAt3Lh } from "../../core/phases.ts";
import type { ChatStore } from "../../core/ports.ts";
import type { EntryWire, LumberJackForest, UpsertNodeInput } from "./binding.ts";

interface StoredImageRef {
	mimeType: ImageSnapshot["mimeType"];
	sha256: string;
	width: number;
	height: number;
}

interface SessionSlotRecord {
	version: number;
	id: string;
	title: string;
	createdAt: string;
	updatedAt: string;
	kind?: ChatRecord["kind"];
	messages: LhMessage[];
	tree?: PlanTree;
	turns?: TurnUsage[];
	extractions?: ExtractionRunUsage[];
	settings?: ChatSettings;
	sideChats?: SideChatThread[];
	imageRefs?: Record<string, StoredImageRef>;
}

export interface LumberJackChatStore extends ChatStore {
	importChatRecord(record: ChatRecord): { imported: boolean; objectsDeduplicated: number; objectsStored: number };
}

const VALID_ID_RE = /^[A-Za-z0-9_-]+$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const isValidId = (v: unknown): v is string => typeof v === "string" && VALID_ID_RE.test(v);

function normalizeSessionHeader(slot: { title?: unknown; createdAt?: unknown; updatedAt?: unknown }): {
	title: string;
	createdAt: string;
	updatedAt: string;
} {
	const createdAt = typeof slot.createdAt === "string" ? slot.createdAt : "";
	const updatedAt = typeof slot.updatedAt === "string" ? slot.updatedAt : createdAt;
	const title = typeof slot.title === "string" && slot.title.trim() ? slot.title : "Untitled session";
	return { title, createdAt, updatedAt };
}

function sessionPathFor(id: string): string {
	if (!isValidId(id)) throw new Error(`Invalid chat id: ${id}`);
	return `sessions/${id}`;
}

function rankForIndex(index: number): string {
	return String(index).padStart(8, "0");
}

function appendSideThreadEntries(entries: EntryWire[], thread: SideChatThread): void {
	const anchorId = thread.anchor?.messageId ?? (thread as { anchorMessageId?: string }).anchorMessageId ?? "";
	for (let j = 0; j < thread.messages.length; j++) {
		const sm = thread.messages[j]!;
		entries.push({
			id: sm.id || `${thread.id}_${j}`,
			parent_id: anchorId,
			rank: `${thread.id}:${rankForIndex(j)}`,
			content: sm,
			metadata: { channel: "side-chat", threadId: thread.id, role: sm.role },
		});
	}
}

function buildSessionEntries(messages: LhMessage[], sideChats?: SideChatThread[]): EntryWire[] {
	const entries: EntryWire[] = [];
	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i]!;
		entries.push({
			id: msg.id || `msg_${i}`,
			rank: rankForIndex(i),
			content: msg,
			metadata: { channel: "main", role: (msg as { role?: string }).role ?? "unknown" },
		});
	}
	if (!sideChats) return entries;
	for (const thread of sideChats) appendSideThreadEntries(entries, thread);
	return entries;
}

function buildPlanDagUpserts(chatId: string, tree: PlanTree): UpsertNodeInput[] {
	const sessionPath = sessionPathFor(chatId);
	const prereqsByTarget = new Map<string, string[]>();
	for (const edge of Array.isArray(tree.edges) ? tree.edges : []) {
		if (!isValidId(edge?.from) || !isValidId(edge?.to)) continue;
		const list = prereqsByTarget.get(edge.to) ?? [];
		list.push(`plans/${chatId}/${edge.from}`);
		prereqsByTarget.set(edge.to, list);
	}
	const validNodes = (Array.isArray(tree.nodes) ? tree.nodes : []).filter((planNode) => isValidId(planNode?.id));
	return validNodes.map((planNode) => ({
		path: `plans/${chatId}/${planNode.id}`,
		type: "leaf" as const,
		kind: "plan_node",
		parent_paths: [sessionPath, ...(prereqsByTarget.get(planNode.id) ?? [])],
		clear_parents: true,
		metadata: {
			chatId,
			nodeId: planNode.id,
			title: planNode.title,
			summary: planNode.summary ?? "",
			version: tree.version,
		},
	}));
}

function hydrateImages(
	forest: LumberJackForest,
	refs?: Record<string, StoredImageRef>,
): Record<string, ImageSnapshot> | undefined {
	if (!refs) return undefined;
	const keys = Object.keys(refs);
	if (keys.length === 0) return undefined;
	const out: Record<string, ImageSnapshot> = {};
	for (const snapshotId of keys) {
		const ref = refs[snapshotId]!;
		const obj = forest.getObject(ref.sha256);
		if (obj.found && obj.data_base64 !== undefined) {
			out[snapshotId] = { mimeType: ref.mimeType, data: obj.data_base64, width: ref.width, height: ref.height };
		}
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

function slotToChatRecord(forest: LumberJackForest, slot: SessionSlotRecord): ChatRecord | null {
	if (typeof slot.version === "number" && slot.version > CURRENT_CHAT_VERSION) return null;
	const images = hydrateImages(forest, slot.imageRefs);
	const { imageRefs: _refs, ...rest } = slot;
	return images ? { ...rest, imageSnapshots: images } : rest;
}

function toChatSummary(slot: SessionSlotRecord): ChatSummary | null {
	if (typeof slot.version === "number" && slot.version > CURRENT_CHAT_VERSION) return null;
	try {
		const { title, createdAt, updatedAt } = normalizeSessionHeader(slot);
		return {
			id: slot.id,
			title,
			createdAt,
			updatedAt,
			kind: slot.kind ?? "teach",
			messageCount: slot.messages.length,
			phase: phaseAt3Lh(slot.messages),
			pendingQuestion: danglingQuestionOf(slot.messages) !== null,
			pendingProblem: activeProblemOf(slot.messages) !== null,
			...(slot.settings ? { settings: slot.settings } : {}),
		};
	} catch {
		return null;
	}
}

function readSessionSlot(forest: LumberJackForest, id: string): SessionSlotRecord | null {
	if (!isValidId(id)) return null;
	const snap = forest.getNode(`sessions/${id}`);
	if (!snap?.slot || typeof snap.slot !== "object") return null;
	const slot = snap.slot as SessionSlotRecord;
	if (typeof slot.version === "number" && slot.version > CURRENT_CHAT_VERSION) return null;
	return slot;
}

function requireSessionSlot(forest: LumberJackForest, id: string): SessionSlotRecord {
	const slot = readSessionSlot(forest, id);
	if (!slot) throw new Error(`Chat not found: ${id}`);
	return slot;
}

function writeSessionSlot(forest: LumberJackForest, slot: SessionSlotRecord, syncEntries = false): void {
	const stamped: SessionSlotRecord = { ...slot, version: CURRENT_CHAT_VERSION };
	const nodePath = sessionPathFor(slot.id);
	forest.upsertNode({
		path: nodePath,
		type: "leaf",
		kind: "session",
		metadata: { title: stamped.title, kind: stamped.kind ?? "teach", updatedAt: stamped.updatedAt },
		slot: stamped,
	});
	if (syncEntries) {
		forest.setEntries(nodePath, "main", buildSessionEntries(stamped.messages, stamped.sideChats));
	}
}

function storeImageOnSlot(
	forest: LumberJackForest,
	slot: SessionSlotRecord,
	snapshotId: string,
	image: ImageSnapshot,
): boolean {
	const digest = createHash("sha256").update(Buffer.from(image.data, "base64")).digest("hex");
	if (!SHA256_RE.test(snapshotId) || digest !== snapshotId) {
		throw new Error("Invalid image snapshot identity");
	}
	const receipt = forest.putObject(snapshotId, image.mimeType, image.data);
	slot.imageRefs = {
		...slot.imageRefs,
		[snapshotId]: { mimeType: image.mimeType, sha256: snapshotId, width: image.width, height: image.height },
	};
	return receipt.existed;
}

function importFullChatRecord(
	forest: LumberJackForest,
	record: ChatRecord,
): { imported: boolean; objectsDeduplicated: number; objectsStored: number } {
	if (!isValidId(record.id)) return { imported: false, objectsDeduplicated: 0, objectsStored: 0 };
	if (typeof record.version === "number" && record.version > CURRENT_CHAT_VERSION) {
		return { imported: false, objectsDeduplicated: 0, objectsStored: 0 };
	}
	const { imageSnapshots, ...rest } = record;
	const slot: SessionSlotRecord = { ...rest, ...normalizeSessionHeader(record), version: CURRENT_CHAT_VERSION };
	let objectsDeduplicated = 0;
	let objectsStored = 0;
	if (imageSnapshots) {
		for (const [snapId, img] of Object.entries(imageSnapshots)) {
			if (storeImageOnSlot(forest, slot, snapId, img)) objectsDeduplicated++;
			else objectsStored++;
		}
	}
	writeSessionSlot(forest, slot, true);
	if (slot.tree && Array.isArray(slot.tree.nodes) && slot.tree.nodes.length > 0) {
		const dag = buildPlanDagUpserts(slot.id, slot.tree);
		if (dag.length > 0) forest.batchUpsertNodes(dag);
	}
	return { imported: true, objectsDeduplicated, objectsStored };
}

function createChatInForest(forest: LumberJackForest, title: string, kind?: "practice"): ChatRecord {
	const now = new Date().toISOString();
	const slot: SessionSlotRecord = {
		version: CURRENT_CHAT_VERSION,
		id: `chat_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`,
		title: title.trim() || "Untitled session",
		createdAt: now,
		updatedAt: now,
		messages: [],
		...(kind === "practice" ? { kind: "practice" as const } : {}),
	};
	writeSessionSlot(forest, slot, true);
	emit("chats-changed", {});
	return slot;
}

function deleteChatFromForest(forest: LumberJackForest, id: string): boolean {
	if (!isValidId(id)) return false;
	for (const planChild of forest.listChildren(`plans/${id}`)) {
		forest.deleteNode(planChild.path);
	}
	forest.deleteNode(`plans/${id}`);
	const deleted = forest.deleteNode(`sessions/${id}`);
	if (deleted) emit("chats-changed", {});
	return deleted;
}

function listSessionSummaries(forest: LumberJackForest): ChatSummary[] {
	const summaries: ChatSummary[] = [];
	for (const node of forest.listChildren("sessions")) {
		const summary = node.slot ? toChatSummary(node.slot as SessionSlotRecord) : null;
		if (summary) summaries.push(summary);
	}
	return summaries.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
}

function saveSessionMessages(forest: LumberJackForest, id: string, messages: LhMessage[]): void {
	const slot = requireSessionSlot(forest, id);
	slot.messages = messages;
	slot.updatedAt = new Date().toISOString();
	writeSessionSlot(forest, slot, true);
}

function saveSessionTree(forest: LumberJackForest, id: string, tree: PlanTree): void {
	const slot = requireSessionSlot(forest, id);
	slot.tree = tree;
	writeSessionSlot(forest, slot, false);
	const dag = buildPlanDagUpserts(id, tree);
	if (dag.length > 0) forest.batchUpsertNodes(dag);
}

function appendSessionTurnUsage(forest: LumberJackForest, id: string, entry: TurnUsage): void {
	const slot = requireSessionSlot(forest, id);
	if ((slot.turns ?? []).some((t) => t.id === entry.id)) return;
	slot.turns = [...(slot.turns ?? []), entry];
	writeSessionSlot(forest, slot, false);
}

function appendSessionExtractionUsage(forest: LumberJackForest, id: string, entry: ExtractionRunUsage): void {
	const slot = requireSessionSlot(forest, id);
	if ((slot.extractions ?? []).some((e) => e.startedAt === entry.startedAt)) return;
	slot.extractions = [...(slot.extractions ?? []), entry];
	writeSessionSlot(forest, slot, false);
}

function renameSessionInForest(forest: LumberJackForest, id: string, title: string): ChatRecord {
	const slot = requireSessionSlot(forest, id);
	slot.title = title.trim() || "Untitled session";
	writeSessionSlot(forest, slot, false);
	emit("chats-changed", {});
	return slotToChatRecord(forest, slot)!;
}

function updateSessionSideChats(
	forest: LumberJackForest,
	id: string,
	update: (current: SideChatThread[]) => SideChatThread[],
): SideChatThread[] | null {
	const slot = readSessionSlot(forest, id);
	if (!slot) return null;
	const next = update(slot.sideChats ?? []);
	slot.sideChats = next;
	writeSessionSlot(forest, slot, true);
	return next;
}

export function createLumberJackChatStore(forest: LumberJackForest): LumberJackChatStore {
	return {
		createChat: (title, kind) => createChatInForest(forest, title, kind),
		getChat: (id) => {
			const slot = readSessionSlot(forest, id);
			return slot ? slotToChatRecord(forest, slot) : null;
		},
		listChats: () => listSessionSummaries(forest),
		saveMessages: (id, messages) => saveSessionMessages(forest, id, messages),
		saveImageSnapshot: (id, snapshotId, image) => {
			const slot = requireSessionSlot(forest, id);
			if (slot.imageRefs?.[snapshotId]) return;
			storeImageOnSlot(forest, slot, snapshotId, image);
			writeSessionSlot(forest, slot, false);
		},
		saveTree: (id, tree) => saveSessionTree(forest, id, tree),
		appendTurnUsage: (id, entry) => appendSessionTurnUsage(forest, id, entry),
		appendExtractionUsage: (id, entry) => appendSessionExtractionUsage(forest, id, entry),
		saveSettings: (id, settings) => {
			const slot = requireSessionSlot(forest, id);
			slot.settings = settings;
			writeSessionSlot(forest, slot, false);
		},
		renameChat: (id, title) => renameSessionInForest(forest, id, title),
		deleteChat: (id) => deleteChatFromForest(forest, id),
		updateSideChats: (id, update) => updateSessionSideChats(forest, id, update),
		importChatRecord: (record) => importFullChatRecord(forest, record),
	};
}
