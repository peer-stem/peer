import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import type { ExtractionRunUsage, GraphNode, SideChatThread, TurnUsage } from "../src/core/contracts.ts";
import { subscribe, type ServerEvent } from "../src/core/events.ts";
import type { LhMessage } from "../src/core/native-messages.ts";
import { DEFAULT_ADDON_PATH, type LumberJackForest } from "../src/store/lumberjack/binding.ts";
import { encodeEntitySegment } from "../src/store/lumberjack/graph-store.ts";
import { createLumberJackStores, LJ_STATUS, startLumberJackStreamBridge } from "../src/store/lumberjack/index.ts";

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

const SAMPLE_PLAN_TREE = {
	version: 1,
	nodes: [{ id: "p_vec", title: "Vectors" }, { id: "p_mat", title: "Matrices" }, { id: "p_eig", title: "Eigenvalues" }],
	edges: [{ from: "p_vec", to: "p_eig" }, { from: "p_mat", to: "p_eig" }],
};

const SAMPLE_SIDE_CHATS: SideChatThread[] = [
	{
		id: "th_1",
		anchor: { messageId: "msg_u1", partId: "msg_u1-t0", blockIndex: 0, blockText: "Explain eigenvalues" },
		open: true,
		createdAt: "2026-11-16T00:00:00Z",
		messages: [{ id: "sc_1", role: "user", text: "Why non-zero vector?", at: "2026-11-16T00:00:01Z" }],
	},
];

const SAMPLE_TURN_USAGE: TurnUsage = {
	id: "turn_req_1", messageId: "msg_a1", at: "2026-11-16T00:01:00Z", model: "anthropic:claude-sonnet",
	steps: [{ inputTokens: 120, outputTokens: 45, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 10 }],
};

const SAMPLE_EXTRACTION_USAGE: ExtractionRunUsage = {
	startedAt: 1763251200000, at: "2026-11-16T00:02:00Z", durationMs: 450, stats: { nodes: 2, chains: 1 },
	stages: {
		extractor: { model: "anthropic:claude-haiku", steps: [] },
		auditor: { model: "anthropic:claude-sonnet", steps: [] },
	},
};

function verifyObjectStorageInForest(
	stores: ReturnType<typeof createLumberJackStores>,
	dir: string,
	chatId: string,
	sha: string,
	rawBase64: string,
): void {
	stores.chatStore.saveTree(chatId, SAMPLE_PLAN_TREE);
	stores.chatStore.saveImageSnapshot(chatId, sha, {
		mimeType: "image/png", data: rawBase64, width: 64, height: 64,
	});
	assert.throws(() =>
		stores.chatStore.saveImageSnapshot(chatId, "0".repeat(64), {
			mimeType: "image/png", data: rawBase64, width: 1, height: 1,
		}),
	);
	const dupReceipt = stores.forest.putObject(sha, "image/png", rawBase64);
	assert.equal(dupReceipt.existed, true);
	assert.equal(fs.existsSync(path.join(dir, "state.objects")), true);
	assert.equal(stores.forest.getNode("objects"), null);
	assert.deepEqual(stores.forest.listChildren("objects"), []);
	const eigParents = Object.values(stores.forest.getNode(`plans/${chatId}/p_eig`)?.parents ?? {});
	assert.equal(eigParents.includes("p_vec"), true);
	assert.equal(eigParents.includes("p_mat"), true);
}

test("L5: binary images store in LumberJack /objects segments with zero objects/** nodes", SKIP_GUARD, () => {
	withScratchForest("s4-l5-objects", (dir) => {
		let stores = createLumberJackStores(dir);
		let chatsChanged = 0;
		const unsub = subscribe((ev) => {
			if (ev.type === "chats-changed") chatsChanged++;
		});
		const rawBytes = Buffer.from("png-binary-payload-for-lumberjack-object-store");
		const sha = createHash("sha256").update(rawBytes).digest("hex");
		const rawBase64 = rawBytes.toString("base64");
		try {
			const older = stores.chatStore.createChat("Older Session");
			const chat = stores.chatStore.createChat("Linear Algebra", "practice");
			assert.equal(chatsChanged, 2);
			verifyObjectStorageInForest(stores, dir, chat.id, sha, rawBase64);
			assert.equal(chatsChanged, 2, "content saves must stay silent");
			stores.chatStore.renameChat(chat.id, "Spectral Theory");
			assert.equal(chatsChanged, 3);
			stores.close();

			stores = createLumberJackStores(dir);
			const listed = stores.chatStore.listChats();
			assert.deepEqual(listed.map((c) => c.id), [chat.id, older.id]);
			assert.equal(listed[0]?.title, "Spectral Theory");
			assert.equal(listed[0]?.kind, "practice");
			assert.equal(stores.chatStore.getChat(chat.id)?.imageSnapshots?.[sha]?.data, rawBase64);
			assert.equal(stores.chatStore.deleteChat(older.id), true);
		} finally {
			unsub();
			stores.close();
		}
	});
});

