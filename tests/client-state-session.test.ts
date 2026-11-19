import assert from "node:assert/strict";
import test from "node:test";
import {
	newCompactionMarker,
	newGraphContextMessage,
	newUserMessage,
	type LhMarkerMessage,
	type LhMessage,
} from "../src/core/index.ts";
import { projectView } from "../src/core/view.ts";

await import("./helpers/client-env.ts");
const {
	createState,
} = await import("../src/client/state/index.ts");
import type { SessionScreenModel } from "../src/client/state/index.ts";

const SNAP_A = "a".repeat(64);
const SNAP_B = "b".repeat(64);

function sseBody(...events: unknown[]): Response {
	const text = events
		.map((e) => (e === "[DONE]" ? "data: [DONE]\n\n" : `data: ${JSON.stringify(e)}\n\n`))
		.join("");
	return new Response(text, {
		status: 200,
		headers: { "Content-Type": "text/event-stream" },
	});
}

function waitTicks(ms = 15): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function assistantToolMessage(id: string, toolCallId: string, toolName: string): LhMessage {
	return {
		id,
		role: "assistant",
		content: [{ type: "toolCall", id: toolCallId, name: toolName, arguments: {} }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude",
		usage: {
			input: 10,
			output: 5,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 15,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: 1,
	} as unknown as LhMessage;
}

function buildImageSessionMessages(): LhMessage[] {
	const toolMsg = assistantToolMessage("a1", "call_img", "show_image");
	const toolRes = {
		id: "tr1",
		role: "toolResult",
		toolCallId: "call_img",
		toolName: "show_image",
		content: [{ type: "text", text: "Image shown" }],
		details: {
			path: "/notes/fig.png",
			mimeType: "image/png",
			snapshotId: SNAP_A,
			width: 64,
			height: 48,
		},
		isError: false,
		timestamp: 2,
	} as unknown as LhMessage;
	const steerMarker: LhMarkerMessage = {
		id: "steer_vis",
		role: "custom",
		customType: "subagent-steer",
		content: "Visual ready",
		display: true,
		details: {
			kind: "visual",
			result: { svg: "<svg/>", image: { snapshotId: SNAP_B, width: 32, height: 32 } },
		},
		timestamp: 3,
	};
	return [toolMsg, toolRes, steerMarker];
}

function createLiveStreamMock(userMsg: LhMessage): typeof globalThis.fetch {
	let settled = false;
	const finalAssistant = {
		id: "m_final",
		role: "assistant",
		content: [{ type: "text", text: "P(A|B) = P(B|A)P(A)/P(B)" }],
		stopReason: "stop",
		timestamp: 5,
	};
	return async (input) => {
		const url = String(input);
		if (url === "/api/settings") return Response.json({ settings: null });
		if (url === "/api/themes") return Response.json({ themes: [] });
		if (url === "/api/chats/c_live") {
			const messages = settled ? [userMsg, finalAssistant] : [userMsg];
			return Response.json({ id: "c_live", title: "Bayes", messages, turnInFlight: !settled });
		}
		if (url === "/api/chats/c_live/stream") {
			settled = true;
			return sseBody(
				{ type: "agent_start" },
				{ type: "message_start", message: { role: "assistant", content: [] } },
				{ type: "message_update", message: finalAssistant },
				{ type: "message_end", message: finalAssistant },
				"[DONE]",
			);
		}
		return Response.json({ error: "unexpected" }, { status: 404 });
	};
}

test("projectView skips hidden MFN recall markers while preserving display:true graph-context and compaction", () => {
	const visibleMap = newGraphContextMessage(
		[{ id: "p1", name: "DAG", statement: "Acyclic directed graph" }],
		[],
	);
	const hiddenMfn: LhMarkerMessage = {
		id: "mfn_ctx_1",
		role: "custom",
		customType: "graph-context",
		content: "[MFN memory context]",
		display: false,
		details: { source: "mfn", propositions: [], chains: [] },
		timestamp: 2,
	};
	const user1 = newUserMessage("First turn");
	const user2 = newUserMessage("Kept turn");
	const compaction = newCompactionMarker("Summary text", {
		firstKeptMessageId: user2.id,
		tokensBefore: 1200,
		at: "2026-11-19T12:00:00.000Z",
	});

	const projected = projectView([visibleMap, hiddenMfn, user1, user2, compaction]);
	const partTypes = projected.flatMap((m) => m.parts.map((p) => p.type));
	assert.equal(partTypes.includes("data-graph-context"), true);
	assert.equal(projected.some((m) => m.id === "mfn_ctx_1"), false);
	assert.equal(partTypes.includes("data-compaction-cut"), true);
	assert.equal(partTypes.includes("data-compaction"), true);
});

test("SessionStore and SessionScreenStore handle 404 not-found and same-key route hash updates", async () => {
	const state = createState({
		initialUrl: "/chat/missing-chat",
		fetch: async (input) => {
			const url = String(input);
			if (url === "/api/settings") return Response.json({ settings: null });
			if (url === "/api/themes") return Response.json({ themes: [] });
			if (url === "/api/chats/missing-chat") return Response.json({ error: "Not found" }, { status: 404 });
			return Response.json({
				id: "c1",
				title: "Linear Algebra",
				kind: "practice",
				messages: [newUserMessage("Eigenvalues")],
				turnError: "Previous stream interrupted",
			});
		},
	});
	const missingScreen = state.screen(state.router.get());
	await waitTicks();
	assert.equal((missingScreen.get() as SessionScreenModel).load, "not-found");
	missingScreen.dispose();

	await state.router.send({ type: "navigate", to: "/chat/c1?prompt=start#msg_1" });
	const screen = state.screen(state.router.get());
	await waitTicks();
	const snap1 = screen.get() as SessionScreenModel;
	assert.equal(snap1.load, "ready");
	assert.equal(snap1.title, "Linear Algebra");
	assert.equal(snap1.kind, "practice");
	assert.equal(snap1.turnError, "Previous stream interrupted");
	assert.equal(snap1.hash, "#msg_1");

	await state.router.send({ type: "navigate", to: "/chat/c1#msg_2" });
	await waitTicks();
	const snap2 = screen.get() as SessionScreenModel;
	assert.equal(snap2.hash, "#msg_2");
	assert.equal(snap2.route.prompt, undefined);

	screen.dispose();
	state.dispose();
});

test("SessionStore hydrates 64-hex imageSnapshots once per snapshotId from tool outputs", async () => {
	const imageCalls: string[] = [];
	const messages = buildImageSessionMessages();
	const state = createState({
		fetch: async (input) => {
			const url = String(input);
			if (url === "/api/settings") return Response.json({ settings: null });
			if (url === "/api/themes") return Response.json({ themes: [] });
			if (url === "/api/chats/c_img") {
				return Response.json({ id: "c_img", title: "Images", messages });
			}
			if (url.startsWith("/api/chats/c_img/images/")) {
				imageCalls.push(url);
				return Response.json({ mimeType: "image/png", data: "AAAA", width: 64, height: 48 });
			}
			return Response.json({ error: "unexpected" }, { status: 404 });
		},
	});
	const session = state.openSession("c_img");
	await waitTicks(25);
	const snap = session.get();
	assert.equal(snap.imageSnapshots[SNAP_A]?.status, "ready");
	assert.equal(snap.imageSnapshots[SNAP_B]?.status, "ready");
	assert.equal(imageCalls.length, 2);

	await session.send({ type: "reload" });
	await waitTicks(15);
	assert.equal(imageCalls.length, 2);
	session.dispose();
	state.dispose();
});

test("SessionStore attaches live SSE stream when turnInFlight is true and settles cleanly", async () => {
	const userMsg = newUserMessage("Derive Bayes rule");
	const state = createState({ fetch: createLiveStreamMock(userMsg) });
	const session = state.openSession("c_live");
	await waitTicks(30);

	const model = session.get();
	assert.equal(model.load, "ready");
	assert.equal(model.state?.status, "ready");
	assert.equal(model.state?.messages.length, 2);
	const assistantParts = model.state?.messages[1]?.parts ?? [];
	assert.equal(assistantParts.some((p) => p.text === "P(A|B) = P(B|A)P(A)/P(B)"), true);

	session.dispose();
	state.dispose();
});

test("SessionStore updates compacting and reloads idle record on SSE notifications", async () => {
	const handlers = new Map<string, (raw: string) => void>();
	let title = "Initial Title";
	const state = createState({
		createEventSource: () => ({
			close: () => {},
			onOpen: () => {},
			onEvent: (name, cb) => { handlers.set(name, cb); },
		}),
		fetch: async (input) => {
			if (String(input) === "/api/chats/c_ev") {
				return Response.json({ id: "c_ev", title, messages: [] });
			}
			return Response.json({ settings: null, themes: [] });
		},
	});
	const session = state.openSession("c_ev");
	await waitTicks();
	assert.equal(session.get().title, "Initial Title");

	handlers.get("compaction-changed")?.(JSON.stringify({ chatId: "c_ev", running: true }));
	await waitTicks(5);
	assert.equal(session.get().compacting, true);

	title = "Updated Title";
	handlers.get("record-changed")?.(JSON.stringify({ chatId: "c_ev" }));
	await waitTicks();
	assert.equal(session.get().title, "Updated Title");

	session.dispose();
	state.dispose();
});
