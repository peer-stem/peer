import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { ExtractionRunUsage, TurnUsage } from "../src/core/contracts.ts";
import { subscribe, type ServerEvent } from "../src/core/events.ts";
import type { LhMessage } from "../src/core/native-messages.ts";
import type { PluginAgentRecord } from "../src/core/plugin-agents.ts";
import type { PluginTaskRecord } from "../src/core/plugin-workers.ts";
import type { ThemeFile } from "../src/core/themes.ts";
import { DEFAULT_ADDON_PATH, type LumberJackForest } from "../src/store/lumberjack/binding.ts";
import {
	createLumberJackStores,
	LJ_STATUS,
	LumberJackForest as PublicForest,
	startLumberJackStreamBridge,
	type FsrsCardSchedule,
} from "../src/store/lumberjack/index.ts";

const WORKTREE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PERSIST_ROOT = process.env.PEER_PERSIST_ROOT ?? "/usr/lib/persist/peer";
const SCRATCH_ROOT = process.env.PEER_TEST_SCRATCH ?? path.join(PERSIST_ROOT, "scratch");
const SKIP_GUARD = {
	skip:
		!fs.existsSync(DEFAULT_ADDON_PATH) && process.env.PEER_REQUIRE_SUBSTRATE !== "1"
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
	due: 1765000000000,
	stability: 6.4,
	difficulty: 2.8,
	reps: 5,
	lapses: 0,
	state: 2,
	last_review: 1764000000000,
};

function seedBayesGraph(stores: ReturnType<typeof createLumberJackStores>): void {
	stores.graphStore.upsertSource({
		id: "src_1",
		filePath: "/docs/probability.md",
		importedAt: "2026-11-16T00:00:00Z",
	});
	stores.graphStore.appendNode({
		id: "n_prior",
		name: "Prior",
		statement: "P(A) is prior probability",
		aliases: ["prior"],
		createdAt: "2026-11-16T00:01:00Z",
		provenance: [{ chatId: "src_1", messageId: "m1" }],
	});
	stores.graphStore.appendNode({
		id: "n_like",
		name: "Likelihood",
		statement: "P(B|A) is likelihood",
		aliases: [],
		createdAt: "2026-11-16T00:02:00Z",
		provenance: [{ chatId: "src_1", messageId: "m2" }],
	});
	stores.graphStore.appendNode({
		id: "n_bayes",
		name: "Bayes Rule",
		statement: "P(A|B) = P(B|A)P(A)/P(B)",
		aliases: ["Bayes"],
		createdAt: "2026-11-16T00:03:00Z",
		provenance: [{ chatId: "src_1", messageId: "m3" }],
	});
	stores.graphStore.appendChain({
		id: "arg_bayes",
		premises: ["n_prior", "n_like"],
		conclusion: "n_bayes",
		createdAt: "2026-11-16T00:04:00Z",
		provenance: [{ chatId: "src_1", messageId: "m3" }],
	});
	stores.graphStore.writePositions({ n_prior: { x: 12, y: 34 }, n_bayes: { x: 90, y: 180 } });
}

test("GraphStore persists joint-premise DAG, canvas positions, and durable learner progress across rewriteLedgers", SKIP_GUARD, () => {
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
		assert.equal(parentNames.includes("n_prior") && parentNames.includes("n_like"), true);
		const conclSnap = stores.forest.getNode("knowledge/propositions/n_bayes");
		assert.equal(Object.values(conclSnap?.parents ?? {}).includes("arg_bayes"), true);

		stores.close();
		stores = createLumberJackStores(dir);
		assert.equal(stores.graphStore.readNodes().length, 3);
		assert.deepEqual(stores.graphStore.readPositions(), { n_prior: { x: 12, y: 34 }, n_bayes: { x: 90, y: 180 } });

		stores.graphStore.rewriteLedgers({ nodes: [], chains: [] });
		assert.equal(stores.graphStore.readNodes().length, 0);
		assert.equal(stores.forest.getNode("knowledge/propositions/n_prior"), null);
		assert.deepEqual(stores.learnerStore.readPropositionProgress("n_prior"), { mastery: 0.9, fsrs: SAMPLE_FSRS });

		stores.close();
		stores = createLumberJackStores(dir);
		assert.deepEqual(stores.learnerStore.readPropositionProgress("n_prior"), { mastery: 0.9, fsrs: SAMPLE_FSRS });
		stores.close();
	});
});

const SAMPLE_PLAN_TREE = {
	version: 1,
	nodes: [
		{ id: "p_vec", title: "Vectors" },
		{ id: "p_mat", title: "Matrices" },
		{ id: "p_eig", title: "Eigenvalues" },
	],
	edges: [
		{ from: "p_vec", to: "p_eig" },
		{ from: "p_mat", to: "p_eig" },
	],
};

const SAMPLE_SIDE_CHATS = [
	{
		id: "th_1",
		anchor: { messageId: "msg_u1", partId: "msg_u1-t0", blockIndex: 0, blockText: "Explain eigenvalues" },
		open: true,
		createdAt: "2026-11-16T00:00:00Z",
		messages: [{ id: "sc_1", role: "user" as const, text: "Why non-zero vector?", at: "2026-11-16T00:00:01Z" }],
	},
];

