import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { importLearnHarnessData } from "../src/store/import-learnharness.ts";
import { DEFAULT_ADDON_PATH } from "../src/store/lumberjack/binding.ts";
import {
	isGraphChain,
	isGraphNode,
	isNotesSource,
	sanitizeSegment,
} from "../src/store/lumberjack/graph-store.ts";
import { createLumberJackStores } from "../src/store/lumberjack/index.ts";

const PERSIST_ROOT = process.env.PEER_PERSIST_ROOT ?? "/usr/lib/persist/peer";
const SCRATCH_ROOT = process.env.PEER_TEST_SCRATCH ?? path.join(PERSIST_ROOT, "scratch");
const SKIP_GUARD = {
	skip:
		!fs.existsSync(DEFAULT_ADDON_PATH) && process.env.PEER_REQUIRE_SUBSTRATE !== "1"
			? "lumberjack_peer.node not built"
			: false,
};

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
	schedule: {
		due: 1760000000000,
		stability: 4.5,
		difficulty: 3.2,
		reps: 3,
		lapses: 0,
		state: 2,
		last_review: 1759000000000,
	},
	cues: [{ id: "cue_1", question: "Define sigma algebra", answer: "Closed under complement & countable union" }],
};

const SAMPLE_REVIEWS = [
	{ id: "rev_1", propositionId: "n_sigma", cueId: "cue_1", rating: 3, at: 1759000000000 },
];

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
	fs.writeFileSync(
		path.join(srcDir, "graph", "positions.json"),
		JSON.stringify({ positions: { n_lebesgue: { x: 42, y: 84 } }, updatedAt: "2026-11-01T00:04:30Z" }),
	);
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
		reviews: SAMPLE_REVIEWS,
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
		assert.equal(first.corruptFilesSkipped, 0);
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

		const positions = stores.graphStore.readPositions();
		assert.equal("positions" in positions, false);
		assert.equal("updatedAt" in positions, false);
		assert.deepEqual(positions, { n_lebesgue: { x: 42, y: 84 } });
		const reviewsSlot = stores.forest.getNode("learner/flashcard-reviews")?.slot as { reviews?: unknown[] } | undefined;
		assert.deepEqual(reviewsSlot?.reviews, SAMPLE_REVIEWS);

		const chat = stores.chatStore.getChat("chat_imp_1");
		assert.equal(chat?.title, "Integration Lesson");
		assert.ok(chat?.imageSnapshots?.[imgSha]);
		assert.equal(stores.learnerStore.listDecks().length, 1);
		assert.equal(stores.learnerStore.readPropositionProgress("n_sigma")?.fsrs?.stability, 4.5);

		const second = importLearnHarnessData(srcDir, stores);
		assert.equal(second.nodesImported, 0);
		assert.equal(second.chainsImported, 0);
		assert.equal(second.objectsStored, 0);
		assert.equal(second.objectsDeduplicated, 2);
		const afterSlot = stores.forest.getNode("learner/flashcard-reviews")?.slot as { reviews?: unknown[] } | undefined;
		assert.equal(afterSlot?.reviews?.length, 1);
	} finally {
		stores.close();
	}
}

