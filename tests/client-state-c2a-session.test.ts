import assert from "node:assert/strict";
import test from "node:test";
import {
	BUILTIN_THEMES,
	DEFAULT_RENDER_SETTINGS,
	dismissedAnswer,
	newUserMessage,
	type LhMessage,
	type QuestionAnswerData,
} from "../src/core/index.ts";

await import("./helpers/client-env.ts");

type AnyFn = (...args: any[]) => any;

interface RecordedReq {
	method: string;
	url: string;
	body: string;
}

interface StateMod {
	createState: AnyFn;
}

const stateMod = (await import("../src/client/state/index.ts")) as unknown as StateMod;

function waitTicks(ms = 25): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function sawReq(calls: readonly RecordedReq[], method: string, url: string): boolean {
	return calls.some((c) => c.method === method && c.url === url);
}

function buildMemStorage(map: Map<string, string>) {
	return {
		get length() { return map.size; },
		key: (idx: number) => [...map.keys()][idx] ?? null,
		getItem: (k: string) => map.get(k) ?? null,
		setItem: (k: string, v: string) => { map.set(k, String(v)); },
		removeItem: (k: string) => { map.delete(k); },
		clear: () => { map.clear(); },
	};
}

function installStorageShim(): () => void {
	const g = globalThis as Record<string, unknown>;
	const prevLocal = g.localStorage;
	const prevSession = g.sessionStorage;
	const prevWin = g.window;
	const local = buildMemStorage(new Map());
	const session = buildMemStorage(new Map());
	g.localStorage = local;
	g.sessionStorage = session;
	g.window = { localStorage: local, sessionStorage: session, Event: globalThis.Event, dispatchEvent: () => true };
	return () => {
		if (prevLocal === undefined) delete g.localStorage; else g.localStorage = prevLocal;
		if (prevSession === undefined) delete g.sessionStorage; else g.sessionStorage = prevSession;
		if (prevWin === undefined) delete g.window; else g.window = prevWin;
	};
}

