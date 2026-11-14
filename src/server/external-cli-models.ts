import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { Api, Model } from "@earendil-works/pi-ai";

import { PATHS } from "../../config.ts";
import { claudeCodeModels } from "../agent/claude-code/provider.ts";
import { externalCliEnv } from "../core/auth-env.ts";
import { EXTERNAL_CLI_MODEL_ID, externalCli, type ExternalCliId } from "../core/contracts/external-cli.ts";
import { writeFileAtomicSync } from "../store/atomic-write.ts";

export type CliModelEntry = { id: string; name?: string; contextWindow?: number };

export const EXTERNAL_CLI_API = "external-cli";

/** Aliases the installed CLI resolves itself; full model names can be added in settings. */
const CLAUDE_ALIASES: CliModelEntry[] = [{ id: "fable" }, { id: "opus" }, { id: "sonnet" }, { id: "haiku" }];
/** The listing is a network call that can take half a minute. */
const DISCOVERY_TIMEOUT_MS = 120_000;
/** Used only when the CLI reports no window; compaction needs some bound. */
const FALLBACK_CONTEXT_WINDOW = 200_000;

const LINE_MODEL_FIELDS = {
	api: EXTERNAL_CLI_API,
	baseUrl: "",
	input: ["text"],
	// Pi-required placeholders, not prices: the CLI's own account is billed.
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	maxTokens: 128_000,
} satisfies Partial<Model<Api>>;

const CODEX_LEVELS = { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" };

function asEntries(value: unknown): Record<string, unknown>[] {
	return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => item !== null && typeof item === "object") : [];
}

/** Codex keeps the account's model list beside its login; hidden entries are
 * its internal routes, not user choices. */
export function readCodexModels(home: string = path.join(os.homedir(), ".codex")): CliModelEntry[] {
	try {
		const cache = JSON.parse(fs.readFileSync(path.join(home, "models_cache.json"), "utf8")) as { models?: unknown };
		return asEntries(cache.models)
			.filter((model) => typeof model.slug === "string" && EXTERNAL_CLI_MODEL_ID.test(model.slug) && model.visibility !== "hide")
			.map((model) => ({
				id: model.slug as string,
				...(typeof model.display_name === "string" ? { name: model.display_name } : {}),
				...(typeof model.context_window === "number" ? { contextWindow: model.context_window } : {}),
			}));
	} catch {
		return [];
	}
}

/** `agy models` prints one `id<TAB>name` row per model after a status line. */
export function parseAgyModels(stdout: string): CliModelEntry[] {
	return stdout.split("\n").flatMap((line) => {
		const [id, name] = line.split("\t").map((part) => part.trim());
		return id && EXTERNAL_CLI_MODEL_ID.test(id) && name ? [{ id, name }] : [];
	});
}

/** The last listing, kept beside the app's other records so a saved model
 * choice resolves at once after a restart instead of after the next listing. */
function listingFile(): string {
	return path.join(PATHS.data, "external-cli-models.json");
}

function readListing(): CliModelEntry[] {
	try {
		const saved = JSON.parse(fs.readFileSync(listingFile(), "utf8")) as { "agy-cli"?: unknown };
		return asEntries(saved["agy-cli"]).flatMap((entry) => typeof entry.id === "string" && EXTERNAL_CLI_MODEL_ID.test(entry.id)
			? [{ id: entry.id, ...(typeof entry.name === "string" ? { name: entry.name } : {}) }] : []);
	} catch {
		return [];
	}
}

function saveListing(models: CliModelEntry[]): void {
	try {
		fs.mkdirSync(PATHS.data, { recursive: true });
		writeFileAtomicSync(listingFile(), `${JSON.stringify({ "agy-cli": models }, null, "\t")}\n`);
	} catch (error) {
		console.error("[external-cli] could not save the Antigravity model list:", error);
	}
}

let agyModels: CliModelEntry[] | undefined;
let agyRefresh: Promise<void> | undefined;

/** One listing at a time; a failure keeps the last known list. */
export function refreshAgyModels(binary: string): Promise<void> {
	agyRefresh ??= new Promise<void>((resolve) => {
		execFile(binary, ["models"], { cwd: os.tmpdir(), env: externalCliEnv(), timeout: DISCOVERY_TIMEOUT_MS, maxBuffer: 262_144 }, (error, stdout) => {
			const found = error ? [] : parseAgyModels(stdout);
			if (found.length > 0) {
				agyModels = found;
				saveListing(found);
			}
			agyRefresh = undefined;
			resolve();
		});
	});
	return agyRefresh;
}

/** What the CLI itself offers, without the user's extra IDs. */
export function discoveredCliModels(id: ExternalCliId, home: string | undefined): CliModelEntry[] {
	switch (externalCli(id)?.family) {
		case "claude": return CLAUDE_ALIASES;
		case "codex": return readCodexModels(home);
		case "agy": return agyModels ??= readListing();
		default: return [];
	}
}

export function mergeCliModels(discovered: CliModelEntry[], extra: readonly string[] = []): CliModelEntry[] {
	const known = new Set(discovered.map((model) => model.id));
	return [...discovered, ...extra.filter((id) => !known.has(id)).map((id) => ({ id }))];
}

function lineCliModel(provider: string, entry: CliModelEntry, levels: Model<Api>["thinkingLevelMap"] | undefined): Model<Api> {
	return {
		...LINE_MODEL_FIELDS,
		provider,
		id: entry.id,
		name: entry.name ?? entry.id,
		contextWindow: entry.contextWindow ?? FALLBACK_CONTEXT_WINDOW,
		reasoning: levels !== undefined,
		...(levels ? { thinkingLevelMap: levels } : {}),
	} as Model<Api>;
}

export function toCliModels(id: ExternalCliId, entries: CliModelEntry[]): Model<Api>[] {
	switch (externalCli(id)?.family) {
		case "claude": return claudeCodeModels(entries.map((entry) => entry.id), id);
		case "codex": return entries.map((entry) => lineCliModel(id, entry, CODEX_LEVELS));
		// Antigravity's model IDs already name their effort tier.
		default: return entries.map((entry) => lineCliModel(id, entry, undefined));
	}
}
