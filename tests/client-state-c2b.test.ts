import assert from "node:assert/strict";
import test from "node:test";
import {
	BUILTIN_THEMES, buildSubagentSteer, modelsNotConfigured, providerKeyMissing,
	type ChatListItem, type JobRecord, type LhMessage, type SideChatThread, type SourceDirectory,
} from "../src/core/index.ts";

await import("./helpers/client-env.ts");

const {
	ApiError, OPEN_FOLDERS_STORAGE_KEY, createActivityStore, createApiClient, createEventsStore,
	createSessionsStore, createSideThreadStore, createState, formatActivityElapsed, toActivityBlobs,
} = await import("../src/client/state/index.ts");
import type { ActivityFeed, FeedJob, SessionScreenIntent, SessionScreenModel, Store } from "../src/client/state/index.ts";

interface RecordedReq { method: string; url: string; body: string }

const waitTicks = (ms = 25): Promise<void> => new Promise((r) => setTimeout(r, ms));

function createFakeSse() {
	let openCb: (() => void) | null = null;
	const handlers = new Map<string, (raw: string) => void>();
	return {
		open: () => openCb?.(),
		emit: (name: string, payload: unknown = {}) => handlers.get(name)?.(JSON.stringify(payload)),
		source: {
			close: () => {},
			onOpen: (cb: () => void) => { openCb = cb; },
			onEvent: (name: string, cb: (raw: string) => void) => { handlers.set(name, cb); },
		},
	};
}

function createMemStorage(map = new Map<string, string>(), fail = false): Storage {
	const boom = () => { throw new Error("Storage blocked"); };
	return {
		get length() { return map.size; },
		key: (idx: number) => [...map.keys()][idx] ?? null,
		getItem: (k: string) => (fail ? boom() : (map.get(k) ?? null)),
		setItem: (k: string, v: string) => { if (fail) boom(); map.set(k, String(v)); },
		removeItem: (k: string) => { if (fail) boom(); map.delete(k); },
		clear: () => { if (fail) boom(); map.clear(); },
	};
}

function makeChatItem(id: string, title: string, updatedAt = "2026-11-22T12:00:00Z"): ChatListItem {
	return {
		id, title, createdAt: updatedAt, updatedAt, kind: "teach", messageCount: 2,
		phase: "teach", pendingQuestion: false, pendingProblem: false, busy: false, compacting: false,
	};
}

function makeAssistantProse(id: string, text: string): LhMessage {
	return {
		id, role: "assistant", content: [{ type: "text", text }],
		api: "anthropic-messages", provider: "anthropic", model: "claude-sonnet-4",
		usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop", timestamp: 10,
	} as unknown as LhMessage;
}

const SAMPLE_CHATS: ChatListItem[] = [
	makeChatItem("c_buried", "Advanced Linear Operators", "2026-11-22T10:00:00Z"),
	makeChatItem("c_exact", "Linear", "2026-11-22T11:00:00Z"),
	makeChatItem("c_prefix", "Linear Algebra Basics", "2026-11-22T12:00:00Z"),
];

const INITIAL_DIRECTORY: SourceDirectory = {
	organization: {
		version: 1,
		folders: [{ id: "fld_math", name: "Math", parentId: null, createdAt: "2026-11-20T00:00:00Z" }],
		placements: { c_exact: { folderId: "fld_math" } },
	},
	sources: [
		{ id: "c_buried", kind: "chat", label: "Advanced Linear Operators", createdAt: "2026-11-22T10:00:00Z" },
		{ id: "c_exact", kind: "chat", label: "Linear", createdAt: "2026-11-22T11:00:00Z" },
		{ id: "c_prefix", kind: "chat", label: "Linear Algebra Basics", createdAt: "2026-11-22T12:00:00Z" },
	],
};

