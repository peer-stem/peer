import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ThinkingLevel } from "@earendil-works/pi-ai";

import { externalCliEnv } from "../../core/auth-env.ts";
import { toEffort } from "../claude-code/stream.ts";
import { findCliBinary } from "./binary.ts";
import {
	BRIDGE_SERVER_NAME, CliLaunchError, PRIVATE_FILE_MODE, TOOL_TIMEOUT_SECONDS, asRecord, countOf, parseJsonLine,
	type CliDialect, type CliLaunch, type CliLineEvent, type CliPrepareInput,
} from "./dialect.ts";

const TOKEN_ENV = "LH_CODEX_BRIDGE_TOKEN";
/** A tutor turn's only tools are the bridge's: no shell, apps, hooks, sub-agents or plugins. */
const DISABLED_FEATURES = ["shell_tool", "apps", "hooks", "multi_agent", "plugins"];

type CodexArgsInput = { model: string; effort: ThinkingLevel | undefined; cwd: string; instructionsFile: string; bridgeUrl: string };

/** Values are TOML; a JSON string literal is also a valid TOML basic string. */
function configArgs(pairs: Record<string, string | number>): string[] {
	return Object.entries(pairs).flatMap(([key, value]) => ["-c", `${key}=${typeof value === "number" ? value : JSON.stringify(value)}`]);
}

export function toCodexArgs(input: CodexArgsInput): string[] {
	const server = `mcp_servers.${BRIDGE_SERVER_NAME}`;
	// Codex takes the same effort names as Claude Code.
	const effort = input.effort ? toEffort(input.effort) : undefined;
	return [
		"exec", "--json", "--ephemeral", "--skip-git-repo-check",
		// The user's config.toml names their own instructions file and MCP servers.
		"--ignore-user-config", "--ignore-rules",
		"--sandbox", "read-only",
		...DISABLED_FEATURES.flatMap((feature) => ["--disable", feature]),
		"--cd", input.cwd,
		"--model", input.model,
		...configArgs({
			// Replaces Codex's base instructions with the tutor's system prompt.
			model_instructions_file: input.instructionsFile,
			[`${server}.url`]: input.bridgeUrl,
			[`${server}.bearer_token_env_var`]: TOKEN_ENV,
			[`${server}.default_tools_approval_mode`]: "approve",
			[`${server}.tool_timeout_sec`]: TOOL_TIMEOUT_SECONDS,
			...(effort ? { model_reasoning_effort: effort } : {}),
		}),
		"-",
	];
}

function itemEvents(item: Record<string, unknown> | undefined): CliLineEvent[] {
	if (item?.type !== "agent_message" || typeof item.text !== "string") return [];
	return [{ type: "text", delta: item.text, paragraph: true }];
}

/** Codex counts cached tokens inside `input_tokens`; Pi keeps them apart. */
function usageEvent(usage: Record<string, unknown> | undefined): CliLineEvent {
	const cacheRead = countOf(usage?.cached_input_tokens);
	return { type: "usage", usage: { input: Math.max(0, countOf(usage?.input_tokens) - cacheRead), output: countOf(usage?.output_tokens), cacheRead } };
}

function messageOf(value: unknown, fallback: string): string {
	const text = typeof value === "string" ? value : asRecord(value)?.message;
	return typeof text === "string" && text.trim() ? text.trim() : fallback;
}

export function parseCodexLine(line: string): CliLineEvent[] {
	const event = parseJsonLine(line);
	switch (event?.type) {
		case "item.completed": return itemEvents(asRecord(event.item));
		case "turn.completed": return [usageEvent(asRecord(event.usage)), { type: "done" }];
		case "turn.failed": return [{ type: "error", message: messageOf(event.error, "Codex could not complete the turn") }];
		// Also used for reconnect notices: only `turn.failed` ends a turn.
		case "error": return [{ type: "warning", message: messageOf(event.message, "Codex reported an error") }];
		default: return [];
	}
}

async function tempDir(made: string[], prefix: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), prefix));
	made.push(dir);
	return dir;
}

/** The bridge token travels only in the environment, never in an argument. */
function codexEnv(input: CliPrepareInput): NodeJS.ProcessEnv {
	return {
		...externalCliEnv(),
		[TOKEN_ENV]: input.bridge.authorization.replace(/^Bearer /, ""),
		...(input.home ? { CODEX_HOME: input.home } : {}),
	};
}

async function prepareCodex(input: CliPrepareInput): Promise<CliLaunch> {
	const binary = findCliBinary("codex");
	if (!binary) throw new CliLaunchError("Codex CLI not found");
	const made: string[] = [];
	const cleanup = async () => { await Promise.all(made.map((dir) => rm(dir, { recursive: true, force: true }))); };
	try {
		const cwd = await tempDir(made, "lh-codex-cwd-");
		const instructionsFile = join(await tempDir(made, "lh-codex-private-"), "instructions.md");
		await writeFile(instructionsFile, input.systemPrompt, { mode: PRIVATE_FILE_MODE });
		const args = toCodexArgs({ model: input.model, effort: input.effort, cwd, instructionsFile, bridgeUrl: input.bridge.url });
		return { binary, args, env: codexEnv(input), cwd, stdin: input.prompt, cleanup };
	} catch (error) {
		await cleanup();
		throw error;
	}
}

export const codexDialect: CliDialect = { id: "codex-cli", label: "Codex", prepare: prepareCodex, parse: parseCodexLine };
