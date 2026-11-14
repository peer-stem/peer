import { getClaudeBinary } from "../agent/claude-code/binary.ts";
import { expandHome, findCliBinary } from "../agent/external-cli/binary.ts";
import { CLAUDE_CODE_PROVIDER } from "../core/contracts/claude-code.ts";
import { EXTERNAL_CLI_DEFAULT_HOMES, externalCli, type ExternalCliId, type ExternalCliSettings } from "../core/contracts/external-cli.ts";
import type { UserSettings } from "../core/settings.ts";
import { settingsStore } from "../store/settings.ts";
import { claudeCodeEnabled } from "./claude-code-config.ts";

/** A second Claude Code login lives in its own configuration directory, which
 * must be passed; the other CLIs find their default home themselves. */
const PASSED_HOMES: Partial<Record<ExternalCliId, string>> = { claudex: EXTERNAL_CLI_DEFAULT_HOMES.claudex };
const BINARY_TTL_MS = 5_000;

const binaries = new Map<string, { path: string | null; at: number }>();

/** Model resolution runs constantly; installation is not rechecked each time. */
export function cliBinary(id: ExternalCliId): string | null {
	const name = externalCli(id)!.binary;
	const cached = binaries.get(name);
	if (cached && Date.now() - cached.at < BINARY_TTL_MS) return cached.path;
	const found = name === "claude" ? getClaudeBinary() : findCliBinary(name);
	binaries.set(name, { path: found, at: Date.now() });
	return found;
}

/** An explicit recheck must see an install or removal made a moment ago. */
export function forgetCliBinary(id: ExternalCliId): void {
	binaries.delete(externalCli(id)!.binary);
}

/** Settings as read for one decision. Fresh admission state, not a process-wide
 * cache: callers making several checks at once read once and pass it on. */
export type CliSettingsSnapshot = UserSettings | null;

export function readCliSettings(): CliSettingsSnapshot {
	return settingsStore.readSettings();
}

export function externalCliSettings(id: ExternalCliId, settings: CliSettingsSnapshot = readCliSettings()): ExternalCliSettings {
	return settings?.externalCli?.[id] ?? {};
}

export function externalCliHome(id: ExternalCliId, settings: CliSettingsSnapshot = readCliSettings()): string | undefined {
	const home = externalCliSettings(id, settings).home ?? PASSED_HOMES[id];
	return home ? expandHome(home) : undefined;
}

/** Explicit opt-in. Claude Code keeps its original switch. */
export function externalCliEnabled(id: ExternalCliId, settings: CliSettingsSnapshot = readCliSettings()): boolean {
	return id === CLAUDE_CODE_PROVIDER ? claudeCodeEnabled() : externalCliSettings(id, settings).enabled === true;
}

/** Opt-in and installation only, never authenticated readiness. */
export function externalCliAvailable(provider: string, settings: CliSettingsSnapshot = readCliSettings()): boolean {
	const cli = externalCli(provider);
	return cli !== undefined && externalCliEnabled(cli.id, settings) && cliBinary(cli.id) !== null;
}
