import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test, { after } from "node:test";
import type { GraphChain, GraphNode, GraphSnapshot } from "../src/core/contracts.ts";
import { DEFAULT_ADDON_PATH } from "../src/store/lumberjack/binding.ts";
import { installScratchProcessEnv } from "./api-test-helpers.ts";

const scratchEnv = installScratchProcessEnv("c2a-graph-progress-");
after(() => {
	scratchEnv.restore();
});

const serverMod = await import("../src/server/index.ts");
const graphRoute = await import("../src/api/handlers/graph/route.ts");

const HAS_ADDON = fs.existsSync(DEFAULT_ADDON_PATH);
const REQUIRE_SUBSTRATE = process.env.PEER_REQUIRE_SUBSTRATE === "1";
const SKIP_SUBSTRATE = !HAS_ADDON && !REQUIRE_SUBSTRATE ? "lumberjack_peer.node not built" : false;

interface ProgressEntry {
	mastery?: number;
	fsrs?: {
		due: number | string;
		stability: number;
		difficulty: number;
		elapsed_days?: number;
		scheduled_days?: number;
		reps: number;
		lapses: number;
		state: number;
		last_review?: number | string | null;
	};
}

interface ProgressSnapshot extends GraphSnapshot {
	learnerProgress?: Record<string, ProgressEntry>;
}

const SAMPLE_EVT_PROGRESS = {
	mastery: 0.88,
	fsrs: {
		due: 1_765_000_000_000,
		stability: 7.5,
		difficulty: 2.9,
		elapsed_days: 3,
		scheduled_days: 8,
		reps: 5,
		lapses: 0,
		state: 2,
		last_review: 1_764_700_000_000,
	},
};

function makeNode(id: string, name: string, statement: string, chatId = "chat_c2a_g1"): GraphNode {
	return {
		id,
		name,
		statement,
		aliases: [],
		createdAt: "2026-11-19T12:00:00.000Z",
		provenance: [{ chatId, messageId: "msg_1" }],
	};
}

function makeChain(id: string, premises: string[], conclusion: string): GraphChain {
	return {
		id,
		premises,
		conclusion,
		provenance: [{ chatId: "chat_c2a_g1", messageId: "msg_1" }],
		createdAt: "2026-11-19T12:01:00.000Z",
	};
}

function waitMs(ms = 6): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

test("graphView omits learnerProgress in flat-file mode and preserves sourceOrganizationStore placement names", () => {
	try {
		const emptySnap = serverMod.graphView() as ProgressSnapshot;
		assert.equal(emptySnap.nodes.length, 0);
		assert.equal("learnerProgress" in emptySnap, false);

		serverMod.stores.graphStore.upsertSource({
			id: "src_notes_1",
			filePath: "topology/compactness.md",
			importedAt: "2026-11-19T12:00:00.000Z",
		});
		serverMod.stores.sourceOrganizationStore.write({
			version: 1,
			folders: [],
			placements: { src_notes_1: { folderId: null, name: "Compactness Notes" } },
		});
		serverMod.stores.graphStore.appendNode(
			makeNode("n_flat_1", "Compactness", "Open covers have finite subcovers.", "src_notes_1"),
		);
		serverMod.stores.graphStore.appendNode(
			makeNode("n_flat_2", "Continuity", "Preimages of open sets are open.", "src_notes_1"),
		);
		serverMod.stores.graphStore.appendNode(
			makeNode("n_flat_3", "EVT", "Continuous real map on compact set attains bounds.", "src_notes_1"),
		);
		const populatedSnap = serverMod.graphView() as ProgressSnapshot;
		assert.equal(populatedSnap.propositions.length, 3);
		assert.equal(populatedSnap.fileSources.src_notes_1, "topology/compactness.md");
		assert.equal(populatedSnap.clusters[0]?.label, "Compactness Notes");
		assert.equal("learnerProgress" in populatedSnap, false);
		assert.equal(populatedSnap.learnerProgress, undefined);
	} finally {
		serverMod.stores.graphStore.rewriteLedgers({ nodes: [], chains: [], checkpoints: [], coverage: [] });
		serverMod.stores.graphStore.deleteSources(new Set(["src_notes_1"]));
	}
});

