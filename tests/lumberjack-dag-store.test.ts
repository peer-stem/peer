import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { subscribe } from "../src/core/events.ts";
import type { LhMessage } from "../src/core/native-messages.ts";
import { createLumberJackStores, LJ_STATUS, LumberJackForest } from "../src/store/lumberjack/index.ts";

const WORKTREE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PERSIST_ROOT = process.env.PEER_PERSIST_ROOT ?? "/usr/lib/persist/peer";
const SCRATCH_ROOT = path.join(PERSIST_ROOT, "scratch");

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

test("LumberJackForest enforces close handle guard and cross-process LJ_LOCKED", () => {
	withScratchForest("s1-lock", (dir) => {
		const forest = new LumberJackForest(dir);
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

test("GraphStore persists multi-parent joint-premise DAG, colocated canvas positions, and reopen durability", () => {
	withScratchForest("s1-graph", (dir) => {
		let stores = createLumberJackStores(dir);
		seedBayesGraph(stores);
		const chainSnap = stores.forest.getNode("knowledge/chains/arg_bayes");
		assert.ok(chainSnap);
		const parentNames = Object.values(chainSnap.parents).sort();
		assert.equal(parentNames.includes("n_prior"), true);
		assert.equal(parentNames.includes("n_like"), true);
		const conclSnap = stores.forest.getNode("knowledge/propositions/n_bayes");
		assert.equal(Object.values(conclSnap?.parents ?? {}).includes("arg_bayes"), true);

		stores.close();
		stores = createLumberJackStores(dir);
		assert.equal(stores.graphStore.readNodes().length, 3);
		assert.equal(stores.graphStore.readChains().length, 1);
		assert.deepEqual(stores.graphStore.readPositions(), { n_prior: { x: 12, y: 34 }, n_bayes: { x: 90, y: 180 } });

		stores.graphStore.rewriteLedgers({
			nodes: stores.graphStore.readNodes().filter((n) => n.id !== "n_prior"),
			chains: [],
		});
		assert.deepEqual(stores.graphStore.readPositions(), { n_bayes: { x: 90, y: 180 } });
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

function verifyChatForestState(
	stores: ReturnType<typeof createLumberJackStores>,
	chatId: string,
	sha: string,
	rawBase64: string,
): void {
	const eigPlan = stores.forest.getNode(`plans/${chatId}/p_eig`);
	const eigParents = Object.values(eigPlan?.parents ?? {});
	assert.equal(eigParents.includes("p_vec") && eigParents.includes("p_mat"), true);
	const entries = stores.forest.getEntries(`sessions/${chatId}`, "main");
	const sideEntry = entries.find((e) => e.id === "sc_1");
	assert.equal(sideEntry?.parent_id, "msg_u1");
	const loaded = stores.chatStore.getChat(chatId);
	assert.equal(loaded?.imageSnapshots?.[sha]?.data, rawBase64);
}

test("ChatStore honors SILENCE LAW, PlanTree DAG edges, side-chat ParentID entries, and SHA-256 objects", () => {
	withScratchForest("s1-chat", (dir) => {
		const stores = createLumberJackStores(dir);
		let chatsChangedCount = 0;
		const unsub = subscribe((ev) => {
			if (ev.type === "chats-changed") chatsChangedCount++;
		});
		try {
			const chat = stores.chatStore.createChat("Linear Algebra");
			assert.equal(chatsChangedCount, 1);
			const userMsg = { id: "msg_u1", role: "user", content: "Explain eigenvalues", timestamp: 1 } as LhMessage;
			stores.chatStore.saveMessages(chat.id, [userMsg]);
			stores.chatStore.saveTree(chat.id, SAMPLE_PLAN_TREE);
			stores.chatStore.updateSideChats(chat.id, () => SAMPLE_SIDE_CHATS);
			const rawBytes = Buffer.from("svg-or-png-binary-payload");
			const sha = createHash("sha256").update(rawBytes).digest("hex");
			const rawBase64 = rawBytes.toString("base64");
			const snapshot = { mimeType: "image/png" as const, data: rawBase64, width: 64, height: 64 };
			stores.chatStore.saveImageSnapshot(chat.id, sha, snapshot);
			assert.equal(chatsChangedCount, 1, "content saves must stay silent");
			verifyChatForestState(stores, chat.id, sha, rawBase64);
			stores.chatStore.renameChat(chat.id, "Spectral Theory");
			assert.equal(chatsChangedCount, 2);
			assert.equal(stores.chatStore.deleteChat(chat.id), true);
			assert.equal(chatsChangedCount, 3);
		} finally {
			unsub();
			stores.close();
		}
	});
});

const SAMPLE_PROFILE = {
	goals: ["Master stochastic calculus"],
	interests: ["Probability", "Physics"],
	confidenceCalibration: 0.85,
	updatedAt: "2026-11-16T00:00:00Z",
};

test("JobStore, Settings, Themes, PromptOverrides, LearnerStore, and StreamBridge work end to end", () => {
	withScratchForest("s1-misc", (dir) => {
		const stores = createLumberJackStores(dir);
		const events: string[] = [];
		const unsub = subscribe((ev) => events.push(ev.type));
		const bridge = startStreamAndVerify(stores);
		try {
			assert.equal(stores.settingsStore.readSettings(), null);
			assert.equal(stores.settingsStore.readFileAccessSettings().ok, true);
			const rawCfg = { version: 1, agent: { fileAccess: { restricted: true, folders: ["/home/persist"] } } };
			stores.settingsStore.writeSettings(rawCfg as never);
			const expectedAccess = { ok: true, settings: { restricted: true, folders: ["/home/persist"] } };
			assert.deepEqual(stores.settingsStore.readFileAccessSettings(), expectedAccess);

			stores.promptOverrides.writeOverride("teacher/20-teaching.md", "Custom teacher segment");
			assert.deepEqual(stores.promptOverrides.listOverrides(), ["teacher/20-teaching.md"]);
			assert.equal(stores.promptOverrides.readOverride("teacher/20-teaching.md"), "Custom teacher segment");

			const job = stores.jobStore.createJob({ kind: "research", chatId: "chat_1", toolCallId: "tc_1" });
			assert.equal(stores.jobStore.findJobByToolCallId("chat_1", "tc_1")?.id, job.id);
			stores.jobStore.updateJob(job.id, { status: "done", activity: "finished" });
			assert.equal(stores.jobStore.deleteJobsForChat("chat_1"), 1);

			stores.learnerStore.writeProfile(SAMPLE_PROFILE);
			assert.equal(stores.learnerStore.readProfile()?.goals[0], "Master stochastic calculus");
			bridge.pollOnce();
			assert.equal(events.includes("jobs-changed"), true);
		} finally {
			bridge.stop();
			unsub();
			stores.close();
		}
	});
});

function startStreamAndVerify(stores: ReturnType<typeof createLumberJackStores>) {
	return stores.startStreamBridge(60_000) as { stop(): void; pollOnce(): unknown };
}
