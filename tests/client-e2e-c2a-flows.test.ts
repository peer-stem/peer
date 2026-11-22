import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import type { Page } from "puppeteer-core";
import { newUserMessage, type LhMessage } from "../src/core/native-messages.ts";
import type { LumberJackStoreBundle } from "../src/store/lumberjack/index.ts";
import { sanitizeComputeEnv } from "../src/substrate/hardware-guard.ts";
import {
	startClientE2eHarness,
	type ClientE2eBadResponse,
	type ClientE2eConsoleError,
} from "./helpers/client-e2e.ts";

const E2E_QUIZ_CHAT_ID = "chat_c2a_quiz_e2e";
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

function buildPendingQuizMessages(): LhMessage[] {
	const user = newUserMessage("Quiz me on compactness and the Extreme Value Theorem.");
	const quizArgs = {
		type: "predict",
		question: "Does a continuous real function on a compact space attain its maximum?",
		options: [
			{ label: "Yes, always", value: "yes" },
			{ label: "No, counterexamples exist", value: "no" },
		],
		explanation: "The continuous image of a compact space in R is compact, hence closed and bounded.",
		correctAnswer: "yes",
	};
	const assistant = {
		id: "msg_c2a_quiz_pose",
		role: "assistant",
		content: [{ type: "toolCall", id: "call_c2a_quiz_1", name: "quiz", arguments: quizArgs }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-20250514",
		usage: { input: 80, output: 60, cacheRead: 0, cacheWrite: 0, totalTokens: 140, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "toolUse",
		timestamp: 1_700_000_100_000,
	} as unknown as LhMessage;
	return [user, assistant];
}

function writeScratchImportSource(rootDir: string): string {
	const importDir = path.join(rootDir, "lh-import-src");
	fs.mkdirSync(path.join(importDir, "graph"), { recursive: true, mode: 0o700 });
	fs.mkdirSync(path.join(importDir, "chats"), { recursive: true, mode: 0o700 });
	const importedNode = {
		id: "n_c2a_heine",
		name: "Heine-Borel",
		statement: "Closed and bounded subsets of R^n are compact.",
		aliases: [],
		createdAt: "2026-11-19T11:00:00.000Z",
		provenance: [],
	};
	fs.writeFileSync(path.join(importDir, "graph", "nodes.jsonl"), `${JSON.stringify(importedNode)}\n`);
	fs.writeFileSync(path.join(importDir, "settings.json"), JSON.stringify({ version: 1, graph: { enabled: true } }));
	return importDir;
}

function seedC2aForest(bundle: LumberJackStoreBundle, rootDir: string): string {
	const cleanEnv = sanitizeComputeEnv(process.env, "cpu");
	assert.equal(cleanEnv.OLLAMA_LLM_LIBRARY, "cpu");
	bundle.settingsStore.writeSettings({ version: 1, appearance: { theme: "default" }, graph: { enabled: true } });

	const createdAt = "2026-11-19T10:00:00.000Z";
	const props = [
		{ id: "n_c2a_p1", name: "Compactness", statement: "Every open cover admits a finite subcover.", aliases: [], createdAt, provenance: [{ chatId: E2E_QUIZ_CHAT_ID, messageId: "msg_c2a_quiz_pose" }] },
		{ id: "n_c2a_p2", name: "Continuity", statement: "Preimages of open sets are open.", aliases: [], createdAt, provenance: [{ chatId: E2E_QUIZ_CHAT_ID, messageId: "msg_c2a_quiz_pose" }] },
		{ id: "n_c2a_p3", name: "Extreme Value Theorem", statement: "Continuous real function on compact space attains bounds.", aliases: ["EVT"], createdAt, provenance: [{ chatId: E2E_QUIZ_CHAT_ID, messageId: "msg_c2a_quiz_pose" }] },
	];
	for (const p of props) bundle.graphStore.appendNode(p);
	bundle.graphStore.appendChain({
		id: "arg_c2a_evt",
		premises: ["n_c2a_p1", "n_c2a_p2"],
		conclusion: "n_c2a_p3",
		provenance: [{ chatId: E2E_QUIZ_CHAT_ID, messageId: "msg_c2a_quiz_pose" }],
		createdAt,
	});
	bundle.graphStore.writePositions({
		n_c2a_p1: { x: -120, y: -100 },
		n_c2a_p2: { x: 120, y: 100 },
		n_c2a_p3: { x: 0, y: 0 },
		arg_c2a_evt: { x: 0, y: -50 },
	});
	const fsrs = { due: 1_765_000_000_000, stability: 7.5, difficulty: 2.8, elapsed_days: 3, scheduled_days: 8, reps: 5, lapses: 0, state: 2, last_review: 1_764_700_000_000 };
	for (const p of props) bundle.learnerStore.updatePropositionProgress(p.id, { mastery: 0.88, fsrs });

	bundle.sourceOrganizationStore.write({
		version: 1,
		folders: [{ id: "fld_topology", name: "Topology", parentId: null, createdAt }],
		placements: { [E2E_QUIZ_CHAT_ID]: { folderId: "fld_topology" } },
	});

	bundle.chatStore.importChatRecord({ id: E2E_QUIZ_CHAT_ID, title: "Compactness Quiz", createdAt, updatedAt: createdAt, messages: [] });
	bundle.chatStore.saveMessages(E2E_QUIZ_CHAT_ID, buildPendingQuizMessages());
	return writeScratchImportSource(rootDir);
}

async function verifyHomeGraphAndChains(page: Page, baseUrl: string): Promise<void> {
	const res = await page.goto(`${baseUrl}/`, { waitUntil: "domcontentloaded" });
	assert.equal(res?.status(), 200);
	await page.waitForFunction(() => {
		if (document.documentElement.hasAttribute("data-theme-pending")) return false;
		const canvas = document.querySelector("[data-testid='graph-view'] canvas, [data-peer-screen='home'] canvas") as HTMLCanvasElement | null;
		return Boolean(canvas && canvas.width > 0 && canvas.height > 0);
	});

	const center = await page.evaluate(() => {
		const canvas = document.querySelector("[data-testid='graph-view'] canvas, [data-peer-screen='home'] canvas") as HTMLCanvasElement;
		const rect = canvas.getBoundingClientRect();
		return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
	});
	await page.mouse.click(center.x, center.y);
	await page.waitForSelector("[data-testid='node-card']");

	const cardSummary = await page.evaluate(() => {
		const card = document.querySelector("[data-testid='node-card']");
		return {
			hasEvt: (card?.textContent ?? "").includes("Extreme Value Theorem") || (card?.textContent ?? "").includes("attains bounds"),
			hasMastery: Boolean(card?.querySelector("[data-peer-mastery]")),
			hasFsrs: Boolean(card?.querySelector("[data-peer-fsrs]")),
		};
	});
	assert.equal(cardSummary.hasEvt, true);
	assert.equal(cardSummary.hasMastery, true);
	assert.equal(cardSummary.hasFsrs, true);

	const hasFolderFilter = await page.$("[data-testid='graph-folder-filter']");
	assert.notEqual(hasFolderFilter, null);

	await page.evaluate(() => {
		const home = document.querySelector("[data-peer-screen='home']")!;
		const tab = home.querySelector("[data-peer-tab='chains'], [data-peer-view-tab='chains']") as HTMLElement | null;
		if (tab) { tab.click(); return; }
		const btn = [...home.querySelectorAll("button")].find((b) => /chains/i.test(b.textContent ?? ""));
		btn?.click();
	});
	await page.waitForSelector("[data-testid='chains-table']");
	const chainsText = await page.$eval("[data-testid='chains-table']", (el) => el.textContent ?? "");
	assert.equal(chainsText.includes("Compactness"), true);
	assert.equal(chainsText.includes("Extreme Value Theorem"), true);
}

function triggerSettingsAppearanceSaveInDom(): boolean {
	const dialog = document.querySelector("[data-testid='settings-dialog']");
	if (!dialog) return false;
	const appTab = dialog.querySelector("[data-peer-settings-tab='appearance'], [data-peer-tab='appearance']") as HTMLElement | null
		?? [...dialog.querySelectorAll("button, [role='tab']")].find((b) => /appearance/i.test(b.textContent ?? "")) as HTMLElement | undefined;
	appTab?.click();
	const panel = dialog.querySelector("[data-peer-settings-section='appearance']") ?? dialog;
	const themeBtn = panel.querySelector("[data-peer-theme-id='catppuccin-latte']") as HTMLElement | null
		?? [...panel.querySelectorAll("button")].find((b) => /catppuccin latte|gruvbox|ivory/i.test(b.textContent ?? "")) as HTMLElement | undefined;
	if (themeBtn) themeBtn.click();
	else {
		const sel = panel.querySelector("select") as HTMLSelectElement | null;
		const alt = sel ? [...sel.options].find((o) => o.value && o.value !== sel.value) : undefined;
		if (sel && alt) {
			sel.value = alt.value;
			sel.dispatchEvent(new Event("input", { bubbles: true }));
			sel.dispatchEvent(new Event("change", { bubbles: true }));
		}
	}
	const saveBtn = [...panel.querySelectorAll("button")].find((b) => /^(save|apply)/i.test((b.textContent ?? "").trim()));
	saveBtn?.click();
	return true;
}

async function verifySettingsSaveAndImport(page: Page, importDir: string): Promise<void> {
	await page.keyboard.down("Control");
	await page.keyboard.press("Comma");
	await page.keyboard.up("Control");
	await page.waitForSelector("[data-testid='settings-dialog']");

	const putSettingsPromise = page.waitForResponse(
		(res) => res.url().includes("/api/settings/") && res.request().method() === "PUT",
	);
	const triggered = await page.evaluate(triggerSettingsAppearanceSaveInDom);
	assert.equal(triggered, true);
	const putRes = await putSettingsPromise;
	assert.equal(putRes.status(), 200);

	await page.evaluate((srcPath) => {
		const dialog = document.querySelector("[data-testid='settings-dialog']")!;
		const dataTab = dialog.querySelector("[data-peer-settings-tab='data'], [data-peer-tab='data']") as HTMLElement | null
			?? [...dialog.querySelectorAll("button, [role='tab']")].find((b) => /^data$/i.test((b.textContent ?? "").trim())) as HTMLElement | undefined;
		dataTab?.click();
		const input = dialog.querySelector("[data-peer-import-input]") as HTMLInputElement;
		input.value = srcPath;
		input.dispatchEvent(new Event("input", { bubbles: true }));
		input.dispatchEvent(new Event("change", { bubbles: true }));
	}, importDir);

	const graphRefreshAfterImport = page.waitForResponse(
		(res) => res.url().endsWith("/api/graph") && res.request().method() === "GET",
	);
	const importPromise = page.waitForResponse(
		(res) => res.url().endsWith("/api/settings/import-learnharness") && res.request().method() === "POST",
	);
	await page.click("[data-peer-action='import-learnharness']");
	const importRes = await importPromise;
	assert.equal(importRes.status(), 200);
	await graphRefreshAfterImport;

	await page.waitForFunction(() => {
		const rep = document.querySelector("[data-peer-import-report]") as HTMLElement | null;
		return Boolean(rep && !rep.hidden && (rep.textContent ?? "").includes("Nodes imported: 1"));
	});
	await page.keyboard.press("Escape");
	await page.waitForFunction(() => !document.querySelector("[data-testid='settings-dialog']"));
}

async function verifyPracticePickerAndQuestionDismiss(page: Page, baseUrl: string): Promise<void> {
	const newRes = await page.goto(`${baseUrl}/chat/new?mode=practice`, { waitUntil: "domcontentloaded" });
	assert.equal(newRes?.status(), 200);
	await page.waitForFunction(() => {
		const picker = document.querySelector("[data-peer-screen='new-session'] [data-peer-node-picker]");
		return Boolean(picker && (picker.textContent ?? "").includes("Compactness"));
	});
	const picked = await page.evaluate(() => {
		const picker = document.querySelector("[data-peer-node-picker]")!;
		const item = picker.querySelector("[data-peer-node-id], input[type='checkbox'], button, label") as HTMLElement | null;
		if (!item) return false;
		item.click();
		return true;
	});
	assert.equal(picked, true);

	const chatRes = await page.goto(`${baseUrl}/chat/${E2E_QUIZ_CHAT_ID}`, { waitUntil: "domcontentloaded" });
	assert.equal(chatRes?.status(), 200);
	await page.waitForFunction(() => {
		const dock = document.querySelector("[data-testid='question-dock']") as HTMLElement | null;
		return Boolean(dock && !dock.hidden && (dock.textContent ?? "").includes("attain its maximum"));
	});

	const dismissPromise = page.waitForResponse(
		(res) => res.url().endsWith(`/api/chats/${E2E_QUIZ_CHAT_ID}/dismiss`) && res.request().method() === "POST",
	);
	await page.click("[data-peer-action='dismiss-question']");
	const dismissRes = await dismissPromise;
	assert.equal(dismissRes.status(), 200);

	await page.waitForFunction(() => {
		const dock = document.querySelector("[data-testid='question-dock']") as HTMLElement | null;
		return !dock || dock.hidden;
	});
}

test("C2a headless Chrome E2E: peer-graph DAG mastery/FSRS + folder filter, Settings save + import, practice picker, and quiz dismiss", { skip: SKIP_REASON }, async () => {
	let importDir = "";
	const harness = await startClientE2eHarness({
		seed: (bundle, rootDir) => {
			importDir = seedC2aForest(bundle, rootDir);
		},
	});
	try {
		await verifyHomeGraphAndChains(harness.page, harness.baseUrl);
		await verifySettingsSaveAndImport(harness.page, importDir);
		await verifyPracticePickerAndQuestionDismiss(harness.page, harness.baseUrl);

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