function handleSessionsMutation(
	url: string,
	method: string,
	body: string,
	data: { chats: ChatListItem[]; dir: SourceDirectory; blockDeleteId: string | null },
): Response | null {
	if (url === "/api/graph/sources" && method === "POST") {
		const act = JSON.parse(body) as { action: string; name?: string; parentId?: string | null };
		if (act.action === "create-folder") {
			const fld = { id: "fld_new", name: act.name ?? "New", parentId: act.parentId ?? null, createdAt: "2026-11-22T12:00:00Z" };
			data.dir = { ...data.dir, organization: { ...data.dir.organization, folders: [...data.dir.organization.folders, fld] } };
		}
		return Response.json(data.dir);
	}
	if (url.startsWith("/api/chats/") && method === "PUT") {
		const id = decodeURIComponent(url.slice("/api/chats/".length));
		const nextTitle = (JSON.parse(body) as { title: string }).title;
		data.chats = data.chats.map((c) => (c.id === id ? { ...c, title: nextTitle } : c));
		return Response.json({ title: nextTitle });
	}
	if (url.startsWith("/api/chats/") && method === "DELETE") {
		const parsed = new URL(url, "http://localhost");
		const id = decodeURIComponent(parsed.pathname.slice("/api/chats/".length));
		if (id === data.blockDeleteId) {
			return Response.json({ error: "A turn is running", code: "turn_in_flight", jobIds: ["j_1"] }, { status: 409 });
		}
		data.chats = data.chats.filter((c) => c.id !== id);
		return Response.json({ ok: true, mode: parsed.searchParams.get("mode"), graphRevision: 2 });
	}
	if (url.startsWith("/api/graph/sources/folders/") && method === "DELETE") {
		const scope = JSON.parse(body) as { folderIds: string[]; chatIds: string[] };
		data.chats = data.chats.filter((c) => !scope.chatIds.includes(c.id));
		const folders = data.dir.organization.folders.filter((f) => !scope.folderIds.includes(f.id));
		const sources = data.dir.sources.filter((s) => !scope.chatIds.includes(s.id));
		data.dir = { organization: { version: 1, folders, placements: {} }, sources };
		return Response.json({ ok: true, ...data.dir, graphRevision: 3, deletedChatIds: scope.chatIds });
	}
	return null;
}

function buildMarkdownResponse(url: string): Response {
	const headers: Record<string, string> = url.includes("c_exact")
		? { "Content-Disposition": 'attachment; filename="linear-notes.md"' }
		: {};
	return new Response("# Session Export\n\nBody", { status: 200, headers });
}

function createSessionsMockFetch(calls: RecordedReq[], opts: { arrayShape: boolean; blockDeleteId: string | null }) {
	const data = { chats: [...SAMPLE_CHATS], dir: structuredClone(INITIAL_DIRECTORY), blockDeleteId: opts.blockDeleteId };
	return async (input: unknown, init?: RequestInit) => {
		const url = String(input);
		const method = init?.method ?? "GET";
		const body = typeof init?.body === "string" ? init.body : "";
		calls.push({ method, url, body });
		data.blockDeleteId = opts.blockDeleteId;
		if (url === "/api/chats" && method === "GET") return Response.json(opts.arrayShape ? data.chats : { chats: data.chats });
		if (url === "/api/graph/sources" && method === "GET") return Response.json(data.dir);
		if (url.startsWith("/api/chats/") && url.endsWith("/markdown") && method === "GET") return buildMarkdownResponse(url);
		return handleSessionsMutation(url, method, body, data) ?? Response.json({ ok: true });
	};
}

test("SessionsStore hydrates /api/chats shapes, fuzzy-filters, persists open folders, renames, and exports markdown", async () => {
	const calls: RecordedReq[] = [];
	const mockState = { arrayShape: false, blockDeleteId: null as string | null };
	const map = new Map<string, string>();
	const storage = createMemStorage(map);
	const events = createEventsStore();
	const api = createApiClient({ fetch: createSessionsMockFetch(calls, mockState) });
	const sessions = createSessionsStore({ api, events, storage });
	await waitTicks();
	assert.equal(sessions.get().load, "ready");
	assert.equal(sessions.get().chats.length, 3);
	assert.equal(sessions.get().organization.folders[0]?.id, "fld_math");

	await sessions.send({ type: "set-search", query: "linear" });
	assert.deepEqual(sessions.get().filteredChats.map((c) => c.id), ["c_exact", "c_prefix", "c_buried"]);
	await sessions.send({ type: "set-search", query: "   " });
	assert.equal(sessions.get().filteredChats.length, 3);

	await sessions.send({ type: "toggle-folder-open", folderId: "fld_math" });
	assert.deepEqual(sessions.get().openFolderIds, ["fld_math"]);
	assert.equal(map.get(OPEN_FOLDERS_STORAGE_KEY), JSON.stringify(["fld_math"]));

	mockState.arrayShape = true;
	const rehydrated = createSessionsStore({ api, events, storage });
	await waitTicks();
	assert.deepEqual(rehydrated.get().openFolderIds, ["fld_math"]);
	assert.equal(rehydrated.get().chats.length, 3);
	rehydrated.dispose();

	await sessions.send({ type: "rename-session", chatId: "c_prefix", title: "  Linear Operators II  " });
	assert.equal(sessions.get().chats.find((c) => c.id === "c_prefix")?.title, "Linear Operators II");
	assert.equal(calls.some((c) => c.method === "PUT" && c.url === "/api/chats/c_prefix"), true);
	await sessions.send({ type: "export-markdown", chatId: "c_exact" });
	assert.deepEqual(sessions.get().lastExport, { chatId: "c_exact", filename: "linear-notes.md", markdown: "# Session Export\n\nBody" });
	await sessions.send({ type: "export-markdown", chatId: "c_prefix" });
	assert.equal(sessions.get().lastExport?.filename, "c_prefix.md");
	sessions.dispose();
	events.dispose();
});

