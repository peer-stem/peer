import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import type { Page } from "puppeteer-core";
import { newUserMessage, type LhMessage } from "../src/core/native-messages.ts";
import type { LumberJackStoreBundle } from "../src/store/lumberjack/index.ts";
import {
	startClientE2eHarness,
	type ClientE2eBadResponse,
	type ClientE2eConsoleError,
} from "./helpers/client-e2e.ts";

const E2E_C2C_CHAT_ID = "chat_c2c_plugins_voice_e2e";
const SKIP_REASON = process.env.PEER_E2E === "1" ? false : "Set PEER_E2E=1 to run headless Chrome E2E";
const DISABLED_PROBE_PATHS = ["/api/claude-code", "/api/external-cli", "/api/subscriptions"];

function isExpectedProbeOrIntentional503(res: ClientE2eBadResponse): boolean {
	if (res.url.includes("/api/stt/token") && res.status === 503) return true;
	if (res.method !== "GET" || res.status >= 500) return false;
	return DISABLED_PROBE_PATHS.some((segment) => res.url.includes(segment));
}

function isExpectedConsoleEntry(entry: ClientE2eConsoleError): boolean {
	if (!entry.url) return false;
	if (!entry.text.includes("Failed to load resource")) return false;
	if (entry.url.includes("/api/stt/token")) return true;
	return DISABLED_PROBE_PATHS.some((segment) => entry.url?.includes(segment));
}

function startMockSpeechEndpoint(): Promise<{ url: string; close: () => Promise<void> }> {
	return new Promise((resolve) => {
		const srv = http.createServer((req, res) => {
			if (req.url?.endsWith("/audio/voices")) {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify({ voices: ["af_heart", "bf_emma"] }));
				return;
			}
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ text: "ok" }));
		});
		srv.listen(0, "127.0.0.1", () => {
			const addr = srv.address() as { port: number };
			resolve({
				url: `http://127.0.0.1:${addr.port}/v1`,
				close: () => new Promise<void>((done) => srv.close(() => done())),
			});
		});
	});
}

