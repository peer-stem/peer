import * as fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import * as path from "node:path";

export type ServerSide = "next" | "api";
export type TtsStubMode = "normal" | "over-cap" | "over-cap-header" | "hold-for-abort";

export interface DeferredGate {
	promise: Promise<void>;
	resolve: () => void;
}

export interface ChatHoldHandle {
	waitStarted: (side: ServerSide) => Promise<void>;
	release: (side: ServerSide) => void;
	clear: () => void;
}

export interface TtsAbortHandle {
	waitStarted: () => Promise<void>;
	waitAborted: () => Promise<void>;
}

export interface ToolCallSpec {
	name: string;
	args: Record<string, unknown>;
}

export function createDeferred(): DeferredGate {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

export function writeCliStubs(binDir: string): void {
	fs.mkdirSync(binDir, { recursive: true, mode: 0o700 });
	const claudePath = path.join(binDir, "claude");
	const codexPath = path.join(binDir, "codex");
	const agyPath = path.join(binDir, "agy");
	fs.writeFileSync(claudePath, "#!/bin/sh\nprintf '99.0.0 (Claude Code)\\n'\n", { mode: 0o755 });
	fs.writeFileSync(codexPath, "#!/bin/sh\nprintf '99.0.0\\n'\n", { mode: 0o755 });
	const agyScript = [
		"#!/bin/sh",
		"if [ \"$1\" = \"models\" ]; then",
		"\tprintf 'stub-agy-model\\tStub Agy Model\\n'",
		"else",
		"\tprintf '99.0.0\\n'",
		"fi",
		"",
	].join("\n");
	fs.writeFileSync(agyPath, agyScript, { mode: 0o755 });
	fs.chmodSync(claudePath, 0o755);
	fs.chmodSync(codexPath, 0o755);
	fs.chmodSync(agyPath, 0o755);
}

function makeTinyWav(): Buffer {
	const pcmSamples = 8000;
	const dataBytes = pcmSamples * 2;
	const buf = Buffer.alloc(44 + dataBytes);
	buf.write("RIFF", 0, "ascii");
	buf.writeUInt32LE(36 + dataBytes, 4);
	buf.write("WAVE", 8, "ascii");
	buf.write("fmt ", 12, "ascii");
	buf.writeUInt32LE(16, 16);
	buf.writeUInt16LE(1, 20);
	buf.writeUInt16LE(1, 22);
	buf.writeUInt32LE(16000, 24);
	buf.writeUInt32LE(32000, 28);
	buf.writeUInt16LE(2, 32);
	buf.writeUInt16LE(16, 34);
	buf.write("data", 36, "ascii");
	buf.writeUInt32LE(dataBytes, 40);
	for (let i = 0; i < pcmSamples; i++) {
		buf.writeInt16LE((i % 32) * 200 - 3000, 44 + i * 2);
	}
	return buf;
}

export const FIXED_WAV = makeTinyWav();

export function readRequestBytes(req: IncomingMessage): Promise<Buffer> {
	return new Promise<Buffer>((resolve, reject) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer | string) => {
			chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
		});
		req.on("end", () => resolve(Buffer.concat(chunks)));
		req.on("error", reject);
	});
}

