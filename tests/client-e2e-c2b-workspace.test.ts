import assert from "node:assert/strict";
import test from "node:test";
import type { Page } from "puppeteer-core";
import { buildSubagentSteer } from "../src/core/contracts/jobs.ts";
import { newUserMessage, type LhMessage } from "../src/core/native-messages.ts";
import type { LumberJackStoreBundle } from "../src/store/lumberjack/index.ts";
import {
	startClientE2eHarness,
	type ClientE2eBadResponse,
	type ClientE2eConsoleError,
} from "./helpers/client-e2e.ts";

const E2E_PRIMARY_CHAT_ID = "chat_c2b_primary_e2e";
const E2E_SECONDARY_CHAT_ID = "chat_c2b_secondary_e2e";
const SKIP_REASON = process.env.PEER_E2E === "1" ? false : "Set PEER_E2E=1 to run headless Chrome E2E";

const DISABLED_PROBE_PATHS = ["/api/claude-code", "/api/external-cli", "/api/subscriptions"];

function isExpectedDisabledProbe(res: ClientE2eBadResponse): boolean {
	if (res.method !== "GET" || res.status >= 500) return false;
	return DISABLED_PROBE_PATHS.some((segment) => res.url.includes(segment));
}

function isExpectedDisabledProbeConsole(entry: ClientE2eConsoleError): boolean {
	if (!entry.url) return false;
	if (!entry.text.includes("Failed to load resource")) return false;
	return DISABLED_PROBE_PATHS.some((segment) => entry.url?.includes(segment));
}

