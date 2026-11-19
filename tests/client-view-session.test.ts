import assert from "node:assert/strict";
import test from "node:test";
import "./helpers/client-env.ts";
import { installDom } from "./helpers/client-dom.ts";

type AnyFn = (...args: any[]) => any;

function loadMod<T>(relPath: string): Promise<T> {
	return import(new URL(relPath, import.meta.url).href) as Promise<T>;
}

const VALID_SNAPSHOT_ID = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";
const TINY_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4////fwAJ+wP9KobjigAAAABJRU5ErkJggg==";

function makeBaseSessionModel(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		route: { name: "session", id: "chat-1" },
		hash: "",
		load: "ready",
		error: null,
		chatId: "chat-1",
		title: "Linear Algebra Foundations",
		kind: "teach",
		compacting: false,
		mode: "dark",
		configured: true,
		messages: [],
		status: "ready",
		contextTokens: 2048,
		turnError: null,
		imageSnapshots: {},
		...overrides,
	};
}

function makeMarkerMsg(id: string, type: string, data: Record<string, unknown>): Record<string, unknown> {
	return { id, role: "user", parts: [{ type, id: `${type}_${id}`, data }] };
}

function makeAssistantRichMsg(): Record<string, unknown> {
	const prose = [
		"Consider inline $x^2 + 1$ and display:",
		"",
		"$$",
		"\\dim(V) = \\operatorname{rank}(T) + \\operatorname{nullity}(T)",
		"$$",
		"",
		"```js",
		"const rank = 2;",
		"```",
	].join("\n");
	const imgOut = { snapshotId: VALID_SNAPSHOT_ID, caption: "Annotated basis diagram", mimeType: "image/png", width: 320, height: 180 };
	const quizIn = { question: "What is the dimension of R^3?", options: ["2", "3", "4"] };
	return {
		id: "a1",
		role: "assistant",
		parts: [
			{ type: "step-start", sourceMessageId: "a1" },
			{ type: "reasoning", id: "a1-r0", text: "Check rank-nullity theorem first." },
			{ type: "text", id: "a1-t0", text: prose },
			{ type: "tool-show_image", toolCallId: "call_img_1", state: "output-available", output: imgOut },
			{ type: "tool-quiz", toolCallId: "call_quiz_1", state: "output-available", input: quizIn, output: { answer: "3" } },
		],
	};
}

function makeRichMessages(): Array<Record<string, unknown>> {
	const initialCtx = {
		propositions: [{ id: "p1", name: "Basis", statement: "Spans V and is linearly independent." }],
		chains: ["Independent + Spanning -> Basis"],
	};
	const hiddenMfn = { source: "mfn", display: false, propositions: [], chains: [], recalledMemoryIds: ["mem_1"] };
	const cmpDetails = { firstKeptMessageId: "u1", tokensBefore: 150000, at: "2026-11-19T00:00:00Z" };
	const userParts = [
		{ type: "text", id: "u1-t0", text: "Here is my matrix sketch." },
		{ type: "image", id: "u1-img0", mimeType: "image/png", data: TINY_PNG_BASE64 },
	];
	return [
		makeMarkerMsg("ctx-initial", "data-graph-context", initialCtx),
		makeMarkerMsg("mfn-hidden-turn", "data-graph-context", hiddenMfn),
		makeMarkerMsg("cut_cmp1", "data-compaction-cut", { content: "Earlier Vectors summary.", details: cmpDetails }),
		{ id: "u1", role: "user", parts: userParts },
		makeAssistantRichMsg(),
		makeMarkerMsg("cmp1", "data-compaction", { content: "Compaction moment summary.", details: cmpDetails }),
	];
}

function makeReadySnapshots(): Record<string, unknown> {
	return {
		[VALID_SNAPSHOT_ID]: {
			status: "ready",
			image: { mimeType: "image/png", data: TINY_PNG_BASE64, width: 320, height: 180 },
		},
	};
}

test("deriveSessionViewModel runs DOM-free, skips MFN source==='mfn', and resolves snapshots", async () => {
	const { deriveSessionViewModel } = await loadMod<{ deriveSessionViewModel: AnyFn }>(
		"../src/client/views/session/session-models.js",
	);
	const vm = deriveSessionViewModel(makeBaseSessionModel({
		compacting: true,
		messages: makeRichMessages(),
		imageSnapshots: makeReadySnapshots(),
	}));

	assert.equal(vm.state, "ready");
	assert.equal(vm.topBar.title, "Linear Algebra Foundations");
	assert.equal(vm.topBar.subtitle, "Compacting context…");
	assert.equal(vm.items.length, 5);
	const ids = vm.items.map((item: { id: string }) => item.id);
	assert.equal(ids.includes("mfn-hidden-turn"), false);
	assert.equal(ids[0], "ctx-initial");
	assert.equal(vm.items[0].parts[0].kind, "graph-context");
	assert.equal(vm.items[1].parts[0].kind, "compaction-cut");
	assert.equal(vm.items[4].parts[0].kind, "compaction");
	const snapPart = vm.items[3].parts.find((p: { kind: string }) => p.kind === "snapshot-image");
	assert.equal(snapPart.status, "ready");
	assert.equal(snapPart.snapshotId, VALID_SNAPSHOT_ID);
});

