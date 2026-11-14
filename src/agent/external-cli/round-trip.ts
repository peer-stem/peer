import { isDeepStrictEqual } from "node:util";

import type { Message, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";

import { conversationForReuse } from "../claude-code/reuse-context.ts";
import type { PendingToolCall, ToolBridge } from "../claude-code/tool-bridge.ts";
import type { CliTurn } from "./turn.ts";

/** Calls a CLI issues together reach the bridge within milliseconds; one
 * short wait returns them to Pi as a single batch. */
const ADMISSION_DELAY_MS = 40;

function toToolCall(call: PendingToolCall): ToolCall {
	return { type: "toolCall", id: call.id, name: call.name, arguments: call.arguments };
}

/** One tool round trip with Pi: the CLI's held requests, handed over as one
 * batch, and the conversation a continuation must extend. */
export class RoundTrip {
	private admitted: PendingToolCall[] = [];
	private timer: NodeJS.Timeout | undefined;

	constructor(private readonly bridge: ToolBridge, private conversation: unknown[], private readonly due: () => void) {}

	get ids(): string[] { return this.admitted.map((call) => call.id); }
	get size(): number { return this.admitted.length; }

	schedule(): void {
		if (this.timer) return;
		this.timer = setTimeout(() => {
			this.timer = undefined;
			this.due();
		}, ADMISSION_DELAY_MS);
	}

	stop(): void { clearTimeout(this.timer); }

	/** Every request waiting now goes to Pi; false when none is waiting. */
	handOver(turn: CliTurn): boolean {
		const pending = this.bridge.getPendingToolCalls();
		if (pending.length === 0) return false;
		this.admitted = pending;
		turn.admit(pending.map(toToolCall));
		this.conversation.push(...structuredClone(conversationForReuse([turn.getMessage()])));
		return true;
	}

	/** Pi's history extends the saved one by exactly this batch and its results. */
	continuedBy(messages: Message[], results: ToolResultMessage[]): boolean {
		const conversation = conversationForReuse(messages);
		return isDeepStrictEqual(conversation.slice(0, this.conversation.length), this.conversation)
			&& conversation.length === this.conversation.length + this.admitted.length
			&& results.length === this.admitted.length
			&& this.admitted.every((call) => results.some((result) => result.toolCallId === call.id && result.toolName === call.name));
	}

	/** Pi's results answer the held requests; a request that arrived after the
	 * hand-over is still waiting and goes into the next batch. */
	answer(messages: Message[], results: ToolResultMessage[], deliver: boolean): void {
		const admitted = this.admitted;
		this.admitted = [];
		this.conversation = structuredClone(conversationForReuse(messages));
		if (!deliver) return;
		for (const call of admitted) this.bridge.resolveToolCall(call, results.find((result) => result.toolCallId === call.id)!);
		this.schedule();
	}
}