test(
	"graphView populates learnerProgress with mastery and FSRS in LumberJack mode and omits when empty",
	{ skip: SKIP_SUBSTRATE },
	async () => {
		const forestDir = path.join(scratchEnv.rootDir, "lj-progress-view");
		const sub = await serverMod.activateLumberJackSubstrate({ forestDir });
		try {
			const emptyLjSnap = serverMod.graphView() as ProgressSnapshot;
			assert.equal("learnerProgress" in emptyLjSnap, false);

			sub.bundle.graphStore.appendNode(makeNode("n_lj_1", "Compactness", "Every open cover has a finite subcover."));
			sub.bundle.graphStore.appendNode(makeNode("n_lj_2", "Continuity", "Preimages of open sets are open."));
			sub.bundle.graphStore.appendNode(makeNode("n_lj_3", "EVT", "Continuous real map on compact set attains bounds."));
			sub.bundle.graphStore.appendChain(makeChain("arg_lj_evt", ["n_lj_1", "n_lj_2"], "n_lj_3"));

			const beforeProgress = serverMod.graphView() as ProgressSnapshot;
			assert.equal(beforeProgress.propositions.length, 3);
			assert.equal("learnerProgress" in beforeProgress, false);

			sub.bundle.learnerStore.updatePropositionProgress("n_lj_3", SAMPLE_EVT_PROGRESS);

			const withProgress = serverMod.graphView() as ProgressSnapshot;
			assert.equal("learnerProgress" in withProgress, true);
			assert.equal(withProgress.learnerProgress?.n_lj_3?.mastery, 0.88);
			assert.equal(withProgress.learnerProgress?.n_lj_3?.fsrs?.stability, 7.5);
			assert.equal(withProgress.learnerProgress?.n_lj_3?.fsrs?.difficulty, 2.9);
			assert.equal(withProgress.learnerProgress?.n_lj_3?.fsrs?.reps, 5);
			assert.equal(withProgress.learnerProgress?.n_lj_1, undefined);

			const res = await graphRoute.GET();
			assert.equal(res.status, 200);
			const body = (await res.json()) as ProgressSnapshot;
			assert.equal(body.learnerProgress?.n_lj_3?.mastery, 0.88);
			assert.equal(body.learnerProgress?.n_lj_3?.fsrs?.stability, 7.5);
		} finally {
			await sub.close();
		}
	},
);

test(
	"graphRevision is positive and strictly advances across LumberJack graph writes and deleteGraphNode",
	{ skip: SKIP_SUBSTRATE },
	async () => {
		const forestDir = path.join(scratchEnv.rootDir, "lj-progress-rev");
		const sub = await serverMod.activateLumberJackSubstrate({ forestDir });
		try {
			sub.bundle.graphStore.appendNode(makeNode("n_rev_1", "Metric space", "Distance satisfies triangle inequality."));
			sub.bundle.learnerStore.updatePropositionProgress("n_rev_1", { mastery: 0.72 });
			const rev1 = serverMod.graphRevision();
			assert.equal(rev1 > 0, true);

			await waitMs();
			sub.bundle.graphStore.appendNode(makeNode("n_rev_2", "Cauchy sequence", "Terms become arbitrarily close."));
			const rev2 = serverMod.graphRevision();
			assert.equal(rev2 > rev1, true);

			await waitMs();
			const deleted = serverMod.deleteGraphNode("n_rev_1");
			assert.equal(deleted.ok, true);
			const rev3 = deleted.ok ? deleted.graphRevision : 0;
			assert.equal(rev3 > rev2, true);

			const afterDelete = serverMod.graphView() as ProgressSnapshot;
			assert.equal(afterDelete.propositions.length, 1);
			assert.equal("learnerProgress" in afterDelete, false);
		} finally {
			await sub.close();
		}
	},
);
