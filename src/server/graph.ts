import * as fs from "node:fs";
import { LEDGER_FILES, POSITIONS_FILE } from "../../config.ts";
import type { GraphSnapshot, PropProgressView } from "../core/contracts.ts";
import type { GraphCostSummary } from "../core/cost-summary.ts";
import { graphCostSummary } from "../core/cost-summary.ts";
import { graphSnapshot } from "../core/graph.ts";
import {
	deleteNodeTraces,
	type NodeDeletionStats,
} from "../core/graph-deletion.ts";
import { extractionStatuses } from "../agent/subagents/extraction.ts";
import {
	LJ_STATUS,
	pollLumberJackMutations,
	type LumberJackForest,
} from "../store/lumberjack/index.ts";
import { getActiveLumberJackBundle, stores, type LumberJackStoreBundle } from "./stores.ts";
import { callCost } from "./pricing.ts";

const forestAnchors = new WeakMap<LumberJackForest, number>();
let minForestAnchor = 1;

function collectLearnerProgress(
	bundle: LumberJackStoreBundle,
	nodes: readonly { id: string }[],
): Record<string, PropProgressView> {
	const out: Record<string, PropProgressView> = {};
	for (const node of nodes) {
		const progress = bundle.learnerStore.readPropositionProgress(node.id);
		if (progress) out[node.id] = progress;
	}
	return out;
}

function readForestHeadSequence(forest: LumberJackForest): bigint {
	if (!forest.isOpen) return 0n;
	try {
		const first = pollLumberJackMutations(forest, { epoch: 0n, after: 0n });
		if (first.status !== LJ_STATUS.GAP) return first.maxSequence;
		const resumeAfter = first.oldest > 0n ? first.oldest - 1n : 0n;
		const second = pollLumberJackMutations(forest, { epoch: first.epoch, after: resumeAfter });
		return second.maxSequence > resumeAfter ? second.maxSequence : resumeAfter;
	} catch {
		return 0n;
	}
}

function anchorForForest(forest: LumberJackForest): number {
	const existing = forestAnchors.get(forest);
	if (existing !== undefined) return existing;
	let dirMtime = 0;
	try {
		dirMtime = Math.trunc(fs.statSync(forest.directory).mtimeMs);
	} catch {
		dirMtime = 0;
	}
	const anchor = Math.max(minForestAnchor, dirMtime, 1);
	forestAnchors.set(forest, anchor);
	return anchor;
}

function forestRevision(forest: LumberJackForest): number {
	const anchor = anchorForForest(forest);
	const rev = anchor + Number(readForestHeadSequence(forest));
	if (rev >= minForestAnchor) minForestAnchor = rev + 1;
	return rev;
}

function readSourcePlacementNames(): Record<string, string> {
	const organization = stores.sourceOrganizationStore.read();
	const out: Record<string, string> = {};
	for (const [id, placement] of Object.entries(organization.placements)) {
		if (placement.name !== undefined) out[id] = placement.name;
	}
	return out;
}

/**
 * Server-side graph entry for the home view (GET /api/graph). A PURE READ:
 * the extraction pipeline (the sole graph writer) is triggered by quiz
 * answers in sessions (turn-service), never from here — the home view
 * reflects whatever the pipeline has merged so far.
 */
export function graphView(): GraphSnapshot {
	const snap = graphSnapshot(stores, readSourcePlacementNames());
	const bundle = getActiveLumberJackBundle();
	if (!bundle) return snap;
	const learnerProgress = collectLearnerProgress(bundle, snap.nodes);
	return Object.keys(learnerProgress).length > 0 ? { ...snap, learnerProgress } : snap;
}

/** The graph view's cost surface (GET /api/graph/costs — the 2026-09 cost
 *  pill): fold every usage channel into stage totals + recent runs. */
export function graphCosts(): GraphCostSummary {
	const chats = stores.chatStore.listChats().flatMap((summary) => {
		const record = stores.chatStore.getChat(summary.id);
		if (!record?.extractions?.length) return [];
		return [{ title: record.title ?? summary.id, extractions: record.extractions }];
	});
	const sources = stores.graphStore
		.readSources()
		.filter((s) => s.extractions?.length)
		.map((s) => ({ filePath: s.filePath, extractions: s.extractions! }));
	return graphCostSummary({ chats, sources }, callCost);
}

/** The graph's version stamp (session-deletion wave 6): the max mtime
 * across every graph data file — ledgers, positions — plus LumberJack
 * forest sequence when active. */
export function graphRevision(): number {
	let revision = 0;
	for (const file of [
		LEDGER_FILES.nodes,
		LEDGER_FILES.chains,
		LEDGER_FILES.sessions,
		LEDGER_FILES.coverage,
		POSITIONS_FILE,
	]) {
		try {
			revision = Math.max(revision, fs.statSync(file).mtimeMs);
		} catch {
			/* absent — nothing has ever written it */
		}
	}
	const bundle = getActiveLumberJackBundle();
	if (bundle) revision = Math.max(revision, forestRevision(bundle.forest));
	return revision;
}

// ─── single-node deletion (node interlude, owner-locked full-death) ──────────

/** What deleteGraphNode did — the route maps it straight to HTTP. */
export type NodeDeleteOutcome =
	| { ok: false; status: 404; code: "not_found"; error: string }
	| { ok: false; status: 409; code: "extraction_running"; error: string }
	| { ok: true; stats: NodeDeletionStats; graphRevision: number };

/**
 * Delete one node by id — FULL DEATH (core/graph-deletion.ts for the
 * ledger semantics). 409 while any extraction pipeline run is active.
 */
export function deleteGraphNode(nodeId: string): NodeDeleteOutcome {
	if (extractionStatuses().length > 0) {
		return {
			ok: false,
			status: 409,
			code: "extraction_running",
			error: "An extraction is running — try again when it finishes",
		};
	}
	const stats = deleteNodeTraces(stores.graphStore, nodeId);
	if (stats === null) {
		return { ok: false, status: 404, code: "not_found", error: "No such node" };
	}
	return { ok: true, stats, graphRevision: graphRevision() };
}