function verifySessionEventChannelsAndDelta(stores: ReturnType<typeof createLumberJackStores>, chatId: string): void {
	const m1 = { id: "msg_u1", role: "user", content: "Explain eigenvalues", timestamp: 1 } as LhMessage;
	const m2 = {
		id: "msg_a1",
		role: "assistant",
		content: [{ type: "text", text: "Eigenvalues scale eigenvectors" }],
		timestamp: 2,
	} as unknown as LhMessage;
	let appendCalls = 0;
	let setCalls = 0;
	const origAppend = stores.forest.appendEntries.bind(stores.forest);
	const origSet = stores.forest.setEntries.bind(stores.forest);
	stores.forest.appendEntries = (...args) => { appendCalls++; return origAppend(...args); };
	stores.forest.setEntries = (...args) => { setCalls++; return origSet(...args); };
	try {
		stores.chatStore.saveMessages(chatId, [m1]);
		assert.equal(setCalls, 1);
		stores.chatStore.saveMessages(chatId, [m1, m2]);
		assert.equal(appendCalls, 1, "prefix extension must use incremental appendEntries");
		assert.equal(setCalls, 1, "prefix extension must not rewrite whole event");
		stores.chatStore.saveMessages(chatId, [{ ...m1, content: "Edited question" } as LhMessage, m2]);
		assert.equal(setCalls, 2, "mutated history rewrites cleanly");
	} finally {
		stores.forest.appendEntries = origAppend;
		stores.forest.setEntries = origSet;
	}
}

function seedAndCheckCanonicalEvents(stores: ReturnType<typeof createLumberJackStores>, chatId: string): string {
	stores.chatStore.updateSideChats(chatId, () => SAMPLE_SIDE_CHATS);
	stores.chatStore.updateSideChats(chatId, (prev) => [
		{ ...prev[0]!, messages: [...prev[0]!.messages, { id: "sc_2", role: "assistant", text: "Non-trivial", at: "t2" }] },
	]);
	stores.chatStore.appendTurnUsage(chatId, SAMPLE_TURN_USAGE);
	stores.chatStore.appendTurnUsage(chatId, SAMPLE_TURN_USAGE);
	stores.chatStore.appendTurnUsage(chatId, { ...SAMPLE_TURN_USAGE, id: "turn_req_2" });
	stores.chatStore.appendExtractionUsage(chatId, SAMPLE_EXTRACTION_USAGE);
	stores.chatStore.appendExtractionUsage(chatId, SAMPLE_EXTRACTION_USAGE);
	const sessSlot = (stores.forest.getNode(`sessions/${chatId}`)?.slot ?? {}) as Record<string, unknown>;
	assert.equal("messages" in sessSlot, false);
	assert.equal("sideChats" in sessSlot, false);
	assert.equal("turns" in sessSlot, false);
	assert.equal("extractions" in sessSlot, false);
	assert.equal(stores.forest.getEntries(`sessions/${chatId}`, "side:th_1")[0]?.parent_id, "msg_u1");
	const job = stores.jobStore.createJob({ kind: "research", chatId, toolCallId: "tc_ev" });
	assert.equal(stores.forest.getNode(`jobs/${job.id}`)?.slot, undefined);
	assert.equal(stores.forest.listEvents(`jobs/${job.id}`)[0]?.status, "ongoing");
	stores.jobStore.updateJob(job.id, { status: "done", activity: "complete", result: "ok" });
	assert.equal(stores.forest.listEvents(`jobs/${job.id}`)[0]?.status, "finished");
	return job.id;
}