test("SessionsStore handles delete-session modes + 409 ApiError, source-action, and delete-folder scope", async () => {
	const calls: RecordedReq[] = [];
	const mockState = { arrayShape: false, blockDeleteId: "c_exact" as string | null };
	const map = new Map<string, string>([[OPEN_FOLDERS_STORAGE_KEY, JSON.stringify(["fld_math"])]]);
	const events = createEventsStore();
	const api = createApiClient({ fetch: createSessionsMockFetch(calls, mockState) });
	const sessions = createSessionsStore({ api, events, storage: createMemStorage(map) });
	await waitTicks();

	let caught: unknown;
	try { await sessions.send({ type: "delete-session", chatId: "c_exact", mode: "preserve-graph" }); } catch (err) { caught = err; }
	assert.ok(caught instanceof ApiError);
	assert.equal(caught.status, 409);
	assert.equal(caught.code, "turn_in_flight");
	assert.deepEqual((caught.body as { jobIds?: string[] }).jobIds, ["j_1"]);
	assert.equal(sessions.get().chats.some((c) => c.id === "c_exact"), true);

	await sessions.send({ type: "delete-session", chatId: "c_prefix", mode: "delete-nodes" });
	assert.equal(calls.some((c) => c.method === "DELETE" && c.url === "/api/chats/c_prefix?mode=delete-nodes"), true);
	assert.equal(sessions.get().chats.some((c) => c.id === "c_prefix"), false);
	await sessions.send({ type: "source-action", action: { action: "create-folder", name: "Physics", parentId: null } });
	assert.equal(sessions.get().organization.folders.some((f) => f.id === "fld_new"), true);

	mockState.blockDeleteId = null;
	await sessions.send({ type: "delete-folder", folderId: "fld_math", mode: "preserve-graph" });
	const folderDel = calls.find((c) => c.method === "DELETE" && c.url === "/api/graph/sources/folders/fld_math?mode=preserve-graph");
	assert.ok(folderDel);
	assert.deepEqual(JSON.parse(folderDel.body), { parentId: null, folderIds: ["fld_math"], chatIds: ["c_exact"], noteIds: [] });
	assert.deepEqual(sessions.get().openFolderIds, []);
	assert.equal(sessions.get().chats.some((c) => c.id === "c_exact"), false);
	sessions.dispose();
	events.dispose();
});

const SAMPLE_USAGE: FeedJob["usage"] = {
	model: "anthropic:claude-haiku", inputTokens: 100, outputTokens: 20, cacheReadTokens: 50,
	cacheWriteTokens: 30, reasoningTokens: undefined, steps: 2,
	lastStep: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 50, cacheWriteTokens: 30, reasoningTokens: undefined },
};

