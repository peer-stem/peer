import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { importLearnHarnessData } from "../src/store/import-learnharness.ts";
import { createLumberJackStores } from "../src/store/lumberjack/index.ts";

const PERSIST_ROOT = process.env.PEER_PERSIST_ROOT ?? "/usr/lib/persist/peer";
const SCRATCH_ROOT = path.join(PERSIST_ROOT, "scratch");

function walkTree(root: string, dir: string, out: Record<string, { sha256: string; mtimeMs: number }>): void {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			walkTree(root, full, out);
		} else if (entry.isFile()) {
			const st = fs.statSync(full);
			const sha256 = createHash("sha256").update(fs.readFileSync(full)).digest("hex");
			out[path.relative(root, full)] = { sha256, mtimeMs: st.mtimeMs };
		}
	}
}

function snapshotDirectoryTree(root: string): Record<string, { sha256: string; mtimeMs: number }> {
	const out: Record<string, { sha256: string; mtimeMs: number }> = {};
	walkTree(root, root, out);
	return out;
}

const IMPORT_PLAN_TREE = {
	version: 1,
	nodes: [
		{ id: "pl_1", title: "Simple functions" },
		{ id: "pl_2", title: "Monotone convergence" },
	],
	edges: [{ from: "pl_1", to: "pl_2" }],
};

const IMPORT_SIDE_CHATS = [
	{
		id: "side_1",
		anchor: { messageId: "msg_a1", partId: "msg_a1-t0", blockIndex: 0, blockText: "How does Lebesgue work?" },
		open: false,
		createdAt: "2026-11-01T00:01:00Z",
		messages: [{ id: "sm_1", role: "user", text: "Quick check on sets", at: "2026-11-01T00:01:05Z" }],
	},
];

const SIGMA_FSRS_PROP = {
	id: "n_sigma",
	schedule: { due: 1760000000000, stability: 4.5, difficulty: 3.2, reps: 3, lapses: 0, state: 2 },
	cues: [{ id: "cue_1", question: "Define sigma algebra", answer: "Closed under complement & countable union" }],
};

function seedGraphFixtures(srcDir: string): void {
	const sourcesMap = {
		src_measure: { id: "src_measure", filePath: "/notes/measure.md", importedAt: "2026-11-01T00:00:00Z" },
	};
	fs.writeFileSync(path.join(srcDir, "graph", "sources.json"), JSON.stringify(sourcesMap));
	const nodesLines = [
		JSON.stringify({
			id: "n_sigma",
			name: "Sigma Algebra",
			statement: "Closed under complement and countable unions",
			aliases: ["sigma-field"],
			createdAt: "2026-11-01T00:01:00Z",
			provenance: [{ chatId: "src_measure", messageId: "m1" }],
		}),
		JSON.stringify({
			id: "n_meas",
			name: "Measure",
			statement: "Countably additive non-negative set function",
			aliases: [],
			createdAt: "2026-11-01T00:02:00Z",
			provenance: [{ chatId: "src_measure", messageId: "m2" }],
		}),
		JSON.stringify({
			id: "n_lebesgue",
			name: "Lebesgue Integral",
			statement: "Integral built from simple functions over measurable sets",
			aliases: [],
			createdAt: "2026-11-01T00:03:00Z",
			provenance: [{ chatId: "chat_imp_1", messageId: "msg_a1" }],
		}),
	];
	fs.writeFileSync(path.join(srcDir, "graph", "nodes.jsonl"), `${nodesLines.join("\n")}\n`);
	const chainLine = JSON.stringify({
		id: "chain_leb",
		premises: ["n_sigma", "n_meas"],
		conclusion: "n_lebesgue",
		createdAt: "2026-11-01T00:04:00Z",
		provenance: [{ chatId: "chat_imp_1", messageId: "msg_a1" }],
	});
	fs.writeFileSync(path.join(srcDir, "graph", "chains.jsonl"), `${chainLine}\n`);
	fs.writeFileSync(path.join(srcDir, "graph", "positions.json"), JSON.stringify({ n_lebesgue: { x: 42, y: 84 } }));
}

