/**
 * The line-CLI engine (src/agent/external-cli). A scripted child stands in
 * for the CLI and a real MCP client calls the real loopback bridge, the way
 * Codex and Antigravity do: tool calls reach Pi only through the bridge.
 */
import assert from "node:assert/strict";
import type { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";

import { normalizeContext, type Api, type AssistantMessage, type AssistantMessageEvent, type Message, type Model, type Tool } from "@earendil-works/pi-ai";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Type } from "typebox";

import { CliLaunchError, type CliDialect, type CliLineEvent, type CliPrepareInput } from "../src/agent/external-cli/dialect.ts";
import { createLineCliStreamFunction } from "../src/agent/external-cli/stream.ts";

const MODEL = { id: "test-model", name: "Test", provider: "codex-cli", api: "external-cli", baseUrl: "", input: ["text"], reasoning: false, contextWindow: 1000, maxTokens: 100, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } as unknown as Model<Api>;
const READ_TOOL: Tool = { name: "read", description: "Read a file", parameters: Type.Object({ path: Type.String() }) };
const HI: Message = { role: "user", content: "hi", timestamp: 0 };

type FakeChild = EventEmitter & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; kill(): boolean; killed: boolean };

function fakeChild(): FakeChild {
	const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), killed: false }) as FakeChild;
	child.kill = () => {
		if (!child.killed) setImmediate(() => child.emit("close", null));
		child.killed = true;
		return true;
	};
	return child;
}

/** One JSON object per stdout line, already in the engine's event form. */
function harness(prepareError?: Error) {
	const children: FakeChild[] = [];
	const prepared: CliPrepareInput[] = [];
	let cleaned = 0;
	const dialect: CliDialect = {
		id: "codex-cli",
		label: "Fake",
		prepare: async (input) => {
			if (prepareError) throw prepareError;
			prepared.push(input);
			return { binary: "fake", args: [], env: process.env, cwd: "/", stdin: input.prompt, cleanup: async () => { cleaned++; } };
		},
		parse: (line) => JSON.parse(line) as CliLineEvent[],
	};
	const spawnProcess = (() => {
		const child = fakeChild();
		children.push(child);
		return child;
	}) as unknown as typeof spawn;
	const stream = createLineCliStreamFunction(dialect, { spawnProcess });
	const say = (child: FakeChild, events: CliLineEvent[]) => child.stdout.write(`${JSON.stringify(events)}\n`);
	return { stream, children, prepared, say, cleaned: () => cleaned };
}

async function collect(events: AsyncIterable<AssistantMessageEvent>): Promise<AssistantMessage> {
	let last: AssistantMessage | undefined;
	for await (const event of events) {
		if (event.type === "done") last = event.message;
		if (event.type === "error") last = event.error;
	}
	assert.ok(last);
	return last;
}

