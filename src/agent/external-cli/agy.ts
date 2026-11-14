import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import type { Tool } from "@earendil-works/pi-ai";

import { externalCliEnv } from "../../core/auth-env.ts";
import { findCliBinary } from "./binary.ts";
import {
	BRIDGE_SERVER_NAME, CliLaunchError, PRIVATE_DIR_MODE, PRIVATE_FILE_MODE, asRecord, countOf, parseJsonLine,
	type CliDialect, type CliLaunch, type CliLineEvent, type CliPrepareInput,
} from "./dialect.ts";

const GEMINI_DIR = ".gemini";
const APP_DATA_DIR = "antigravity-cli";
const TOKEN_FILE = "antigravity-oauth-token";
const LEGACY_CREDENTIALS = "oauth_creds.json";

/** Antigravity reads its instructions, memory, plugins and MCP servers from
 * `~/.gemini`, and print mode has no flag to move that. Each turn therefore
 * runs with a private HOME holding only the login and this turn's bridge. */
const NOT_SIGNED_IN = "Antigravity is not signed in. Run `agy` in a terminal and sign in, then try again.";

/** Its system prompt cannot be replaced, so the tutor's leads the conversation. */
export function withInstructions(systemPrompt: string, prompt: string): string {
	return [
		"<instructions>",
		"These instructions define your role for this whole conversation and take precedence over your default behaviour.",
		`Your tools here come from the MCP server "${BRIDGE_SERVER_NAME}": call them with call_mcp_tool. No other built-in tool (files, shell, browser, questions, permissions) is available in this session, so never call one.`,
		"",
		systemPrompt,
		"</instructions>",
		"",
		prompt,
	].join("\n");
}

export function toAgyArgs(model: string, tools: Tool[]): string[] {
	// Headless mode denies anything unlisted; only this turn's bridge tools are allowed.
	const allow = tools.map((tool) => `mcp(${BRIDGE_SERVER_NAME}/${tool.name})`);
	return [
		"--input-format", "stream-json",
		"--output-format", "stream-json",
		"--model", model,
		"--disable-slash-commands",
		"--settings", JSON.stringify({ permissions: { allow } }),
		"-p=",
	];
}

export function toAgyStdin(systemPrompt: string, prompt: string): string {
	return JSON.stringify({ event: "user", message: { content: withInstructions(systemPrompt, prompt) } });
}

function stepEvents(step: Record<string, unknown> | undefined): CliLineEvent[] {
	if (step?.step_type !== "agent_response" || typeof step.text_delta !== "string") return [];
	return [{ type: "text", delta: step.text_delta }];
}

function resultEvents(result: Record<string, unknown> | undefined): CliLineEvent[] {
	if (result?.status !== "SUCCESS") {
		const detail = typeof result?.error === "string" ? result.error : asRecord(result?.error)?.message;
		return [{ type: "error", message: typeof detail === "string" && detail.trim() ? detail.trim() : "Antigravity could not complete the turn" }];
	}
	const usage = asRecord(result.usage);
	return [
		{ type: "usage", usage: { input: countOf(usage?.input_tokens), output: countOf(usage?.output_tokens), cacheRead: countOf(usage?.cache_read_tokens) } },
		{ type: "done", text: typeof result.response === "string" ? result.response : undefined },
	];
}

export function parseAgyLine(line: string): CliLineEvent[] {
	const event = parseJsonLine(line);
	if (event?.event === "step_update") return stepEvents(asRecord(event.step_update));
	if (event?.event === "result") return resultEvents(asRecord(event.result));
	return [];
}

/** Only the sign-in choice is carried over; every other setting stays behind. */
async function readSecuritySettings(source: string): Promise<Record<string, unknown>> {
	try {
		const settings = asRecord(JSON.parse(await readFile(join(source, "settings.json"), "utf8")));
		return settings?.security === undefined ? {} : { security: settings.security };
	} catch {
		return {};
	}
}

async function populateHome(home: string, source: string, bridge: CliPrepareInput["bridge"]): Promise<void> {
	const gemini = join(home, GEMINI_DIR);
	await mkdir(join(gemini, APP_DATA_DIR), { recursive: true, mode: PRIVATE_DIR_MODE });
	await mkdir(join(gemini, "config"), { recursive: true, mode: PRIVATE_DIR_MODE });
	await mkdir(join(home, "work"), { mode: PRIVATE_DIR_MODE });
	// Links, not copies: a refreshed login stays with its one owner.
	await symlink(join(source, APP_DATA_DIR, TOKEN_FILE), join(gemini, APP_DATA_DIR, TOKEN_FILE));
	if (existsSync(join(source, LEGACY_CREDENTIALS))) await symlink(join(source, LEGACY_CREDENTIALS), join(gemini, LEGACY_CREDENTIALS));
	await writeFile(join(gemini, "settings.json"), JSON.stringify(await readSecuritySettings(source)), { mode: PRIVATE_FILE_MODE });
	const server = { disabled: false, headers: { Authorization: bridge.authorization }, serverUrl: bridge.url };
	await writeFile(join(gemini, "config", "mcp_config.json"), JSON.stringify({ mcpServers: { [BRIDGE_SERVER_NAME]: server } }), { mode: PRIVATE_FILE_MODE });
}

async function prepareAgy(input: CliPrepareInput): Promise<CliLaunch> {
	const binary = findCliBinary("agy");
	if (!binary) throw new CliLaunchError("Antigravity CLI not found");
	const source = join(input.home ?? homedir(), GEMINI_DIR);
	if (!existsSync(join(source, APP_DATA_DIR, TOKEN_FILE))) throw new CliLaunchError(NOT_SIGNED_IN);
	const home = await mkdtemp(join(tmpdir(), "lh-agy-home-"));
	const cleanup = () => rm(home, { recursive: true, force: true });
	try {
		await populateHome(home, source, input.bridge);
		return {
			binary,
			args: toAgyArgs(input.model, input.tools),
			env: { ...externalCliEnv(), HOME: home },
			cwd: join(home, "work"),
			stdin: toAgyStdin(input.systemPrompt, input.prompt),
			cleanup,
		};
	} catch (error) {
		await cleanup();
		throw error;
	}
}

export const agyDialect: CliDialect = { id: "agy-cli", label: "Antigravity", prepare: prepareAgy, parse: parseAgyLine };
