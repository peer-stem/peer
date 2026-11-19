import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { crc32, deflateSync } from "node:zlib";
import type { Page } from "puppeteer-core";
import type { ImageSnapshot, ShowImageDetails } from "../src/core/contracts.ts";
import {
	newGraphContextMessage,
	newThinkingMessage,
	newUserMessage,
	type LhMarkerMessage,
	type LhMessage,
} from "../src/core/native-messages.ts";
import type { LumberJackStoreBundle } from "../src/store/lumberjack/index.ts";
import { startClientE2eHarness } from "./helpers/client-e2e.ts";

const E2E_CHAT_ID = "chat_c1_e2e_demo";
const SKIP_REASON = process.env.PEER_E2E === "1" ? false : "Set PEER_E2E=1 to run headless Chrome E2E";

const ASSISTANT_MARKDOWN = [
	"# Harmonic Oscillators",
	"",
	"Classical mechanics reveals **bold insight** and *italic nuance* when energy is conserved.",
	"",
	"| Quantity | Symbol |",
	"| --- | --- |",
	"| Energy | E |",
	"| Mass | m |",
	"",
	"> [!IMPORTANT]",
	"> Conservation laws constrain every valid trajectory.",
	"",
	"Inline relativistic rest energy $E = mc^2$ pairs with the definite integral:",
	"",
	"$$",
	"\\int_0^1 x^2\\,dx = \\frac{1}{3}",
	"$$",
	"",
	"```typescript",
	"export function energy(mass: number, c: number): number {",
	"\treturn mass * c * c;",
	"}",
	"```",
	"",
	"```mermaid",
	"flowchart LR",
	"\tStateA[Position x] --> StateB[Momentum p]",
	"```",
	"",
	"Remote image check: ![Blocked](https://evil.example/x.png)",
].join("\n");

function pngChunk(typeAscii: string, payload: Buffer): Buffer {
	const lengthBuf = Buffer.alloc(4);
	lengthBuf.writeUInt32BE(payload.length, 0);
	const typeBuf = Buffer.from(typeAscii, "ascii");
	const crcInput = Buffer.concat([typeBuf, payload]);
	const crcBuf = Buffer.alloc(4);
	crcBuf.writeUInt32BE(crc32(crcInput) >>> 0, 0);
	return Buffer.concat([lengthBuf, typeBuf, payload, crcBuf]);
}

function buildOneByOnePngSnapshot(): { snapshotId: string; snapshot: ImageSnapshot } {
	const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(1, 0);
	ihdr.writeUInt32BE(1, 4);
	ihdr[8] = 8;
	ihdr[9] = 2;
	const idat = deflateSync(Buffer.from([0x00, 0x22, 0xc5, 0x5e]));
	const pngBytes = Buffer.concat([
		signature,
		pngChunk("IHDR", ihdr),
		pngChunk("IDAT", idat),
		pngChunk("IEND", Buffer.alloc(0)),
	]);
	const snapshotId = createHash("sha256").update(pngBytes).digest("hex");
	return {
		snapshotId,
		snapshot: { mimeType: "image/png", data: pngBytes.toString("base64"), width: 1, height: 1 },
	};
}

function buildHiddenMfnMarker(): LhMarkerMessage {
	return {
		id: "mfn_ctx_c1_e2e_hidden",
		role: "custom",
		customType: "graph-context",
		content: "[MFN memory context] — recalled from associative memory for this turn:\n\n- [1001]: secret recalled cue",
		display: false,
		details: {
			source: "mfn",
			propositions: [],
			chains: [],
			recalledMemoryIds: ["1001"],
			lexicalMemoryIds: [],
			degraded: [],
		},
		timestamp: 1_700_000_002_000,
	};
}

function buildAssistantAndToolMessages(snapshotId: string): LhMessage[] {
	const showDetails: ShowImageDetails = {
		path: "/usr/lib/persist/peer/unit-circle.png",
		caption: "Unit circle snapshot",
		mimeType: "image/png",
		snapshotId,
		width: 1,
		height: 1,
	};
	return [
		{
			id: "msg_assistant_c1_e2e",
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "Step 1: Relate energy and momentum invariants." },
				{ type: "text", text: ASSISTANT_MARKDOWN },
				{
					type: "toolCall",
					id: "call_show_img_1",
					name: "show_image",
					arguments: { path: showDetails.path, caption: showDetails.caption ?? "" },
				},
			],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-20250514",
			usage: {
				input: 120,
				output: 240,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 360,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 1_700_000_004_000,
		},
		{
			id: "msg_tool_img_1",
			role: "toolResult",
			toolCallId: "call_show_img_1",
			toolName: "show_image",
			content: [{ type: "text", text: "Shown to the learner: /usr/lib/persist/peer/unit-circle.png (1x1)." }],
			details: showDetails as unknown as Record<string, never>,
			isError: false,
			timestamp: 1_700_000_005_000,
		},
	];
}