const SAMPLE_FEED: ActivityFeed = {
	jobs: [
		{ id: "job_models", kind: "research", chatId: "c1", toolCallId: "tc1", status: "error", activity: "searching", error: modelsNotConfigured(["cheap"]).error, createdAt: "2026-11-22T12:00:02.000Z", updatedAt: "2026-11-22T12:00:02.000Z", title: "Topic A", costUsd: 0.01, contextLimit: 200000, usage: SAMPLE_USAGE },
		{ id: "job_key", kind: "visual", chatId: "c1", toolCallId: "tc2", status: "error", activity: "drawing", error: providerKeyMissing("anthropic", ["vision"]).error, createdAt: "2026-11-22T12:00:03.000Z", updatedAt: "2026-11-22T12:00:03.000Z", title: "Topic B", contextLimit: null },
	],
	pluginWorkers: [{ id: "pw_1", taskId: "t1", pluginId: "cards", definitionId: "gen", status: "running", title: "Deck Worker", createdAt: "2026-11-22T12:00:01.000Z", updatedAt: "2026-11-22T12:00:01.000Z", model: { provider: "openai", id: "gpt-5" }, costUsd: 0.02, contextLimit: 128000 }],
	extractions: [{ id: "ext_1", chatId: "c1", title: "Session Map", phase: "auditing", startedAt: Date.parse("2026-11-22T12:00:00.500Z") }],
};

function createActivityMockFetch(ctl: { gets: number; fail: boolean; abortStatus: number; aborts: unknown[] }) {
	return async (input: unknown, init?: RequestInit) => {
		if (String(input) === "/api/activity") {
			ctl.gets += 1;
			return ctl.fail ? Response.json({ error: "blip" }, { status: 502 }) : Response.json(SAMPLE_FEED);
		}
		if (String(input) === "/api/activity/abort" && init?.method === "POST") {
			ctl.aborts.push(JSON.parse(String(init.body)));
			return Response.json({ ok: ctl.abortStatus < 300 }, { status: ctl.abortStatus });
		}
		return Response.json({});
	};
}

test("ActivityStore debounces SSE bursts at 250ms, refetches immediately onResync, formats blobs, and aborts", async () => {
	const blobs = toActivityBlobs(SAMPLE_FEED);
	assert.deepEqual(blobs.map((b) => b.process), ["extraction", "plugin-worker", "job", "job"]);
	assert.equal(blobs[2]?.activity, "needs model setup");
	assert.deepEqual(blobs[2]?.context, { used: 200, limit: 200000 });
	assert.equal(blobs[3]?.activity, "needs a provider key");
	assert.equal(formatActivityElapsed(45_200), "45s");
	assert.equal(formatActivityElapsed(184_000), "3m 04s");
	assert.equal(formatActivityElapsed(4_320_000), "1h 12m");

	const ctl = { gets: 0, fail: false, abortStatus: 500, aborts: [] as unknown[] };
	const sse = createFakeSse();
	const events = createEventsStore({ createEventSource: () => sse.source });
	const activity = createActivityStore({ api: createApiClient({ fetch: createActivityMockFetch(ctl) }), events });
	sse.open();
	await waitTicks(20);
	assert.equal(ctl.gets, 1);

	sse.emit("activity-changed", {});
	sse.emit("jobs-changed", { chatId: "c1" });
	sse.emit("activity-changed", {});
	await waitTicks(100);
	assert.equal(ctl.gets, 1);
	await waitTicks(200);
	assert.equal(ctl.gets, 2);

	ctl.fail = true;
	sse.open();
	await waitTicks(20);
	assert.equal(ctl.gets, 3);
	assert.equal(activity.get().blobs.length, 4);
	ctl.fail = false;

	await activity.send({ type: "abort", kind: "job", id: "job_models" });
	assert.equal(activity.get().abortErrors.job_models, "Abort failed");
	assert.deepEqual(ctl.aborts[0], { kind: "job", id: "job_models" });
	ctl.abortStatus = 409;
	await activity.send({ type: "abort", kind: "job", id: "job_models" });
	assert.equal(activity.get().abortErrors.job_models, undefined);
	assert.equal(ctl.gets, 4);
	activity.dispose();
	events.dispose();
});

function createOpenNdjsonStream() {
	const enc = new TextEncoder();
	let ctrl!: ReadableStreamDefaultController<Uint8Array>;
	const stream = new ReadableStream<Uint8Array>({ start(c) { ctrl = c; } });
	return {
		response: new Response(stream, { status: 200, headers: { "Content-Type": "application/x-ndjson" } }),
		send: (ev: unknown) => ctrl.enqueue(enc.encode(`${JSON.stringify(ev)}\n`)),
		close: () => ctrl.close(),
	};
}