function sseResponse(...events: unknown[]): Response {
	const payload = events.map((e) => (e === "[DONE]" ? "data: [DONE]\n\n" : `data: ${JSON.stringify(e)}\n\n`)).join("");
	return new Response(payload, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

function makePendingQuizAssistant(msgId: string, callId: string): LhMessage {
	const args = {
		type: "predict",
		question: "Is an orthogonal projection idempotent (P^2 = P)?",
		options: [{ label: "Yes", value: "yes" }, { label: "No", value: "no" }],
		explanation: "Applying P to an already-projected vector leaves it unchanged.",
		correctAnswer: "yes",
	};
	return {
		id: msgId,
		role: "assistant",
		content: [{ type: "toolCall", id: callId, name: "quiz", arguments: args }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4",
		usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "toolUse",
		timestamp: 10,
	} as unknown as LhMessage;
}

const GRADED_YES_ANSWER: QuestionAnswerData = {
	kind: "quiz",
	tool: "quiz",
	questionType: "predict",
	questionText: "Is an orthogonal projection idempotent (P^2 = P)?",
	options: [{ index: 1, label: "Yes" }, { index: 2, label: "No" }],
	dontKnow: false,
	answers: [{ index: 1, label: "Yes", value: "yes" }],
	confidence: 90,
	correct: true,
	correctIndices: [1],
	explanation: "Applying P twice equals P.",
	answeredAt: "2026-11-19T12:00:00.000Z",
};

const CONFIGURED_SETTINGS = {
	version: 1,
	models: {
		strong: { model: { provider: "anthropic", id: "claude-sonnet-4" }, thinkingLevel: "high" },
		cheap: { model: { provider: "anthropic", id: "claude-sonnet-4" } },
		vision: { model: { provider: "anthropic", id: "claude-sonnet-4" } },
	},
};

const PLAN_TREE_FIXTURE = {
	version: 1,
	nodes: [{ id: "step-1", title: "Subspaces" }, { id: "step-2", title: "Projections" }],
	edges: [{ from: "step-1", to: "step-2" }],
};

const GRAPH_NODE = {
	id: "n_1",
	name: "Idempotence",
	statement: "P^2 = P characterizes projections.",
	aliases: [],
	createdAt: "2026-11-19T00:00:00Z",
	provenance: [{ chatId: "c_src_1", messageId: "m1" }],
};

const GRAPH_FIXTURE = {
	nodes: [GRAPH_NODE],
	propositions: [GRAPH_NODE],
	edges: [],
	logicalEdges: [],
	impLinks: [],
	chains: [],
	sessions: { c_src_1: "Projections" },
	fileSources: {},
	nodeSessions: { n_1: ["c_src_1"] },
	clusters: [],
	positions: { n_1: { x: 0, y: 0 } },
};

const SOURCES_FIXTURE = {
	organization: {
		version: 1 as const,
		folders: [
			{ id: "fld_la", name: "Linear Algebra", parentId: null, createdAt: "2026-11-19T00:00:00Z" },
			{ id: "fld_sub", name: "Projections", parentId: "fld_la", createdAt: "2026-11-19T00:00:00Z" },
		],
		placements: { c_src_1: { folderId: "fld_sub" } },
	},
	sources: [{ id: "c_src_1", kind: "chat" as const, label: "Projections", createdAt: "2026-11-19T00:00:00Z" }],
};

const CATALOG_MODELS = [
	{ provider: "anthropic", id: "claude-sonnet-4", name: "Claude Sonnet 4", reasoning: true, supportedLevels: ["low", "high"], input: ["text"], cost: null, contextWindow: 200000, maxTokens: 8192 },
];

function createInteractiveSessionFetch(calls: RecordedReq[]) {
	let title = "Initial Session";
	let chatSettings: Record<string, unknown> | undefined;
	const messages: LhMessage[] = [];
	const replyMsg = { id: "m_assist_reply", role: "assistant", content: [{ type: "text", text: "Projection satisfies P^2 = P." }], stopReason: "stop", timestamp: 20 } as unknown as LhMessage;
	return async (input: unknown, init?: RequestInit) => {
		const url = String(input);
		const method = init?.method ?? "GET";
		const body = typeof init?.body === "string" ? init.body : "";
		calls.push({ method, url, body });
		if (url === "/api/settings") return Response.json({ settings: CONFIGURED_SETTINGS });
		if (url === "/api/themes") return Response.json({ themes: BUILTIN_THEMES });
		if (url.startsWith("/api/models")) return Response.json({ models: CATALOG_MODELS, defaults: null, rolePins: {}, slots: {}, providers: [] });
		if (url === "/api/chat" && method === "POST") {
			messages.push(newUserMessage("Explain orthogonal projections"));
			return Response.json({ ok: true });
		}
		if (url === "/api/chats/c_inter" && method === "PUT") {
			title = (JSON.parse(body) as { title: string }).title;
			return Response.json({ title });
		}
		if (url === "/api/chats/c_inter/settings" && method === "PUT") {
			chatSettings = JSON.parse(body) as Record<string, unknown>;
			return Response.json({ settings: chatSettings });
		}
		if (url === "/api/chats/c_inter") return Response.json({ id: "c_inter", title, messages, tree: PLAN_TREE_FIXTURE, settings: chatSettings, turnInFlight: false });
		if (url === "/api/chats/c_inter/stream") {
			messages.push(replyMsg);
			return sseResponse({ type: "agent_start" }, { type: "message_start", message: { role: "assistant", content: [] } }, { type: "message_end", message: replyMsg }, "[DONE]");
		}
		return Response.json({ graph: GRAPH_FIXTURE, runs: [] });
	};
}

test("SessionStore send-text streams reply and executes rename and save-chat-settings", async () => {
	const restore = installStorageShim();
	const calls: RecordedReq[] = [];
	try {
		const state = stateMod.createState({ fetch: createInteractiveSessionFetch(calls) });
		const session = state.openSession("c_inter");
		await waitTicks();

		await session.send({ type: "send-text", text: "Explain orthogonal projections" });
		await waitTicks(35);
		assert.equal(sawReq(calls, "POST", "/api/chat"), true);
		assert.equal((session.get().state?.messages ?? []).some((m: { id: string }) => m.id === "m_assist_reply"), true);

		await session.send({ type: "rename", title: "Orthogonal Projections" });
		assert.equal(session.get().title, "Orthogonal Projections");

		await session.send({ type: "save-chat-settings", settings: { model: { provider: "anthropic", id: "claude-sonnet-4" }, thinkingLevel: "high" as const } });
		assert.equal(session.get().chatSettings?.model?.id, "claude-sonnet-4");

		session.dispose();
		state.dispose();
	} finally {
		restore();
	}
});

function createOpenStreamResponse(): { response: Response; close: () => void } {
	const enc = new TextEncoder();
	let ctrlRef: ReadableStreamDefaultController<Uint8Array> | null = null;
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			ctrlRef = controller;
			controller.enqueue(enc.encode(`data: ${JSON.stringify({ type: "agent_start" })}\n\n`));
			controller.enqueue(enc.encode(`data: ${JSON.stringify({ type: "message_start", message: { role: "assistant", content: [{ type: "text", text: "Working..." }] } })}\n\n`));
		},
	});
	return {
		response: new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } }),
		close: () => { try { ctrlRef?.close(); } catch { /* closed */ } },
	};
}

