import assert from "node:assert/strict";
import test from "node:test";
import "./helpers/client-env.ts";
import { installDom, type InstalledDom } from "./helpers/client-dom.ts";

type AnyFn = (...args: any[]) => any;

function loadMod<T>(relPath: string): Promise<T> {
	return import(new URL(relPath, import.meta.url).href) as Promise<T>;
}

function trackWindowListeners(win: Window & typeof globalThis): { activeCount(): number; restore(): void } {
	const origAdd = win.addEventListener.bind(win);
	const origRemove = win.removeEventListener.bind(win);
	const entries = new Map<string, { type: string; listener: unknown }>();
	let seq = 0;
	win.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject, opts?: boolean | AddEventListenerOptions) => {
		const sig = typeof opts === "object" && opts !== null ? opts.signal : undefined;
		if (sig?.aborted) return;
		const id = `l_${seq++}`;
		entries.set(id, { type, listener });
		if (sig) sig.addEventListener("abort", () => { entries.delete(id); }, { once: true });
		origAdd(type, listener, opts);
	}) as typeof win.addEventListener;
	win.removeEventListener = ((type: string, listener: EventListenerOrEventListenerObject, opts?: boolean | EventListenerOptions) => {
		for (const [id, item] of entries) {
			if (item.type === type && item.listener === listener) entries.delete(id);
		}
		origRemove(type, listener, opts);
	}) as typeof win.removeEventListener;
	return {
		activeCount: () => entries.size,
		restore: () => { win.addEventListener = origAdd; win.removeEventListener = origRemove; },
	};
}

function fillControl(dom: InstalledDom, control: Element | null, text: string): void {
	assert.notEqual(control, null);
	const el = control as HTMLElement & { value?: string };
	if ("value" in el) el.value = text;
	else el.textContent = text;
	el.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
	el.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
}

function clickQuizOption(dock: Element, labelText: string): void {
	const candidates = [...dock.querySelectorAll("button")];
	const match = candidates.find((node) => (node.textContent ?? "").includes(labelText)) ?? candidates[0];
	assert.notEqual(match, undefined);
	(match as HTMLElement).click();
}

function makeInteractiveSessionModel(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		route: { name: "session", id: "c_c2a" },
		hash: "", load: "ready", error: null, chatId: "c_c2a", title: "Spectral Theorem",
		kind: "teach", compacting: false, mode: "dark", configured: true,
		messages: [{ id: "u1", role: "user", parts: [{ type: "text", id: "u1-t0", text: "Hello" }] }],
		status: "ready", contextTokens: 4096, turnError: null, imageSnapshots: {},
		tree: null, planOpen: true,
		appearanceSettings: { transcriptWidth: 64, adaptiveQuestions: true },
		chatSettings: { model: { provider: "anthropic", id: "claude-sonnet-4" }, thinkingLevel: "high" },
		pricing: { totalCost: 0.0125, inputTokens: 2048, outputTokens: 512 },
		queuedSteers: [], pendingQuestion: null, activeProblem: null,
		effectiveModel: { provider: "anthropic", id: "claude-sonnet-4", thinkingLevel: "high" },
		availableModels: [{ provider: "anthropic", id: "claude-sonnet-4", name: "Claude Sonnet 4", reasoning: true, supportedThinkingLevels: ["low", "high"] }],
		...overrides,
	};
}

const PENDING_QUIZ_FIXTURE = {
	toolCallId: "call_quiz_42", tool: "quiz", messageId: "a_quiz_1", contentIndex: 0, key: "call_quiz_42",
	input: {
		type: "predict", question: "What is det(I_3)?",
		options: [{ label: "Zero", value: "zero" }, { label: "One", value: "one" }],
		explanation: "The identity matrix has determinant 1.", correctAnswer: "one",
	},
};

const ACTIVE_PROBLEM_FIXTURE = {
	toolCallId: "call_prob_7",
	input: {
		statement: "Prove every real symmetric matrix has real eigenvalues.",
		mode: "guided", target: ["n_spectral"], modelSolution: "Compare <Ax, x> with <x, Ax>.",
	},
};

