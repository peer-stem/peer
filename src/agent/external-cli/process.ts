import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { isDeepStrictEqual } from "node:util";

import type { Message, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";

import { addLiveProcess, removeLiveProcess, type LiveProcess } from "../claude-code/live-processes.ts";
import { conversationForReuse } from "../claude-code/reuse-context.ts";
import type { PendingToolCall, ToolBridge } from "../claude-code/tool-bridge.ts";
import type { CliDialect, CliLaunch, CliLineEvent } from "./dialect.ts";
import type { CliTurn } from "./turn.ts";

export const ABORT_MESSAGE = "Request was aborted";
/** Calls a CLI issues together reach the bridge within milliseconds; one
 * short wait returns them to Pi as a single batch. */
const ADMISSION_DELAY_MS = 40;
const STDERR_LIMIT = 65_536;
const DETAIL_LIMIT = 300;

export type CliProcessParts = {
	child: ChildProcessWithoutNullStreams;
	bridge: ToolBridge;
	launch: CliLaunch;
	dialect: CliDialect;
	owner: symbol;
	sessionId: string | undefined;
	configuration: unknown;
};

function toToolCall(call: PendingToolCall): ToolCall {
	return { type: "toolCall", id: call.id, name: call.name, arguments: call.arguments };
}

/** One CLI child across the tool round trips of a single model turn. The CLI
 * runs its own loop: a tool call is a held bridge request, answered when Pi
 * calls back with the result. */
export class LineCliProcess implements LiveProcess {
	toolCallIds: string[] = [];
	private admitted: PendingToolCall[] = [];
	private stderr = "";
	private warning: string | undefined;
	private stopping = false;
	private closed = false;
	private signal: AbortSignal | undefined;
	private admitTimer: NodeJS.Timeout | undefined;
	private killTimer: NodeJS.Timeout | undefined;

	constructor(private readonly parts: CliProcessParts, private turn: CliTurn, private conversation: unknown[]) {}

	get owner(): symbol { return this.parts.owner; }

	get sessionId(): string | undefined { return this.parts.sessionId; }

	start(signal: AbortSignal | undefined): void {
		const { child, dialect, launch } = this.parts;
		child.once("close", (code: number | null) => this.handleClose(code));
		child.once("error", (error) => {
			console.error(`${dialect.label} CLI process failed:`, error);
			this.turn.fail(`${dialect.label} CLI failed to start`, "error");
			this.handleClose(null);
		});
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk: string) => { this.stderr = (this.stderr + chunk).slice(-STDERR_LIMIT); });
		child.stdin.on("error", (error) => console.error(`${dialect.label} CLI stdin closed early:`, error));
		createInterface({ input: child.stdout }).on("line", (line) => this.handleLine(line));
		this.setSignal(signal);
		if (!this.stopping) child.stdin.end(`${launch.stdin}\n`);
	}

	/** Bridge callback: an authenticated tool request is waiting. */
	scheduleAdmission(): void {
		if (this.admitTimer || this.stopping) return;
		this.admitTimer = setTimeout(() => {
			this.admitTimer = undefined;
			this.admitPending();
		}, ADMISSION_DELAY_MS);
	}

	canContinue(sessionId: string | undefined, configuration: unknown, messages: Message[], results: ToolResultMessage[]): boolean {
		const conversation = conversationForReuse(messages);
		return !this.stopping && !!sessionId && sessionId === this.sessionId
			&& isDeepStrictEqual(configuration, this.parts.configuration)
			&& isDeepStrictEqual(conversation.slice(0, this.conversation.length), this.conversation)
			&& conversation.length === this.conversation.length + this.admitted.length
			&& results.length === this.admitted.length
			&& this.admitted.every((call) => results.some((result) => result.toolCallId === call.id && result.toolName === call.name));
	}

	continueTurn(turn: CliTurn, messages: Message[], results: ToolResultMessage[], signal: AbortSignal | undefined): void {
		removeLiveProcess(this);
		const admitted = this.admitted;
		this.admitted = [];
		this.toolCallIds = [];
		this.conversation = structuredClone(conversationForReuse(messages));
		this.turn = turn;
		this.setSignal(signal);
		if (this.stopping) return;
		for (const call of admitted) {
			this.parts.bridge.resolveToolCall(call, results.find((result) => result.toolCallId === call.id)!);
		}
		// A call that arrived after the previous batch was handed over is still waiting.
		this.scheduleAdmission();
	}

	kill(): void {
		removeLiveProcess(this);
		if (this.stopping || this.closed) return;
		this.stopping = true;
		clearTimeout(this.admitTimer);
		this.parts.child.kill();
		this.killTimer = setTimeout(() => this.parts.child.kill("SIGKILL"), 1000);
		this.killTimer.unref();
	}

	fail(message: string): void {
		this.turn.fail(message, "error");
		this.kill();
	}

	private admitPending(): void {
		if (this.stopping || this.turn.finished) return;
		const pending = this.parts.bridge.getPendingToolCalls();
		if (pending.length === 0) return;
		this.admitted = pending;
		this.toolCallIds = pending.map((call) => call.id);
		this.turn.admit(pending.map(toToolCall));
		this.conversation.push(...structuredClone(conversationForReuse([this.turn.getMessage()])));
		if (this.sessionId) addLiveProcess(this);
		else this.kill(); // No trusted scope to resume in: return the batch, then replay fresh.
	}

	private readonly abort = () => {
		this.turn.fail(ABORT_MESSAGE, "aborted");
		this.kill();
	};

	private setSignal(signal: AbortSignal | undefined): void {
		this.signal?.removeEventListener("abort", this.abort);
		this.signal = signal;
		signal?.addEventListener("abort", this.abort, { once: true });
		if (signal?.aborted) this.abort();
	}

	private handleLine(line: string): void {
		if (this.stopping || !line.trim()) return;
		for (const event of this.parts.dialect.parse(line)) this.handleEvent(event);
	}

	private handleEvent(event: CliLineEvent): void {
		switch (event.type) {
			case "text": this.turn.text(event.delta, event.paragraph); return;
			case "usage": this.turn.usage(event.usage); return;
			case "warning": this.warning = event.message; return;
			case "error": this.fail(event.message); return;
			case "done":
				this.turn.complete(event.text, this.emptyMessage());
				this.kill();
				return;
		}
	}

	/** The CLI's own last word, bounded: it can name a sign-in or quota problem. */
	private detail(): string {
		const last = this.stderr.trim().split("\n").at(-1)?.trim() ?? "";
		const text = this.warning ?? last;
		return text ? `: ${text.slice(0, DETAIL_LIMIT)}` : "";
	}

	private emptyMessage(): string {
		return `${this.parts.dialect.label} returned no response${this.detail()}`;
	}

	private handleClose(code: number | null): void {
		if (this.closed) return;
		this.closed = true;
		clearTimeout(this.killTimer);
		clearTimeout(this.admitTimer);
		removeLiveProcess(this);
		this.signal?.removeEventListener("abort", this.abort);
		const { bridge, dialect, launch } = this.parts;
		if (this.stderr.trim()) console.error(`${dialect.label} CLI stderr:`, this.stderr.trim());
		this.turn.fail(`${dialect.label} CLI exited with code ${code}${this.detail()}`, "error");
		Promise.all([bridge.close(), launch.cleanup()]).catch((error: unknown) => {
			console.error(`${dialect.label} CLI cleanup failed:`, error);
		});
	}
}
