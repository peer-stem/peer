import type {
	CoverageEntry,
	ExtractionRunUsage,
	GraphChain,
	GraphNode,
	NotesSource,
	Position,
	ProvenancePoint,
	SessionCheckpoint,
} from "../../core/contracts.ts";
import { emit } from "../../core/events.ts";
import type { GraphStore, SourceOrganizationStore } from "../../core/ports.ts";
import {
	emptySourceOrganization,
	parseSourceOrganization,
	type SourceOrganization,
} from "../../core/source-organization.ts";
import type { LumberJackForest, UpsertNodeInput } from "./binding.ts";

interface RootLedgerSlot {
	nodes: GraphNode[];
	chains: GraphChain[];
	checkpoints: SessionCheckpoint[];
	coverage: CoverageEntry[];
}

export interface FsrsCardSchedule {
	due: number | string;
	stability: number;
	difficulty: number;
	elapsed_days?: number;
	scheduled_days?: number;
	reps: number;
	lapses: number;
	learning_steps?: number;
	state: number;
	last_review?: number | string | null;
}

export interface LearnerProfileRecord {
	goals: string[];
	interests: string[];
	learningStyle?: string;
	confidenceCalibration?: number;
	updatedAt: string;
}

export interface FlashcardDeckRecord {
	id: string;
	name: string;
	propositionIds: string[];
	cards: Array<{ id: string; front: string; back: string; propositionId?: string; fsrs?: FsrsCardSchedule }>;
	updatedAt: string;
}

type PropProgress = { mastery?: number; fsrs?: FsrsCardSchedule };

export interface LumberJackLearnerStore {
	readProfile(): LearnerProfileRecord | null;
	writeProfile(profile: LearnerProfileRecord): void;
	updatePropositionProgress(nodeId: string, progress: PropProgress): void;
	readPropositionProgress(nodeId: string): PropProgress | null;
	upsertDeck(deck: FlashcardDeckRecord): void;
	listDecks(): FlashcardDeckRecord[];
}

function isPlainRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

const isString = (v: unknown): v is string => typeof v === "string";

export const isSafeEntityId = (v: unknown): v is string =>
	typeof v === "string" && v.trim().length > 0 && v.trim() !== "." && v.trim() !== ".." &&
	!v.includes("/") && !v.includes("\\") && !v.includes("\0");

const isProvenancePoint = (v: unknown): v is ProvenancePoint =>
	isPlainRecord(v) && isSafeEntityId(v.chatId) && isSafeEntityId(v.messageId);

export const isGraphNode = (v: unknown): v is GraphNode =>
	isPlainRecord(v) &&
	isSafeEntityId(v.id) &&
	isString(v.name) &&
	isString(v.statement) &&
	Array.isArray(v.aliases) &&
	v.aliases.every(isString) &&
	isString(v.createdAt) &&
	Array.isArray(v.provenance) &&
	v.provenance.every(isProvenancePoint);

export const isGraphChain = (v: unknown): v is GraphChain =>
	isPlainRecord(v) &&
	isSafeEntityId(v.id) &&
	Array.isArray(v.premises) &&
	v.premises.length > 0 &&
	v.premises.every(isSafeEntityId) &&
	isSafeEntityId(v.conclusion) &&
	Array.isArray(v.provenance) &&
	v.provenance.every(isProvenancePoint) &&
	isString(v.createdAt);

export const isCheckpoint = (v: unknown): v is SessionCheckpoint =>
	isPlainRecord(v) && isSafeEntityId(v.chatId) && isString(v.foldedAt);

export const isCoverageEntry = (v: unknown): v is CoverageEntry =>
	isPlainRecord(v) &&
	isSafeEntityId(v.chatId) &&
	isString(v.fp) &&
	typeof v.tokens === "number" &&
	Number.isFinite(v.tokens) &&
	isString(v.foldedAt);

export const isNotesSource = (v: unknown): v is NotesSource =>
	isPlainRecord(v) && isSafeEntityId(v.id) && isString(v.filePath) && isString(v.importedAt);

