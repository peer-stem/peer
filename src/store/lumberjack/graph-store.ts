import type {
	CoverageEntry,
	ExtractionRunUsage,
	GraphChain,
	GraphNode,
	NotesSource,
	SessionCheckpoint,
} from "../../core/contracts.ts";
import { emit } from "../../core/events.ts";
import type { GraphStore, SourceOrganizationStore } from "../../core/ports.ts";
import {
	emptySourceOrganization,
	parseSourceOrganization,
	type SourceOrganization,
} from "../../core/source-organization.ts";
import type { LumberJackForest } from "./binding.ts";
import {
	buildChainUpserts,
	buildPropositionUpsert,
	readCanvasPositions,
	rebuildGraphDag,
	syncSourceFolderDag,
	writeCanvasPositions,
} from "./graph-dag.ts";
import {
	encodeEntitySegment,
	isCheckpoint,
	isCoverageEntry,
	isGraphChain,
	isGraphNode,
	isNotesSource,
	isPlainRecord,
	sanitizeSegment,
} from "./graph-guards.ts";
import { buildLearnerStore, deletePropProgressNode, type LumberJackLearnerStore } from "./learner-store.ts";

interface ValidatedLedgers {
	nodes: GraphNode[];
	chains: GraphChain[];
	checkpoints: SessionCheckpoint[];
	coverage: CoverageEntry[];
}

interface LedgerState {
	rawDoc: Record<string, unknown>;
	valid: ValidatedLedgers;
}

function parseLedgerState(raw: unknown): LedgerState {
	const doc = isPlainRecord(raw) ? structuredClone(raw) : {};
	const rawNodes = Array.isArray(doc.nodes) ? doc.nodes : [];
	const rawChains = Array.isArray(doc.chains) ? doc.chains : [];
	const rawCheckpoints = Array.isArray(doc.checkpoints) ? doc.checkpoints : [];
	const rawCoverage = Array.isArray(doc.coverage) ? doc.coverage : [];
	return {
		rawDoc: {
			...doc,
			nodes: rawNodes,
			chains: rawChains,
			checkpoints: rawCheckpoints,
			coverage: rawCoverage,
		},
		valid: {
			nodes: rawNodes.filter(isGraphNode),
			chains: rawChains.filter(isGraphChain),
			checkpoints: rawCheckpoints.filter(isCheckpoint),
			coverage: rawCoverage.filter(isCoverageEntry),
		},
	};
}

function replaceKnownPreservingUnknown<T>(
	rawItems: unknown[],
	isKnown: (v: unknown) => v is T,
	nextValid: T[],
): unknown[] {
	const preservedUnknown = rawItems.filter((item) => !isKnown(item));
	return [...nextValid, ...preservedUnknown];
}

function applyLedgerRewrites(state: LedgerState, next: Partial<ValidatedLedgers>): void {
	if (next.nodes !== undefined) {
		const clean = next.nodes.filter(isGraphNode);
		state.rawDoc.nodes = replaceKnownPreservingUnknown(state.rawDoc.nodes as unknown[], isGraphNode, clean);
		state.valid.nodes = clean;
	}
	if (next.chains !== undefined) {
		const clean = next.chains.filter(isGraphChain);
		state.rawDoc.chains = replaceKnownPreservingUnknown(state.rawDoc.chains as unknown[], isGraphChain, clean);
		state.valid.chains = clean;
	}
	if (next.checkpoints !== undefined) {
		const clean = next.checkpoints.filter(isCheckpoint);
		state.rawDoc.checkpoints = replaceKnownPreservingUnknown(state.rawDoc.checkpoints as unknown[], isCheckpoint, clean);
		state.valid.checkpoints = clean;
	}
	if (next.coverage !== undefined) {
		const clean = next.coverage.filter(isCoverageEntry);
		state.rawDoc.coverage = replaceKnownPreservingUnknown(state.rawDoc.coverage as unknown[], isCoverageEntry, clean);
		state.valid.coverage = clean;
	}
}

function createCachedLedgerAccessor(forest: LumberJackForest): {
	read(): LedgerState;
	appendItem<K extends keyof ValidatedLedgers>(key: K, item: ValidatedLedgers[K][number]): void;
	rewrite(next: Partial<ValidatedLedgers>): { prevNodes: GraphNode[]; nextNodes: GraphNode[] };
} {
	let cached: LedgerState | null = null;
	forest.onClose(() => { cached = null; });
	const read = (): LedgerState => {
		if (!cached) cached = parseLedgerState(forest.getRootSlot<unknown>());
		return cached;
	};
	return {
		read,
		appendItem(key, item) {
			const state = read();
			const list = Array.isArray(state.rawDoc[key]) ? (state.rawDoc[key] as unknown[]) : [];
			list.push(item);
			state.rawDoc[key] = list;
			(state.valid[key] as Array<typeof item>).push(item);
			forest.setRootSlot(state.rawDoc);
		},
		rewrite(next) {
			const state = read();
			const prevNodes = [...state.valid.nodes];
			applyLedgerRewrites(state, next);
			forest.setRootSlot(state.rawDoc);
			return { prevNodes, nextNodes: state.valid.nodes };
		},
	};
}