test("L6/L7: sessions and jobs persist in canonical Events/Entries with stripped slots", SKIP_GUARD, () => {
	withScratchForest("s4-l6-events", (dir) => {
		let stores = createLumberJackStores(dir);
		const chat = stores.chatStore.createChat("Canonical Events");
		verifySessionEventChannelsAndDelta(stores, chat.id);
		const jobId = seedAndCheckCanonicalEvents(stores, chat.id);
		stores.forest.eventStart(`sessions/${chat.id}`, "cabi_probe", { source: "napi" });
		stores.forest.eventAppend(`sessions/${chat.id}`, "cabi_probe", "hello-cabi", { step: 1 });
		stores.forest.eventEnd(`sessions/${chat.id}`, "cabi_probe");
		assert.equal(stores.forest.eventEntries(`sessions/${chat.id}`, "cabi_probe").includes("hello-cabi"), true);

		stores.close();
		stores = createLumberJackStores(dir);
		const hydrated = stores.chatStore.getChat(chat.id);
		assert.equal(hydrated?.messages.length, 2);
		assert.equal(hydrated?.sideChats?.[0]?.messages.length, 2);
		assert.equal(hydrated?.turns?.length, 2);
		assert.equal(hydrated?.extractions?.length, 1);
		assert.equal(stores.jobStore.getJob(jobId)?.result, "ok");
		stores.chatStore.updateSideChats(chat.id, () => []);
		assert.equal(stores.chatStore.getChat(chat.id)?.sideChats, undefined);
		stores.close();
	});
});

function makeGraphNode(id: string): GraphNode {
	return { id, name: id, statement: `Stmt ${id}`, aliases: [], createdAt: "2026-11-18T00:00:00Z", provenance: [] };
}

function assertZeroRootSlotReadsDuringProgress(stores: ReturnType<typeof createLumberJackStores>): void {
	let rootSlotExecCount = 0;
	const origExec = stores.forest.exec.bind(stores.forest);
	stores.forest.exec = ((op: string, payload?: unknown) => {
		if (op === "get_root_slot") rootSlotExecCount++;
		return origExec(op, payload);
	}) as typeof stores.forest.exec;
	try {
		stores.learnerStore.updatePropositionProgress("n?1", { mastery: 0.25 });
		stores.learnerStore.updatePropositionProgress("n_1", { mastery: 0.85 });
		assert.equal(rootSlotExecCount, 0, "progress updates must not read peer_ledgers");
		assert.equal(stores.graphStore.readNodes().length, 2);
		assert.equal(rootSlotExecCount, 1, "positive control: first uncached readNodes reads get_root_slot once");
		assert.equal(stores.graphStore.readNodes().length, 2);
		assert.equal(rootSlotExecCount, 1, "cached ledger read must not re-read get_root_slot");
	} finally {
		stores.forest.exec = origExec;
	}
}

test("N9: collision-free segment encoding, unknown ledger preservation, and cached root slot", SKIP_GUARD, () => {
	assert.notEqual(encodeEntitySegment("n?1"), encodeEntitySegment("n_1"));
	assert.notEqual(encodeEntitySegment("hex_raw"), "hex_raw");
	withScratchForest("s4-n9", (dir) => {
		let stores = createLumberJackStores(dir);
		stores.forest.setRootSlot({
			futureExtensionKey: { version: 99, flag: true },
			nodes: [{ futureNodeShape: true, id: "unrecognized_v2" }],
			chains: [], checkpoints: [], coverage: [],
		});
		stores.graphStore.appendNode(makeGraphNode("n?1"));
		stores.graphStore.appendNode(makeGraphNode("n_1"));
		stores.graphStore.writePositions({ "n?1": { x: 10, y: 20 }, n_1: { x: 30, y: 40 } });
		stores.close();
		stores = createLumberJackStores(dir);
		assertZeroRootSlotReadsDuringProgress(stores);

		assert.equal(stores.learnerStore.readPropositionProgress("n?1")?.mastery, 0.25);
		assert.equal(stores.learnerStore.readPropositionProgress("n_1")?.mastery, 0.85);
		assert.deepEqual(stores.graphStore.readPositions(), { "n?1": { x: 10, y: 20 }, n_1: { x: 30, y: 40 } });
		stores.graphStore.rewriteLedgers({ nodes: [makeGraphNode("n_1")] });
		assert.equal(stores.learnerStore.readPropositionProgress("n?1"), null);
		assert.equal(stores.learnerStore.readPropositionProgress("n_1")?.mastery, 0.85);

		stores.close();
		stores = createLumberJackStores(dir);
		const rawRoot = stores.forest.getRootSlot<Record<string, unknown>>();
		assert.deepEqual(rawRoot?.futureExtensionKey, { version: 99, flag: true });
		const rawNodes = Array.isArray(rawRoot?.nodes) ? rawRoot.nodes : [];
		assert.equal(rawNodes.some((item) => (item as { futureNodeShape?: boolean }).futureNodeShape === true), true);
		stores.close();
	});
});