export const isPosition = (v: unknown): v is Position =>
	isPlainRecord(v) && typeof v.x === "number" && Number.isFinite(v.x) && typeof v.y === "number" && Number.isFinite(v.y);

export function sanitizeSegment(raw: string): string {
	if (typeof raw !== "string") throw new Error("Invalid segment: expected string");
	const trimmed = raw.trim();
	if (trimmed === "" || trimmed === "." || trimmed === "..") throw new Error(`Invalid segment: ${raw}`);
	const clean = raw.replace(/[^A-Za-z0-9_.:-]/g, "_");
	if (clean === "" || clean === "." || clean === "..") throw new Error(`Invalid segment: ${raw}`);
	return clean;
}

function readLedgers(forest: LumberJackForest): RootLedgerSlot {
	const raw = forest.getRootSlot<Partial<RootLedgerSlot>>();
	if (!isPlainRecord(raw)) {
		return { nodes: [], chains: [], checkpoints: [], coverage: [] };
	}
	return {
		nodes: Array.isArray(raw.nodes) ? raw.nodes.filter(isGraphNode) : [],
		chains: Array.isArray(raw.chains) ? raw.chains.filter(isGraphChain) : [],
		checkpoints: Array.isArray(raw.checkpoints) ? raw.checkpoints.filter(isCheckpoint) : [],
		coverage: Array.isArray(raw.coverage) ? raw.coverage.filter(isCoverageEntry) : [],
	};
}

function originParentPath(forest: LumberJackForest, chatOrSourceId: string): string | null {
	const clean = sanitizeSegment(chatOrSourceId);
	if (forest.getNode(`knowledge/sources/${clean}`)) return `knowledge/sources/${clean}`;
	if (forest.getNode(`sessions/${clean}`)) return `sessions/${clean}`;
	return null;
}

function extractProgressFields(raw: unknown): PropProgress {
	if (!isPlainRecord(raw)) return {};
	const out: PropProgress = {};
	if (typeof raw.mastery === "number" && Number.isFinite(raw.mastery)) out.mastery = raw.mastery;
	if (isPlainRecord(raw.fsrs)) out.fsrs = raw.fsrs as unknown as FsrsCardSchedule;
	return out;
}

function readPropProgressNode(forest: LumberJackForest, nodeId: string): PropProgress | null {
	const seg = sanitizeSegment(nodeId);
	const snap = forest.getNode(`learner/progress/${seg}`);
	if (snap) {
		return { ...extractProgressFields(snap.metadata), ...extractProgressFields(snap.slot) };
	}
	const legacy = extractProgressFields(forest.getNode(`knowledge/propositions/${seg}`)?.metadata);
	return legacy.mastery !== undefined || legacy.fsrs !== undefined ? legacy : null;
}

function buildPropositionUpsert(forest: LumberJackForest, node: GraphNode): UpsertNodeInput {
	const propPath = `knowledge/propositions/${sanitizeSegment(node.id)}`;
	const existing = forest.getNode(propPath);
	const prevAliases = Array.isArray(existing?.metadata?.aliases) ? (existing.metadata.aliases as string[]) : [];
	const aliases = new Set<string>(prevAliases);
	for (const alias of node.aliases) aliases.add(alias);
	const parents: string[] = [];
	for (const pt of node.provenance) {
		const p = originParentPath(forest, pt.chatId);
		if (p) parents.push(p);
	}
	const progress = readPropProgressNode(forest, node.id);
	return {
		path: propPath,
		type: "leaf",
		kind: "proposition",
		parent_paths: parents,
		metadata: {
			nodeId: node.id,
			name: node.name,
			statement: node.statement,
			aliases: [...aliases],
			createdAt: (existing?.metadata?.createdAt as string | undefined) ?? node.createdAt,
			...(progress?.mastery !== undefined ? { mastery: progress.mastery } : {}),
			...(progress?.fsrs !== undefined ? { fsrs: progress.fsrs } : {}),
		},
	};
}