test("createSessionView renders loading, 404 not-found, and error state with Retry reload", async () => {
	const dom = installDom();
	try {
		const { createSessionView } = await loadMod<{ createSessionView: AnyFn }>(
			"../src/client/views/session/session-view.js",
		);
		const host = dom.document.createElement("div");
		dom.document.body.append(host);
		const intents: Array<{ type: string }> = [];
		const view = createSessionView(host, { send: (intent: { type: string }) => { intents.push(intent); } });

		view.update(makeBaseSessionModel({ load: "loading" }));
		const statusEl = host.querySelector(".cloudcanvas-ui-status");
		assert.equal(statusEl?.getAttribute("data-status"), "loading");
		assert.equal((host.querySelector("[data-peer-transcript]") as HTMLElement).hidden, true);

		view.update(makeBaseSessionModel({ load: "not-found", error: "Missing chat" }));
		assert.equal(statusEl?.getAttribute("data-status"), "empty");
		assert.equal(statusEl?.textContent?.includes("Session not found"), true);

		view.update(makeBaseSessionModel({ load: "error", error: "Gateway 502" }));
		assert.equal(statusEl?.getAttribute("data-status"), "error");
		assert.equal(statusEl?.textContent?.includes("Gateway 502"), true);
		(host.querySelector(".cloudcanvas-ui-status-retry") as HTMLButtonElement).click();
		assert.deepEqual(intents, [{ type: "reload" }]);

		view.destroy();
		assert.equal(host.childElementCount, 0);
	} finally {
		await dom.cleanup();
	}
});

test("createSessionView renders transcript parts, Mod+T thinking, /objects image, and skips MFN", async () => {
	const dom = installDom();
	try {
		const { createBlockRegistry } = await loadMod<{ createBlockRegistry: AnyFn }>("../src/client/blocks/registry.js");
		const { createSessionView } = await loadMod<{ createSessionView: AnyFn }>("../src/client/views/session/session-view.js");
		const host = dom.document.createElement("div");
		dom.document.body.append(host);
		const view = createSessionView(host, { blocks: createBlockRegistry() });

		view.update(makeBaseSessionModel({
			messages: makeRichMessages(),
			turnError: "Rate limit reached",
			imageSnapshots: { [VALID_SNAPSHOT_ID]: { status: "loading" } },
		}));
		assert.equal(host.querySelector("[data-peer-message-id='mfn-hidden-turn']"), null);
		assert.equal(host.querySelector("[data-peer-graph-context]")?.textContent?.includes("Spans V"), true);
		assert.notEqual(host.querySelector("[data-peer-compaction-cut]"), null);
		assert.notEqual(host.querySelector("[data-peer-compaction]"), null);
		assert.notEqual(host.querySelector("[data-peer-image] img"), null);
		assert.equal(host.querySelector("[data-peer-snapshot-id]")?.getAttribute("data-peer-snapshot-status"), "loading");

		view.update(makeBaseSessionModel({
			messages: makeRichMessages(),
			turnError: "Rate limit reached",
			imageSnapshots: makeReadySnapshots(),
		}));
		const card = host.querySelector("[data-testid='image-card']") as HTMLElement | null;
		assert.equal(card?.getAttribute("data-peer-snapshot-id"), VALID_SNAPSHOT_ID);
		assert.equal(card?.querySelector("figcaption")?.textContent, "Annotated basis diagram");
		const mdEl = host.querySelector("[data-peer-message-id='a1'] [data-peer-markdown]");
		assert.equal(mdEl?.textContent?.includes("Consider inline"), true);
		assert.notEqual(mdEl?.querySelector(".katex"), null);
		assert.equal(mdEl?.textContent?.includes("const rank = 2;"), true);
		assert.notEqual(host.querySelector("[data-peer-part-type='tool-quiz']"), null);

		const thinking = host.querySelector("[data-peer-thinking]") as HTMLDetailsElement;
		assert.equal(thinking.open, false);
		assert.equal(view.command("toggle-user-thinking"), true);
		assert.equal(thinking.open, true);
		assert.equal(view.command("toggle-user-thinking"), true);
		assert.equal(thinking.open, false);
		assert.equal(host.querySelector("[data-peer-turn-error]")?.textContent, "Rate limit reached");

		view.destroy();
		assert.equal(host.childElementCount, 0);
	} finally {
		await dom.cleanup();
	}
});

test("createSessionView reuses unchanged message nodes via createViewList and scrolls #msg hash", async () => {
	const dom = installDom();
	try {
		const { createSessionView } = await loadMod<{ createSessionView: AnyFn }>(
			"../src/client/views/session/session-view.js",
		);
		const host = dom.document.createElement("div");
		dom.document.body.append(host);
		const view = createSessionView(host);

		const m1 = { id: "m1", role: "user", parts: [{ type: "text", id: "m1-t0", text: "First prompt" }] };
		const m2a = { id: "m2", role: "assistant", parts: [{ type: "text", id: "m2-t0", text: "Part one" }] };
		view.update(makeBaseSessionModel({ messages: [m1, m2a] }));

		const firstArticle = host.querySelector("[data-peer-message-id='m1']");
		const secondArticle = host.querySelector("[data-peer-message-id='m2']") as HTMLElement;
		assert.notEqual(firstArticle, null);
		assert.notEqual(secondArticle, null);

		let scrolled = 0;
		secondArticle.scrollIntoView = () => { scrolled += 1; };
		view.update(makeBaseSessionModel({ messages: [m1, m2a], hash: "#msg-m2" }));
		assert.equal(scrolled, 1);

		const m2b = { id: "m2", role: "assistant", parts: [{ type: "text", id: "m2-t0", text: "Part one + two" }] };
		view.update(makeBaseSessionModel({ messages: [m1, m2b], hash: "#msg-m2" }));
		assert.equal(host.querySelector("[data-peer-message-id='m1']"), firstArticle);
		assert.equal(host.querySelector("[data-peer-message-id='m2']")?.textContent?.includes("Part one + two"), true);

		view.update(makeBaseSessionModel({ messages: [m1] }));
		assert.equal(host.querySelector("[data-peer-message-id='m2']"), null);

		view.destroy();
		assert.equal(host.childElementCount, 0);
	} finally {
		await dom.cleanup();
	}
});