const PLAN_TREE_FIXTURE = {
	version: 1,
	nodes: [{ id: "p_inner", title: "Inner Products" }, { id: "p_self", title: "Self-Adjoint Operators" }],
	edges: [{ from: "p_inner", to: "p_self" }],
};

test("createSessionView handles sticky scroll, transcript width, composer pickers, steer/stop, and abort-turn dialog", async () => {
	const dom = installDom();
	let tracker: ReturnType<typeof trackWindowListeners> | null = null;
	try {
		const { createSessionView } = await loadMod<{ createSessionView: AnyFn }>("../src/client/views/session/session-view.js");
		tracker = trackWindowListeners(dom.window);
		const host = dom.document.createElement("div");
		dom.document.body.append(host);
		const intents: Array<Record<string, unknown>> = [];
		const view = createSessionView(host, {
			send: (i: Record<string, unknown>) => { intents.push(i); },
			onPickDirectory: async () => "/workspace/notes",
			onPickFiles: async () => ["/workspace/svd.tex"],
		});

		view.update(makeInteractiveSessionModel({ configured: false }));
		assert.equal((host.querySelector("[data-peer-setup-cta]") as HTMLElement | null)?.hidden, false);

		view.update(makeInteractiveSessionModel({ configured: true }));
		const rootEl = host.querySelector("[data-peer-screen='session']") as HTMLElement;
		assert.equal(rootEl.style.getPropertyValue("--peer-transcript-max-width"), "64rem");
		assert.notEqual(host.querySelector("[data-peer-transcript].cloudcanvas-ui-sticky-scroll"), null);
		assert.notEqual(host.querySelector("[data-peer-action='pick-directory']"), null);

		(host.querySelector("[data-peer-action='pick-directory']") as HTMLButtonElement).click();
		(host.querySelector("[data-peer-action='pick-files']") as HTMLButtonElement).click();
		await new Promise((r) => setTimeout(r, 15));
		assert.notEqual(host.querySelector("[data-peer-path-chip='/workspace/notes/']"), null);
		assert.notEqual(host.querySelector("[data-peer-path-chip='/workspace/svd.tex']"), null);

		fillControl(dom, host.querySelector("[data-peer-composer-input]"), "Derive @notes/svd.md");
		assert.notEqual(host.querySelector("[data-peer-path-chip='notes/svd.md']"), null);
		(host.querySelector("[data-peer-action='send-turn']") as HTMLButtonElement).click();
		assert.equal(intents[0]?.type, "send-text");

		view.update(makeInteractiveSessionModel({ status: "streaming", queuedSteers: [{ id: "st_1", text: "Keep it geometric" }] }));
		fillControl(dom, host.querySelector("[data-peer-composer-input]"), "Show 2x2 case");
		(host.querySelector("[data-peer-action='steer-turn']") as HTMLButtonElement).click();
		assert.equal(intents.some((i) => i.type === "steer"), true);
		assert.equal(view.command("escape-session"), true);
		assert.equal(host.querySelector("[data-testid='abort-turn-title']")?.textContent, "Abort this turn?");
		(host.querySelector("[data-testid='abort-turn-confirm']") as HTMLButtonElement).click();
		assert.equal(intents.some((i) => i.type === "stop"), true);

		view.destroy();
		assert.equal(host.childElementCount, 0);
		assert.equal(tracker.activeCount(), 0);
	} finally {
		tracker?.restore();
		await dom.cleanup();
	}
});