function buildChainUpserts(assertion: GraphChain): UpsertNodeInput[] {
	const chainSeg = sanitizeSegment(assertion.id);
	const chainPath = `knowledge/chains/${chainSeg}`;
	const premisePaths = assertion.premises.map((pid) => `knowledge/propositions/${sanitizeSegment(pid)}`);
	const conclusionPath = `knowledge/propositions/${sanitizeSegment(assertion.conclusion)}`;
	const chainMeta = {
		chainId: assertion.id,
		premises: assertion.premises,
		conclusion: assertion.conclusion,
		createdAt: assertion.createdAt,
	};
	return [
		{ path: chainPath, type: "leaf", kind: "chain", parent_paths: premisePaths, metadata: chainMeta, slot: assertion },
		{ path: conclusionPath, type: "leaf", kind: "proposition", parent_paths: [chainPath] },
	];
}

function extractCanvasPosition(meta?: Record<string, unknown>): Position | null {
	return isPosition(meta?.canvas) ? { x: meta.canvas.x, y: meta.canvas.y } : null;
}

function readCanvasPositions(forest: LumberJackForest): Record<string, Position> {
	const out: Record<string, Position> = {};
	for (const snap of forest.listChildren("knowledge/propositions")) {
		const pos = extractCanvasPosition(snap.metadata);
		const nodeId = (snap.metadata?.nodeId as string | undefined) ?? snap.name;
		if (pos) out[nodeId] = pos;
	}
	return out;
}

function writeCanvasPositions(forest: LumberJackForest, positions: Record<string, Position>): void {
	const activeProps = forest.listChildren("knowledge/propositions");
	const seen = new Set<string>();
	const batch: UpsertNodeInput[] = [];
	for (const snap of activeProps) {
		const nodeId = (snap.metadata?.nodeId as string | undefined) ?? snap.name;
		seen.add(nodeId);
		const nextPos = positions[nodeId];
		batch.push({
			path: snap.path,
			kind: "proposition",
			metadata: { canvas: isPosition(nextPos) ? { x: nextPos.x, y: nextPos.y } : null },
		});
	}
	for (const [nodeId, pos] of Object.entries(positions)) {
		if (seen.has(nodeId) || !isPosition(pos)) continue;
		batch.push({
			path: `knowledge/propositions/${sanitizeSegment(nodeId)}`,
			type: "leaf",
			kind: "proposition",
			metadata: { nodeId, canvas: { x: pos.x, y: pos.y } },
		});
	}
	if (batch.length > 0) forest.batchUpsertNodes(batch);
}

function rebuildGraphDag(
	forest: LumberJackForest,
	nodes: GraphNode[],
	chains: GraphChain[],
	keepPositions: Record<string, Position>,
): void {
	for (const existingChain of forest.listChildren("knowledge/chains")) {
		forest.deleteNode(existingChain.path);
	}
	const keepNodeIds = new Set(nodes.map((n) => sanitizeSegment(n.id)));
	for (const existingProp of forest.listChildren("knowledge/propositions")) {
		if (!keepNodeIds.has(existingProp.name)) forest.deleteNode(existingProp.path);
	}
	const batch: UpsertNodeInput[] = [];
	for (const node of nodes) {
		const up = buildPropositionUpsert(forest, node);
		const pos = keepPositions[node.id];
		if (pos) up.metadata = { ...up.metadata, canvas: { x: pos.x, y: pos.y } };
		batch.push(up);
	}
	for (const chain of chains) batch.push(...buildChainUpserts(chain));
	if (batch.length > 0) forest.batchUpsertNodes(batch);
}

function mergeSourceRecord(prev: NotesSource | undefined, incoming: NotesSource): NotesSource {
	if (!prev) return incoming;
	const { extractions: _dropped, ...rest } = incoming;
	return prev.extractions !== undefined ? { ...rest, extractions: prev.extractions } : rest;
}

function upsertSourceNode(forest: LumberJackForest, source: NotesSource): void {
	const nodePath = `knowledge/sources/${sanitizeSegment(source.id)}`;
	const prevSlot = forest.getNode(nodePath)?.slot;
	const merged = mergeSourceRecord(isNotesSource(prevSlot) ? prevSlot : undefined, source);
	forest.upsertNode({
		path: nodePath,
		type: "leaf",
		kind: "source",
		metadata: { sourceId: source.id, filePath: source.filePath },
		slot: merged,
	});
}

