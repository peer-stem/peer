import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { ExtractionRunUsage, GraphNode } from "../src/core/contracts.ts";
import type { PluginAgentRecord } from "../src/core/plugin-agents.ts";
import type { PluginTaskRecord } from "../src/core/plugin-workers.ts";
import type { ThemeFile } from "../src/core/themes.ts";
import { DEFAULT_ADDON_PATH } from "../src/store/lumberjack/binding.ts";
import { isGraphChain, isGraphNode, isNotesSource, sanitizeSegment } from "../src/store/lumberjack/graph-store.ts";
import {
	createLumberJackStores,
	LJ_STATUS,
	LumberJackForest as PublicForest,
	type FsrsCardSchedule,
} from "../src/store/lumberjack/index.ts";

const WORKTREE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PERSIST_ROOT = process.env.PEER_PERSIST_ROOT ?? "/usr/lib/persist/peer";
const SCRATCH_ROOT = process.env.PEER_TEST_SCRATCH ?? path.join(PERSIST_ROOT, "scratch");
const SKIP_GUARD = {
	skip: !fs.existsSync(DEFAULT_ADDON_PATH) && process.env.PEER_REQUIRE_SUBSTRATE !== "1"
		? "lumberjack_peer.node not built"
		: false,
};

function withScratchForest<T>(prefix: string, fn: (dir: string) => T): T {
	fs.mkdirSync(SCRATCH_ROOT, { recursive: true, mode: 0o755 });
	const dir = path.join(SCRATCH_ROOT, `${prefix}-${process.pid}-${randomBytes(4).toString("hex")}`);
	fs.mkdirSync(dir, { mode: 0o700 });
	try {
		return fn(dir);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

test("LumberJackForest enforces close handle guard and cross-process LJ_LOCKED", SKIP_GUARD, () => {
	withScratchForest("s1-lock", (dir) => {
		const forest = new PublicForest(dir);
		forest.upsertNode({ path: "knowledge/propositions/n1", kind: "proposition" });
		const childScript = `
			import { LumberJackForest } from "./src/store/lumberjack/index.ts";
			try { new LumberJackForest(${JSON.stringify(dir)}); process.exit(2); }
			catch (err) { process.exit(err.ljStatus === 14 ? 0 : 3); }
		`;
		execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", childScript], {
			cwd: WORKTREE_ROOT,
			env: { ...process.env, TMPDIR: dir },
		});
		forest.close();
		assert.throws(
			() => forest.getNode("knowledge/propositions/n1"),
			(err: unknown) => (err as { ljStatus?: number }).ljStatus === LJ_STATUS.BAD_HANDLE,
		);
	});
});

const SAMPLE_FSRS: FsrsCardSchedule = {
	due: 1765000000000, stability: 6.4, difficulty: 2.8,
	reps: 5, lapses: 0, state: 2, last_review: 1764000000000,
};

function makeSeedNode(
	id: string,
	name: string,
	statement: string,
	aliases: string[],
	min: string,
	msgId: string,
): GraphNode {
	return {
		id,
		name,
		statement,
		aliases,
		createdAt: `2026-11-16T00:0${min}:00Z`,
		provenance: [{ chatId: "src_1", messageId: msgId }],
	};
}

function seedBayesGraph(stores: ReturnType<typeof createLumberJackStores>): void {
	stores.graphStore.upsertSource({ id: "src_1", filePath: "/docs/probability.md", importedAt: "2026-11-16T00:00:00Z" });
	stores.graphStore.appendNode(makeSeedNode("n_prior", "Prior", "P(A) is prior probability", ["prior"], "1", "m1"));
	stores.graphStore.appendNode(makeSeedNode("n_like", "Likelihood", "P(B|A) is likelihood", [], "2", "m2"));
	stores.graphStore.appendNode(makeSeedNode("n_bayes", "Bayes Rule", "P(A|B) = P(B|A)P(A)/P(B)", ["Bayes"], "3", "m3"));
	stores.graphStore.appendChain({
		id: "arg_bayes",
		premises: ["n_prior", "n_like"],
		conclusion: "n_bayes",
		createdAt: "2026-11-16T00:04:00Z",
		provenance: [{ chatId: "src_1", messageId: "m3" }],
	});
	stores.graphStore.writePositions({ n_prior: { x: 12, y: 34 }, n_bayes: { x: 90, y: 180 } });
}