test("createSessionView wires question-dock, practice-dock, controlled plan-dock, and inline PanZoom", async () => {
	const dom = installDom();
	let tracker: ReturnType<typeof trackWindowListeners> | null = null;
	try {
		const { createSessionView } = await loadMod<{ createSessionView: AnyFn }>("../src/client/views/session/session-view.js");
		tracker = trackWindowListeners(dom.window);
		const host = dom.document.createElement("div");
		dom.document.body.append(host);
		const intents: Array<Record<string, unknown>> = [];
		const view = createSessionView(host, { send: (i: Record<string, unknown>) => { intents.push(i); } });

		view.update(makeInteractiveSessionModel({ pendingQuestion: PENDING_QUIZ_FIXTURE, tree: PLAN_TREE_FIXTURE, planOpen: false }));
		const planBody = host.querySelector("[data-peer-plan-body]") as HTMLElement;
		assert.equal(planBody.hidden, true);
		(host.querySelector("[data-peer-action='toggle-plan']") as HTMLButtonElement).click();
		assert.equal(intents.some((i) => i.type === "toggle-plan"), true);

		view.update(makeInteractiveSessionModel({ pendingQuestion: PENDING_QUIZ_FIXTURE, tree: PLAN_TREE_FIXTURE, planOpen: true }));
		assert.equal(planBody.hidden, false);
		assert.notEqual(planBody.querySelector(".cloudcanvas-ui-pan-zoom svg"), null);

		const qDock = host.querySelector("[data-testid='question-dock']") as HTMLElement;
		clickQuizOption(qDock, "One");
		fillControl(dom, host.querySelector("[data-peer-question-thinking]"), "Diagonal product is 1.");
		(host.querySelector("[data-peer-action='submit-answer']") as HTMLButtonElement).click();
		assert.equal(intents.some((i) => i.type === "answer-question"), true);
		(host.querySelector("[data-peer-action='dismiss-question']") as HTMLButtonElement).click();
		assert.equal(intents.some((i) => i.type === "dismiss-question"), true);

		view.update(makeInteractiveSessionModel({ kind: "practice", activeProblem: ACTIVE_PROBLEM_FIXTURE }));
		fillControl(dom, host.querySelector("[data-peer-practice-thinking]"), "Take conjugate transpose.");
		(host.querySelector("[data-peer-action='submit-thinking']") as HTMLButtonElement).click();
		assert.equal(intents.some((i) => i.type === "submit-thinking"), true);
		(host.querySelector("[data-peer-action='next-problem']") as HTMLButtonElement).click();
		assert.equal(intents.some((i) => i.type === "next-problem"), true);
		(host.querySelector("[data-peer-action='dismiss-problem']") as HTMLButtonElement).click();
		assert.equal(intents.some((i) => i.type === "dismiss-problem"), true);

		view.destroy();
		assert.equal(tracker.activeCount(), 0);
	} finally {
		tracker?.restore();
		await dom.cleanup();
	}
});

test("transcript-item reconciles streaming reasoning and Markdown block slots in place without flicker", async () => {
	const dom = installDom();
	try {
		const { createSessionView } = await loadMod<{ createSessionView: AnyFn }>("../src/client/views/session/session-view.js");
		const host = dom.document.createElement("div");
		dom.document.body.append(host);
		const view = createSessionView(host);

		const step1 = [{ id: "a_stream", role: "assistant", parts: [{ type: "reasoning", id: "r_1", text: "Checking invariants..." }] }];
		view.update(makeInteractiveSessionModel({ status: "streaming", messages: step1 }));
		const reasoningEl = host.querySelector("[data-peer-thinking][data-peer-part-type='reasoning']");
		assert.equal(reasoningEl?.querySelector("summary")?.textContent?.includes("Thinking…"), true);

		const parts2 = [
			{ type: "reasoning", id: "r_1", text: "Checking invariants and basis." },
			{ type: "text", id: "t_1", text: "```js\nconst d = 3;\n```\n\nFirst line" },
		];
		view.update(makeInteractiveSessionModel({ status: "streaming", messages: [{ id: "a_stream", role: "assistant", parts: parts2 }] }));
		assert.equal(host.querySelector("[data-peer-thinking][data-peer-part-type='reasoning']"), reasoningEl);
		const mdPartEl = host.querySelector("[data-peer-part-type='text']");
		const preEl = mdPartEl?.querySelector("pre");
		assert.notEqual(preEl, null);

		const parts3 = [
			{ type: "reasoning", id: "r_1", text: "Checking invariants and basis." },
			{ type: "text", id: "t_1", text: "```js\nconst d = 3;\n```\n\nFirst line extended cleanly." },
		];
		view.update(makeInteractiveSessionModel({ status: "streaming", messages: [{ id: "a_stream", role: "assistant", parts: parts3 }] }));
		assert.equal(host.querySelector("[data-peer-part-type='text']"), mdPartEl);
		assert.equal(mdPartEl?.querySelector("pre"), preEl);
		assert.equal(mdPartEl?.textContent?.includes("extended cleanly"), true);

		view.destroy();
	} finally {
		await dom.cleanup();
	}
});

