/**
 * External CLI bindings: what each CLI is launched with and how its output is
 * read. The launch arguments are the isolation boundary, so they are pinned.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import type { Tool } from "@earendil-works/pi-ai";

import { parseAgyLine, toAgyArgs, toAgyStdin } from "../src/agent/external-cli/agy.ts";
import { parseCodexLine, toCodexArgs } from "../src/agent/external-cli/codex.ts";
import { toPromptText } from "../src/agent/external-cli/dialect.ts";
import {
	isClaudeCliModel, isClaudeCliProvider, isExternalCliModel, isExternalCliProvider, sanitizeExternalCliSettings,
} from "../src/core/contracts/external-cli.ts";
import { mergeCliModels, parseAgyModels, readCodexModels, toCliModels } from "../src/server/external-cli-models.ts";

const CODEX_INPUT = { model: "gpt-6-luna", effort: "high" as const, cwd: "/tmp/work", instructionsFile: "/tmp/private/instructions.md", bridgeUrl: "http://127.0.0.1:4000/mcp" };
const TOOLS = [{ name: "ask_question" }, { name: "plan" }] as Tool[];

function configValue(args: string[], key: string): string | undefined {
	const index = args.findIndex((arg, at) => args[at - 1] === "-c" && arg.startsWith(`${key}=`));
	return index < 0 ? undefined : args[index]!.slice(key.length + 1);
}

test("codex runs without the user's config, rules, shell or sub-agents", () => {
	const args = toCodexArgs(CODEX_INPUT);
	for (const flag of ["exec", "--json", "--ephemeral", "--ignore-user-config", "--ignore-rules", "--skip-git-repo-check"]) assert.ok(args.includes(flag), flag);
	assert.equal(args[args.indexOf("--sandbox") + 1], "read-only");
	const disabled = args.flatMap((arg, at) => args[at - 1] === "--disable" ? [arg] : []);
	assert.deepEqual(disabled, ["shell_tool", "apps", "hooks", "multi_agent", "plugins"]);
	assert.equal(args.at(-1), "-", "the prompt arrives on stdin, never as an argument");
});

test("codex takes the tutor prompt as its instructions and only the bridge as MCP", () => {
	const args = toCodexArgs(CODEX_INPUT);
	assert.equal(configValue(args, "model_instructions_file"), JSON.stringify(CODEX_INPUT.instructionsFile));
	assert.equal(configValue(args, "mcp_servers.learnharness.url"), JSON.stringify(CODEX_INPUT.bridgeUrl));
	assert.equal(configValue(args, "mcp_servers.learnharness.default_tools_approval_mode"), '"approve"');
	assert.equal(configValue(args, "mcp_servers.learnharness.tool_timeout_sec"), "1800");
	assert.equal(configValue(args, "model_reasoning_effort"), '"high"');
	// The bearer token travels in the environment, never in the process list.
	assert.equal(configValue(args, "mcp_servers.learnharness.bearer_token_env_var"), '"LH_CODEX_BRIDGE_TOKEN"');
	assert.ok(!args.some((arg) => /Bearer/.test(arg)));
});

test("codex omits the effort override when no level is chosen", () => {
	assert.equal(configValue(toCodexArgs({ ...CODEX_INPUT, effort: undefined }), "model_reasoning_effort"), undefined);
});

test("codex lines: messages are text, completion carries usage, cached input is kept apart", () => {
	assert.deepEqual(parseCodexLine(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "hi" } })), [{ type: "text", delta: "hi", paragraph: true }]);
	assert.deepEqual(parseCodexLine(JSON.stringify({ type: "item.completed", item: { type: "mcp_tool_call" } })), []);
	assert.deepEqual(parseCodexLine(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 7 } })), [
		{ type: "usage", usage: { input: 60, output: 7, cacheRead: 40 } },
		{ type: "done" },
	]);
});

test("codex lines: only a failed turn is terminal; error notices are warnings", () => {
	assert.deepEqual(parseCodexLine(JSON.stringify({ type: "turn.failed", error: { message: "quota exceeded" } })), [{ type: "error", message: "quota exceeded" }]);
	assert.deepEqual(parseCodexLine(JSON.stringify({ type: "error", message: "Reconnecting... 1/5" })), [{ type: "warning", message: "Reconnecting... 1/5" }]);
	assert.deepEqual(parseCodexLine("not json"), []);
	assert.deepEqual(parseCodexLine(JSON.stringify({ type: "thread.started" })), []);
});

test("agy allows exactly this turn's bridge tools and nothing else", () => {
	const args = toAgyArgs("gemini-3.8-flash-low", TOOLS);
	const settings = JSON.parse(args[args.indexOf("--settings") + 1]!) as { permissions: { allow: string[] } };
	assert.deepEqual(settings.permissions.allow, ["mcp(learnharness/ask_question)", "mcp(learnharness/plan)"]);
	assert.ok(!args.includes("--dangerously-skip-permissions"));
	assert.ok(args.includes("--disable-slash-commands"));
	assert.equal(args[args.indexOf("--model") + 1], "gemini-3.8-flash-low");
	assert.equal(args.at(-1), "-p=", "the prompt arrives on stdin");
});

test("agy receives the tutor prompt ahead of the conversation, as one stdin message", () => {
	const message = JSON.parse(toAgyStdin("You are a tutor.", "[user]\nhello")) as { event: string; message: { content: string } };
	assert.equal(message.event, "user");
	assert.ok(message.message.content.indexOf("You are a tutor.") < message.message.content.indexOf("[user]\nhello"));
	assert.match(message.message.content, /call_mcp_tool/);
});

test("agy lines: response deltas are text; the result carries usage and the final text", () => {
	const step = (extra: object) => JSON.stringify({ event: "step_update", step_update: { step_type: "agent_response", ...extra } });
	assert.deepEqual(parseAgyLine(step({ state: "ACTIVE", text_delta: "ok" })), [{ type: "text", delta: "ok" }]);
	assert.deepEqual(parseAgyLine(step({ state: "DONE" })), []);
	assert.deepEqual(parseAgyLine(JSON.stringify({ event: "step_update", step_update: { step_type: "tool", text_delta: "x" } })), []);
	const result = { status: "SUCCESS", response: "ok\n", usage: { input_tokens: 9, output_tokens: 2, cache_read_tokens: 5 } };
	assert.deepEqual(parseAgyLine(JSON.stringify({ event: "result", result })), [
		{ type: "usage", usage: { input: 9, output: 2, cacheRead: 5 } },
		{ type: "done", text: "ok\n" },
	]);
	assert.deepEqual(parseAgyLine(JSON.stringify({ event: "result", result: { status: "ERROR", error: "empty prompt" } })), [{ type: "error", message: "empty prompt" }]);
});

test("images are named, not silently dropped, in a text-only prompt", () => {
	const text = toPromptText([{ type: "text", text: "look" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "AA==" } }]);
	assert.match(text, /^look\n\n\[image omitted/);
});

test("agy model listing skips the status line and malformed rows", () => {
	const rows = parseAgyModels("Fetching available models...\ngemini-4-carbon-high\tGemini 4 Carbon (High)\nbad row\n\tno id\n");
	assert.deepEqual(rows, [{ id: "gemini-4-carbon-high", name: "Gemini 4 Carbon (High)" }]);
});

test("codex models come from its own cache, without hidden routes; a missing cache is empty", (t) => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "lh-codex-home-"));
	t.after(() => fs.rmSync(home, { recursive: true, force: true }));
	assert.deepEqual(readCodexModels(home), []);
	fs.writeFileSync(path.join(home, "models_cache.json"), JSON.stringify({ models: [
		{ slug: "gpt-6-luna", display_name: "GPT-6-Luna", context_window: 272000, visibility: "list" },
		{ slug: "codex-auto-review", visibility: "hide" },
		{ slug: "bad id with spaces", visibility: "list" },
	] }));
	assert.deepEqual(readCodexModels(home), [{ id: "gpt-6-luna", name: "GPT-6-Luna", contextWindow: 272000 }]);
});

test("extra model IDs join the discovered ones once; each CLI family gets its own model shape", () => {
	const merged = mergeCliModels([{ id: "opus" }], ["opus", "claude-custom-1"]);
	assert.deepEqual(merged.map((model) => model.id), ["opus", "claude-custom-1"]);
	const claudex = toCliModels("claudex", merged);
	assert.deepEqual(claudex.map((model) => [model.provider, model.id, model.name]), [["claudex", "opus", "Claude Opus"], ["claudex", "claude-custom-1", "claude-custom-1"]]);
	const [codex] = toCliModels("codex-cli", [{ id: "gpt-6-luna", contextWindow: 272000 }]);
	assert.equal(codex!.contextWindow, 272000);
	assert.equal(codex!.reasoning, true);
	const [agy] = toCliModels("agy-cli", [{ id: "gemini-4-carbon-high", name: "Gemini 4 Carbon (High)" }]);
	assert.equal(agy!.reasoning, false, "its model IDs already name the effort tier");
});

test("CLI settings keep known CLIs and valid fields only", () => {
	const settings = sanitizeExternalCliSettings({
		"codex-cli": { enabled: true, home: " ~/.codex-clean ", models: ["gpt-6-luna", "gpt-6-luna", "bad id", 7] },
		claudex: { enabled: "yes", home: "" },
		"unknown-cli": { enabled: true },
	});
	assert.deepEqual(settings, { claudex: {}, "codex-cli": { enabled: true, home: "~/.codex-clean", models: ["gpt-6-luna"] } });
	assert.deepEqual(sanitizeExternalCliSettings(null), {});
});

test("provider checks: every binding is CLI-billed; only Claude bindings report their own window", () => {
	for (const id of ["claude-code", "claudex", "codex-cli", "agy-cli"]) assert.ok(isExternalCliProvider(id), id);
	assert.ok(!isExternalCliProvider("openai"));
	assert.ok(isClaudeCliProvider("claudex") && isClaudeCliProvider("claude-code"));
	assert.ok(!isClaudeCliProvider("codex-cli") && !isClaudeCliProvider("agy-cli"));
	assert.ok(isExternalCliModel("agy-cli:gemini-4-carbon-high") && !isExternalCliModel("gemini-4-carbon-high"));
	assert.ok(isClaudeCliModel("claudex:fable") && !isClaudeCliModel("codex-cli:gpt-6-luna"));
});
