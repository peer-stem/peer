/**
 * Tests for the settings STORE on the default LumberJack DAG substrate:
 * isolated HOME/data/auth before importing any store or config; never touches
 * the repo's data or shares a store directory with another process.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, afterEach, describe, it } from "node:test";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "peer-settings-store-"));
process.env.HOME = path.join(directory, "home");
process.env.LH_DATA_DIR = path.join(directory, "data");
process.env.LH_AUTH_FILE = path.join(directory, "auth.json");
fs.mkdirSync(process.env.HOME, { recursive: true });
fs.mkdirSync(process.env.LH_DATA_DIR, { recursive: true });
fs.writeFileSync(process.env.LH_AUTH_FILE, "{}");

const { ensureActiveLumberJackBundle, readSettings, resetActiveLumberJackForTests, writeSettings } = await import(
	"../src/server/stores.ts"
);
const { resolveSettings } = await import("../src/core/settings-resolution.ts");
const { parseCompactionSettingsBody, parseAppearanceSettingsBody } = await import("../src/server/settings-body.ts");

function writeRawSettingsSlot(raw: unknown): void {
	ensureActiveLumberJackBundle().forest.upsertNode({
		path: "config/settings",
		type: "leaf",
		kind: "config",
		slot: raw,
	});
}

function readRawSettingsSlot(): Record<string, unknown> {
	return (ensureActiveLumberJackBundle().forest.getNode("config/settings")?.slot ?? {}) as Record<string, unknown>;
}

after(async () => {
	await resetActiveLumberJackForTests();
	fs.rmSync(directory, { recursive: true, force: true });
});

afterEach(() => {
	ensureActiveLumberJackBundle().forest.deleteNode("config/settings");
});

describe("the settings store", () => {
	it("persists worker concurrency, drops invalid stored values, and resets to 8 when unset", () => {
		writeSettings({ version: 1, agent: { workerRequestConcurrency: 29, tools: { research: false } } });
		assert.deepEqual(readSettings()?.agent, { workerRequestConcurrency: 29, tools: { research: false } });
		assert.equal((readRawSettingsSlot().agent as Record<string, unknown>).workerRequestConcurrency, 29);
		writeRawSettingsSlot({ version: 1, agent: { workerRequestConcurrency: 1.5, tools: { research: false } } });
		assert.deepEqual(readSettings()?.agent, { tools: { research: false } });
		assert.equal(resolveSettings(readSettings()).agent.workerRequestConcurrency, 8);
		writeSettings({ version: 1, agent: { tools: { research: false } } });
		assert.equal("workerRequestConcurrency" in (readRawSettingsSlot().agent as Record<string, unknown>), false);
		assert.equal(resolveSettings(readSettings()).agent.workerRequestConcurrency, 8);
	});

	it("code ligatures persist in either state; omitted and invalid existing settings resolve OFF", () => {
		assert.equal(resolveSettings(readSettings()).appearance.codeLigatures, false);
		for (const codeLigatures of [true, false]) {
			const parsed = parseAppearanceSettingsBody({ codeLigatures, proseFontSize: 20 });
			assert.ok(parsed.ok);
			writeSettings({ version: 1, appearance: parsed.settings });
			assert.deepEqual(readSettings()?.appearance, { codeLigatures, proseFontSize: 20 });
			assert.equal((readRawSettingsSlot().appearance as Record<string, unknown>).codeLigatures, codeLigatures);
			assert.equal(resolveSettings(readSettings()).appearance.codeLigatures, codeLigatures);
		}
		for (const appearance of [{ proseFontSize: 20 }, { proseFontSize: 20, codeLigatures: "true" }]) {
			writeRawSettingsSlot({ version: 1, appearance });
			assert.deepEqual(readSettings()?.appearance, { proseFontSize: 20 });
			assert.equal(resolveSettings(readSettings()).appearance.codeLigatures, false);
		}
	});

	it("compact session list is off by default and persists either checkbox state", () => {
		assert.equal(resolveSettings(readSettings()).appearance.compactSessionList, false);
		for (const compactSessionList of [true, false]) {
			const appearance = { compactSessionList, fontFamily: "Georgia" };
			const parsed = parseAppearanceSettingsBody(appearance);
			assert.ok(parsed.ok);
			writeSettings({ version: 1, appearance: parsed.settings });
			assert.deepEqual(readSettings()?.appearance, appearance);
			assert.equal(resolveSettings(readSettings()).appearance.compactSessionList, compactSessionList);
		}
		assert.equal(parseAppearanceSettingsBody({ compactSessionList: "true" }).ok, false);
		writeRawSettingsSlot({ version: 1, appearance: { compactSessionList: "true" } });
		assert.equal(resolveSettings(readSettings()).appearance.compactSessionList, false);
	});

	it("reads null on first boot (no record)", () => {
		ensureActiveLumberJackBundle().forest.deleteNode("config/settings");
		assert.equal(readSettings(), null);
	});

	it("write→read round-trips through the sanitizer", () => {
		writeSettings({ version: 1, graph: { enabled: false } });
		const out = readSettings();
		assert.ok(out);
		assert.deepEqual(out.graph, { enabled: false });
	});

	it("reasoning estimation defaults off and explicit choices survive parsing, storage, and resolution", () => {
		assert.equal(resolveSettings(null).compaction.includeReasoning, false);
		writeSettings({ version: 1, compaction: { thresholdTokens: 120_000 } });
		assert.equal(resolveSettings(readSettings()).compaction.includeReasoning, false, "older records stay on the original estimator");
		for (const includeReasoning of [true, false]) {
			const parsed = parseCompactionSettingsBody({ thresholdTokens: 120_000, includeReasoning });
			assert.ok(parsed.ok);
			writeSettings({ version: 1, compaction: parsed.settings });
			assert.deepEqual(readSettings()?.compaction, { thresholdTokens: 120_000, includeReasoning });
			assert.equal(resolveSettings(readSettings()).compaction.includeReasoning, includeReasoning);
		}
		writeSettings({ version: 1, compaction: { thresholdTokens: 120_000, includeReasoning: "true" } } as never);
		assert.deepEqual(readSettings()?.compaction, { thresholdTokens: 120_000 }, "invalid stored values are dropped");
		assert.equal(resolveSettings(readSettings()).compaction.includeReasoning, false);
	});

	it("a chat section in storage is IGNORED — the field died with per-session models", () => {
		writeRawSettingsSlot({
			version: 1,
			chat: { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" }, thinkingLevel: "low" },
			graph: { enabled: true },
		});
		const out = readSettings();
		assert.ok(out);
		assert.equal("chat" in out, false, "the chat section never surfaces");
		assert.deepEqual(out.graph, { enabled: true });
	});

	it("corrupt settings slot → null (first-boot semantics), never throws", () => {
		writeRawSettingsSlot("{not an object");
		assert.equal(readSettings(), null);
	});
});