function buildRichCardsMessages(): Array<Record<string, unknown>> {
	const quizInput = {
		type: "predict", question: "For any orthogonal matrix $Q$, what is $|\\det(Q)|$?", details: "Recall $Q^\\top Q = I$.",
		options: [{ label: "Zero", value: "0" }, { label: "One", value: "1" }],
		explanation: "Because $\\det(Q)^2 = \\det(I) = 1$.", correctAnswer: "1",
	};
	const quizOutput = {
		kind: "quiz", tool: "quiz", questionType: "predict", questionText: quizInput.question,
		options: [{ index: 1, label: "Zero" }, { index: 2, label: "One" }], optionOrder: { A: 1, B: 2 },
		dontKnow: false, answers: [{ index: 2, label: "One", value: "1" }], correct: true, correctIndices: [2],
		confidence: 90, explanation: quizInput.explanation, thinking: "Determinants multiply.",
		readingThinking: "Orthogonal preserves lengths.", answeredAt: "2026-11-22T00:00:00Z",
	};
	const qParts = [
		{ type: "tool-quiz", toolCallId: "q_rich", state: "output-available", input: quizInput, output: quizOutput },
		{ type: "tool-ask_user_question", toolCallId: "q_skip", state: "output-available", input: { question: "Skip me?" }, output: { kind: "ask", questionText: "Skip me?", dontKnow: false, answers: [], dismissed: true, answeredAt: "" } },
		{ type: "tool-ask_user_question", toolCallId: "q_other", state: "output-available", input: { question: "Preferred proof?" }, output: { kind: "ask", questionText: "Preferred proof?", dontKnow: false, answers: [], other: "Geometric SVD", answeredAt: "" } },
		{ type: "tool-explain", toolCallId: "q_exp", state: "output-available", input: { question: "Define kernel.", correctAnswer: "Vectors mapped to 0." }, output: { kind: "explain", questionText: "Define kernel.", dontKnow: false, answers: [], text: "Nullspace", committed: "Vectors mapped to 0.", answeredAt: "" } },
	];
	const pParts = [
		{ type: "tool-problem", toolCallId: "p_1", state: "output-available", input: { statement: "Find rank(I_4).", modelSolution: "SECRET_COMMITMENT" } },
		{ type: "data-practice-thinking", id: "pt_1", data: { problemCallId: "p_1", text: "Four pivots." } },
		{ type: "tool-conclude", toolCallId: "c_1", state: "output-available", input: { outcome: "solvedWithHints", verdict: "Solid pivot count.", rung: "nudge", retest: false }, problemInput: { mode: "guided", target: ["n_rank"] }, reveal: "All 4 diagonal entries are non-zero." },
		{ type: "tool-quiz", toolCallId: "q_bad", state: "output-error", errorText: "Invalid options array" },
	];
	return [{ id: "m_quiz", role: "assistant", parts: qParts }, { id: "m_prac", role: "assistant", parts: pParts }];
}

