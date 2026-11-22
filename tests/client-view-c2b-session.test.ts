import assert from "node:assert/strict";
import test from "node:test";
import "./helpers/client-env.ts";
import { installDom } from "./helpers/client-dom.ts";
import { providerKeyMissing, serializeCitation } from "../src/core/index.ts";

type AnyFn = (...args: any[]) => any;

function loadMod<T>(relPath: string): Promise<T> {
	return import(new URL(relPath, import.meta.url).href) as Promise<T>;
}

test("artifacts: demo-card sandbox bridge, height clamp, invert toggle, and visual-card SVG data URL", async () => {
	const dom = installDom();
	try {
		const { createDemoOutputHandle } = await loadMod<{ createDemoOutputHandle: AnyFn }>("../src/client/views/artifacts/demo-card.js");
		const { createVisualOutputHandle } = await loadMod<{ createVisualOutputHandle: AnyFn }>("../src/client/views/artifacts/visual-card.js");
		const host = dom.document.createElement("div");
		dom.document.body.append(host);

		const inverts: Array<[string, boolean]> = [];
		const sent: string[] = [];
		const expanded: unknown[] = [];
		const ctx = {
			getMode: () => "dark" as const,
			getImageSnapshot: () => null,
			onInvertArtifact: (id: string, inv: boolean) => inverts.push([id, inv]),
			onSendText: (t: string) => sent.push(t),
			onExpand: (p: unknown) => expanded.push(p),
		};

		const demo = createDemoOutputHandle(dom.document, {
			id: "d1",
			messageId: "msg_demo_1",
			inverted: false,
			result: {
				title: "Pendulum Explorer",
				html: "<!doctype html><html><body><canvas id='c'></canvas></body></html>",
				tested: true,
			},
		}, ctx);
		host.append(demo.node);

		const iframe = host.querySelector("[data-testid='demo-iframe']") as HTMLIFrameElement;
		assert.notEqual(iframe, null);
		assert.equal(iframe.getAttribute("sandbox"), "allow-scripts");
		assert.equal(iframe.srcdoc.includes("demo-resize"), true);
		assert.equal(iframe.srcdoc.includes("demo-error"), true);

		const invertBtn = host.querySelector("button[aria-label*='Invert']") as HTMLButtonElement;
		invertBtn.click();
		assert.deepEqual(inverts, [["msg_demo_1", true]]);
		demo.destroy();

		const visual = createVisualOutputHandle(dom.document, {
			id: "v1",
			messageId: "msg_vis_1",
			inverted: false,
			result: {
				svg: "<svg width=\"200\" height=\"100\" viewBox=\"0 0 200 100\"><circle cx=\"50\" cy=\"50\" r=\"30\"/></svg>",
				notes: "Unit circle",
			},
		}, ctx);
		host.append(visual.node);
		const svgImg = host.querySelector("[data-testid='visual-svg'] img") as HTMLImageElement;
		assert.notEqual(svgImg, null);
		assert.equal(svgImg.src.startsWith("data:image/svg+xml"), true);
		svgImg.click();
		assert.equal(expanded.length, 1);
		visual.destroy();
		assert.equal(sent.length, 0);
	} finally {
		await dom.cleanup();
	}
});

test("artifacts: dispatch-card variants, steer-card branches, probe-done-card, and tool-cards", async () => {
	const dom = installDom();
	try {
		const { createDispatchCardHandle } = await loadMod<{ createDispatchCardHandle: AnyFn }>("../src/client/views/artifacts/dispatch-card.js");
		const { createSteerCardHandle } = await loadMod<{ createSteerCardHandle: AnyFn }>("../src/client/views/artifacts/steer-card.js");
		const { createProbeDoneHandle } = await loadMod<{ createProbeDoneHandle: AnyFn }>("../src/client/views/artifacts/probe-done-card.js");
		const { createLiveToolHandle, createToolCallHandle } = await loadMod<{
			createLiveToolHandle: AnyFn;
			createToolCallHandle: AnyFn;
		}>("../src/client/views/artifacts/tool-cards.js");

		const host = dom.document.createElement("div");
		dom.document.body.append(host);
		let setupOpened = 0;
		let jobs: Array<Record<string, unknown>> = [
			{ id: "j1", kind: "research", toolCallId: "tc_disp", status: "running", activity: "reading papers", createdAt: new Date().toISOString() },
		];
		const ctx = {
			getJobs: () => jobs,
			getMode: () => "dark",
			onOpenSetup: () => { setupOpened += 1; },
		};

		const disp = createDispatchCardHandle(dom.document, { id: "dp1", dispatchKind: "research", toolCallId: "tc_disp", partType: "tool-research" }, ctx);
		host.append(disp.node);
		assert.notEqual(host.querySelector("[data-testid='dispatch-card']"), null);
		assert.equal(host.querySelector("[data-testid='dispatch-activity-line']")?.textContent, "reading papers");

		jobs = [{ id: "j1", kind: "research", toolCallId: "tc_disp", status: "error", error: providerKeyMissing("openai", ["cheap"]).error }];
		disp.update({ id: "dp1", dispatchKind: "research", toolCallId: "tc_disp", partType: "tool-research" }, ctx);
		assert.notEqual(host.querySelector("[data-testid='dispatch-refused']"), null);
		(host.querySelector("[data-testid='dispatch-setup-link']") as HTMLButtonElement).click();
		assert.equal(setupOpened, 1);

		jobs = [{ id: "j1", kind: "research", toolCallId: "tc_disp", status: "done" }];
		disp.update({ id: "dp1", dispatchKind: "research", toolCallId: "tc_disp", partType: "tool-research" }, ctx);
		assert.notEqual(host.querySelector("[data-testid='dispatch-settled']"), null);
		disp.destroy();

		const steerAbort = createSteerCardHandle(dom.document, {
			id: "st1", partType: "data-subagent-aborted", subagentType: "aborted", subKind: "demo",
		}, ctx);
		host.append(steerAbort.node);
		assert.notEqual(host.querySelector("[data-testid='job-aborted-badge']"), null);
		steerAbort.update({
			id: "st1", partType: "data-subagent-aborted", subagentType: "aborted", subKind: "demo", failure: "Worker crashed",
		}, ctx);
		assert.notEqual(host.querySelector("[data-testid='job-delivery-failure']"), null);
		steerAbort.destroy();

		const probe = createProbeDoneHandle(dom.document, {
			id: "pr1",
			state: "output-available",
			input: { assessment: { strands: [{ strand: "Compactness", assessment: "Solid grasp of open covers." }], summary: "Ready for Heine-Borel." } },
			output: { ok: true },
		}, ctx);
		host.append(probe.node);
		assert.notEqual(host.querySelector("details[data-testid='probe-done-card']"), null);
		assert.equal(host.textContent?.includes("1 strand"), true);
		probe.destroy();

		const live = createLiveToolHandle(dom.document, { id: "lt1", toolName: "read", partType: "tool-read", input: { path: "notes/top.md" } });
		host.append(live.node);
		assert.equal(host.querySelector("[data-testid='live-tool-card']")?.getAttribute("data-tool"), "read");
		live.destroy();

		const call = createToolCallHandle(dom.document, {
			id: "tc1", toolName: "grep", partType: "tool-grep", state: "output-available", input: { pattern: "Bolzano" }, output: "3 matches",
		});
		host.append(call.node);
		assert.equal(host.querySelector("[data-testid='tool-call-card']")?.textContent?.includes("Bolzano"), true);
		call.destroy();
	} finally {
		await dom.cleanup();
	}
});