function createSteerSessionFetch(calls: RecordedReq[], streamResponse: Response) {
	return async (input: unknown, init?: RequestInit) => {
		const url = String(input);
		calls.push({ method: init?.method ?? "GET", url, body: typeof init?.body === "string" ? init.body : "" });
		if (url === "/api/chats/c_steer") return Response.json({ id: "c_steer", title: "Live Turn", messages: [newUserMessage("Start")], turnInFlight: true });
		if (url === "/api/chats/c_steer/stream") return streamResponse;
		if (url === "/api/chats/c_steer/steer" || url === "/api/activity/abort") return Response.json({ ok: true });
		return Response.json({ settings: CONFIGURED_SETTINGS, themes: BUILTIN_THEMES, models: CATALOG_MODELS, providers: [] });
	};
}

test("SessionStore steer queues mid-turn steer over /api/chats/{id}/steer and stop detaches stream", async () => {
	const restore = installStorageShim();
	const calls: RecordedReq[] = [];
	const openStream = createOpenStreamResponse();
	try {
		const state = stateMod.createState({ fetch: createSteerSessionFetch(calls, openStream.response) });
		const session = state.openSession("c_steer");
		await waitTicks(30);
		assert.equal(session.get().state?.status, "streaming");

		await session.send({ type: "steer", text: "Include a 2D picture" });
		await waitTicks(10);
		assert.equal(sawReq(calls, "POST", "/api/chats/c_steer/steer"), true);
		assert.equal((session.get().queuedSteers ?? [])[0]?.text, "Include a 2D picture");

		await session.send({ type: "stop" });
		await waitTicks(10);
		assert.equal(session.get().state?.status, "ready");
		session.dispose();
		state.dispose();
	} finally {
		openStream.close();
		restore();
	}
});