test("GraphStore persists joint-premise DAG, L4 progress retention, and N9 orphan cleanup", SKIP_GUARD, () => {
	withScratchForest("s1-graph", (dir) => {
		let stores = createLumberJackStores(dir);
		seedBayesGraph(stores);
		stores.learnerStore.updatePropositionProgress("n_prior", { mastery: 0.9 });
		stores.learnerStore.updatePropositionProgress("n_prior", { fsrs: SAMPLE_FSRS });
		stores.learnerStore.updatePropositionProgress("n_unlisted", { mastery: 0.4 });
		assert.equal(stores.forest.getNode("knowledge/propositions/n_unlisted"), null);
		assert.equal(stores.forest.getNode("knowledge/propositions/n_prior")?.metadata?.mastery, 0.9);

		const chainSnap = stores.forest.getNode("knowledge/chains/arg_bayes");
		const parentNames = Object.values(chainSnap?.parents ?? {}).sort();
		assert.equal(parentNames.includes("n_prior"), true);
		assert.equal(parentNames.includes("n_like"), true);
		const conclSnap = stores.forest.getNode("knowledge/propositions/n_bayes");
		assert.equal(Object.values(conclSnap?.parents ?? {}).includes("arg_bayes"), true);

		stores.close();
		stores = createLumberJackStores(dir);
		assert.equal(stores.graphStore.readNodes().length, 3);
		assert.deepEqual(stores.graphStore.readPositions(), { n_prior: { x: 12, y: 34 }, n_bayes: { x: 90, y: 180 } });

		const updatedPrior = makeSeedNode("n_prior", "Prior Updated", "Updated statement", ["prior"], "5", "m1");
		stores.graphStore.rewriteLedgers({ nodes: [updatedPrior], chains: [] });
		assert.deepEqual(stores.learnerStore.readPropositionProgress("n_prior"), { mastery: 0.9, fsrs: SAMPLE_FSRS });
		assert.equal(stores.learnerStore.readPropositionProgress("n_unlisted")?.mastery, 0.4);

		stores.graphStore.rewriteLedgers({ nodes: [], chains: [] });
		assert.equal(stores.graphStore.readNodes().length, 0);
		assert.equal(stores.forest.getNode("knowledge/propositions/n_prior"), null);
		assert.equal(stores.learnerStore.readPropositionProgress("n_prior"), null);
		stores.close();
	});
});

const SAMPLE_EXTRACTION_USAGE: ExtractionRunUsage = {
	startedAt: 1763251200000, at: "2026-11-16T00:02:00Z", durationMs: 450, stats: { nodes: 2, chains: 1 },
	stages: {
		extractor: { model: "anthropic:claude-haiku", steps: [] },
		auditor: { model: "anthropic:claude-sonnet", steps: [] },
	},
};

const VALID_AGENT_RECORD: PluginAgentRecord = {
	version: 1, id: "agent_sess_1", definitionId: "tutor_helper",
	createdAt: "2026-11-16T00:00:00Z", updatedAt: "2026-11-16T00:01:00Z",
	messages: [{ role: "user", content: "Hello", timestamp: 1 } as never],
	pending: [], status: "idle", acceptedInputs: ["req_1"],
};

const VALID_TASK_RECORD: PluginTaskRecord = {
	version: 1, id: "task_1", definitionId: "quiz_builder", requestId: "req_task_1",
	createdAt: "2026-11-16T00:00:00Z", updatedAt: "2026-11-16T00:01:00Z", completedAt: "2026-11-16T00:02:00Z",
	prompt: "Build quiz", input: { topic: "Measure theory" },
	model: { provider: "anthropic", id: "claude-sonnet", thinkingLevel: "low" },
	purpose: "background", maxTurns: 4, turns: 1, status: "succeeded", result: { count: 3 },
	messages: [{ role: "user", content: "Build quiz", timestamp: 10 } as never],
};