function seedLearnHarnessFixture(srcDir: string): { imgSha: string } {
	for (const rel of ["chats", "graph", "prompts/teacher", "images", "core-plugin-data/flashcards"]) {
		fs.mkdirSync(path.join(srcDir, rel), { recursive: true });
	}
	fs.writeFileSync(path.join(srcDir, "settings.json"), JSON.stringify({ version: 1, graph: { enabled: true } }));
	fs.writeFileSync(path.join(srcDir, "prompts", "teacher", "10-planning.md"), "Override plan prompt");

	const imgBytes = Buffer.from("fake-png-binary-content-for-dedup-test");
	const imgSha = createHash("sha256").update(imgBytes).digest("hex");
	fs.writeFileSync(path.join(srcDir, "images", "diagram.png"), imgBytes);
	seedGraphFixtures(srcDir);

	const imageSnapshots = {
		[imgSha]: { mimeType: "image/png", data: imgBytes.toString("base64"), width: 120, height: 80 },
	};
	const chatJson = {
		version: 1,
		id: "chat_imp_1",
		title: "Integration Lesson",
		createdAt: "2026-11-01T00:00:00Z",
		updatedAt: "2026-11-01T00:05:00Z",
		messages: [{ id: "msg_a1", role: "user", content: "How does Lebesgue work?", timestamp: 100 }],
		tree: IMPORT_PLAN_TREE,
		sideChats: IMPORT_SIDE_CHATS,
		imageSnapshots,
	};
	fs.writeFileSync(path.join(srcDir, "chats", "chat_imp_1.json"), JSON.stringify(chatJson));

	const fcJson = {
		version: 1,
		revision: 1,
		decks: [{ id: "deck_measure", name: "Measure Deck", propositionIds: ["n_sigma"] }],
		propositions: { n_sigma: SIGMA_FSRS_PROP },
		reviews: [],
		batches: [],
	};
	fs.writeFileSync(path.join(srcDir, "core-plugin-data", "flashcards", "flashcards.json"), JSON.stringify(fcJson));
	return { imgSha };
}

function verifyImportRoundtrip(
	srcDir: string,
	forestDir: string,
	imgSha: string,
	beforeSnap: Record<string, { sha256: string; mtimeMs: number }>,
): void {
	const stores = createLumberJackStores(forestDir);
	try {
		const first = importLearnHarnessData(srcDir, stores);
		assert.equal(first.settingsImported, true);
		assert.equal(first.promptsImported, 1);
		assert.equal(first.sourcesImported, 1);
		assert.equal(first.nodesImported, 3);
		assert.equal(first.chainsImported, 1);
		assert.equal(first.positionsImported, 1);
		assert.equal(first.chatsImported, 1);
		assert.equal(first.objectsStored, 1);
		assert.equal(first.objectsDeduplicated, 1);
		assert.equal(first.flashcardDecksImported, 1);
		assert.equal(first.flashcardCardsImported, 1);

		assert.deepEqual(snapshotDirectoryTree(srcDir), beforeSnap, "sourceDir must stay strictly untouched");

		const chat = stores.chatStore.getChat("chat_imp_1");
		assert.equal(chat?.title, "Integration Lesson");
		assert.ok(chat?.imageSnapshots?.[imgSha]);
		assert.deepEqual(stores.graphStore.readPositions(), { n_lebesgue: { x: 42, y: 84 } });
		assert.equal(stores.learnerStore.listDecks().length, 1);
		assert.equal(stores.learnerStore.readPropositionProgress("n_sigma")?.fsrs?.stability, 4.5);

		const second = importLearnHarnessData(srcDir, stores);
		assert.equal(second.nodesImported, 0);
		assert.equal(second.chainsImported, 0);
		assert.equal(second.objectsStored, 0);
		assert.equal(second.objectsDeduplicated, 2);
		assert.equal(stores.graphStore.readNodes().length, 3);
		assert.equal(stores.graphStore.readChains().length, 1);
	} finally {
		stores.close();
	}
}

test("importLearnHarnessData imports read-only, preserves DAG/FSRS/objects, and is idempotent", () => {
	fs.mkdirSync(SCRATCH_ROOT, { recursive: true, mode: 0o755 });
	const base = path.join(SCRATCH_ROOT, `s1-import-${process.pid}-${randomBytes(4).toString("hex")}`);
	const srcDir = path.join(base, "lh-source");
	const forestDir = path.join(base, "peer-forest");
	fs.mkdirSync(srcDir, { recursive: true, mode: 0o700 });
	fs.mkdirSync(forestDir, { recursive: true, mode: 0o700 });
	try {
		const { imgSha } = seedLearnHarnessFixture(srcDir);
		const beforeSnap = snapshotDirectoryTree(srcDir);
		verifyImportRoundtrip(srcDir, forestDir, imgSha, beforeSnap);
	} finally {
		fs.rmSync(base, { recursive: true, force: true });
	}
});