function createQuestionSessionFetch(calls: RecordedReq[]) {
	const quizMessages: LhMessage[] = [makePendingQuizAssistant("m_q1", "call_q_dismiss")];
	const ansMessages: LhMessage[] = [makePendingQuizAssistant("m_q2", "call_q_ans")];
	const followup = { id: "m_after_ans", role: "assistant", content: [{ type: "text", text: "Spot on!" }], stopReason: "stop", timestamp: 30 } as unknown as LhMessage;
	return async (input: unknown, init?: RequestInit) => {
		const url = String(input);
		const method = init?.method ?? "GET";
		calls.push({ method, url, body: typeof init?.body === "string" ? init.body : "" });
		if (url === "/api/chats/c_quiz/dismiss" && method === "POST") {
			quizMessages.push({ id: "tr_d", role: "toolResult", toolCallId: "call_q_dismiss", toolName: "quiz", content: [{ type: "text", text: "{}" }], details: dismissedAnswer("quiz", "Q"), isError: false, timestamp: 15 } as unknown as LhMessage);
			return Response.json({ ok: true });
		}
		if (url === "/api/chats/c_quiz") return Response.json({ id: "c_quiz", title: "Quiz", messages: quizMessages, turnInFlight: false });
		if (url === "/api/chat" && method === "POST") {
			ansMessages.push({ id: "tr_a", role: "toolResult", toolCallId: "call_q_ans", toolName: "quiz", content: [{ type: "text", text: "{}" }], details: GRADED_YES_ANSWER, isError: false, timestamp: 25 } as unknown as LhMessage);
			return Response.json({ ok: true });
		}
		if (url === "/api/chats/c_ans") return Response.json({ id: "c_ans", title: "Answer", messages: ansMessages, turnInFlight: false });
		if (url === "/api/chats/c_ans/stream") {
			ansMessages.push(followup);
			return sseResponse({ type: "agent_start" }, { type: "message_start", message: { role: "assistant", content: [] } }, { type: "message_end", message: followup }, "[DONE]");
		}
		return Response.json({ settings: CONFIGURED_SETTINGS, themes: BUILTIN_THEMES, models: CATALOG_MODELS, providers: [] });
	};
}

test("SessionStore exposes pendingQuestion, persists questionDraft, dismisses silently, and submits answers", async () => {
	const restore = installStorageShim();
	const calls: RecordedReq[] = [];
	try {
		const state = stateMod.createState({ fetch: createQuestionSessionFetch(calls) });
		const quizSession = state.openSession("c_quiz");
		await waitTicks();
		await quizSession.send({ type: "save-question-draft", questionKey: "call_q_dismiss", draft: { readingThinking: "Checking P^2" } });
		await waitTicks(5);
		assert.equal(quizSession.get().questionDraft?.readingThinking, "Checking P^2");

		await quizSession.send({ type: "dismiss-question", toolCallId: "call_q_dismiss", answer: dismissedAnswer("quiz", "Is P^2 = P?") });
		await waitTicks(15);
		assert.equal(sawReq(calls, "POST", "/api/chats/c_quiz/dismiss"), true);
		quizSession.dispose();

		const ansSession = state.openSession("c_ans");
		await waitTicks();
		await ansSession.send({ type: "answer-question", tool: "quiz", toolCallId: "call_q_ans", answer: GRADED_YES_ANSWER });
		await waitTicks(35);
		assert.equal(ansSession.get().pendingQuestion ?? null, null);
		ansSession.dispose();
		state.dispose();
	} finally {
		restore();
	}
});

function createScreensMockFetch(calls: RecordedReq[]) {
	let mintedSeq = 0;
	const screenMessages: LhMessage[] = [makePendingQuizAssistant("m_sq1", "call_sq_abort")];
	return async (input: unknown, init?: RequestInit) => {
		const url = String(input);
		const method = init?.method ?? "GET";
		const body = typeof init?.body === "string" ? init.body : "";
		calls.push({ method, url, body });
		if (url === "/api/settings") return Response.json({ settings: CONFIGURED_SETTINGS });
		if (url === "/api/themes") return Response.json({ themes: BUILTIN_THEMES });
		if (url.startsWith("/api/models")) return Response.json({ models: CATALOG_MODELS, defaults: null, rolePins: {}, slots: {}, providers: [] });
		if (url === "/api/graph") return Response.json(GRAPH_FIXTURE);
		if (url === "/api/graph/sources") return Response.json(SOURCES_FIXTURE);
		if (url === "/api/graph/render-settings") return Response.json(DEFAULT_RENDER_SETTINGS);
		if (url === "/api/graph/costs") return Response.json({ totalUsd: 0, totalInputTokens: 0, totalOutputTokens: 0, stages: { extractor: { calls: 0, usd: 0 }, auditor: { calls: 0, usd: 0 } }, runs: [] });
		if (url === "/api/graph/status") return Response.json({ runs: [] });
		if (url === "/api/chats" && method === "POST") return Response.json({ id: `chat_mint_${++mintedSeq}`, title: "Started Session" });
		if (url === "/api/chats/c_screen/dismiss" && method === "POST") {
			screenMessages.push({ id: "tr_sq", role: "toolResult", toolCallId: "call_sq_abort", toolName: "quiz", content: [{ type: "text", text: "{}" }], details: dismissedAnswer("quiz", "Q"), isError: false, timestamp: 19 } as unknown as LhMessage);
			return Response.json({ ok: true });
		}
		if (url.startsWith("/api/chats/")) return Response.json({ id: "c_screen", title: "Screen Session", messages: screenMessages, tree: PLAN_TREE_FIXTURE, turnInFlight: false });
		return Response.json({ ok: true });
	};
}