const SAMPLE_TURN_USAGE: TurnUsage = {
	id: "turn_req_1",
	messageId: "msg_a1",
	at: "2026-11-16T00:01:00Z",
	model: "anthropic:claude-sonnet",
	steps: [{ inputTokens: 120, outputTokens: 45, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 10 }],
};

const SAMPLE_EXTRACTION_USAGE: ExtractionRunUsage = {
	startedAt: 1763251200000,
	at: "2026-11-16T00:02:00Z",
	durationMs: 450,
	stats: { nodes: 2, chains: 1 },
	stages: {
		extractor: { model: "anthropic:claude-haiku", steps: [] },
		auditor: { model: "anthropic:claude-sonnet", steps: [] },
	},
};

function verifyChatForestAndUsage(
	stores: ReturnType<typeof createLumberJackStores>,
	chatId: string,
	sha: string,
	rawBase64: string,
): void {
	const eigPlan = stores.forest.getNode(`plans/${chatId}/p_eig`);
	const eigParents = Object.values(eigPlan?.parents ?? {});
	assert.equal(eigParents.includes("p_vec") && eigParents.includes("p_mat"), true);
	const sideEntry = stores.forest.getEntries(`sessions/${chatId}`, "main").find((e) => e.id === "sc_1");
	assert.equal(sideEntry?.parent_id, "msg_u1");
	stores.chatStore.appendTurnUsage(chatId, SAMPLE_TURN_USAGE);
	stores.chatStore.appendTurnUsage(chatId, SAMPLE_TURN_USAGE);
	stores.chatStore.appendTurnUsage(chatId, { ...SAMPLE_TURN_USAGE, id: "turn_req_2" });
	stores.chatStore.appendExtractionUsage(chatId, SAMPLE_EXTRACTION_USAGE);
	stores.chatStore.appendExtractionUsage(chatId, SAMPLE_EXTRACTION_USAGE);
	const loaded = stores.chatStore.getChat(chatId);
	assert.equal(loaded?.imageSnapshots?.[sha]?.data, rawBase64);
	assert.equal(loaded?.turns?.length, 2);
	assert.equal(loaded?.extractions?.length, 1);
}

test("ChatStore honors SILENCE LAW, listChats order, idempotent usage appends, and reopen durability", SKIP_GUARD, () => {
	withScratchForest("s1-chat", (dir) => {
		let stores = createLumberJackStores(dir);
		let chatsChangedCount = 0;
		const unsub = subscribe((ev) => {
			if (ev.type === "chats-changed") chatsChangedCount++;
		});
		try {
			const older = stores.chatStore.createChat("Older Session");
			const chat = stores.chatStore.createChat("Linear Algebra", "practice");
			assert.equal(chatsChangedCount, 2);
			const userMsg = { id: "msg_u1", role: "user", content: "Explain eigenvalues", timestamp: 1 } as LhMessage;
			stores.chatStore.saveMessages(chat.id, [userMsg]);
			stores.chatStore.saveTree(chat.id, SAMPLE_PLAN_TREE);
			stores.chatStore.updateSideChats(chat.id, () => SAMPLE_SIDE_CHATS);
			const rawBytes = Buffer.from("svg-or-png-binary-payload");
			const sha = createHash("sha256").update(rawBytes).digest("hex");
			const rawBase64 = rawBytes.toString("base64");
			stores.chatStore.saveImageSnapshot(chat.id, sha, { mimeType: "image/png", data: rawBase64, width: 64, height: 64 });
			assert.equal(chatsChangedCount, 2, "content saves must stay silent");
			verifyChatForestAndUsage(stores, chat.id, sha, rawBase64);
			stores.chatStore.renameChat(chat.id, "Spectral Theory");
			assert.equal(chatsChangedCount, 3);

			stores.close();
			stores = createLumberJackStores(dir);
			const listed = stores.chatStore.listChats();
			assert.deepEqual(listed.map((c) => c.id), [chat.id, older.id]);
			assert.equal(listed[0]?.title, "Spectral Theory");
			assert.equal(listed[0]?.kind, "practice");
			assert.equal(stores.chatStore.getChat(chat.id)?.turns?.length, 2);
			assert.equal(stores.chatStore.getChat(chat.id)?.extractions?.length, 1);
			assert.equal(stores.chatStore.deleteChat(older.id), true);
			assert.equal(stores.chatStore.listChats().length, 1);
		} finally {
			unsub();
			stores.close();
		}
	});
});

