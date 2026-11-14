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

/** One JSON object per stdout line, already in the engine's event form.
 * `launchChild` replaces the scripted child, e.g. to fail the spawn. */
function harness(prepareError?: Error, launchChild: () => FakeChild = fakeChild) {
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
		const child = launchChild();
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

const CONTEXT = { systemPrompt: "p", tools: [READ_TOOL] };

/** Runs a turn until its one read call has been handed to Pi. */
async function handOver(run: ReturnType<typeof harness>, t: { after(fn: () => unknown): void }, sessionId: string | undefined) {
	const asked = collect(run.stream(MODEL, normalizeContext({ ...CONTEXT, messages: [HI] }), { sessionId }));
	const child = await waitFor(() => run.children[0]);
	const client = await bridgeClient(run.prepared[0]!);
	t.after(() => client.close());
	const call = client.callTool({ name: "read", arguments: { path: "notes.md" } }).catch((error: unknown) => error);
	const message = await asked;
	const toolCall = message.content.find((block) => block.type === "toolCall");
	assert.ok(toolCall && toolCall.type === "toolCall");
	const result: Message = { role: "toolResult", toolCallId: toolCall.id, toolName: "read", content: [{ type: "text", text: "the notes" }], isError: false, timestamp: 0 };
	return { child, client, call, message, result };
}

test("a line the engine cannot read fails the turn instead of escaping the reader", async () => {
	const { stream, children } = harness();
	const pending = collect(stream(MODEL, normalizeContext({ messages: [HI] }), { sessionId: "s" }));
	const child = await waitFor(() => children[0]);
	child.stdout.write("not json\n");
	const message = await pending;
	assert.deepEqual([message.stopReason, message.errorMessage], ["error", "Fake CLI emitted malformed output"]);
	assert.equal(child.killed, true);
});

test("a failure after the hand-over reaches the learner on the continuation, naming the CLI", async (t) => {
	const run = harness();
	const { child, client, message, result } = await handOver(run, t, "s");
	await assert.rejects(client.callTool({ name: "write", arguments: {} }), /Fake CLI requested an undeclared harness tool/);
	await waitFor(() => child.killed || undefined);
	const next = await collect(run.stream(MODEL, normalizeContext({ ...CONTEXT, messages: [HI, message, result] }), { sessionId: "s" }));
	assert.equal(next.stopReason, "error");
	assert.match(next.errorMessage ?? "", /Fake CLI requested an undeclared harness tool/);
	assert.equal(run.children.length, 1, "the failure was reported, not replayed in a new child");
});

test("a request the CLI cancels before admission never reaches Pi", async (t) => {
	const { stream, children, prepared, say } = harness();
	const pending = collect(stream(MODEL, normalizeContext({ ...CONTEXT, messages: [HI] }), { sessionId: "s" }));
	const child = await waitFor(() => children[0]);
	const client = await bridgeClient(prepared[0]!);
	t.after(() => client.close());
	const controller = new AbortController();
	const call = client.callTool({ name: "read", arguments: { path: "notes.md" } }, undefined, { signal: controller.signal }).catch((error: unknown) => error);
	controller.abort();
	await call;
	await new Promise((resolve) => setTimeout(resolve, 150));
	say(child, [{ type: "text", delta: "No tool after all." }, { type: "done" }]);
	const message = await pending;
	assert.equal(message.stopReason, "stop");
	assert.equal(message.content.some((block) => block.type === "toolCall"), false);
});

test("a synchronous spawn failure closes the bridge and removes the prepared launch", async () => {
	const run = harness(undefined, () => { throw new Error("spawn E2BIG"); });
	const message = await collect(run.stream(MODEL, normalizeContext({ ...CONTEXT, messages: [HI] }), { sessionId: "s" }));
	assert.deepEqual([message.stopReason, message.errorMessage], ["error", "Fake CLI failed to start"]);
	assert.equal(run.cleaned(), 1);
	await assert.rejects(bridgeClient(run.prepared[0]!), "the turn's bridge no longer answers");
});

test("a spawn error event fails the turn and releases the launch", async () => {
	const run = harness(undefined, () => {
		const child = fakeChild();
		setImmediate(() => child.emit("error", Object.assign(new Error("spawn fake ENOENT"), { code: "ENOENT" })));
		return child;
	});
	const message = await collect(run.stream(MODEL, normalizeContext({ messages: [HI] }), { sessionId: "s" }));
	assert.deepEqual([message.stopReason, message.errorMessage], ["error", "Fake CLI failed to start"]);
	await waitFor(() => run.cleaned() === 1 || undefined);
});

test("aborting a continuation kills the child that was waiting for its results", async (t) => {
	const run = harness();
	const { child, message, result } = await handOver(run, t, "s");
	const controller = new AbortController();
	const next = collect(run.stream(MODEL, normalizeContext({ ...CONTEXT, messages: [HI, message, result] }), { sessionId: "s", signal: controller.signal }));
	controller.abort();
	assert.equal((await next).stopReason, "aborted");
	assert.equal(child.killed, true);
	await waitFor(() => run.cleaned() === 1 || undefined);
});

test("results that do not answer the batch end the waiting child and replay in a new one", async (t) => {
	const run = harness();
	const { child, message, result } = await handOver(run, t, "s");
	const wrong = { ...result, toolCallId: "another-call" } as Message;
	const next = collect(run.stream(MODEL, normalizeContext({ ...CONTEXT, messages: [HI, message, wrong] }), { sessionId: "s" }));
	assert.equal(child.killed, true);
	const replay = await waitFor(() => run.children[1]);
	run.say(replay, [{ type: "text", delta: "Fresh." }, { type: "done" }]);
	assert.equal((await next).stopReason, "stop");
	assert.equal(run.prepared.length, 2);
});

test("without a session the child ends once its batch is handed over", async (t) => {
	const run = harness();
	const { child, message } = await handOver(run, t, undefined);
	assert.equal(message.stopReason, "toolUse");
	assert.equal(child.killed, true);
});
