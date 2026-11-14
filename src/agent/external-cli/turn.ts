import type { Api, AssistantMessage, AssistantMessageEventStream, Model, TextContent, ToolCall, Usage } from "@earendil-works/pi-ai";

export type CliUsage = Partial<Pick<Usage, "input" | "output" | "cacheRead" | "cacheWrite">>;

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

/** One Pi assistant message fed by a line-oriented CLI. Text comes from the
 * CLI's stdout; tool calls come only from the authenticated bridge. */
export class CliTurn {
	private readonly output: AssistantMessage;
	private textIndex: number | undefined;
	private started = false;
	finished = false;

	constructor(private readonly stream: AssistantMessageEventStream, model: Model<Api>) {
		this.output = createOutput(model);
	}

	getMessage(): AssistantMessage { return this.output; }

	/** `paragraph` separates whole messages the CLI reports one at a time. */
	text(delta: string, paragraph = false): void {
		if (this.finished || !delta) return;
		this.start();
		const block = this.openText();
		const piece = paragraph && block.text ? `\n\n${delta}` : delta;
		block.text += piece;
		this.stream.push({ type: "text_delta", contentIndex: this.textIndex!, delta: piece, partial: this.output });
	}

	usage(usage: CliUsage): void {
		Object.assign(this.output.usage, usage);
		const { input, output, cacheRead, cacheWrite } = this.output.usage;
		this.output.usage.totalTokens = input + output + cacheRead + cacheWrite;
	}

	admit(calls: ToolCall[]): void {
		if (this.finished) return;
		this.start();
		this.closeText();
		for (const call of calls) {
			const contentIndex = this.output.content.length;
			this.output.content.push(call);
			this.stream.push({ type: "toolcall_start", contentIndex, partial: this.output });
			this.stream.push({ type: "toolcall_end", contentIndex, toolCall: call, partial: this.output });
		}
		this.end("toolUse");
	}

	/** `fallback` is the CLI's own final text, used when nothing streamed. */
	complete(fallback: string | undefined, emptyMessage: string): void {
		if (this.finished) return;
		if (this.output.content.length === 0 && fallback?.trim()) this.text(fallback);
		if (this.output.content.length === 0) {
			this.fail(emptyMessage, "error");
			return;
		}
		this.closeText();
		this.end("stop");
	}

	fail(message: string, reason: "aborted" | "error"): void {
		if (this.finished) return;
		this.finished = true;
		this.output.stopReason = reason;
		this.output.errorMessage = message;
		this.stream.push({ type: "error", reason, error: this.output });
		this.stream.end();
	}

	private start(): void {
		if (this.started) return;
		this.started = true;
		this.stream.push({ type: "start", partial: this.output });
	}

	private openText(): TextContent {
		if (this.textIndex === undefined) {
			this.textIndex = this.output.content.length;
			this.output.content.push({ type: "text", text: "" });
			this.stream.push({ type: "text_start", contentIndex: this.textIndex, partial: this.output });
		}
		return this.output.content[this.textIndex] as TextContent;
	}

	private closeText(): void {
		if (this.textIndex === undefined) return;
		const block = this.output.content[this.textIndex] as TextContent;
		this.stream.push({ type: "text_end", contentIndex: this.textIndex, content: block.text, partial: this.output });
		this.textIndex = undefined;
	}

	private end(reason: "stop" | "toolUse"): void {
		this.finished = true;
		this.output.stopReason = reason;
		this.stream.push({ type: "done", reason, message: this.output });
		this.stream.end();
	}
}