function verifyPluginStoreValidation(stores: ReturnType<typeof createLumberJackStores>): void {
	const agentStore = stores.pluginAgentStore("flashcards");
	const taskStore = stores.pluginTaskStore("flashcards");
	agentStore.save(VALID_AGENT_RECORD);
	taskStore.save(VALID_TASK_RECORD);
	assert.equal(agentStore.get("agent_sess_1")?.definitionId, "tutor_helper");
	assert.equal(taskStore.get("task_1")?.status, "succeeded");
	assert.throws(() => agentStore.save({ ...VALID_AGENT_RECORD, status: "bogus" as never }));
	assert.throws(() => agentStore.save({ ...VALID_AGENT_RECORD, id: "../bad" }));
	assert.throws(() => taskStore.save({ ...VALID_TASK_RECORD, input: { bad: Number.NaN } }));
	assert.throws(() => taskStore.save({ ...VALID_TASK_RECORD, input: new Date() }));
	assert.throws(() => taskStore.save({ ...VALID_TASK_RECORD, status: "running" }));

	const scopeHex = Buffer.from("flashcards", "utf8").toString("hex");
	stores.forest.upsertNode({ path: `config/plugins/${scopeHex}/agents/corrupt_a`, slot: { version: 99 } });
	stores.forest.upsertNode({ path: `config/plugins/${scopeHex}/tasks/corrupt_t`, slot: { version: 99 } });
	assert.throws(() => agentStore.get("corrupt_a"));
	assert.throws(() => agentStore.list());
	assert.throws(() => taskStore.get("corrupt_t"));
	assert.throws(() => taskStore.list());
	stores.forest.deleteNode(`config/plugins/${scopeHex}/agents/corrupt_a`);
	stores.forest.deleteNode(`config/plugins/${scopeHex}/tasks/corrupt_t`);
}

test("GraphStore upsertSource preserves extractions and validates plugin stores", SKIP_GUARD, () => {
	withScratchForest("s1-l8", (dir) => {
		let stores = createLumberJackStores(dir);
		stores.graphStore.upsertSource({ id: "src_a", filePath: "/a.md", importedAt: "2026-11-16T00:00:00Z" });
		stores.graphStore.appendSourceUsage("src_a", SAMPLE_EXTRACTION_USAGE);
		stores.graphStore.appendSourceUsage("src_a", SAMPLE_EXTRACTION_USAGE);
		const otherUsage: ExtractionRunUsage = { ...SAMPLE_EXTRACTION_USAGE, startedAt: 999999, durationMs: 10 };
		const nextSrc = (id: string, filePath: string) => ({
			id, filePath, importedAt: "2026-11-16T01:00:00Z", extractions: [otherUsage],
		});
		stores.graphStore.upsertSource(nextSrc("src_a", "/a-renamed.md"));
		stores.graphStore.upsertSource({ id: "src_b", filePath: "/b.md", importedAt: "2026-11-16T00:00:00Z" });
		stores.graphStore.upsertSource(nextSrc("src_b", "/b2.md"));
		verifyPluginStoreValidation(stores);

		stores.close();
		stores = createLumberJackStores(dir);
		const byId = Object.fromEntries(stores.graphStore.readSources().map((s) => [s.id, s]));
		assert.equal(byId.src_a?.filePath, "/a-renamed.md");
		assert.equal(byId.src_a?.extractions?.length, 1);
		assert.equal(byId.src_a?.extractions?.[0]?.startedAt, SAMPLE_EXTRACTION_USAGE.startedAt);
		assert.equal(byId.src_b?.extractions, undefined);
		assert.equal(stores.pluginAgentStore("flashcards").list().length, 1);
		assert.equal(stores.pluginTaskStore("flashcards").list().length, 1);
		stores.close();
	});
});

