import type { Api, AssistantMessage, AssistantMessageEventStream, Model, TextContent, ToolCall } from "@earendil-works/pi-ai";

import type { CliUsage } from "../claude-code/cli-events.ts";

function createOutput(model: Model<Api>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "pending",
		timestamp: Date.now(),
	};
}

/** Pi's event order for one assistant message: `start`, content blocks, then
 * one `done` or `error` that ends the stream. */
class MessageEvents {
	readonly output: AssistantMessage;
	finished = false;
	private started = false;
	private textIndex: number | undefined;
	constructor(private readonly stream: AssistantMessageEventStream, model: Model<Api>) { this.output = createOutput(model); }

	/** Appends to the open text block, opening one; `separator` joins it to earlier text. */
	text(delta: string, separator: string): void {
		this.start();
		if (this.textIndex === undefined) {
			this.textIndex = this.output.content.length;
			this.output.content.push({ type: "text", text: "" });
			this.stream.push({ type: "text_start", contentIndex: this.textIndex, partial: this.output });
		}
		const block = this.output.content[this.textIndex] as TextContent;
		const piece = block.text ? `${separator}${delta}` : delta;
		block.text += piece;
		this.stream.push({ type: "text_delta", contentIndex: this.textIndex, delta: piece, partial: this.output });
	}

	closeText(): void {
		if (this.textIndex === undefined) return;
		const block = this.output.content[this.textIndex] as TextContent;
		this.stream.push({ type: "text_end", contentIndex: this.textIndex, content: block.text, partial: this.output });
		this.textIndex = undefined;
	}
	toolCall(call: ToolCall): void {
		this.start();
		const contentIndex = this.output.content.length;
		this.output.content.push(call);
		this.stream.push({ type: "toolcall_start", contentIndex, partial: this.output });
		this.stream.push({ type: "toolcall_end", contentIndex, toolCall: call, partial: this.output });
	}

	end(reason: "stop" | "toolUse" | "aborted" | "error", message?: string): void {
		this.finished = true;
		this.output.stopReason = reason;
		if (reason === "aborted" || reason === "error") {
			this.output.errorMessage = message;
			this.stream.push({ type: "error", reason, error: this.output });
		} else this.stream.push({ type: "done", reason, message: this.output });
		this.stream.end();
	}
	private start(): void {
		if (this.started) return;
		this.started = true;
		this.stream.push({ type: "start", partial: this.output });
	}
}

/** One Pi assistant message fed by a line-oriented CLI. Text comes from the
 * CLI's stdout; tool calls come only from the authenticated bridge. */
export class CliTurn {
	private readonly events: MessageEvents;

	constructor(stream: AssistantMessageEventStream, model: Model<Api>) {
		this.events = new MessageEvents(stream, model);
	}

	get finished(): boolean { return this.events.finished; }

	getMessage(): AssistantMessage { return this.events.output; }

	/** `paragraph` separates whole messages the CLI reports one at a time. */
	text(delta: string, paragraph = false): void {
		if (this.finished || !delta) return;
		this.events.text(delta, paragraph ? "\n\n" : "");
	}

	usage(usage: CliUsage): void {
		const total = Object.assign(this.events.output.usage, usage);
		total.totalTokens = total.input + total.output + total.cacheRead + total.cacheWrite;
	}

	admit(calls: ToolCall[]): void {
		if (this.finished) return;
		this.events.closeText();
		for (const call of calls) this.events.toolCall(call);
		this.events.end("toolUse");
	}

	/** `fallback` is the CLI's own final text, used when nothing streamed. */
	complete(fallback: string | undefined, emptyMessage: string): void {
		if (this.finished) return;
		if (this.events.output.content.length === 0 && fallback?.trim()) this.text(fallback);
		if (this.events.output.content.length === 0) {
			this.fail(emptyMessage, "error");
			return;
		}
		this.events.closeText();
		this.events.end("stop");
	}

	fail(message: string, reason: "aborted" | "error"): void {
		if (!this.finished) this.events.end(reason, message);
	}
}