const STOPPED_SIDE_MSGS: SideChatThread["messages"] = [
	{ id: "u1", role: "user", text: "Why?", at: "2026-11-22T12:01:00Z" },
	{ id: "a1", role: "assistant", text: "Partial...", stopped: true, at: "2026-11-22T12:01:01Z" },
];

function createSideMockFetch(calls: RecordedReq[], baseThread: SideChatThread, getStream: () => ReturnType<typeof createOpenNdjsonStream>) {
	return async (input: unknown, init?: RequestInit) => {
		const url = String(input);
		const method = init?.method ?? "GET";
		calls.push({ method, url, body: typeof init?.body === "string" ? init.body : "" });
		if (url === "/api/chats/c_side/side-chats" && method === "GET") return Response.json({ threads: [baseThread], answering: {} });
		if (url === "/api/chats/c_side/side-chats/side_m_seg1" && method === "GET") {
			const lines = `${JSON.stringify({ type: "thread", thread: baseThread })}\n${JSON.stringify({ type: "done", thread: baseThread })}\n`;
			return new Response(lines, { status: 200, headers: { "Content-Type": "application/x-ndjson" } });
		}
		if (url === "/api/chats/c_side/side-chats" && method === "POST") return getStream().response;
		if (url === "/api/chats/c_side/side-chats/side_m_seg1/stop" && method === "POST") {
			getStream().send({ type: "done", thread: { ...baseThread, messages: STOPPED_SIDE_MSGS } });
			getStream().close();
			return Response.json({ ok: true });
		}
		return Response.json({ ok: true });
	};
}

test("SideThreadStore hydrates threads, opens segment, switches mode, streams NDJSON ask, and stops", async () => {
	const messages = [makeAssistantProse("m_seg1", "Projections satisfy P^2 = P.")];
	const baseThread: SideChatThread = {
		id: "side_m_seg1", open: true, createdAt: "2026-11-22T12:00:00Z", messages: [],
		anchor: { messageId: "m_seg1", partId: "m_seg1-t0", blockIndex: 0, blockText: "Projections satisfy P^2 = P." },
	};
	const calls: RecordedReq[] = [];
	let liveStream = createOpenNdjsonStream();
	const events = createEventsStore();
	const api = createApiClient({ fetch: createSideMockFetch(calls, baseThread, () => liveStream) });
	const side = createSideThreadStore({ chatId: "c_side", api, events, getMessages: () => messages });
	await waitTicks();
	assert.equal(side.get().threads.length, 1);
	assert.equal(side.get().currentSegmentId, "m_seg1");

	await side.send({ type: "open", args: { sourceMessageId: "m_seg1", anchor: { kind: "composer" } } });
	await waitTicks(10);
	assert.equal(side.get().active?.mode, "popover");
	await side.send({ type: "set-mode", mode: "panel" });
	assert.equal(side.get().active?.mode, "panel");
	await side.send({ type: "set-draft", threadId: "side_m_seg1", text: "Why?" });
	assert.equal(side.get().drafts.side_m_seg1, "Why?");

	const askPromise = side.send({ type: "ask", text: "Why?" });
	await waitTicks(10);
	const withQ: SideChatThread = { ...baseThread, messages: [{ id: "u1", role: "user", text: "Why?", at: "2026-11-22T12:01:00Z" }] };
	liveStream.send({ type: "thread", thread: withQ });
	liveStream.send({ type: "text", text: "Partial..." });
	await waitTicks(10);
	assert.equal(side.get().active?.answering, true);
	assert.equal(side.get().active?.streamText, "Partial...");

	await side.send({ type: "stop" });
	await askPromise;
	assert.equal(calls.some((c) => c.method === "POST" && c.url === "/api/chats/c_side/side-chats/side_m_seg1/stop"), true);
	assert.equal(side.get().active?.messages.at(-1)?.stopped, true);

	liveStream = createOpenNdjsonStream();
	const secondAsk = side.send({ type: "ask", text: "Full answer" });
	const doneThread: SideChatThread = { ...baseThread, messages: [...withQ.messages, { id: "a2", role: "assistant", text: "Complete reply.", at: "2026-11-22T12:02:01Z" }] };
	liveStream.send({ type: "thread", thread: withQ });
	liveStream.send({ type: "text", text: "Complete " });
	liveStream.send({ type: "done", thread: doneThread });
	liveStream.close();
	await secondAsk;
	assert.equal(side.get().active?.messages.at(-1)?.text, "Complete reply.");
	side.dispose();
	events.dispose();
});

