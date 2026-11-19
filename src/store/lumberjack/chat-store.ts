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
import { phaseAt3Lh, type Phase3 } from "../../core/phases.ts";
import type { ChatStore } from "../../core/ports.ts";
import type { LumberJackForest, NodeSnapshot, UpsertNodeInput } from "./binding.ts";
import {
	appendCanonicalExtractionUsage,
	appendCanonicalTurnUsage,
	readCanonicalSessionEvents,
	syncSessionMainEntries,
	syncSessionSideChatEvents,
} from "./chat-events.ts";
import { hydrateSessionImages, storeSessionImageObject, type StoredImageRef } from "./chat-images.ts";

interface SessionHeaderSlot {
	version: number;
	id: string;
	title: string;
	createdAt: string;
	updatedAt: string;
	kind?: ChatRecord["kind"];
	tree?: PlanTree;
	settings?: ChatSettings;
	imageRefs?: Record<string, StoredImageRef>;
}

export interface LumberJackChatStore extends ChatStore {
	importChatRecord(record: ChatRecord): { imported: boolean; objectsDeduplicated: number; objectsStored: number };
}

const VALID_ID_RE = /^[A-Za-z0-9_-]+$/;
const isValidId = (v: unknown): v is string => typeof v === "string" && VALID_ID_RE.test(v);

function sessionPathFor(id: string): string {
	if (!isValidId(id)) throw new Error(`Invalid chat id: ${id}`);
	return `sessions/${id}`;
}

function normalizeHeaderFields(raw: { title?: unknown; createdAt?: unknown; updatedAt?: unknown }): {
	title: string;
	createdAt: string;
	updatedAt: string;
} {
	const createdAt = typeof raw.createdAt === "string" ? raw.createdAt : "";
	const updatedAt = typeof raw.updatedAt === "string" ? raw.updatedAt : createdAt;
	const title = typeof raw.title === "string" && raw.title.trim() ? raw.title : "Untitled session";
	return { title, createdAt, updatedAt };
}