function seedC2cForest(bundle: LumberJackStoreBundle, rootDir: string, speechEndpoint: string): void {
	const createdAt = "2026-11-22T12:00:00.000Z";
	fs.writeFileSync(
		path.join(rootDir, "auth.json"),
		`${JSON.stringify({ ANTHROPIC_API_KEY: "sk-ant-offline-e2e-fixture" })}\n`,
		{ mode: 0o600 },
	);
	const slot = { model: { provider: "anthropic", id: "claude-sonnet-4-20250514" } };
	bundle.settingsStore.writeSettings({
		version: 1,
		models: { strong: slot, cheap: slot, vision: slot },
		appearance: { theme: "default" },
		speech: {
			dictation: "deepgram",
			speak: "button",
			endpoint: speechEndpoint,
			sttModel: "Systran/faster-whisper-small",
			ttsVoice: "af_heart",
		},
	});
	const user = newUserMessage("Show me a TypeScript example and read the summary.");
	const assistant = {
		id: "msg_c2c_assist_1",
		role: "assistant",
		content: [
			{
				type: "text",
				text: "Here is a concise TypeScript function:\n\n```ts\nexport const double = (n: number): number => n * 2;\n```\n\nEvery pure function maps equal inputs to equal outputs.",
			},
		],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-20250514",
		usage: { input: 40, output: 35, cacheRead: 0, cacheWrite: 0, totalTokens: 75, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "endTurn",
		timestamp: 1_700_000_500_000,
	} as unknown as LhMessage;

	bundle.chatStore.importChatRecord({
		id: E2E_C2C_CHAT_ID,
		title: "Pure Functions & Extensions",
		createdAt,
		updatedAt: "2026-11-22T12:05:00.000Z",
		messages: [],
	});
	bundle.chatStore.saveMessages(E2E_C2C_CHAT_ID, [user, assistant]);
}

async function verifySettingsPluginsAndVoice(page: Page, baseUrl: string): Promise<void> {
	await page.waitForSelector('[data-testid="settings-entry"]', { timeout: 15_000 });
	await page.click('[data-testid="settings-entry"]');
	await page.waitForSelector('[data-testid="settings-dialog"]', { timeout: 10_000 });

	// 1. Core extensions tab lists all 4 built core plugins and activates flashcards + rich-code-blocks
	await page.click('[data-testid="settings-tab-core-plugins"]');
	await page.waitForFunction(
		() => {
			const ids = ["flashcards", "coding-questions", "drawing-pad", "rich-code-blocks"];
			return ids.every((id) => document.querySelector(`[data-testid="plugin-${id}"]`));
		},
		{ timeout: 15_000 },
	);
	await page.click('[data-testid="plugin-toggle-flashcards"] [role="switch"]');
	await page.waitForSelector('[data-testid="plugin-flashcards"][data-plugin-phase="active"]', { timeout: 15_000 });
	await page.waitForSelector('[data-testid="plugin-open-view-flashcards-library"]', { timeout: 10_000 });

	await page.click('[data-testid="plugin-toggle-rich-code-blocks"] [role="switch"]');
	await page.waitForSelector('[data-testid="plugin-rich-code-blocks"][data-plugin-phase="active"]', { timeout: 15_000 });

	// 2. Local plugins tab exposes authoring skill zip download (HTTP 200)
	await page.click('[data-testid="settings-tab-plugins"]');
	await page.waitForSelector('[data-testid="download-plugin-authoring"]', { timeout: 10_000 });
	const zipRes = await fetch(`${baseUrl}/plugin-authoring/learnharness-plugins.zip`);
	assert.equal(zipRes.status, 200);

	// 3. Keys tab renders Speech settings with discovered voices
	await page.click('[data-testid="settings-tab-keys"]');
	await page.waitForSelector('[data-testid="speech-settings"]', { timeout: 10_000 });
	const speakModeVal = await page.$eval('[data-testid="speech-speak-mode"]', (el) => (el as HTMLSelectElement).value);
	assert.equal(speakModeVal, "button");

	await page.click('[data-testid="settings-close"]');
	await page.waitForFunction(() => !document.querySelector('[data-testid="settings-dialog"]'), { timeout: 10_000 });
}

test("C2c headless Chrome E2E: core plugins activate, /plugins/flashcards/library mounts, and session voice controls work cleanly", { skip: SKIP_REASON }, async () => {
	const mockSpeech = await startMockSpeechEndpoint();
	const harness = await startClientE2eHarness({
		seed: (bundle, rootDir) => seedC2cForest(bundle, rootDir, mockSpeech.url),
	});
	try {
		const { page, baseUrl } = harness;
		await page.goto(`${baseUrl}/chat/${E2E_C2C_CHAT_ID}`, { waitUntil: "networkidle2" });
		await page.waitForSelector('[data-peer-screen="session"]', { timeout: 15_000 });

		// Verify settings: Core extensions + Local plugins + Speech settings
		await verifySettingsPluginsAndVoice(page, baseUrl);

		// Verify SpeakButton is visible on assistant message & Dictation keyless 503 prompt works
		await page.waitForFunction(
			() => {
				const sb = document.querySelector('[data-testid="speak-button"]') as HTMLElement | null;
				return Boolean(sb && !sb.hidden);
			},
			{ timeout: 10_000 },
		);
		await page.waitForSelector('[data-peer-composer] [data-testid="dictation-toggle"]', { timeout: 10_000 });
		await page.click('[data-peer-composer] [data-testid="dictation-toggle"]');
		await page.waitForFunction(
			() => (document.querySelector('[data-peer-composer] [data-testid="dictation-error"]')?.textContent ?? "").includes("Deepgram key"),
			{ timeout: 10_000 },
		);

		// Navigate to full-page plugin view (/plugins/flashcards/library) and verify mount
		await page.goto(`${baseUrl}/plugins/flashcards/library`, { waitUntil: "networkidle2" });
		await page.waitForSelector('[data-testid="plugin-view"]', { timeout: 15_000 });
		await page.waitForFunction(
			() => {
				const scroll = document.querySelector("[data-plugin-view-scroll]");
				return Boolean(scroll && (scroll.textContent ?? "").trim().length > 0);
			},
			{ timeout: 15_000 },
		);

		assert.deepEqual(harness.pageErrors, [], "Expected zero uncaught page errors");
		assert.deepEqual(harness.offOriginRequests, [], "Expected zero off-origin requests");
		assert.deepEqual(
			harness.badResponses.filter((r) => !isExpectedProbeOrIntentional503(r)),
			[],
			"Expected zero unexpected HTTP error responses",
		);
		assert.deepEqual(
			harness.consoleErrors.filter((c) => !isExpectedConsoleEntry(c)),
			[],
			"Expected zero unexpected console errors",
		);
	} finally {
		await harness.stop();
		await mockSpeech.close();
	}
});