function seedReadonlyDemoForest(bundle: LumberJackStoreBundle): string {
	bundle.settingsStore.writeSettings({ version: 1, appearance: { theme: "default" } });
	const { snapshotId, snapshot } = buildOneByOnePngSnapshot();
	const createdAt = "2026-11-19T12:00:00.000Z";
	bundle.chatStore.importChatRecord({
		id: E2E_CHAT_ID,
		title: "Harmonic Oscillators Lesson",
		createdAt,
		updatedAt: createdAt,
		messages: [],
	});
	bundle.chatStore.saveImageSnapshot(E2E_CHAT_ID, snapshotId, snapshot);
	const initialGraphContext = newGraphContextMessage(
		[{ id: "n_c1_prop1", name: "Pythagorean identity", statement: "sin^2(theta) + cos^2(theta) = 1" }],
		["Pythagorean theorem -> Unit circle -> Pythagorean identity"],
	);
	const userPrompt = newUserMessage("Derive the invariant relation from this sketch.", [
		{ type: "image", mimeType: "image/png", data: snapshot.data },
	]);
	const learnerThinking = newThinkingMessage("call_seed_prob", "Checking energy dimensions kg * m^2 / s^2.");
	const messages: LhMessage[] = [
		initialGraphContext,
		buildHiddenMfnMarker(),
		userPrompt,
		learnerThinking,
		...buildAssistantAndToolMessages(snapshotId),
	];
	bundle.chatStore.saveMessages(E2E_CHAT_ID, messages);
	return snapshotId;
}

async function waitForTranscriptReady(page: Page): Promise<void> {
	await page.waitForFunction(() => {
		if (document.documentElement.hasAttribute("data-theme-pending")) return false;
		if (!document.querySelector(".peer-shell")) return false;
		const main = document.querySelector("main");
		if (!main) return false;
		const hasHeading = [...main.querySelectorAll("h1")].some((h) => h.textContent?.includes("Harmonic Oscillators"));
		const hasMath = main.querySelectorAll(".katex-display").length >= 1;
		const hasCodeTokens = main.querySelectorAll("pre code span").length > 0;
		const hasMermaidSvg = [...main.querySelectorAll("svg")].some((svg) => svg.textContent?.includes("Position x"));
		const cardImg = main.querySelector('figure[data-testid="image-card"] img') as HTMLImageElement | null;
		const hasLoadedCardImg = Boolean(cardImg && cardImg.src.startsWith("data:image/png;base64,") && cardImg.complete && cardImg.naturalWidth === 1);
		return hasHeading && hasMath && hasCodeTokens && hasMermaidSvg && hasLoadedCardImg;
	});
}

function readTranscriptSnapshot(page: Page) {
	return page.evaluate(() => {
		const main = document.querySelector("main")!;
		const bodyText = document.body.textContent ?? "";
		const mainText = main.textContent ?? "";
		const callout = main.querySelector('[data-testid="md-callout"]');
		const cardImg = main.querySelector('figure[data-testid="image-card"] img') as HTMLImageElement | null;
		const hasContextCard = Boolean(
			main.querySelector('[data-testid="graph-context-card"], [data-peer-part="graph-context"]') ||
				mainText.toLowerCase().includes("graph context") ||
				mainText.includes("1 proposition"),
		);
		const assistantMd = main.querySelector('[data-peer-role="assistant"] .peer-session-markdown') ?? main;
		return {
			topBarTitle: main.querySelector("h1")?.textContent?.trim() ?? "",
			heading: assistantMd.querySelector("h1")?.textContent?.trim() ?? "",
			strong: assistantMd.querySelector("strong")?.textContent?.trim() ?? "",
			em: assistantMd.querySelector("em")?.textContent?.trim() ?? "",
			katexCount: main.querySelectorAll(".katex").length,
			katexDisplayCount: main.querySelectorAll(".katex-display").length,
			katexErrorCount: main.querySelectorAll(".katex-error").length,
			codeHasFn: (main.querySelector("pre code")?.textContent ?? "").includes("export function energy"),
			codeSpanCount: main.querySelectorAll("pre code span").length,
			hasCallout: Boolean(callout),
			calloutText: callout?.textContent?.trim() ?? "",
			tableHeaders: main.querySelectorAll("table th").length,
			tableCells: main.querySelectorAll("table td").length,
			hasBlockedBadge: mainText.includes("[Image blocked: Blocked]"),
			evilImgCount: document.querySelectorAll('img[src*="evil.example"]').length,
			hasMermaidSvg: [...main.querySelectorAll("svg")].some((svg) => svg.textContent?.includes("Momentum p")),
			hasContextCard,
			cardImgDataPrefix: Boolean(cardImg?.src.startsWith("data:image/png;base64,")),
			cardImgNaturalWidth: cardImg?.naturalWidth ?? 0,
			hasHiddenMfnText: bodyText.includes("[MFN memory context]"),
			hasHiddenMfnCue: bodyText.includes("secret recalled cue"),
		};
	});
}