test("LumberJackForest deleteNode unlinks children and rolls back bad batches", SKIP_GUARD, () => {
	withScratchForest("s1-native-dag", (dir) => {
		let forest = new PublicForest(dir);
		forest.upsertNode({ path: "knowledge/propositions/p_parent", kind: "proposition" });
		forest.upsertNode({
			path: "knowledge/chains/c_child",
			kind: "chain",
			parent_paths: ["knowledge/propositions/p_parent"],
		});
		assert.equal(Object.values(forest.getNode("knowledge/chains/c_child")?.parents ?? {}).includes("p_parent"), true);
		assert.equal(forest.deleteNode("knowledge/propositions/p_parent"), true);
		assert.equal(Object.values(forest.getNode("knowledge/chains/c_child")?.parents ?? {}).includes("p_parent"), false);

		const invalidBatch = [
			{ path: "knowledge/propositions/p_atomic_1", kind: "proposition" },
			{ path: "", kind: "proposition" },
		];
		assert.throws(() => forest.batchUpsertNodes(invalidBatch));
		assert.equal(forest.getNode("knowledge/propositions/p_atomic_1"), null);

		forest.close();
		forest = new PublicForest(dir);
		assert.equal(Object.values(forest.getNode("knowledge/chains/c_child")?.parents ?? {}).includes("p_parent"), false);
		assert.equal(forest.getNode("knowledge/propositions/p_atomic_1"), null);
		forest.close();
	});
});

function verifyPlanTreeCleanup(dir: string): void {
	const stores = createLumberJackStores(dir);
	try {
		const chat = stores.chatStore.createChat("Plan Cleanup");
		const mixedTree = {
			version: 1,
			nodes: [{ id: "p_vec", title: "Vectors" }, { id: "p_mat", title: "Matrices" }, { id: "../bad", title: "Bad" }],
			edges: [{ from: "p_vec", to: "p_mat" }, { from: "../bad", to: "p_mat" }],
		};
		stores.chatStore.saveTree(chat.id, mixedTree);
		assert.deepEqual(stores.forest.listChildren(`plans/${chat.id}`).map((n) => n.name), ["p_mat", "p_vec"]);
		assert.equal(stores.forest.deleteNode(`plans/${chat.id}/p_vec`), true);
		assert.equal(stores.forest.getNode(`plans/${chat.id}/p_vec`), null);
		assert.deepEqual(stores.forest.listChildren(`plans/${chat.id}`).map((n) => n.name), ["p_mat"]);
		stores.forest.upsertNode({ path: `plans/${chat.id}/p_mat`, parent_paths: [], clear_parents: true });
		assert.deepEqual(stores.forest.getNode(`plans/${chat.id}/p_mat`)?.parents, {});
		assert.equal(stores.chatStore.deleteChat(chat.id), true);
		assert.deepEqual(stores.forest.listChildren(`plans/${chat.id}`), []);
		assert.equal(stores.forest.getNode(`plans/${chat.id}`), null);
	} finally {
		stores.close();
	}
}

test("N10/N8: deleteNode cleans tree parent Children, clear_parents, and ID guards", SKIP_GUARD, () => {
	for (const bad of ["", ".", ".."]) {
		assert.equal(isGraphNode({ id: bad, name: "N", statement: "S", aliases: [], createdAt: "t", provenance: [] }), false);
		assert.equal(isGraphChain({ id: bad, premises: ["p1"], conclusion: "c1", provenance: [], createdAt: "t" }), false);
		assert.equal(isNotesSource({ id: bad, filePath: "/a.md", importedAt: "t" }), false);
		assert.throws(() => sanitizeSegment(bad));
	}
	withScratchForest("s3-n10-plans", verifyPlanTreeCleanup);
});

const SAMPLE_THEME: ThemeFile = {
	name: "Nordic Night",
	mode: "dark",
	colors: {
		background: "#101418", accent: "#5e81ac", surface: "#1b222c", bold: "#eceff4",
		border: "#2e3440", italic: "#88c0d0", text: "#d8dee9", code: "#a3be8c",
		textMuted: "#81a1c1", error: "#bf616a", success: "#a3be8c", warning: "#ebcb8b",
	},
};