function assertAnsweredAndPracticeDom(host: HTMLElement): void {
	assert.notEqual(host.querySelector("[data-testid='reading-thinking-block']"), null);
	const cards = host.querySelectorAll("[data-testid='answered-card']");
	assert.equal(cards.length, 4);
	assert.equal(cards[0]?.textContent?.includes("Prediction"), true);
	assert.equal(cards[0]?.textContent?.includes("correct"), true);
	assert.equal(cards[0]?.querySelector("[data-option-letter='B']")?.textContent, "B");
	assert.notEqual(cards[0]?.querySelector("[data-mark='check']"), null);
	assert.equal(cards[0]?.querySelector("[data-testid='answered-confidence']")?.textContent?.includes("90%"), true);
	assert.notEqual(cards[0]?.querySelector("[data-testid='your-thinking']"), null);

	const whyBtn = cards[0]?.querySelector("[data-testid='tucked-explanation'] button") as HTMLButtonElement;
	assert.equal(whyBtn.textContent, "Why");
	whyBtn.click();
	assert.equal(whyBtn.textContent, "Hide why");
	assert.equal(cards[1]?.classList.contains("is-dismissed"), true);
	assert.equal(cards[2]?.querySelector("[data-testid='answered-other']")?.textContent?.includes("Geometric SVD"), true);
	assert.equal(cards[3]?.textContent?.includes("The answer:"), true);

	assert.equal(host.querySelector("[data-testid='problem-card']")?.textContent?.includes("SECRET_COMMITMENT"), false);
	assert.notEqual(host.querySelector("[data-testid='thinking-card']"), null);
	const concludeCard = host.querySelector("[data-testid='conclude-card']") as HTMLElement;
	assert.equal(concludeCard.textContent?.includes("Solved with hints"), true);
	(concludeCard.querySelector("[data-testid='metadata-toggle']") as HTMLButtonElement).click();
	assert.equal(concludeCard.querySelector("[data-testid='metadata-box']")?.textContent?.includes("n_rank"), true);
}

test("answered-card and practice-cards render full LearnHarness UX parity and retry malformed questions", async () => {
	const dom = installDom();
	let tracker: ReturnType<typeof trackWindowListeners> | null = null;
	try {
		const { createSessionView } = await loadMod<{ createSessionView: AnyFn }>("../src/client/views/session/session-view.js");
		tracker = trackWindowListeners(dom.window);
		const host = dom.document.createElement("div");
		dom.document.body.append(host);
		const intents: Array<Record<string, unknown>> = [];
		const view = createSessionView(host, { send: (i: Record<string, unknown>) => { intents.push(i); } });

		view.update(makeInteractiveSessionModel({ messages: buildRichCardsMessages() }));
		assertAnsweredAndPracticeDom(host);
		(host.querySelector("[data-peer-action='retry-question']") as HTMLButtonElement).click();
		assert.equal(intents.some((i) => i.type === "retry-question" && i.toolCallId === "q_bad"), true);

		view.destroy();
		assert.equal(tracker.activeCount(), 0);
	} finally {
		tracker?.restore();
		await dom.cleanup();
	}
});

test("createNewSessionView dispatches set-node-filter with zero view-owned searchQuery", async () => {
	const dom = installDom();
	let tracker: ReturnType<typeof trackWindowListeners> | null = null;
	try {
		const { createNewSessionView } = await loadMod<{ createNewSessionView: AnyFn }>("../src/client/views/new-session/new-session-view.js");
		tracker = trackWindowListeners(dom.window);
		const host = dom.document.createElement("div");
		dom.document.body.append(host);
		const intents: Array<Record<string, unknown>> = [];
		const props = [
			{ id: "n_svd", name: "SVD", statement: "Matrix factorization." },
			{ id: "n_eig", name: "Eigenvalues", statement: "Characteristic roots." },
		];
		const baseModel = {
			route: { name: "new-session", mode: "practice" }, configured: true, mode: "dark",
			sessionMode: "practice", nodeFilter: "", pickedNodeIds: [], propositions: props,
			effectiveModel: { provider: "anthropic", id: "claude-sonnet-4" }, availableModels: [], starting: false, error: null,
		};
		const view = createNewSessionView(host, { send: (i: Record<string, unknown>) => { intents.push(i); } });
		view.update(baseModel);
		assert.equal(host.querySelectorAll("[data-peer-node-id]").length, 2);

		fillControl(dom, host.querySelector("[data-peer-node-search]"), "eigen");
		assert.deepEqual(intents[0], { type: "set-node-filter", query: "eigen" });
		assert.equal(host.querySelectorAll("[data-peer-node-id]").length, 2);

		view.update({ ...baseModel, nodeFilter: "eigen" });
		assert.equal(host.querySelectorAll("[data-peer-node-id]").length, 1);
		(host.querySelector("[data-peer-node-id='n_eig']") as HTMLElement).click();
		assert.equal(intents.some((i) => i.type === "toggle-pick-node" && i.nodeId === "n_eig"), true);

		view.destroy();
		assert.equal(host.childElementCount, 0);
		assert.equal(tracker.activeCount(), 0);
	} finally {
		tracker?.restore();
		await dom.cleanup();
	}
});