test("session-view C2b: coverage ring, Mod+F find, Mod+J side thread, user citation strip, and Escape priority", async () => {
	const dom = installDom();
	try {
		const { createSessionView } = await loadMod<{ createSessionView: AnyFn }>("../src/client/views/session/session-view.js");
		const host = dom.document.createElement("div");
		dom.document.body.append(host);

		const intents: Array<Record<string, unknown>> = [];
		const view = createSessionView(host, {
			send: (intent: Record<string, unknown>) => intents.push(intent),
			navigate: () => {},
		});

		const citationLink = serializeCitation({
			version: 1,
			chatId: "chat_c2b",
			messageId: "msg_a1",
			text: "compact space",
			start: 29,
			end: 42,
			prefix: "image of a ",
			suffix: " is compact",
			comment: "Why continuous?",
		});

		view.update({
			load: "ready",
			chatId: "chat_c2b",
			title: "Topology Session",
			kind: "teach",
			mode: "dark",
			configured: true,
			status: "ready",
			graphEnabled: true,
			extractionChunkTokens: 4096,
			coverage: {
				totalMessages: 6,
				coveredCount: 4,
				uncoveredCount: 2,
				coveredTokens: 1200,
				uncoveredTokens: 1024,
				running: false,
				lastFoldedAt: null,
			},
			jobs: [{ id: "j_live", kind: "demo", toolCallId: "tc_demo", status: "running", activity: "bundling demo", createdAt: new Date().toISOString() }],
			messages: [
				{
					id: "msg_a1",
					role: "assistant",
					parts: [
						{ type: "text", text: "Every continuous image of a compact space is compact." },
						{ type: "tool-demo", toolCallId: "tc_demo", state: "output-available", output: { jobId: "j_live" } },
					],
				},
				{
					id: "msg_u2",
					role: "user",
					parts: [{ type: "text", text: `${citationLink} Can you prove this with open covers?` }],
				},
			],
		});

		assert.notEqual(host.querySelector("[data-source-message-id='msg_a1']"), null);
		assert.notEqual(host.querySelector("[data-session-find-root]"), null);
		assert.notEqual(host.querySelector("[data-testid='coverage-ring']"), null);
		assert.notEqual(host.querySelector("[data-testid='dispatch-card']"), null);
		assert.notEqual(host.querySelector("[data-testid='citation-chip']"), null);
		assert.equal(host.textContent?.includes("Why continuous?"), true);
		assert.notEqual(host.querySelector("[data-testid='side-conversation-button']"), null);

		const ringBtn = host.querySelector("[data-testid='coverage-ring']") as HTMLButtonElement;
		ringBtn.click();
		(host.querySelector("[data-testid='coverage-extract']") as HTMLButtonElement).click();
		assert.equal(intents.some((i) => i.type === "request-extract"), true);

		assert.equal(view.command("find"), true);
		const findBar = host.querySelector("[data-testid='session-find']") as HTMLElement;
		assert.equal(findBar.hidden, false);
		const findInput = findBar.querySelector("input") as HTMLInputElement;
		findInput.value = "compact";
		findInput.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
		assert.equal(host.querySelector("[data-testid='session-find-count']")?.textContent, "1/2");

		assert.equal(view.command("escape-session"), true);
		assert.equal(findBar.hidden, true);

		assert.equal(view.command("toggle-question-thread"), true);
		assert.notEqual(host.querySelector("[data-testid='side-thread-popover']"), null);
		assert.equal(view.command("escape-session"), true);
		assert.equal(host.querySelector("[data-testid='side-thread-popover']"), null);

		view.destroy();
		assert.equal(host.childElementCount, 0);
	} finally {
		await dom.cleanup();
	}
});