const SAMPLE_PROFILE = {
	goals: ["Master stochastic calculus"], interests: ["Probability", "Physics"],
	confidenceCalibration: 0.85, updatedAt: "2026-11-16T00:00:00Z",
};

function seedStoresForFullDurability(stores: ReturnType<typeof createLumberJackStores>): string {
	const rawCfg = { version: 1, agent: { fileAccess: { restricted: true, folders: ["/home/persist"] } } };
	stores.settingsStore.writeSettings(rawCfg as never);
	stores.themeStore.writeTheme("nordic-night", SAMPLE_THEME);
	stores.themeStore.writeTheme("temp-theme", { ...SAMPLE_THEME, name: "Temp Theme" });
	stores.themeStore.deleteTheme("temp-theme");
	stores.promptOverrides.writeOverride("teacher/20-teaching.md", "Custom teacher segment");
	stores.graphStore.upsertSource({ id: "src_org", filePath: "/notes/org.md", importedAt: "2026-11-16T00:00:00Z" });
	stores.sourceOrganizationStore.write({
		version: 1,
		folders: [
			{ id: "fld_math", name: "Math", parentId: null, createdAt: "2026-11-16T00:00:00Z" },
			{ id: "fld_meas", name: "Measure", parentId: "fld_math", createdAt: "2026-11-16T00:01:00Z" },
		],
		placements: { src_org: { folderId: "fld_meas", name: "Measure Notes" } },
	});
	stores.graphStore.appendCheckpoint({ chatId: "chat_1", foldedAt: "2026-11-16T00:05:00Z" });
	stores.graphStore.appendCoverage({ chatId: "chat_1", fp: "fp_abc", tokens: 64, foldedAt: "2026-11-16T00:05:00Z" });
	const job = stores.jobStore.createJob({ kind: "research", chatId: "chat_1", toolCallId: "tc_1" });
	stores.jobStore.updateJob(job.id, { status: "done", activity: "finished" });
	stores.learnerStore.writeProfile(SAMPLE_PROFILE);
	return job.id;
}

test("Themes, SourceOrg DAG, Checkpoints, Coverage, Settings, Prompts, and Jobs persist", SKIP_GUARD, () => {
	withScratchForest("s1-durability", (dir) => {
		let stores = createLumberJackStores(dir);
		assert.equal(stores.settingsStore.readSettings(), null);
		const jobId = seedStoresForFullDurability(stores);
		const hasParent = (p: string, name: string) => Object.values(stores.forest.getNode(p)?.parents ?? {}).includes(name);
		assert.equal(hasParent("knowledge/folders/fld_meas", "fld_math"), true);
		assert.equal(hasParent("knowledge/sources/src_org", "fld_meas"), true);

		stores.close();
		stores = createLumberJackStores(dir);
		assert.deepEqual(stores.settingsStore.readFileAccessSettings(), {
			ok: true,
			settings: { restricted: true, folders: ["/home/persist"] },
		});
		assert.deepEqual(stores.themeStore.listThemes().map((t) => t.id), ["nordic-night"]);
		assert.equal(stores.themeStore.readTheme("nordic-night")?.name, "Nordic Night");
		assert.deepEqual(stores.promptOverrides.listOverrides(), ["teacher/20-teaching.md"]);
		assert.equal(stores.sourceOrganizationStore.read().placements.src_org?.folderId, "fld_meas");
		assert.deepEqual(stores.graphStore.readCheckpoints(), [{ chatId: "chat_1", foldedAt: "2026-11-16T00:05:00Z" }]);
		assert.deepEqual(stores.graphStore.readCoverage(), [
			{ chatId: "chat_1", fp: "fp_abc", tokens: 64, foldedAt: "2026-11-16T00:05:00Z" },
		]);
		assert.equal(stores.jobStore.findJobByToolCallId("chat_1", "tc_1")?.id, jobId);
		assert.equal(stores.learnerStore.readProfile()?.goals[0], "Master stochastic calculus");
		assert.equal(stores.jobStore.deleteJobsForChat("chat_1"), 1);
		stores.close();
	});
});