test("StreamBridge dispatches raw node_path mutations and catches transient poll timer errors", SKIP_GUARD, async () => {
	await withScratchForest("s1-stream", async (dir) => {
		const stores = createLumberJackStores(dir);
		const captured: ServerEvent[] = [];
		const unsub = subscribe((ev) => captured.push(ev));
		const bridge = startLumberJackStreamBridge(stores.forest, 60_000);
		try {
			stores.forest.upsertNode({ path: "sessions/chat_raw", kind: "session" });
			stores.forest.upsertNode({ path: "knowledge/sources/src_raw", kind: "source" });
			stores.forest.upsertNode({ path: "jobs/job_raw", kind: "job" });
			assert.equal(captured.length, 0, "raw forest upserts do not emit directly");
			bridge.pollOnce();
			assert.equal(captured.some((e) => e.type === "record-changed" && e.chatId === "chat_raw"), true);
			assert.equal(captured.some((e) => e.type === "sources-changed"), true);
			assert.equal(captured.some((e) => e.type === "jobs-changed"), true);
		} finally {
			bridge.stop();
			unsub();
			stores.close();
		}

		let loggedErrors = 0;
		const origError = console.error;
		console.error = () => { loggedErrors++; };
		const failingForest = {
			isOpen: true,
			pollStream() { throw new Error("transient poll failure"); },
		} as unknown as LumberJackForest;
		const errBridge = startLumberJackStreamBridge(failingForest, 10);
		try {
			await new Promise((resolve) => setTimeout(resolve, 35));
			assert.equal(loggedErrors >= 1, true);
		} finally {
			errBridge.stop();
			console.error = origError;
		}
	});
});

const VALID_AGENT_RECORD: PluginAgentRecord = {
	version: 1,
	id: "agent_sess_1",
	definitionId: "tutor_helper",
	createdAt: "2026-11-16T00:00:00Z",
	updatedAt: "2026-11-16T00:01:00Z",
	messages: [{ role: "user", content: "Hello", timestamp: 1 } as never],
	pending: [],
	status: "idle",
	acceptedInputs: ["req_1"],
};

const VALID_TASK_RECORD: PluginTaskRecord = {
	version: 1,
	id: "task_1",
	definitionId: "quiz_builder",
	requestId: "req_task_1",
	createdAt: "2026-11-16T00:00:00Z",
	updatedAt: "2026-11-16T00:01:00Z",
	completedAt: "2026-11-16T00:02:00Z",
	prompt: "Build quiz",
	input: { topic: "Measure theory" },
	model: { provider: "anthropic", id: "claude-sonnet", thinkingLevel: "low" },
	purpose: "background",
	maxTurns: 4,
	turns: 1,
	status: "succeeded",
	result: { count: 3 },
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

test("GraphStore upsertSource preserves existing extractions and plugin stores enforce schema validation", SKIP_GUARD, () => {
	withScratchForest("s1-l8", (dir) => {
		let stores = createLumberJackStores(dir);
		stores.graphStore.upsertSource({ id: "src_a", filePath: "/a.md", importedAt: "2026-11-16T00:00:00Z" });
		stores.graphStore.appendSourceUsage("src_a", SAMPLE_EXTRACTION_USAGE);
		stores.graphStore.appendSourceUsage("src_a", SAMPLE_EXTRACTION_USAGE);
		const otherUsage: ExtractionRunUsage = { ...SAMPLE_EXTRACTION_USAGE, startedAt: 999999, durationMs: 10 };
		stores.graphStore.upsertSource({
			id: "src_a",
			filePath: "/a-renamed.md",
			importedAt: "2026-11-16T01:00:00Z",
			extractions: [otherUsage],
		});
		stores.graphStore.upsertSource({ id: "src_b", filePath: "/b.md", importedAt: "2026-11-16T00:00:00Z" });
		stores.graphStore.upsertSource({
			id: "src_b",
			filePath: "/b2.md",
			importedAt: "2026-11-16T01:00:00Z",
			extractions: [otherUsage],
		});
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

test("LumberJackForest deleteNode unlinks children parents and batchUpsertNodes rolls back atomically", SKIP_GUARD, () => {
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

const SAMPLE_THEME: ThemeFile = {
	name: "Nordic Night",
	mode: "dark",
	colors: {
		background: "#101418",
		accent: "#5e81ac",
		surface: "#1b222c",
		bold: "#eceff4",
		border: "#2e3440",
		italic: "#88c0d0",
		text: "#d8dee9",
		code: "#a3be8c",
		textMuted: "#81a1c1",
		error: "#bf616a",
		success: "#a3be8c",
		warning: "#ebcb8b",
	},
};

const SAMPLE_PROFILE = {
	goals: ["Master stochastic calculus"],
	interests: ["Probability", "Physics"],
	confidenceCalibration: 0.85,
	updatedAt: "2026-11-16T00:00:00Z",
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

test("Themes, SourceOrganization DAG, Checkpoints, Coverage, Settings, Prompts, Jobs, and LearnerStore survive reopen", SKIP_GUARD, () => {
	withScratchForest("s1-durability", (dir) => {
		let stores = createLumberJackStores(dir);
		assert.equal(stores.settingsStore.readSettings(), null);
		const jobId = seedStoresForFullDurability(stores);
		assert.equal(
			Object.values(stores.forest.getNode("knowledge/folders/fld_meas")?.parents ?? {}).includes("fld_math"),
			true,
		);
		assert.equal(
			Object.values(stores.forest.getNode("knowledge/sources/src_org")?.parents ?? {}).includes("fld_meas"),
			true,
		);

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