async function assertTranscriptDom(page: Page): Promise<void> {
	const dom = await readTranscriptSnapshot(page);
	assert.equal(dom.topBarTitle, "Harmonic Oscillators Lesson");
	assert.equal(dom.heading, "Harmonic Oscillators");
	assert.equal(dom.strong, "bold insight");
	assert.equal(dom.em, "italic nuance");
	assert.equal(dom.katexCount >= 2, true);
	assert.equal(dom.katexDisplayCount >= 1, true);
	assert.equal(dom.katexErrorCount, 0);
	assert.equal(dom.codeHasFn, true);
	assert.equal(dom.codeSpanCount > 0, true);
	assert.equal(dom.hasCallout, true);
	assert.equal(dom.calloutText.includes("Conservation laws constrain every valid trajectory."), true);
	assert.equal(dom.calloutText.includes("[!IMPORTANT]"), false);
	assert.equal(dom.tableHeaders, 2);
	assert.equal(dom.tableCells, 4);
	assert.equal(dom.hasBlockedBadge, true);
	assert.equal(dom.evilImgCount, 0);
	assert.equal(dom.hasMermaidSvg, true);
	assert.equal(dom.hasContextCard, true);
	assert.equal(dom.cardImgDataPrefix, true);
	assert.equal(dom.cardImgNaturalWidth, 1);
	assert.equal(dom.hasHiddenMfnText, false);
	assert.equal(dom.hasHiddenMfnCue, false);
}

async function pressModShortcut(page: Page, code: "KeyB" | "KeyT"): Promise<void> {
	await page.keyboard.down("Control");
	await page.keyboard.press(code);
	await page.keyboard.up("Control");
}

function readSidebarVisible(page: Page): Promise<boolean> {
	return page.evaluate(() => {
		const aside = document.querySelector("aside.peer-shell-side, aside") as HTMLElement | null;
		if (!aside) return false;
		const style = getComputedStyle(aside);
		const rect = aside.getBoundingClientRect();
		return !aside.hidden && style.display !== "none" && style.visibility !== "hidden" && rect.width > 0;
	});
}

function readDisclosureSignature(page: Page): Promise<string> {
	return page.evaluate(() => {
		const detailsStates = [...document.querySelectorAll("main details")].map((d) => `d:${String((d as HTMLDetailsElement).open)}`);
		const ariaStates = [...document.querySelectorAll("main button[aria-expanded]")].map(
			(b) => `b:${b.getAttribute("aria-expanded") ?? ""}`,
		);
		return [...detailsStates, ...ariaStates].join("|");
	});
}

async function assertSidebarShortcut(page: Page): Promise<void> {
	const initialSidebar = await readSidebarVisible(page);
	await pressModShortcut(page, "KeyB");
	await page.waitForFunction(
		(before) => {
			const aside = document.querySelector("aside.peer-shell-side, aside") as HTMLElement | null;
			const now = Boolean(aside && !aside.hidden && getComputedStyle(aside).display !== "none" && aside.getBoundingClientRect().width > 0);
			return now !== before;
		},
		{},
		initialSidebar,
	);
	const toggledSidebar = await readSidebarVisible(page);
	assert.notEqual(toggledSidebar, initialSidebar);
	await pressModShortcut(page, "KeyB");
	await page.waitForFunction(
		(expected) => {
			const aside = document.querySelector("aside.peer-shell-side, aside") as HTMLElement | null;
			const now = Boolean(aside && !aside.hidden && getComputedStyle(aside).display !== "none" && aside.getBoundingClientRect().width > 0);
			return now === expected;
		},
		{},
		initialSidebar,
	);
}

async function assertThinkingShortcut(page: Page): Promise<void> {
	const initialThinking = await readDisclosureSignature(page);
	assert.notEqual(initialThinking, "");
	await pressModShortcut(page, "KeyT");
	await page.waitForFunction(
		(before) => {
			const d = [...document.querySelectorAll("main details")].map((el) => `d:${String((el as HTMLDetailsElement).open)}`);
			const b = [...document.querySelectorAll("main button[aria-expanded]")].map((el) => `b:${el.getAttribute("aria-expanded") ?? ""}`);
			return [...d, ...b].join("|") !== before;
		},
		{},
		initialThinking,
	);
	const afterFirstModT = await readDisclosureSignature(page);
	assert.notEqual(afterFirstModT, initialThinking);
}

test("C1 read-only session renders Markdown/KaTeX/Shiki/Mermaid/objects in Chrome and skips MFN display:false markers", { skip: SKIP_REASON }, async () => {
	const harness = await startClientE2eHarness({
		seed: (bundle) => {
			seedReadonlyDemoForest(bundle);
		},
	});
	try {
		const response = await harness.page.goto(`${harness.baseUrl}/chat/${E2E_CHAT_ID}`, { waitUntil: "domcontentloaded" });
		assert.equal(response?.status(), 200);
		await waitForTranscriptReady(harness.page);
		await assertTranscriptDom(harness.page);
		await assertSidebarShortcut(harness.page);
		await assertThinkingShortcut(harness.page);
		assert.deepEqual(harness.pageErrors, []);
		assert.deepEqual(harness.consoleErrors, []);
		assert.deepEqual(harness.offOriginRequests, []);
		assert.deepEqual(harness.failedRequests, []);
		assert.deepEqual(harness.badResponses, []);
	} finally {
		await harness.stop();
	}
});