function createWorkspaceScreenMockFetch(calls: RecordedReq[]) {
	let extractCalls = 0;
	const steerMsg = buildSubagentSteer({ id: "j_vis", kind: "visual", toolCallId: "tc_vis" }, { svg: "<svg><rect/></svg>" });
	const messages: LhMessage[] = [makeAssistantProse("m_t1", "Visualizing subspace"), steerMsg];
	const jobEntry: JobRecord = { id: "j_vis", kind: "visual", chatId: "c_work", toolCallId: "tc_vis", status: "done", activity: "verified svg", createdAt: "2026-11-22T12:00:00Z", updatedAt: "2026-11-22T12:00:05Z" };
	return async (input: unknown, init?: RequestInit) => {
		const url = String(input);
		const method = init?.method ?? "GET";
		calls.push({ method, url, body: typeof init?.body === "string" ? init.body : "" });
		if (url === "/api/settings") return Response.json({ settings: { version: 1, graph: { enabled: false, extractionChunkTokens: 4096 } } });
		if (url === "/api/themes") return Response.json({ themes: BUILTIN_THEMES });
		if (url === "/api/jobs?chatId=c_work") return Response.json({ jobs: [jobEntry], turnInFlight: false });
		if (url === "/api/chats/c_work/artifact-ui" && method === "POST") return Response.json({ ok: true });
		if (url === "/api/graph/coverage/extract" && method === "POST") {
			extractCalls += 1;
			return Response.json({ started: true }, { status: extractCalls === 1 ? 202 : 409 });
		}
		if (url === "/api/chats/c_work/side-chats") return Response.json({ threads: [], answering: {} });
		if (url === "/api/chats/c_work") return Response.json({ id: "c_work", title: "Subspaces", messages, coverage: { uncoveredTokens: extractCalls > 0 ? 0 : 1200, running: extractCalls > 0 }, turnInFlight: false });
		return Response.json({ chats: [], jobs: [], extractions: [], models: [], providers: [] });
	};
}

test("SessionStore & SessionScreenStore hydrate jobs, invert artifacts, request extract, and project sideThread", async () => {
	const calls: RecordedReq[] = [];
	const state = createState({ initialUrl: "/chat/c_work", storage: createMemStorage(), fetch: createWorkspaceScreenMockFetch(calls) });
	const screen = state.screen(state.router.get()) as unknown as Store<SessionScreenModel, SessionScreenIntent>;
	await waitTicks(30);

	const snap1 = screen.get();
	assert.equal(snap1.jobs.length, 1);
	assert.equal(snap1.jobs[0]?.id, "j_vis");
	assert.equal(snap1.graphEnabled, false);
	assert.equal(snap1.extractionChunkTokens, 4096);
	assert.equal(snap1.sideThread?.chatId, "c_work");
	assert.equal(snap1.sideThread?.currentSegmentId, "m_t1");

	await screen.send({ type: "set-artifact-inverted", messageId: "steer_j_vis", inverted: true });
	const uiCall = calls.find((c) => c.method === "POST" && c.url === "/api/chats/c_work/artifact-ui");
	assert.ok(uiCall);
	assert.deepEqual(JSON.parse(uiCall.body), { input: { messageId: "steer_j_vis", inverted: true } });
	const steerView = screen.get().messages.find((m) => m.id === "steer_j_vis");
	const artPart = steerView?.parts.find((p) => p.type === "data-subagent-artifact");
	assert.equal((artPart?.data as { ui?: { inverted?: boolean } } | undefined)?.ui?.inverted, true);

	await screen.send({ type: "request-extract" });
	await screen.send({ type: "request-extract" });
	assert.equal(screen.get().coverage?.running, true);
	assert.equal(calls.filter((c) => c.method === "POST" && c.url === "/api/graph/coverage/extract").length, 2);

	await screen.send({ type: "side-thread", action: { type: "open", args: { sourceMessageId: "m_t1", anchor: { kind: "composer" } } } });
	await waitTicks(10);
	assert.equal(screen.get().sideThread?.active?.segmentId, "m_t1");
	screen.dispose();
	state.dispose();
});
