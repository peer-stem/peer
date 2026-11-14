import type { CliChild } from "./child.ts";
import type { CliDialect, CliLineEvent } from "./dialect.ts";
import type { CliTurn } from "./turn.ts";

export const ABORT_MESSAGE = "Request was aborted";

/** What the relay needs from the process that owns the child. */
export type RelayOwner = {
	/** Ends the child. */
	stop(): void;
	/** A batch went to Pi in a session a continuation can resume. */
	handedOver(): boolean;
	/** Keeps the process findable for that continuation. */
	keep(): void;
};

/** One abort listener, moved from each turn's signal to the next. */
class AbortWatch {
	private signal: AbortSignal | undefined;

	constructor(private readonly onAbort: () => void) {}

	set(signal: AbortSignal | undefined): void {
		this.release();
		this.signal = signal;
		signal?.addEventListener("abort", this.onAbort, { once: true });
		if (signal?.aborted) this.onAbort();
	}

	release(): void { this.signal?.removeEventListener("abort", this.onAbort); }
}

/** Feeds the child's stdout into the Pi turn it currently serves. */
export class TurnRelay {
	private readonly watch = new AbortWatch(() => this.end(ABORT_MESSAGE, "aborted"));
	private pendingError: string | undefined;
	constructor(public turn: CliTurn, private readonly cli: CliChild, private readonly dialect: CliDialect, private readonly owner: RelayOwner) {}

	serve(turn: CliTurn, signal: AbortSignal | undefined): void {
		this.turn = turn;
		this.watch.set(signal);
	}
	line(line: string): void {
		try { for (const event of this.dialect.parse(line)) this.event(event); }
		catch { this.fail(`${this.dialect.label} CLI emitted malformed output`); }
	}

	/** A failure after the hand-over is kept for the continuation, which would otherwise replay silently. */
	fail(message: string): void {
		if (this.turn.finished && this.owner.handedOver()) this.pendingError = message;
		this.end(message, "error");
		if (this.pendingError) this.owner.keep();
	}

	takeFailure(turn: CliTurn): boolean {
		const message = this.pendingError;
		if (message === undefined) return false;
		this.pendingError = undefined;
		this.turn = turn;
		this.end(message, "error");
		return true;
	}

	close(message: string): void {
		this.watch.release();
		if (this.pendingError) this.owner.keep();
		this.turn.fail(message, "error");
	}
	private event(event: CliLineEvent): void {
		if (event.type === "text") this.turn.text(event.delta, event.paragraph);
		else if (event.type === "usage") this.turn.usage(event.usage);
		else if (event.type === "warning") this.cli.note(event.message);
		else if (event.type === "error") this.fail(event.message);
		// The CLI's own final text stands in when nothing streamed.
		else this.end(`${this.dialect.label} returned no response${this.cli.detail()}`, "stop", event.text);
	}

	private end(message: string, reason: "aborted" | "error" | "stop", fallback?: string): void {
		if (reason === "stop") this.turn.complete(fallback, message);
		else this.turn.fail(message, reason);
		this.owner.stop();
	}
}