test("importLearnHarnessData imports positions.json, flashcard reviews, and is idempotent", SKIP_GUARD, () => {
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

function seedFaultyFixture(srcDir: string, outsideChatPath: string): void {
	for (const rel of ["chats", "graph", "core-plugin-data/flashcards"]) {
		fs.mkdirSync(path.join(srcDir, rel), { recursive: true });
	}
	const validChat = {
		version: 1,
		id: "chat_valid",
		title: "Valid Chat",
		createdAt: "2026-11-02T00:00:00Z",
		updatedAt: "2026-11-02T00:01:00Z",
		messages: [{ id: "m1", role: "user", content: "Still works", timestamp: 1 }],
	};
	fs.writeFileSync(path.join(srcDir, "chats", "chat_valid.json"), JSON.stringify(validChat));
	fs.writeFileSync(path.join(srcDir, "chats", "corrupt.json"), "{corrupt-json-payload");
	fs.symlinkSync(outsideChatPath, path.join(srcDir, "chats", "symlink_chat.json"));

	const validNode = JSON.stringify({
		id: "n_sigma",
		name: "Sigma Algebra",
		statement: "Closed under complement",
		aliases: [],
		createdAt: "2026-11-02T00:00:00Z",
		provenance: [{ chatId: "chat_valid", messageId: "m1" }],
	});
	const wrongShapeNode = JSON.stringify({ id: "n_bad_shape_only" });
	fs.writeFileSync(path.join(srcDir, "graph", "nodes.jsonl"), `${validNode}\n{broken-jsonl\n${wrongShapeNode}\n`);

	const fcJson = {
		version: 1,
		revision: 1,
		decks: [{ id: "deck_m", name: "Measure Deck", propositionIds: ["n_sigma"] }],
		propositions: { n_sigma: SIGMA_FSRS_PROP },
		reviews: SAMPLE_REVIEWS,
	};
	fs.writeFileSync(path.join(srcDir, "core-plugin-data", "flashcards", "flashcards.json"), JSON.stringify(fcJson));
}

const NEWER_SIGMA_FSRS = {
	due: 1770000000000,
	stability: 12.5,
	difficulty: 2.1,
	reps: 9,
	lapses: 0,
	state: 2,
	last_review: 1768000000000,
};

function verifyFaultyImport(srcDir: string, linkDir: string, forestDir: string): void {
	const stores = createLumberJackStores(forestDir);
	try {
		assert.throws(() => importLearnHarnessData(linkDir, stores));
		stores.learnerStore.updatePropositionProgress("n_sigma", { mastery: 0.95, fsrs: NEWER_SIGMA_FSRS });
		const report = importLearnHarnessData(srcDir, stores);
		assert.equal(report.corruptFilesSkipped >= 4, true);
		assert.equal(report.chatsImported, 1);
		assert.equal(stores.chatStore.getChat("chat_valid")?.title, "Valid Chat");
		assert.equal(stores.chatStore.getChat("chat_outside"), null);
		assert.deepEqual(stores.graphStore.readNodes().map((n) => n.id), ["n_sigma"]);

		const progress = stores.learnerStore.readPropositionProgress("n_sigma");
		assert.equal(progress?.mastery, 0.95);
		assert.equal(progress?.fsrs?.reps, 9);
		assert.equal(progress?.fsrs?.stability, 12.5);
	} finally {
		stores.close();
	}
}

test("importLearnHarnessData skips corrupt JSON/symlinks and protects newer FSRS", SKIP_GUARD, () => {
	fs.mkdirSync(SCRATCH_ROOT, { recursive: true, mode: 0o755 });
	const base = path.join(SCRATCH_ROOT, `s1-faulty-${process.pid}-${randomBytes(4).toString("hex")}`);
	const srcDir = path.join(base, "lh-source");
	const linkDir = path.join(base, "lh-link");
	const forestDir = path.join(base, "peer-forest");
	const outsideChat = path.join(base, "outside-chat.json");
	fs.mkdirSync(srcDir, { recursive: true, mode: 0o700 });
	fs.mkdirSync(forestDir, { recursive: true, mode: 0o700 });
	const escaped = {
		version: 1,
		id: "chat_outside",
		title: "Escaped",
		createdAt: "2026-11-02T00:00:00Z",
		updatedAt: "2026-11-02T00:00:00Z",
		messages: [],
	};
	fs.writeFileSync(outsideChat, JSON.stringify(escaped));
	fs.symlinkSync(srcDir, linkDir);
	seedFaultyFixture(srcDir, outsideChat);
	try {
		verifyFaultyImport(srcDir, linkDir, forestDir);
	} finally {
		fs.rmSync(base, { recursive: true, force: true });
	}
});

function assertN8IdGuards(): void {
	for (const bad of ["", ".", "..", "a/b", "a\\b", "a\0b"]) {
		assert.equal(
			isGraphNode({ id: bad, name: "N", statement: "S", aliases: [], createdAt: "t", provenance: [] }),
			false,
		);
		assert.equal(isGraphChain({ id: bad, premises: ["p1"], conclusion: "c1", provenance: [], createdAt: "t" }), false);
		assert.equal(isGraphChain({ id: "c1", premises: [bad], conclusion: "n2", provenance: [], createdAt: "t" }), false);
		assert.equal(isGraphChain({ id: "c1", premises: ["p1"], conclusion: bad, provenance: [], createdAt: "t" }), false);
		assert.equal(isNotesSource({ id: bad, filePath: "/a.md", importedAt: "t" }), false);
	}
	for (const bad of ["", "   ", ".", ".."]) {
		assert.throws(() => sanitizeSegment(bad));
	}
}

function seedN8GraphAndFlashcards(srcDir: string): void {
	const makeNodeLine = (id: string) =>
		JSON.stringify({ id, name: "N", statement: "S", aliases: [], createdAt: "2026-11-03T00:00:00Z", provenance: [] });
	const nodeLines = ["", ".", "..", "n_good"].map(makeNodeLine);
	fs.writeFileSync(path.join(srcDir, "graph", "nodes.jsonl"), `${nodeLines.join("\n")}\n`);
	const rawPos = {
		positions: { "": { x: 1, y: 2 }, ".": { x: 3, y: 4 }, "..": { x: 5, y: 6 }, n_good: { x: 7, y: 8 } },
		updatedAt: "2026-11-03T00:00:00Z",
	};
	fs.writeFileSync(path.join(srcDir, "graph", "positions.json"), JSON.stringify(rawPos));
	const fc = {
		decks: [
			{ id: "..", name: "Bad Deck", propositionIds: ["n_good"] },
			{ id: "deck_ok", name: "Good Deck", propositionIds: ["n_good", ".", ""] },
		],
		propositions: { n_good: { id: "n_good", cues: [{ id: "c1", question: "Q", answer: "A" }] } },
	};
	fs.writeFileSync(path.join(srcDir, "core-plugin-data", "flashcards", "flashcards.json"), JSON.stringify(fc));
}

function seedN8Snapshot(srcDir: string): { lockedChat: string; lockedPrompt: string; lockedSubDir: string } {
	for (const rel of ["chats", "graph", "prompts/teacher", "prompts/locked_sub", "core-plugin-data/flashcards"]) {
		fs.mkdirSync(path.join(srcDir, rel), { recursive: true, mode: 0o700 });
	}
	fs.writeFileSync(path.join(srcDir, "prompts", "teacher", "10-planning.md"), "Healthy teacher prompt");
	const lockedPrompt = path.join(srcDir, "prompts", "teacher", "20-teaching.md");
	fs.writeFileSync(lockedPrompt, "Unreadable prompt");
	const lockedSubDir = path.join(srcDir, "prompts", "locked_sub");
	fs.writeFileSync(path.join(lockedSubDir, "secret.md"), "Inside unreadable subdir");
	seedN8GraphAndFlashcards(srcDir);

	const chatNoUpdated = {
		version: 1,
		id: "chat_no_updated",
		title: "Missing UpdatedAt",
		createdAt: "2026-11-01T00:00:00Z",
		messages: [],
	};
	const chatNoDates = { version: 1, id: "chat_no_dates", messages: [] };
	const chatNewer = {
		version: 1,
		id: "chat_newer",
		title: "Newer Session",
		createdAt: "2026-11-02T00:00:00Z",
		updatedAt: "2026-11-04T00:00:00Z",
		messages: [],
	};
	fs.writeFileSync(path.join(srcDir, "chats", "chat_no_updated.json"), JSON.stringify(chatNoUpdated));
	fs.writeFileSync(path.join(srcDir, "chats", "chat_no_dates.json"), JSON.stringify(chatNoDates));
	fs.writeFileSync(path.join(srcDir, "chats", "chat_newer.json"), JSON.stringify(chatNewer));
	const lockedChat = path.join(srcDir, "chats", "chat_locked.json");
	fs.writeFileSync(lockedChat, JSON.stringify({ ...chatNewer, id: "chat_locked" }));

	fs.chmodSync(lockedChat, 0o000);
	fs.chmodSync(lockedPrompt, 0o000);
	fs.chmodSync(lockedSubDir, 0o000);
	return { lockedChat, lockedPrompt, lockedSubDir };
}

test("N8: ID guards, missing updatedAt sorting, and chmod 0o000 files/dirs skip cleanly", SKIP_GUARD, () => {
	assertN8IdGuards();
	fs.mkdirSync(SCRATCH_ROOT, { recursive: true, mode: 0o755 });
	const base = path.join(SCRATCH_ROOT, `s3-n8-${process.pid}-${randomBytes(4).toString("hex")}`);
	const srcDir = path.join(base, "lh-source");
	const forestDir = path.join(base, "peer-forest");
	fs.mkdirSync(srcDir, { recursive: true, mode: 0o700 });
	fs.mkdirSync(forestDir, { recursive: true, mode: 0o700 });
	const { lockedChat, lockedPrompt, lockedSubDir } = seedN8Snapshot(srcDir);
	const stores = createLumberJackStores(forestDir);
	try {
		const report = importLearnHarnessData(srcDir, stores);
		assert.equal(report.nodesImported, 1);
		assert.equal(report.positionsImported, 1);
		assert.deepEqual(stores.graphStore.readPositions(), { n_good: { x: 7, y: 8 } });
		assert.equal(report.promptsImported, 1);
		assert.deepEqual(stores.promptOverrides.listOverrides(), ["teacher/10-planning.md"]);
		assert.equal(report.flashcardDecksImported, 1);
		assert.equal(report.chatsImported, 3);
		assert.equal(report.corruptFilesSkipped, 12);

		const summaries = stores.chatStore.listChats();
		assert.deepEqual(summaries.map((s) => s.id), ["chat_newer", "chat_no_updated", "chat_no_dates"]);
		assert.equal(summaries[1]?.updatedAt, "2026-11-01T00:00:00Z");
		assert.equal(summaries[2]?.title, "Untitled session");
		assert.equal(summaries[2]?.updatedAt, "");
	} finally {
		fs.chmodSync(lockedSubDir, 0o700);
		fs.chmodSync(lockedChat, 0o600);
		fs.chmodSync(lockedPrompt, 0o600);
		stores.close();
		fs.rmSync(base, { recursive: true, force: true });
	}
});