async function waitFor<T>(read: () => T | undefined): Promise<T> {
	for (let attempt = 0; attempt < 400; attempt++) {
		const value = read();
		if (value !== undefined) return value;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error("timed out waiting");
}

async function bridgeClient(input: CliPrepareInput): Promise<Client> {
	const transport = new StreamableHTTPClientTransport(new URL(input.bridge.url), { requestInit: { headers: { Authorization: input.bridge.authorization } } });
	const client = new Client({ name: "fake-cli", version: "0" });
	await client.connect(transport);
	return client;
}

test("a text turn streams, takes the CLI's usage and ends the child", async () => {
	const { stream, children, prepared, say, cleaned } = harness();
	const pending = collect(stream(MODEL, normalizeContext({ systemPrompt: "You are a tutor.", messages: [HI], tools: [READ_TOOL] }), { sessionId: "s" }));
	const child = await waitFor(() => children[0]);
	assert.equal(prepared[0]!.systemPrompt, "You are a tutor.");
	assert.equal(prepared[0]!.prompt, "hi");
	say(child, [{ type: "text", delta: "Hel" }, { type: "text", delta: "lo" }]);
	say(child, [{ type: "usage", usage: { input: 5, output: 2, cacheRead: 1 } }, { type: "done" }]);
	const message = await pending;
	assert.equal(message.stopReason, "stop");
	assert.deepEqual(message.content, [{ type: "text", text: "Hello" }]);
	assert.equal(message.usage.totalTokens, 8);
	assert.equal(child.killed, true);
	await waitFor(() => cleaned() === 1 ? true : undefined);
});

test("a tool call reaches Pi only through the bridge, and its result resumes the same child", async (t) => {
	const { stream, children, prepared, say } = harness();
	const context = { systemPrompt: "p", tools: [READ_TOOL] };
	const first = collect(stream(MODEL, normalizeContext({ ...context, messages: [HI] }), { sessionId: "s" }));
	const child = await waitFor(() => children[0]);
	say(child, [{ type: "text", delta: "Let me check." }]);
	const client = await bridgeClient(prepared[0]!);
	t.after(() => client.close());
	const call = client.callTool({ name: "read", arguments: { path: "notes.md" } });
	const asked = await first;
	assert.equal(asked.stopReason, "toolUse");
	const toolCall = asked.content.find((block) => block.type === "toolCall");
	assert.ok(toolCall && toolCall.type === "toolCall");
	assert.deepEqual([toolCall.name, toolCall.arguments], ["read", { path: "notes.md" }]);

	const result: Message = { role: "toolResult", toolCallId: toolCall.id, toolName: "read", content: [{ type: "text", text: "the notes" }], isError: false, timestamp: 0 };
	const second = collect(stream(MODEL, normalizeContext({ ...context, messages: [HI, asked, result] }), { sessionId: "s" }));
	assert.deepEqual((await call).content, [{ type: "text", text: "the notes" }]);
	say(child, [{ type: "text", delta: "Done." }, { type: "done" }]);
	const answered = await second;
	assert.equal(answered.stopReason, "stop");
	assert.deepEqual(answered.content, [{ type: "text", text: "Done." }]);
	assert.equal(children.length, 1, "the continuation reused the waiting child");
});

test("a CLI that ends without output fails with its own last words", async () => {
	const { stream, children, say } = harness();
	const pending = collect(stream(MODEL, normalizeContext({ messages: [HI] }), { sessionId: "s" }));
	const child = await waitFor(() => children[0]);
	child.stderr.write("not signed in\n");
	await new Promise((resolve) => setImmediate(resolve));
	say(child, [{ type: "done" }]);
	const message = await pending;
	assert.equal(message.stopReason, "error");
	assert.match(message.errorMessage ?? "", /Fake returned no response: not signed in/);
});

test("the CLI's own final text is used when nothing streamed; a reported failure ends the turn", async () => {
	const fallback = harness();
	const done = collect(fallback.stream(MODEL, normalizeContext({ messages: [HI] }), { sessionId: "s" }));
	fallback.say(await waitFor(() => fallback.children[0]), [{ type: "done", text: "whole answer" }]);
	assert.deepEqual((await done).content, [{ type: "text", text: "whole answer" }]);

	const failing = harness();
	const failed = collect(failing.stream(MODEL, normalizeContext({ messages: [HI] }), { sessionId: "s" }));
	failing.say(await waitFor(() => failing.children[0]), [{ type: "error", message: "quota exceeded" }]);
	const message = await failed;
	assert.deepEqual([message.stopReason, message.errorMessage], ["error", "quota exceeded"]);
});

test("abort kills the child; a launch refusal reaches the learner as written", async () => {
	const { stream, children } = harness();
	const controller = new AbortController();
	const pending = collect(stream(MODEL, normalizeContext({ messages: [HI] }), { sessionId: "s", signal: controller.signal }));
	const child = await waitFor(() => children[0]);
	controller.abort();
	assert.equal((await pending).stopReason, "aborted");
	assert.equal(child.killed, true);

	const refused = harness(new CliLaunchError("Antigravity is not signed in."));
	const message = await collect(refused.stream(MODEL, normalizeContext({ messages: [HI] }), { sessionId: "s" }));
	assert.deepEqual([message.stopReason, message.errorMessage], ["error", "Antigravity is not signed in."]);
	assert.equal(refused.children.length, 0);
});
