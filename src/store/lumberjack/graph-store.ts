import type {
	CoverageEntry,
	ExtractionRunUsage,
	GraphChain,
	GraphNode,
	NotesSource,
	Position,
	SessionCheckpoint,
} from "../../core/contracts.ts";
import { emit } from "../../core/events.ts";
import type { GraphStore, SourceOrganizationStore } from "../../core/ports.ts";
import { emptySourceOrganization, parseSourceOrganization, type SourceOrganization } from "../../core/source-organization.ts";
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

export interface LumberJackLearnerStore {
	readProfile(): LearnerProfileRecord | null;
	writeProfile(profile: LearnerProfileRecord): void;
	updatePropositionProgress(nodeId: string, progress: { mastery?: number; fsrs?: FsrsCardSchedule }): void;
	readPropositionProgress(nodeId: string): { mastery?: number; fsrs?: FsrsCardSchedule } | null;
	upsertDeck(deck: FlashcardDeckRecord): void;
	listDecks(): FlashcardDeckRecord[];
}

function sanitizeSegment(raw: string): string {
	return raw.replace(/[^A-Za-z0-9_.:-]/g, "_");
}

function readLedgers(forest: LumberJackForest): RootLedgerSlot {
	const raw = forest.getRootSlot<Partial<RootLedgerSlot>>();
	if (!raw || typeof raw !== "object") {
		return { nodes: [], chains: [], checkpoints: [], coverage: [] };
	}
	return {
		nodes: Array.isArray(raw.nodes) ? raw.nodes : [],
		chains: Array.isArray(raw.chains) ? raw.chains : [],
		checkpoints: Array.isArray(raw.checkpoints) ? raw.checkpoints : [],
		coverage: Array.isArray(raw.coverage) ? raw.coverage : [],
	};
}

function originParentPath(forest: LumberJackForest, chatOrSourceId: string): string | null {
	const clean = sanitizeSegment(chatOrSourceId);
	if (forest.getNode(`knowledge/sources/${clean}`)) return `knowledge/sources/${clean}`;
	if (forest.getNode(`sessions/${clean}`)) return `sessions/${clean}`;
	return null;
}

function buildPropositionUpsert(forest: LumberJackForest, node: GraphNode): UpsertNodeInput {
	const propPath = `knowledge/propositions/${sanitizeSegment(node.id)}`;
	const existing = forest.getNode(propPath);
	const aliases = new Set<string>(Array.isArray(existing?.metadata?.aliases) ? (existing.metadata.aliases as string[]) : []);
	for (const alias of node.aliases) aliases.add(alias);
	const parents: string[] = [];
	for (const pt of node.provenance) {
		const p = originParentPath(forest, pt.chatId);
		if (p) parents.push(p);
	}
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
	const canvas = meta?.canvas as { x?: unknown; y?: unknown } | undefined;
	if (!canvas || typeof canvas.x !== "number" || typeof canvas.y !== "number") return null;
	return { x: canvas.x, y: canvas.y };
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
			metadata: { canvas: nextPos ? { x: nextPos.x, y: nextPos.y } : null },
		});
	}
	for (const [nodeId, pos] of Object.entries(positions)) {
		if (seen.has(nodeId)) continue;
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

function upsertSourceNode(forest: LumberJackForest, source: NotesSource): void {
	const nodePath = `knowledge/sources/${sanitizeSegment(source.id)}`;
	const prev = forest.getNode(nodePath)?.slot as NotesSource | undefined;
	const merged: NotesSource = {
		...source,
		...(source.extractions ?? prev?.extractions ? { extractions: source.extractions ?? prev?.extractions } : {}),
	};
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
	const existing = forest.getNode(nodePath)?.slot as NotesSource | undefined;
	if (!existing) return;
	const list = existing.extractions ?? [];
	if (list.some((e) => e.startedAt === entry.startedAt)) return;
	forest.upsertNode({ path: nodePath, kind: "source", slot: { ...existing, extractions: [...list, entry] } });
}

function rewriteGraphLedgers(
	forest: LumberJackForest,
	next: {
		nodes?: GraphNode[];
		chains?: GraphChain[];
		coverage?: CoverageEntry[];
		checkpoints?: SessionCheckpoint[];
	},
): void {
	const prevPositions = readCanvasPositions(forest);
	const ledgers = readLedgers(forest);
	if (next.nodes !== undefined) ledgers.nodes = [...next.nodes];
	if (next.chains !== undefined) ledgers.chains = [...next.chains];
	if (next.coverage !== undefined) ledgers.coverage = [...next.coverage];
	if (next.checkpoints !== undefined) ledgers.checkpoints = [...next.checkpoints];
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
		const slot = node.slot as NotesSource | undefined;
		if (slot && typeof slot.id === "string") out.push(slot);
	}
	return out;
}

function updatePropProgressNode(
	forest: LumberJackForest,
	nodeId: string,
	progress: { mastery?: number; fsrs?: FsrsCardSchedule },
): void {
	const meta: Record<string, unknown> = { nodeId };
	if (progress.mastery !== undefined) meta.mastery = progress.mastery;
	if (progress.fsrs !== undefined) meta.fsrs = progress.fsrs;
	forest.upsertNode({
		path: `knowledge/propositions/${sanitizeSegment(nodeId)}`,
		type: "leaf",
		kind: "proposition",
		metadata: meta,
	});
}

function readPropProgressNode(
	forest: LumberJackForest,
	nodeId: string,
): { mastery?: number; fsrs?: FsrsCardSchedule } | null {
	const meta = forest.getNode(`knowledge/propositions/${sanitizeSegment(nodeId)}`)?.metadata;
	if (!meta) return null;
	const out: { mastery?: number; fsrs?: FsrsCardSchedule } = {};
	if (typeof meta.mastery === "number") out.mastery = meta.mastery;
	if (meta.fsrs && typeof meta.fsrs === "object") out.fsrs = meta.fsrs as FsrsCardSchedule;
	return out;
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
			const ledgers = readLedgers(forest);
			ledgers.nodes.push(node);
			forest.setRootSlot(ledgers);
			forest.upsertNode(buildPropositionUpsert(forest, node));
		},
		readNodes: () => readLedgers(forest).nodes,
		appendChain: (assertion) => {
			const ledgers = readLedgers(forest);
			ledgers.chains.push(assertion);
			forest.setRootSlot(ledgers);
			forest.batchUpsertNodes(buildChainUpserts(assertion));
		},
		readCheckpoints: () => readLedgers(forest).checkpoints,
		readChains: () => readLedgers(forest).chains,
		appendCheckpoint: (checkpoint) => {
			const ledgers = readLedgers(forest);
			ledgers.checkpoints.push(checkpoint);
			forest.setRootSlot(ledgers);
		},
		appendCoverage: (entry) => {
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
