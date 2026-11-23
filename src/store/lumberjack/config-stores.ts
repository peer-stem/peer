import path from "node:path";
import { parseFileAccessSettings, type FileAccessSettingsResult } from "../../core/file-access.ts";
import type { PluginAgentRecord } from "../../core/plugin-agents.ts";
import type { PluginTaskRecord } from "../../core/plugin-workers.ts";
import type {
	PluginAgentRecordStore,
	PluginTaskRecordStore,
	PromptOverrideStore,
	SettingsStore,
	ThemeStore,
} from "../../core/ports.ts";
import { isValidSegmentPath } from "../../core/prompt-segments.ts";
import { sanitizeUserSettings, type UserSettings } from "../../core/settings.ts";
import { isBuiltinThemeId, isThemeId, sanitizeThemeFile, type Theme, type ThemeFile } from "../../core/themes.ts";
import type { LumberJackForest } from "./binding.ts";
import {
	assertFinitePlainJson,
	assertSafePluginRecordId,
	validatePluginAgentRecord,
	validatePluginTaskRecord,
} from "./plugin-validators.ts";

const FILE_ACCESS_ERROR =
	"File-access configuration cannot be read reliably. Learner-file access is blocked. Repair File access in Settings → Agent → Tools.";

function fileAccessFromRaw(raw: unknown): FileAccessSettingsResult {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: FILE_ACCESS_ERROR };
	const agent = (raw as Record<string, unknown>).agent;
	if (agent === undefined) return { ok: true, settings: { restricted: false, folders: [] } };
	if (!agent || typeof agent !== "object" || Array.isArray(agent)) return { ok: false, error: FILE_ACCESS_ERROR };
	const value = (agent as Record<string, unknown>).fileAccess;
	if (value === undefined) return { ok: true, settings: { restricted: false, folders: [] } };
	const parsed = parseFileAccessSettings(value);
	const invalidFolder =
		!parsed.ok ||
		parsed.settings.folders.some((f) => f !== "~" && !f.startsWith("~/") && !path.isAbsolute(f));
	return invalidFolder ? { ok: false, error: FILE_ACCESS_ERROR } : parsed;
}

export function createLumberJackSettingsStore(forest: LumberJackForest): SettingsStore & {
	readFileAccessSettings(): FileAccessSettingsResult;
} {
	const readFileAccessSettings = (): FileAccessSettingsResult => {
		try {
			const snap = forest.getNode("config/settings");
			if (!snap || snap.slot === undefined) {
				return { ok: true, settings: { restricted: false, folders: [] } };
			}
			return fileAccessFromRaw(snap.slot);
		} catch {
			return { ok: false, error: FILE_ACCESS_ERROR };
		}
	};

	const readSettings = (): UserSettings | null => {
		try {
			const snap = forest.getNode("config/settings");
			if (!snap || snap.slot === undefined) return null;
			const record = sanitizeUserSettings(snap.slot);
			if (!record) return null;
			if (!fileAccessFromRaw(snap.slot).ok) {
				record.agent = { ...record.agent, fileAccess: { restricted: true, folders: [] } };
			}
			return record;
		} catch {
			return null;
		}
	};

	const writeSettings = (raw: unknown): UserSettings => {
		const settings = sanitizeUserSettings(raw);
		if (!settings) throw new Error("settings record must be a JSON object");
		if (!readFileAccessSettings().ok && settings.agent?.fileAccess === undefined) {
			settings.agent = { ...settings.agent, fileAccess: { restricted: true, folders: [] } };
		}
		forest.upsertNode({ path: "config/settings", type: "leaf", kind: "config", slot: settings });
		return settings;
	};

	return { readSettings, writeSettings, readFileAccessSettings };
}

function readOneTheme(forest: LumberJackForest, id: string): Theme | null {
	if (!isThemeId(id) || isBuiltinThemeId(id)) return null;
	const raw = forest.getNode(`config/themes/${id}`)?.slot;
	if (!raw) return null;
	const parsed = sanitizeThemeFile(raw);
	return parsed ? { ...parsed, id, builtin: false } : null;
}

function listCustomThemes(forest: LumberJackForest): Theme[] {
	const out: Theme[] = [];
	for (const node of forest.listChildren("config/themes")) {
		const theme = readOneTheme(forest, node.name);
		if (theme) out.push(theme);
	}
	return out.sort((a, b) => a.id.localeCompare(b.id));
}

