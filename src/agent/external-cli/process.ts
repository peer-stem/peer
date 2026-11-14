import { isDeepStrictEqual } from "node:util";

import type { Message, ToolResultMessage } from "@earendil-works/pi-ai";

import { addLiveProcess, removeLiveProcess, type LiveProcess } from "../claude-code/live-processes.ts";
import { CliChild, type CliChildParts } from "./child.ts";
import { TurnRelay } from "./relay.ts";
import { RoundTrip } from "./round-trip.ts";
import type { CliTurn } from "./turn.ts";

export { ABORT_MESSAGE } from "./relay.ts";

export type CliProcessParts = CliChildParts & { owner: symbol; sessionId: string | undefined; configuration: unknown };

/** One CLI child across the tool round trips of a single model turn. The CLI
 * runs its own loop: a tool call is a held bridge request, answered when Pi
 * calls back with the result. */
export class LineCliProcess implements LiveProcess {
	private readonly cli: CliChild;
	private readonly trip: RoundTrip;
	private readonly relay: TurnRelay;

	constructor(private readonly parts: CliProcessParts, turn: CliTurn, conversation: unknown[]) {
		this.cli = new CliChild(parts, { line: (line) => this.relay.line(line), close: (message) => { this.kill(); this.relay.close(message); } });
		this.trip = new RoundTrip(parts.bridge, conversation, () => this.admitPending());
		const owner = { stop: () => this.kill(), keep: () => addLiveProcess(this), handedOver: () => !!this.sessionId && this.trip.size > 0 };
		this.relay = new TurnRelay(turn, this.cli, parts.dialect, owner);
	}

	get owner(): symbol { return this.parts.owner; }
	get sessionId(): string | undefined { return this.parts.sessionId; }
	get toolCallIds(): string[] { return this.trip.ids; }
	/** Bridge callback: an authenticated tool request is waiting. */
	scheduleAdmission(): void { if (!this.cli.stopping) this.trip.schedule(); }
	/** A failure that arrived after the last hand-over ends this continuation. */
	consumeFailure(turn: CliTurn): boolean { return this.relay.takeFailure(turn); }
	fail(message: string): void { this.relay.fail(message); }

	start(signal: AbortSignal | undefined): void {
		this.cli.start();
		this.relay.serve(this.relay.turn, signal);
		this.cli.send(this.parts.launch.stdin);
	}

	canContinue(sessionId: string | undefined, configuration: unknown, messages: Message[], results: ToolResultMessage[]): boolean {
		return !this.cli.stopping && !!sessionId && sessionId === this.sessionId
			&& isDeepStrictEqual(configuration, this.parts.configuration) && this.trip.continuedBy(messages, results);
	}

	continueTurn(turn: CliTurn, messages: Message[], results: ToolResultMessage[], signal: AbortSignal | undefined): void {
		removeLiveProcess(this);
		this.relay.serve(turn, signal);
		this.trip.answer(messages, results, !this.cli.stopping);
	}

	kill(): void {
		removeLiveProcess(this);
		this.trip.stop();
		this.cli.kill();
	}

	private admitPending(): void {
		if (this.cli.stopping || this.relay.turn.finished || !this.trip.handOver(this.relay.turn)) return;
		if (this.sessionId) addLiveProcess(this);
		else this.kill(); // No trusted scope to resume in: return the batch, then replay fresh.
	}
}