function buildC2bMessages(): LhMessage[] {
	const user = newUserMessage("Explain compactness with a demo and figure.");
	const assistant = {
		id: "msg_c2b_assist_1",
		role: "assistant",
		content: [
			{
				type: "text",
				text: "Every continuous image of a compact space is compact. Notice how compact intervals preserve extrema.",
			},
		],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-20250514",
		usage: { input: 60, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 110, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "endTurn",
		timestamp: 1_700_000_200_000,
	} as unknown as LhMessage;

	const demoSteer = buildSubagentSteer(
		{ id: "job_c2b_demo", kind: "demo", toolCallId: "call_c2b_demo" },
		{
			title: "Compact Interval Explorer",
			html: "<!doctype html><html><body style='margin:0'><div id='demo-box' style='height:180px;padding:12px'>Sine Explorer Ready</div></body></html>",
			tested: true,
			notes: "Verified interactive height.",
		},
	);
	const visualSteer = buildSubagentSteer(
		{ id: "job_c2b_visual", kind: "visual", toolCallId: "call_c2b_visual" },
		{
			svg: "<svg width=\"240\" height=\"120\" viewBox=\"0 0 240 120\"><rect width=\"240\" height=\"120\" fill=\"#224466\"/><text x=\"20\" y=\"60\" fill=\"#ffffff\">Compactness Figure</text></svg>",
			notes: "Verified SVG layout.",
		},
	);
	return [user, assistant, demoSteer, visualSteer];
}

function seedC2bForest(bundle: LumberJackStoreBundle): void {
	const createdAt = "2026-11-20T10:00:00.000Z";
	bundle.settingsStore.writeSettings({
		version: 1,
		appearance: { theme: "default" },
		graph: { enabled: true, extractionChunkTokens: 4096 },
	});
	bundle.sourceOrganizationStore.write({
		version: 1,
		folders: [{ id: "fld_analysis", name: "Analysis", parentId: null, createdAt }],
		placements: { [E2E_PRIMARY_CHAT_ID]: { folderId: "fld_analysis" } },
	});
	bundle.chatStore.importChatRecord({
		id: E2E_PRIMARY_CHAT_ID,
		title: "Topology Compactness Lesson",
		createdAt,
		updatedAt: "2026-11-20T10:05:00.000Z",
		messages: [],
	});
	bundle.chatStore.saveMessages(E2E_PRIMARY_CHAT_ID, buildC2bMessages());

	bundle.chatStore.importChatRecord({
		id: E2E_SECONDARY_CHAT_ID,
		title: "Scratch Session To Delete",
		createdAt,
		updatedAt: "2026-11-20T09:30:00.000Z",
		messages: [newUserMessage("Temporary scratch session")],
	});
}

async function verifyArtifactsAndCoverage(page: Page, baseUrl: string): Promise<void> {
	const res = await page.goto(`${baseUrl}/chat/${E2E_PRIMARY_CHAT_ID}`, { waitUntil: "domcontentloaded" });
	assert.equal(res?.status(), 200);
	await page.waitForSelector("[data-testid='demo-card']");
	await page.waitForSelector("[data-testid='visual-card']");
	await page.waitForSelector("[data-testid='coverage-ring']");

	const iframeSandbox = await page.$eval("[data-testid='demo-iframe']", (el) => el.getAttribute("sandbox"));
	assert.equal(iframeSandbox, "allow-scripts");

	await page.waitForFunction(() => {
		const iframe = document.querySelector("[data-testid='demo-iframe']") as HTMLIFrameElement | null;
		if (!iframe) return false;
		const h = Number.parseFloat(iframe.style.height || "0");
		return h >= 170 && h <= 240;
	});

	const invertPost = page.waitForResponse(
		(r) => r.url().endsWith(`/api/chats/${E2E_PRIMARY_CHAT_ID}/artifact-ui`) && r.request().method() === "POST",
	);
	await page.evaluate(() => {
		const card = document.querySelector("[data-testid='demo-card']")!;
		const btn = (card.querySelector("[data-testid='demo-invert'], button[aria-label*='Invert']") ?? card.querySelector("button")) as HTMLElement;
		btn.click();
	});
	const invertRes = await invertPost;
	assert.equal(invertRes.status(), 200);

	const visualImgSrc = await page.$eval("[data-testid='visual-svg'] img", (el) => el.getAttribute("src") ?? "");
	assert.equal(visualImgSrc.startsWith("data:image/svg+xml"), true);
}

async function verifyFindAndSideThread(page: Page): Promise<void> {
	await page.keyboard.down("Control");
	await page.keyboard.press("KeyF");
	await page.keyboard.up("Control");
	await page.waitForSelector("[data-testid='session-find']");
	await page.type("[data-testid='session-find'] input", "compact");
	await page.waitForFunction(() => {
		const out = document.querySelector("[data-testid='session-find-count']");
		return Boolean(out && /^1\/[2-9]/.test((out.textContent ?? "").trim()));
	});
	await page.keyboard.press("Escape");
	await page.waitForFunction(() => {
		const find = document.querySelector("[data-testid='session-find']") as HTMLElement | null;
		return !find || find.hidden;
	});

	await page.keyboard.down("Control");
	await page.keyboard.press("KeyJ");
	await page.keyboard.up("Control");
	await page.waitForSelector("[data-testid='side-thread-input']");
	await page.evaluate(() => {
		const pinBtn = document.querySelector("button[aria-label='Dock side conversation']") as HTMLElement | null;
		pinBtn?.click();
	});
	await page.waitForSelector("[data-testid='side-thread-panel']");
	await page.evaluate(() => {
		const closeBtn = document.querySelector("button[aria-label='Close side conversation']") as HTMLElement | null;
		closeBtn?.click();
	});
	await page.waitForFunction(() => {
		const panel = document.querySelector("[data-testid='side-thread-panel']") as HTMLElement | null;
		return !panel || panel.hidden;
	});
}

async function verifySidebarSearchAndDelete(page: Page): Promise<void> {
	await page.keyboard.down("Control");
	await page.keyboard.press("KeyK");
	await page.keyboard.up("Control");
	await page.waitForSelector("[data-testid='sidebar-search']");

	await page.waitForFunction(() => document.querySelectorAll("[data-testid='session-row']").length >= 2);
	await page.type("[data-testid='sidebar-search']", "Scratch Session");
	await page.waitForFunction(() => document.querySelectorAll("[data-testid='session-row']").length === 1);

	await page.evaluate(() => {
		const row = document.querySelector("[data-testid='session-row']") as HTMLElement;
		row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 80, clientY: 120 }));
	});
	await page.evaluate(() => {
		const delBtn = [...document.querySelectorAll("button, [role='menuitem']")].find((b) =>
			/^delete/i.test((b.textContent ?? "").trim()),
		) as HTMLElement | undefined;
		delBtn?.click();
	});
	await page.waitForSelector("[data-testid='delete-session-dialog']");
	const delResponse = page.waitForResponse(
		(r) => r.url().includes(`/api/chats/${E2E_SECONDARY_CHAT_ID}`) && r.request().method() === "DELETE",
	);
	await page.click("[data-testid='delete-confirm']");
	assert.equal((await delResponse).status(), 200);
	await page.waitForFunction(() => !document.querySelector("[data-testid='delete-session-dialog']"));
}

test("C2b headless Chrome E2E: demo sandbox bridge + artifact invert, SVG visual, coverage ring, Mod+F find, Mod+J side thread, and sidebar search/delete", { skip: SKIP_REASON }, async () => {
	const harness = await startClientE2eHarness({
		seed: (bundle) => seedC2bForest(bundle),
	});
	try {
		await verifyArtifactsAndCoverage(harness.page, harness.baseUrl);
		await verifyFindAndSideThread(harness.page);
		await verifySidebarSearchAndDelete(harness.page);

		assert.deepEqual(harness.pageErrors, []);
		assert.deepEqual(harness.offOriginRequests, []);
		assert.deepEqual(harness.failedRequests, []);
		assert.deepEqual(harness.badResponses.filter((r) => r.status >= 500), []);
		assert.deepEqual(harness.badResponses.filter((r) => !isExpectedDisabledProbe(r)), []);
		assert.deepEqual(harness.consoleErrors.filter((c) => !isExpectedDisabledProbeConsole(c)), []);
	} finally {
		await harness.stop();
	}
});