function mergeSourceRecord(prev: NotesSource | undefined, incoming: NotesSource): NotesSource {
	if (!prev) return incoming;
	const { extractions: _dropped, ...rest } = incoming;
	return prev.extractions !== undefined ? { ...rest, extractions: prev.extractions } : rest;
}

function upsertSourceNode(forest: LumberJackForest, source: NotesSource): void {
	const nodePath = `knowledge/sources/${encodeEntitySegment(source.id)}`;
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
		if (forest.deleteNode(`knowledge/sources/${encodeEntitySegment(id)}`)) removed++;
	}
	return removed;
}

function appendUsageToSource(forest: LumberJackForest, id: string, entry: ExtractionRunUsage): void {
	const nodePath = `knowledge/sources/${encodeEntitySegment(id)}`;
	const existing = forest.getNode(nodePath)?.slot;
	if (!isNotesSource(existing)) return;
	const list = existing.extractions ?? [];
	if (list.some((e) => e.startedAt === entry.startedAt)) return;
	forest.upsertNode({ path: nodePath, kind: "source", slot: { ...existing, extractions: [...list, entry] } });
}

function listStoredSources(forest: LumberJackForest): NotesSource[] {
	const out: NotesSource[] = [];
	for (const node of forest.listChildren("knowledge/sources")) {
		if (isNotesSource(node.slot)) out.push(node.slot);
	}
	return out;
}

function buildGraphStore(forest: LumberJackForest): GraphStore {
	const ledgers = createCachedLedgerAccessor(forest);
	return {
		appendNode: (node) => {
			if (!isGraphNode(node)) return;
			ledgers.appendItem("nodes", node);
			forest.upsertNode(buildPropositionUpsert(forest, node));
		},
		readNodes: () => [...ledgers.read().valid.nodes],
		appendChain: (assertion) => {
			if (!isGraphChain(assertion)) return;
			ledgers.appendItem("chains", assertion);
			forest.batchUpsertNodes(buildChainUpserts(assertion));
		},
		readCheckpoints: () => [...ledgers.read().valid.checkpoints],
		readChains: () => [...ledgers.read().valid.chains],
		appendCheckpoint: (checkpoint) => {
			if (isCheckpoint(checkpoint)) ledgers.appendItem("checkpoints", checkpoint);
		},
		appendCoverage: (entry) => {
			if (isCoverageEntry(entry)) ledgers.appendItem("coverage", entry);
		},
		readCoverage: () => [...ledgers.read().valid.coverage],
		upsertSource: (source) => upsertSourceNode(forest, source),
		readSources: () => listStoredSources(forest),
		deleteSources: (ids) => deleteSourceNodes(forest, ids),
		appendSourceUsage: (id, entry) => appendUsageToSource(forest, id, entry),
		readPositions: () => readCanvasPositions(forest),
		writePositions: (positions) => writeCanvasPositions(forest, positions),
		rewriteLedgers: (next) => {
			const prevPositions = readCanvasPositions(forest);
			const { prevNodes, nextNodes } = ledgers.rewrite(next);
			if (next.nodes !== undefined) {
				const keptIds = new Set(nextNodes.map((n) => n.id));
				for (const prev of prevNodes) {
					if (!keptIds.has(prev.id)) deletePropProgressNode(forest, prev.id);
				}
			}
			if (next.nodes !== undefined || next.chains !== undefined) {
				rebuildGraphDag(forest, nextNodes, ledgers.read().valid.chains, prevPositions);
			}
		},
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
			forest.noteStoreEmittedEvent("sources-changed");
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

export {
	encodeEntitySegment,
	isCheckpoint,
	isCoverageEntry,
	isGraphChain,
	isGraphNode,
	isNotesSource,
	isPosition,
	isSafeEntityId,
	sanitizeSegment,
} from "./graph-guards.ts";
export type {
	FlashcardDeckRecord,
	FsrsCardSchedule,
	LearnerProfileRecord,
	LumberJackLearnerStore,
	PropProgress,
} from "./learner-store.ts";
