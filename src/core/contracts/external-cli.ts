import { CLAUDE_CODE_PROVIDER } from "./claude-code.ts";

/** Installed command-line agents used as model transports. The CLI owns its
 * authentication, routing and billing; LearnHarness owns prompts and tools. */
export const EXTERNAL_CLIS = [
	{ id: CLAUDE_CODE_PROVIDER, label: "Claude Code", family: "claude", binary: "claude" },
	{ id: "claudex", label: "Claudex", family: "claude", binary: "claude" },
	{ id: "codex-cli", label: "Codex", family: "codex", binary: "codex" },
	{ id: "agy-cli", label: "Antigravity", family: "agy", binary: "agy" },
] as const;

export type ExternalCliId = (typeof EXTERNAL_CLIS)[number]["id"];
export type ExternalCliFamily = (typeof EXTERNAL_CLIS)[number]["family"];

/** Bindings switched on through `settings.externalCli`. Claude Code keeps its
 * original `settings.claudeCode.enabled` opt-in. */
export type AddedCliId = Exclude<ExternalCliId, typeof CLAUDE_CODE_PROVIDER>;
export const ADDED_CLI_IDS: readonly AddedCliId[] = ["claudex", "codex-cli", "agy-cli"];

/** Where each added CLI keeps its own login when no directory is named. */
export const EXTERNAL_CLI_DEFAULT_HOMES: Record<AddedCliId, string> = { claudex: "~/.claudeex", "codex-cli": "~/.codex", "agy-cli": "~" };

/** `home` is the CLI's own configuration directory (CLAUDE_CONFIG_DIR,
 * CODEX_HOME, or the home whose `.gemini` holds the Antigravity login). */
export interface ExternalCliSettings {
	enabled?: boolean;
	home?: string;
	/** Extra model IDs offered beside the discovered or default ones. */
	models?: string[];
}

export type ExternalCliSettingsMap = Partial<Record<ExternalCliId, ExternalCliSettings>>;

export interface ExternalCliStatus {
	id: ExternalCliId;
	state: "not-found" | "found";
	version: string | null;
	models: string[];
}

export const EXTERNAL_CLI_MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$/;
export const EXTERNAL_CLI_MAX_MODELS = 64;
export const EXTERNAL_CLI_MAX_HOME = 1024;

export function externalCli(id: string): (typeof EXTERNAL_CLIS)[number] | undefined {
	return EXTERNAL_CLIS.find((cli) => cli.id === id);
}

export function isExternalCliProvider(provider: string): boolean {
	return externalCli(provider) !== undefined;
}

/** Claude Code bindings report their own context window per session; no
 * catalog value stands in for it. */
export function isClaudeCliProvider(provider: string): boolean {
	return externalCli(provider)?.family === "claude";
}

/** Accepts the `provider:model` form used for saved selections and turns. */
export function isExternalCliModel(model: string): boolean {
	const colon = model.indexOf(":");
	return colon > 0 && isExternalCliProvider(model.slice(0, colon));
}

/** The refusal for a selected CLI that is switched off or not installed. */
export function externalCliUnavailable(provider: string): string | undefined {
	const cli = externalCli(provider);
	return cli ? `${cli.label} is unavailable. Enable and set it up in Settings → Providers.` : undefined;
}

export function isClaudeCliModel(model: string): boolean {
	const colon = model.indexOf(":");
	return colon > 0 && isClaudeCliProvider(model.slice(0, colon));
}

function sanitizeEntry(raw: unknown): ExternalCliSettings | undefined {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const { enabled, home, models } = raw as Record<string, unknown>;
	const entry: ExternalCliSettings = {};
	if (typeof enabled === "boolean") entry.enabled = enabled;
	if (typeof home === "string" && home.trim() && home.length <= EXTERNAL_CLI_MAX_HOME) entry.home = home.trim();
	if (Array.isArray(models)) {
		const ids = models.filter((id): id is string => typeof id === "string" && EXTERNAL_CLI_MODEL_ID.test(id));
		entry.models = [...new Set(ids)].slice(0, EXTERNAL_CLI_MAX_MODELS);
	}
	return entry;
}

/** Unknown CLIs and malformed fields are dropped, never guessed. */
export function sanitizeExternalCliSettings(raw: unknown): ExternalCliSettingsMap {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
	const out: ExternalCliSettingsMap = {};
	for (const cli of EXTERNAL_CLIS) {
		const entry = sanitizeEntry((raw as Record<string, unknown>)[cli.id]);
		if (entry) out[cli.id] = entry;
	}
	return out;
}