function verifyStartupMessageOverlay(host: HTMLElement, createStartupMessageDialog: AnyFn): void {
	const dismissed: string[] = [];
	const startup = createStartupMessageDialog(host, { onDismiss: (id: string) => { dismissed.push(id); } });
	startup.update({
		id: "msg_070", title: "LearnHarness v0.7.0", publishedAt: "2026-11-22",
		bodyMarkdown: "Read [Release](https://learnharness.dev/v070), [Insecure](http://bad.test), [Rel](/local), and [Cred](https://u:p@bad.test).",
	});
	const dialogEl = host.querySelector("[data-testid='startup-message-dialog']") as HTMLElement;
	assert.notEqual(dialogEl, null);
	const anchors = [...dialogEl.querySelectorAll("a")];
	assert.equal(anchors.length, 1);
	assert.equal(anchors[0]?.getAttribute("href"), "https://learnharness.dev/v070");
	(dialogEl.querySelector("[data-testid='startup-message-close']") as HTMLButtonElement).click();
	assert.deepEqual(dismissed, ["msg_070"]);
	startup.update(null);
	assert.equal(host.querySelector("[data-testid='startup-message-dialog']"), null);
	startup.destroy();
}

test("overlays: createCheatSheet, createPanZoomViewer, and createStartupMessageDialog enforce contracts and security", async () => {
	const dom = installDom();
	let tracker: ReturnType<typeof trackWindowListeners> | null = null;
	try {
		const { createCheatSheet } = await loadMod<{ createCheatSheet: AnyFn }>("../src/client/views/overlays/cheat-sheet.js");
		const { createPanZoomViewer } = await loadMod<{ createPanZoomViewer: AnyFn }>("../src/client/views/overlays/pan-zoom-viewer.js");
		const { createStartupMessageDialog } = await loadMod<{ createStartupMessageDialog: AnyFn }>("../src/client/views/overlays/startup-message.js");
		tracker = trackWindowListeners(dom.window);
		const host = dom.document.createElement("div");
		dom.document.body.append(host);

		let cheatClosed = 0;
		const cheat = createCheatSheet(host, { onClose: () => { cheatClosed += 1; } });
		assert.notEqual(host.querySelector("[data-testid='cheat-sheet'][data-peer-layer='cheat-sheet']"), null);
		(host.querySelector("[data-testid='cheat-sheet-close']") as HTMLButtonElement).click();
		assert.equal(cheatClosed, 1);
		cheat.destroy();

		let viewerClosed = 0;
		const viewer = createPanZoomViewer(host, { onClose: () => { viewerClosed += 1; } });
		viewer.update({ kind: "svg", title: "Safe Plan", svg: '<svg viewBox="0 0 100 50" onload="evil()"><script>alert(1)</script><rect width="10" height="10"/></svg>' });
		const viewerEl = host.querySelector("[data-testid='pan-zoom-viewer'][data-peer-layer='viewer']");
		assert.equal(viewerEl?.querySelector("script"), null);
		assert.equal(viewerEl?.querySelector("svg")?.hasAttribute("onload"), false);
		(host.querySelector("[data-testid='viewer-zoom-fit']") as HTMLButtonElement).click();
		(host.querySelector("[data-testid='viewer-close']") as HTMLButtonElement).click();
		assert.equal(viewerClosed, 1);
		viewer.destroy();

		verifyStartupMessageOverlay(host, createStartupMessageDialog);
		assert.equal(tracker.activeCount(), 0);
	} finally {
		tracker?.restore();
		await dom.cleanup();
	}
});