function deleteSourceNodes(forest: LumberJackForest, ids: ReadonlySet<string>): number {
	let removed = 0;
	for (const id of ids) {
		if (forest.deleteNode(`knowledge/sources/${sanitizeSegment(id)}`)) removed++;
	}
	return removed;
}

function appendUsageToSource(forest: LumberJackForest, id: string, entry: ExtractionRunUsage): void {
	const nodePath = `knowledge/sources/${sanitizeSegment(id)}`;
	const existing = forest.getNode(nodePath)?.slot;
	if (!isNotesSource(existing)) return;
	const list = existing.extractions ?? [];
	if (list.some((e) => e.startedAt === entry.startedAt)) return;
	forest.upsertNode({ path: nodePath, kind: "source", slot: { ...existing, extractions: [...list, entry] } });
}

function rewriteGraphLedgers(forest: LumberJackForest, next: Partial<RootLedgerSlot>): void {
	const prevPositions = readCanvasPositions(forest);
	const ledgers = readLedgers(forest);
	if (next.nodes !== undefined) ledgers.nodes = next.nodes.filter(isGraphNode);
	if (next.chains !== undefined) ledgers.chains = next.chains.filter(isGraphChain);
	if (next.coverage !== undefined) ledgers.coverage = next.coverage.filter(isCoverageEntry);
	if (next.checkpoints !== undefined) ledgers.checkpoints = next.checkpoints.filter(isCheckpoint);
	forest.setRootSlot(ledgers);
	if (next.nodes !== undefined || next.chains !== undefined) {
		rebuildGraphDag(forest, ledgers.nodes, ledgers.chains, prevPositions);
	}
}

function syncSourceFolderDag(forest: LumberJackForest, org: SourceOrganization): void {
	const batch: UpsertNodeInput[] = [];
	for (const folder of org.folders) {
		const parentPaths = folder.parentId ? [`knowledge/folders/${sanitizeSegment(folder.parentId)}`] : [];
		batch.push({
			path: `knowledge/folders/${sanitizeSegment(folder.id)}`,
			type: "branch",
			kind: "folder",
			parent_paths: parentPaths,
			clear_parents: true,
			metadata: { folderId: folder.id, name: folder.name },
		});
	}
	for (const [sourceId, placement] of Object.entries(org.placements ?? {})) {
		const folderId = (placement as { folderId?: string | null } | null)?.folderId;
		if (!folderId) continue;
		batch.push({
			path: `knowledge/sources/${sanitizeSegment(sourceId)}`,
			type: "leaf",
			kind: "source",
			parent_paths: [`knowledge/folders/${sanitizeSegment(folderId)}`],
		});
	}
	if (batch.length > 0) forest.batchUpsertNodes(batch);
}

function listStoredSources(forest: LumberJackForest): NotesSource[] {
	const out: NotesSource[] = [];
	for (const node of forest.listChildren("knowledge/sources")) {
		if (isNotesSource(node.slot)) out.push(node.slot);
	}
	return out;
}

function updatePropProgressNode(forest: LumberJackForest, nodeId: string, progress: PropProgress): void {
	const seg = sanitizeSegment(nodeId);
	const prev = readPropProgressNode(forest, nodeId) ?? {};
	const merged: PropProgress = { ...prev };
	if (progress.mastery !== undefined) merged.mastery = progress.mastery;
	if (progress.fsrs !== undefined) merged.fsrs = progress.fsrs;
	forest.upsertNode({
		path: `learner/progress/${seg}`,
		type: "leaf",
		kind: "proposition_progress",
		metadata: { nodeId, ...merged },
		slot: merged,
	});
	if (readLedgers(forest).nodes.some((n) => sanitizeSegment(n.id) === seg)) {
		forest.upsertNode({
			path: `knowledge/propositions/${seg}`,
			type: "leaf",
			kind: "proposition",
			metadata: { nodeId, ...merged },
		});
	}
}