export function delay(ms: number): Promise<void> {
	return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export function detectExtractionToolCall(parsed: Record<string, unknown>): ToolCallSpec | null {
	const rawTools = Array.isArray(parsed.tools) ? parsed.tools : [];
	const toolNames = rawTools.flatMap((entry) => {
		if (!entry || typeof entry !== "object") return [];
		const fn = (entry as { function?: { name?: unknown } }).function;
		return typeof fn?.name === "string" ? [fn.name] : [];
	});
	if (toolNames.includes("submit_findings")) {
		const rawText = JSON.stringify(parsed.messages ?? []);
		const match = /TEACHER \[([A-Za-z0-9_-]+)\]/.exec(rawText);
		const prop: Record<string, unknown> = {
			id: "p1",
			name: "Parity extracted proposition",
			statement: "Both servers run identical extraction pipelines against the stub.",
		};
		if (match?.[1]) prop.messageId = match[1];
		return { name: "submit_findings", args: { propositions: [prop], chains: [] } };
	}
	if (toolNames.includes("submit_review")) {
		return { name: "submit_review", args: { links: [{ id: "p1", linkTo: "n_465398b5356a" }] } };
	}
	return null;
}

export function summarizeChatBody(parsed: Record<string, unknown>): Record<string, unknown> {
	const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
	return {
		model: parsed.model ?? null,
		stream: Boolean(parsed.stream),
		messageCount: messages.length,
		hasTools: Array.isArray(parsed.tools) && parsed.tools.length > 0,
	};
}

function buildToolSseChunks(model: string, toolCall: ToolCallSpec): string[] {
	const callEntry = {
		index: 0,
		id: "call_parity_0",
		type: "function",
		function: { name: toolCall.name, arguments: JSON.stringify(toolCall.args) },
	};
	const first = {
		id: "chatcmpl_parity_tool",
		object: "chat.completion.chunk",
		created: 1,
		model,
		choices: [{ index: 0, delta: { role: "assistant", tool_calls: [callEntry] }, finish_reason: null }],
	};
	const done = {
		id: "chatcmpl_parity_tool",
		object: "chat.completion.chunk",
		created: 1,
		model,
		choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
		usage: { prompt_tokens: 24, completion_tokens: 12, total_tokens: 36 },
	};
	return [`data: ${JSON.stringify(first)}\n\n`, `data: ${JSON.stringify(done)}\n\n`, "data: [DONE]\n\n"];
}

export function buildOpenAiSseChunks(model: string, toolCall: ToolCallSpec | null): string[] {
	if (toolCall) return buildToolSseChunks(model, toolCall);
	const part1 = {
		id: "chatcmpl_parity_text",
		object: "chat.completion.chunk",
		created: 1,
		model,
		choices: [{ index: 0, delta: { role: "assistant", content: "Stub parity " }, finish_reason: null }],
	};
	const part2 = {
		id: "chatcmpl_parity_text",
		object: "chat.completion.chunk",
		created: 1,
		model,
		choices: [{ index: 0, delta: { content: "model response." }, finish_reason: null }],
	};
	const stop = {
		id: "chatcmpl_parity_text",
		object: "chat.completion.chunk",
		created: 1,
		model,
		choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
		usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 },
	};
	return [
		`data: ${JSON.stringify(part1)}\n\n`,
		`data: ${JSON.stringify(part2)}\n\n`,
		`data: ${JSON.stringify(stop)}\n\n`,
		"data: [DONE]\n\n",
	];
}

function waitWritableDrain(res: ServerResponse): Promise<void> {
	return new Promise<void>((done) => {
		const finish = () => {
			res.off("drain", finish);
			res.off("close", finish);
			res.off("error", finish);
			done();
		};
		res.on("drain", finish);
		res.on("close", finish);
		res.on("error", finish);
	});
}

export async function streamOverCapWav(res: ServerResponse, overflowGate: Promise<void>): Promise<void> {
	res.writeHead(200, { "Content-Type": "audio/wav" });
	const chunk = Buffer.alloc(65_536, 0x55);
	chunk.set(FIXED_WAV.subarray(0, 44), 0);
	for (let i = 0; i < 512; i++) {
		if (res.destroyed || res.writableEnded) return;
		if (!res.write(chunk)) await waitWritableDrain(res);
	}
	await Promise.race([overflowGate, new Promise<void>((done) => res.once("close", done))]);
	for (let i = 0; i < 4; i++) {
		if (res.destroyed || res.writableEnded) return;
		if (!res.write(chunk)) await waitWritableDrain(res);
	}
	if (!res.destroyed && !res.writableEnded) res.end();
}