export function createLumberJackThemeStore(forest: LumberJackForest): ThemeStore {
	return {
		listThemes: () => listCustomThemes(forest),
		readTheme: (id) => readOneTheme(forest, id),
		writeTheme(id: string, theme: ThemeFile): void {
			if (!isThemeId(id) || isBuiltinThemeId(id)) throw new Error(`Invalid custom theme id "${id}"`);
			const file: ThemeFile = { name: theme.name, mode: theme.mode, colors: theme.colors };
			forest.upsertNode({ path: `config/themes/${id}`, type: "leaf", kind: "theme", slot: file });
		},
		deleteTheme(id: string): void {
			if (!isThemeId(id) || isBuiltinThemeId(id)) return;
			forest.deleteNode(`config/themes/${id}`);
		},
	};
}

function encodePromptKey(segmentPath: string): string {
	return Buffer.from(segmentPath, "utf8").toString("hex");
}

function listPromptOverridePaths(forest: LumberJackForest): string[] {
	const out: string[] = [];
	for (const node of forest.listChildren("config/prompts")) {
		const seg = (node.slot as { segmentPath?: string } | undefined)?.segmentPath;
		if (typeof seg === "string" && isValidSegmentPath(seg)) out.push(seg);
	}
	return out.sort();
}

function readPromptOverrideText(forest: LumberJackForest, segmentPath: string): string | null {
	if (!isValidSegmentPath(segmentPath)) return null;
	const slot = forest.getNode(`config/prompts/${encodePromptKey(segmentPath)}`)?.slot as { text?: string } | undefined;
	return typeof slot?.text === "string" ? slot.text : null;
}

function writePromptOverrideNode(forest: LumberJackForest, segmentPath: string, text: string): void {
	if (!isValidSegmentPath(segmentPath)) return;
	forest.upsertNode({
		path: `config/prompts/${encodePromptKey(segmentPath)}`,
		type: "leaf",
		kind: "prompt_override",
		metadata: { segmentPath },
		slot: { segmentPath, text },
	});
}

export function createLumberJackPromptOverrideStore(forest: LumberJackForest): PromptOverrideStore {
	return {
		listOverrides: () => listPromptOverridePaths(forest),
		readOverride: (segmentPath) => readPromptOverrideText(forest, segmentPath),
		writeOverride: (segmentPath, text) => writePromptOverrideNode(forest, segmentPath, text),
		deleteOverride(segmentPath: string): void {
			if (!isValidSegmentPath(segmentPath)) return;
			forest.deleteNode(`config/prompts/${encodePromptKey(segmentPath)}`);
		},
	};
}

function listValidatedPluginSlots<T extends { id: string }>(
	forest: LumberJackForest,
	base: string,
	validator: (value: unknown, expectedId: string) => T,
): T[] {
	const out: T[] = [];
	for (const node of forest.listChildren(base)) {
		out.push(validator(node.slot, node.name));
	}
	return out.sort((a, b) => a.id.localeCompare(b.id));
}

export function createLumberJackPluginAgentStore(forest: LumberJackForest, pluginScope: string): PluginAgentRecordStore {
	const scopeHex = Buffer.from(pluginScope, "utf8").toString("hex");
	const base = `config/plugins/${scopeHex}/agents`;
	return {
		get(id: string): PluginAgentRecord | null {
			assertSafePluginRecordId(id, "plugin agent");
			const snap = forest.getNode(`${base}/${id}`);
			if (!snap || snap.slot === undefined) return null;
			return validatePluginAgentRecord(snap.slot, id);
		},
		list: () => listValidatedPluginSlots(forest, base, validatePluginAgentRecord),
		save(record: PluginAgentRecord): void {
			assertSafePluginRecordId(record?.id, "plugin agent");
			const valid = validatePluginAgentRecord(JSON.parse(JSON.stringify(record)), record.id);
			forest.upsertNode({ path: `${base}/${record.id}`, type: "leaf", kind: "plugin_agent", slot: valid });
		},
	};
}

export function createLumberJackPluginTaskStore(forest: LumberJackForest, pluginScope: string): PluginTaskRecordStore {
	const scopeHex = Buffer.from(pluginScope, "utf8").toString("hex");
	const base = `config/plugins/${scopeHex}/tasks`;
	return {
		get(id: string): PluginTaskRecord | null {
			assertSafePluginRecordId(id, "plugin task");
			const snap = forest.getNode(`${base}/${id}`);
			if (!snap || snap.slot === undefined) return null;
			return validatePluginTaskRecord(snap.slot, id);
		},
		list: () => listValidatedPluginSlots(forest, base, validatePluginTaskRecord),
		save(record: PluginTaskRecord): void {
			assertSafePluginRecordId(record?.id, "plugin task");
			assertFinitePlainJson(record);
			const valid = validatePluginTaskRecord(JSON.parse(JSON.stringify(record)), record.id);
			forest.upsertNode({ path: `${base}/${record.id}`, type: "leaf", kind: "plugin_task", slot: valid });
		},
	};
}