function deriveSummaryMetadata(header: SessionHeaderSlot, messages: readonly LhMessage[]): Record<string, unknown> {
	return {
		title: header.title,
		kind: header.kind ?? "teach",
		createdAt: header.createdAt,
		updatedAt: header.updatedAt,
		messageCount: messages.length,
		phase: phaseAt3Lh(messages),
		pendingQuestion: danglingQuestionOf(messages) !== null,
		pendingProblem: activeProblemOf(messages) !== null,
	};
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
	const validNodes = (Array.isArray(tree.nodes) ? tree.nodes : []).filter((n) => isValidId(n?.id));
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

function readHeaderNode(forest: LumberJackForest, id: string): { snap: NodeSnapshot; header: SessionHeaderSlot } | null {
	if (!isValidId(id)) return null;
	const snap = forest.getNode(`sessions/${id}`);
	if (!snap?.slot || typeof snap.slot !== "object") return null;
	const header = snap.slot as SessionHeaderSlot;
	if (typeof header.version === "number" && header.version > CURRENT_CHAT_VERSION) return null;
	return { snap, header };
}

function requireHeader(forest: LumberJackForest, id: string): SessionHeaderSlot {
	const found = readHeaderNode(forest, id);
	if (!found) throw new Error(`Chat not found: ${id}`);
	return found.header;
}

function writeSessionHeader(
	forest: LumberJackForest,
	header: SessionHeaderSlot,
	messagesForMeta?: readonly LhMessage[],
): void {
	const stamped: SessionHeaderSlot = { ...header, version: CURRENT_CHAT_VERSION };
	const metadata = messagesForMeta
		? deriveSummaryMetadata(stamped, messagesForMeta)
		: { title: stamped.title, kind: stamped.kind ?? "teach", createdAt: stamped.createdAt, updatedAt: stamped.updatedAt };
	forest.upsertNode({
		path: sessionPathFor(header.id),
		type: "leaf",
		kind: "session",
		metadata,
		slot: stamped,
	});
}

function assembleChatRecord(forest: LumberJackForest, header: SessionHeaderSlot): ChatRecord {
	const nodePath = sessionPathFor(header.id);
	const events = readCanonicalSessionEvents(forest, nodePath);
	const images = hydrateSessionImages(forest, header.imageRefs);
	const { imageRefs: _refs, ...restHeader } = header;
	return {
		...restHeader,
		messages: events.messages,
		...(events.sideChats ? { sideChats: events.sideChats } : {}),
		...(events.turns ? { turns: events.turns } : {}),
		...(events.extractions ? { extractions: events.extractions } : {}),
		...(images ? { imageSnapshots: images } : {}),
	};
}

function summaryFromNode(forest: LumberJackForest, snap: NodeSnapshot): ChatSummary | null {
	if (!snap.slot || typeof snap.slot !== "object") return null;
	const header = snap.slot as SessionHeaderSlot;
	if (typeof header.version === "number" && header.version > CURRENT_CHAT_VERSION) return null;
	try {
		const { title, createdAt, updatedAt } = normalizeHeaderFields(header);
		const meta = snap.metadata ?? {};
		const hasFastMeta = typeof meta.messageCount === "number" && typeof meta.phase === "string";
		const messages = hasFastMeta ? null : readCanonicalSessionEvents(forest, snap.path).messages;
		return {
			id: header.id,
			title,
			createdAt,
			updatedAt,
			kind: header.kind ?? "teach",
			messageCount: hasFastMeta ? (meta.messageCount as number) : messages!.length,
			phase: hasFastMeta ? (meta.phase as Phase3) : phaseAt3Lh(messages!),
			pendingQuestion: hasFastMeta ? Boolean(meta.pendingQuestion) : danglingQuestionOf(messages!) !== null,
			pendingProblem: hasFastMeta ? Boolean(meta.pendingProblem) : activeProblemOf(messages!) !== null,
			...(header.settings ? { settings: header.settings } : {}),
		};
	} catch {
		return null;
	}
}

function importFullChatRecord(
	forest: LumberJackForest,
	record: ChatRecord,
): { imported: boolean; objectsDeduplicated: number; objectsStored: number } {
	if (!isValidId(record.id)) return { imported: false, objectsDeduplicated: 0, objectsStored: 0 };
	if (typeof record.version === "number" && record.version > CURRENT_CHAT_VERSION) {
		return { imported: false, objectsDeduplicated: 0, objectsStored: 0 };
	}
	const { title, createdAt, updatedAt } = normalizeHeaderFields(record);
	let imageRefs: Record<string, StoredImageRef> | undefined;
	let objectsDeduplicated = 0;
	let objectsStored = 0;
	for (const [snapId, img] of Object.entries(record.imageSnapshots ?? {})) {
		const stored = storeSessionImageObject(forest, imageRefs, snapId, img);
		imageRefs = stored.nextRefs;
		if (stored.existed) objectsDeduplicated++;
		else objectsStored++;
	}
	const header: SessionHeaderSlot = {
		version: CURRENT_CHAT_VERSION,
		id: record.id,
		title,
		createdAt,
		updatedAt,
		...(record.kind ? { kind: record.kind } : {}),
		...(record.tree ? { tree: record.tree } : {}),
		...(record.settings ? { settings: record.settings } : {}),
		...(imageRefs ? { imageRefs } : {}),
	};
	const nodePath = sessionPathFor(record.id);
	writeSessionHeader(forest, header, record.messages);
	syncSessionMainEntries(forest, nodePath, record.messages);
	if (record.sideChats?.length) syncSessionSideChatEvents(forest, nodePath, record.sideChats);
	for (const t of record.turns ?? []) appendCanonicalTurnUsage(forest, nodePath, t);
	for (const ex of record.extractions ?? []) appendCanonicalExtractionUsage(forest, nodePath, ex);
	if (header.tree && Array.isArray(header.tree.nodes) && header.tree.nodes.length > 0) {
		const dag = buildPlanDagUpserts(header.id, header.tree);
		if (dag.length > 0) forest.batchUpsertNodes(dag);
	}
	return { imported: true, objectsDeduplicated, objectsStored };
}

function createChatInForest(forest: LumberJackForest, title: string, kind?: "practice"): ChatRecord {
	const now = new Date().toISOString();
	const header: SessionHeaderSlot = {
		version: CURRENT_CHAT_VERSION,
		id: `chat_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`,
		title: title.trim() || "Untitled session",
		createdAt: now,
		updatedAt: now,
		...(kind === "practice" ? { kind: "practice" as const } : {}),
	};
	const nodePath = sessionPathFor(header.id);
	writeSessionHeader(forest, header, []);
	syncSessionMainEntries(forest, nodePath, []);
	forest.noteStoreEmittedEvent(`record-changed:${header.id}`);
	emit("chats-changed", {});
	return { ...header, messages: [] };
}

function deleteChatFromForest(forest: LumberJackForest, id: string): boolean {
	if (!isValidId(id)) return false;
	for (const planChild of forest.listChildren(`plans/${id}`)) {
		forest.deleteNode(planChild.path);
	}
	forest.deleteNode(`plans/${id}`);
	const deleted = forest.deleteNode(`sessions/${id}`);
	if (deleted) {
		forest.noteStoreEmittedEvent(`record-changed:${id}`);
		emit("chats-changed", {});
	}
	return deleted;
}

function saveChatMessages(forest: LumberJackForest, id: string, messages: LhMessage[]): void {
	const header = requireHeader(forest, id);
	header.updatedAt = new Date().toISOString();
	writeSessionHeader(forest, header, messages);
	syncSessionMainEntries(forest, sessionPathFor(id), messages);
}

function saveChatImage(forest: LumberJackForest, id: string, snapshotId: string, image: ImageSnapshot): void {
	const header = requireHeader(forest, id);
	if (header.imageRefs?.[snapshotId]) return;
	header.imageRefs = storeSessionImageObject(forest, header.imageRefs, snapshotId, image).nextRefs;
	writeSessionHeader(forest, header);
}

function saveChatPlanTree(forest: LumberJackForest, id: string, tree: PlanTree): void {
	const header = requireHeader(forest, id);
	header.tree = tree;
	writeSessionHeader(forest, header);
	const dag = buildPlanDagUpserts(id, tree);
	if (dag.length > 0) forest.batchUpsertNodes(dag);
}

function renameChatHeader(forest: LumberJackForest, id: string, title: string): ChatRecord {
	const header = requireHeader(forest, id);
	header.title = title.trim() || "Untitled session";
	forest.noteStoreEmittedEvent(`record-changed:${id}`);
	writeSessionHeader(forest, header);
	emit("chats-changed", {});
	return assembleChatRecord(forest, header);
}

function mutateSideChats(
	forest: LumberJackForest,
	id: string,
	update: (threads: SideChatThread[]) => SideChatThread[],
): SideChatThread[] | null {
	const found = readHeaderNode(forest, id);
	if (!found) return null;
	const nodePath = sessionPathFor(id);
	const current = readCanonicalSessionEvents(forest, nodePath).sideChats ?? [];
	const next = update(current);
	syncSessionSideChatEvents(forest, nodePath, next);
	return next;
}

export function createLumberJackChatStore(forest: LumberJackForest): LumberJackChatStore {
	return {
		createChat: (title, kind) => createChatInForest(forest, title, kind),
		getChat: (id) => {
			const found = readHeaderNode(forest, id);
			return found ? assembleChatRecord(forest, found.header) : null;
		},
		listChats: () =>
			forest
				.listChildren("sessions")
				.map((snap) => summaryFromNode(forest, snap))
				.filter((s): s is ChatSummary => s !== null)
				.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "")),
		saveMessages: (id, messages) => saveChatMessages(forest, id, messages),
		saveImageSnapshot: (id, snapshotId, image) => saveChatImage(forest, id, snapshotId, image),
		saveTree: (id, tree) => saveChatPlanTree(forest, id, tree),
		appendTurnUsage: (id, entry) => {
			requireHeader(forest, id);
			appendCanonicalTurnUsage(forest, sessionPathFor(id), entry);
		},
		appendExtractionUsage: (id, entry) => {
			requireHeader(forest, id);
			appendCanonicalExtractionUsage(forest, sessionPathFor(id), entry);
		},
		saveSettings: (id, settings) => {
			const header = requireHeader(forest, id);
			header.settings = settings;
			writeSessionHeader(forest, header);
		},
		renameChat: (id, title) => renameChatHeader(forest, id, title),
		deleteChat: (id) => deleteChatFromForest(forest, id),
		updateSideChats: (id, update) => mutateSideChats(forest, id, update),
		importChatRecord: (record) => importFullChatRecord(forest, record),
	};
}
