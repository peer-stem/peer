import { getClaudeBinary } from "../agent/claude-code/binary.ts";
import { expandHome, findCliBinary } from "../agent/external-cli/binary.ts";
import { CLAUDE_CODE_PROVIDER } from "../core/contracts/claude-code.ts";
import { externalCli, type ExternalCliId, type ExternalCliSettings } from "../core/contracts/external-cli.ts";
import { settingsStore } from "../store/settings.ts";
import { claudeCodeEnabled } from "./claude-code-config.ts";

/** A second Claude Code login lives in its own configuration directory. */
const DEFAULT_HOMES: Partial<Record<ExternalCliId, string>> = { claudex: "~/.claudeex" };
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

/** Fresh admission state, not a process-wide cache. */
export function externalCliSettings(id: ExternalCliId): ExternalCliSettings {
	return settingsStore.readSettings()?.externalCli?.[id] ?? {};
}

export function externalCliHome(id: ExternalCliId): string | undefined {
	const home = externalCliSettings(id).home ?? DEFAULT_HOMES[id];
	return home ? expandHome(home) : undefined;
}

/** Explicit opt-in. Claude Code keeps its original switch. */
export function externalCliEnabled(id: ExternalCliId): boolean {
	return id === CLAUDE_CODE_PROVIDER ? claudeCodeEnabled() : externalCliSettings(id).enabled === true;
}

/** Opt-in and installation only, never authenticated readiness. */
export function externalCliAvailable(provider: string): boolean {
	const cli = externalCli(provider);
	return cli !== undefined && externalCliEnabled(cli.id) && cliBinary(cli.id) !== null;
}