test("SessionScreenStore and NewSessionScreenStore manage planOpen, abort confirmation, nodeFilter, and empty-prompt practice", async () => {
	const restore = installStorageShim();
	const calls: RecordedReq[] = [];
	try {
		const state = stateMod.createState({ initialUrl: "/chat/c_screen", fetch: createScreensMockFetch(calls) });
		const sessScreen = state.screen(state.router.get());
		await waitTicks(25);
		assert.equal(sessScreen.get().planOpen, true);
		assert.equal(typeof sessScreen.get().appearanceSettings.theme, "string");

		await sessScreen.send({ type: "toggle-plan" });
		assert.equal(sessScreen.get().planOpen, false);
		await sessScreen.send({ type: "request-abort", mode: "question" });
		assert.equal(sessScreen.get().abortDialogMode, "question");
		await sessScreen.send({ type: "confirm-abort" });
		await waitTicks(15);
		assert.equal(sessScreen.get().abortDialogMode, null);
		assert.equal(sawReq(calls, "POST", "/api/chats/c_screen/dismiss"), true);
		sessScreen.dispose();

		await state.router.send({ type: "navigate", to: "/chat/new?mode=practice" });
		const newScreen = state.screen(state.router.get());
		await waitTicks(25);
		await newScreen.send({ type: "set-node-filter", query: "idemp" });
		assert.equal(newScreen.get().nodeFilter, "idemp");
		await newScreen.send({ type: "toggle-pick-node", nodeId: "n_1" });
		await newScreen.send({ type: "start-session", prompt: "   " });
		await waitTicks(20);
		const createCall = calls.find((c) => c.method === "POST" && c.url === "/api/chats");
		assert.equal(JSON.parse(createCall!.body).title, "Practice: Idempotence");
		newScreen.dispose();
		state.dispose();
	} finally {
		restore();
	}
});

test("HomeScreenStore manages sessionMode, folder filter pruning/toggling, and empty-prompt practice launch", async () => {
	const restore = installStorageShim();
	const calls: RecordedReq[] = [];
	try {
		const state = stateMod.createState({ initialUrl: "/", fetch: createScreensMockFetch(calls) });
		await state.prefs.send({ type: "set-graph-folder-filter", folderIds: ["fld_stale"] });
		const home = state.screen(state.router.get());
		await waitTicks(25);

		assert.deepEqual(home.get().selectedFolderIds, []);
		assert.equal(home.get().sources?.organization.folders.length, 2);

		await home.send({ type: "toggle-graph-folder", folderId: "fld_la", checked: true });
		await waitTicks(5);
		assert.deepEqual(home.get().selectedFolderIds, ["fld_la", "fld_sub"]);

		await home.send({ type: "clear-graph-folders" });
		await waitTicks(5);
		assert.deepEqual(home.get().selectedFolderIds, []);

		await home.send({ type: "set-session-mode", mode: "practice" });
		await home.send({ type: "toggle-pick-node", nodeId: "n_1" });
		await home.send({ type: "start-session", prompt: "" });
		await waitTicks(20);
		const createCall = calls.find((c) => c.method === "POST" && c.url === "/api/chats");
		assert.equal(JSON.parse(createCall!.body).title, "Practice selected propositions");
		assert.equal(JSON.parse(createCall!.body).kind, "practice");
		home.dispose();
		state.dispose();
	} finally {
		restore();
	}
});