function upsertDeckNode(forest: LumberJackForest, deck: FlashcardDeckRecord): void {
	const propParents = deck.propositionIds.map((pid) => `knowledge/propositions/${sanitizeSegment(pid)}`);
	forest.upsertNode({
		path: `learner/decks/${sanitizeSegment(deck.id)}`,
		type: "leaf",
		kind: "deck",
		parent_paths: propParents,
		metadata: { deckId: deck.id, name: deck.name, cardCount: deck.cards.length },
		slot: deck,
	});
}

function listDeckNodes(forest: LumberJackForest): FlashcardDeckRecord[] {
	const out: FlashcardDeckRecord[] = [];
	for (const node of forest.listChildren("learner/decks")) {
		const slot = node.slot as FlashcardDeckRecord | undefined;
		if (slot && typeof slot.id === "string") out.push(slot);
	}
	return out;
}

function buildGraphStore(forest: LumberJackForest): GraphStore {
	return {
		appendNode: (node) => {
			if (!isGraphNode(node)) return;
			const ledgers = readLedgers(forest);
			ledgers.nodes.push(node);
			forest.setRootSlot(ledgers);
			forest.upsertNode(buildPropositionUpsert(forest, node));
		},
		readNodes: () => readLedgers(forest).nodes,
		appendChain: (assertion) => {
			if (!isGraphChain(assertion)) return;
			const ledgers = readLedgers(forest);
			ledgers.chains.push(assertion);
			forest.setRootSlot(ledgers);
			forest.batchUpsertNodes(buildChainUpserts(assertion));
		},
		readCheckpoints: () => readLedgers(forest).checkpoints,
		readChains: () => readLedgers(forest).chains,
		appendCheckpoint: (checkpoint) => {
			if (!isCheckpoint(checkpoint)) return;
			const ledgers = readLedgers(forest);
			ledgers.checkpoints.push(checkpoint);
			forest.setRootSlot(ledgers);
		},
		appendCoverage: (entry) => {
			if (!isCoverageEntry(entry)) return;
			const ledgers = readLedgers(forest);
			ledgers.coverage.push(entry);
			forest.setRootSlot(ledgers);
		},
		readCoverage: () => readLedgers(forest).coverage,
		upsertSource: (source) => upsertSourceNode(forest, source),
		readSources: () => listStoredSources(forest),
		deleteSources: (ids) => deleteSourceNodes(forest, ids),
		appendSourceUsage: (id, entry) => appendUsageToSource(forest, id, entry),
		readPositions: () => readCanvasPositions(forest),
		writePositions: (positions) => writeCanvasPositions(forest, positions),
		rewriteLedgers: (next) => rewriteGraphLedgers(forest, next),
	};
}

function buildLearnerStore(forest: LumberJackForest): LumberJackLearnerStore {
	return {
		readProfile: () => (forest.getNode("learner/profile")?.slot as LearnerProfileRecord | undefined) ?? null,
		writeProfile: (profile) => {
			forest.upsertNode({ path: "learner/profile", type: "leaf", kind: "learner_profile", slot: profile });
		},
		updatePropositionProgress: (nodeId, progress) => updatePropProgressNode(forest, nodeId, progress),
		readPropositionProgress: (nodeId) => readPropProgressNode(forest, nodeId),
		upsertDeck: (deck) => upsertDeckNode(forest, deck),
		listDecks: () => listDeckNodes(forest),
	};
}

export function createLumberJackGraphStores(forest: LumberJackForest): {
	graphStore: GraphStore;
	sourceOrganizationStore: SourceOrganizationStore;
	learnerStore: LumberJackLearnerStore;
} {
	const sourceOrganizationStore: SourceOrganizationStore = {
		read(): SourceOrganization {
			const snap = forest.getNode("config/source-organization");
			return snap?.slot ? parseSourceOrganization(snap.slot) : emptySourceOrganization();
		},
		write(state: SourceOrganization): void {
			const valid = parseSourceOrganization(state);
			forest.upsertNode({ path: "config/source-organization", type: "leaf", kind: "config", slot: valid });
			syncSourceFolderDag(forest, valid);
			emit("sources-changed", {});
		},
	};
	return {
		graphStore: buildGraphStore(forest),
		sourceOrganizationStore,
		learnerStore: buildLearnerStore(forest),
	};
}