async function verifyGapAndPollErrorHandling(): Promise<void> {
	let pollCalls = 0;
	const gapEvents: ServerEvent[] = [];
	const unsub = subscribe((ev) => gapEvents.push(ev));
	const gapForest = {
		isOpen: true,
		pollStream() {
			pollCalls++;
			if (pollCalls === 1) return { status: LJ_STATUS.OK, yaml: "epoch: 1\noldest: 1\nevents:\n  - sequence: 1\n" };
			if (pollCalls === 2) return { status: LJ_STATUS.GAP, yaml: "epoch: 1\noldest: 50\n" };
			return { status: LJ_STATUS.OK, yaml: "epoch: 1\noldest: 50\nevents:\n  - sequence: 52\n" };
		},
	} as unknown as LumberJackForest;
	const gapBridge = startLumberJackStreamBridge(gapForest, 60_000);
	try {
		assert.equal(gapEvents.length, 0);
		gapBridge.pollOnce();
		assert.equal(gapEvents.some((e) => e.type === "chats-changed"), true);
		assert.equal(gapEvents.some((e) => e.type === "sources-changed"), true);
	} finally {
		gapBridge.stop();
		unsub();
	}

	let loggedErrors = 0;
	const origError = console.error;
	console.error = () => { loggedErrors++; };
	const errBridge = startLumberJackStreamBridge({
		isOpen: true,
		pollStream() { throw new Error("transient poll failure"); },
	} as unknown as LumberJackForest, 10);
	try {
		await new Promise((resolve) => setTimeout(resolve, 35));
		assert.equal(loggedErrors >= 1, true);
	} finally {
		errBridge.stop();
		console.error = origError;
	}
}

function verifySingleEmitterAndRawDispatch(
	stores: ReturnType<typeof createLumberJackStores>,
	bridge: ReturnType<typeof startLumberJackStreamBridge>,
	captured: ServerEvent[],
	seedChatId: string,
): void {
	bridge.pollOnce();
	assert.equal(captured.length, 0, "reopened forest must not emit false startup gap");
	const created = stores.chatStore.createChat("Live Session");
	stores.chatStore.renameChat(created.id, "Renamed Live");
	const job = stores.jobStore.createJob({ kind: "research", chatId: created.id, toolCallId: "tc_n11" });
	stores.jobStore.updateJob(job.id, { status: "done", activity: "done" });
	stores.sourceOrganizationStore.write({ version: 1, folders: [], placements: {} });
	const countBeforePoll = captured.length;
	bridge.pollOnce();
	assert.equal(captured.length, countBeforePoll, "bridge must not re-emit store-emitted mutations");

	captured.length = 0;
	stores.forest.upsertNode({ path: `sessions/${seedChatId}`, kind: "session" });
	stores.forest.upsertNode({ path: "jobs/raw_job", kind: "job" });
	bridge.pollOnce();
	const recEv = captured.find((e): e is Extract<ServerEvent, { type: "record-changed" }> => e.type === "record-changed");
	assert.equal(recEv?.chatId, seedChatId);
	assert.equal(captured.some((e) => e.type === "jobs-changed"), true);
}

test("N11: StreamBridge syncs head cursor, deduplicates store emits, and stops on close()", SKIP_GUARD, async () => {
	await verifyGapAndPollErrorHandling();
	await withScratchForest("s4-n11-stream", async (dir) => {
		let stores = createLumberJackStores(dir);
		const seedChat = stores.chatStore.createChat("Pre-existing");
		stores.close();

		stores = createLumberJackStores(dir);
		const captured: ServerEvent[] = [];
		const unsub = subscribe((ev) => captured.push(ev));
		let pollCount = 0;
		const origPoll = stores.forest.pollStream.bind(stores.forest);
		stores.forest.pollStream = (...args) => { pollCount++; return origPoll(...args); };
		const bridge = startLumberJackStreamBridge(stores.forest, 15);
		try {
			verifySingleEmitterAndRawDispatch(stores, bridge, captured, seedChat.id);
			stores.close();
			const pollsAtClose = pollCount;
			await new Promise((resolve) => setTimeout(resolve, 45));
			assert.equal(pollCount, pollsAtClose, "forest.close() must stop interval timer without bridge.stop()");
		} finally {
			unsub();
			bridge.stop();
			stores.close();
		}
	});
});
