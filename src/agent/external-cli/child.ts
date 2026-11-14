import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

import type { ToolBridge } from "../claude-code/tool-bridge.ts";
import type { CliDialect, CliLaunch } from "./dialect.ts";

const STDERR_LIMIT = 65_536;
const DETAIL_LIMIT = 300;
const KILL_GRACE_MS = 1000;

export type CliChildParts = { child: ChildProcessWithoutNullStreams; bridge: ToolBridge; launch: CliLaunch; dialect: CliDialect };
type ChildHandlers = { line(line: string): void; close(message: string): void };

/** The CLI's own last word, bounded: it can name a sign-in or quota problem. */
function lastWords(warning: string | undefined, stderr: string): string {
	const text = warning ?? stderr.trim().split("\n").at(-1)?.trim() ?? "";
	return text ? `: ${text.slice(0, DETAIL_LIMIT)}` : "";
}

/** The CLI child's pipes and its end: one kill escalation, one close, and one
 * release of the turn's bridge and prepared launch. */
export class CliChild {
	stopping = false;
	private closed = false;
	private stderr = "";
	private warning: string | undefined;
	private killTimer: NodeJS.Timeout | undefined;

	constructor(private readonly parts: CliChildParts, private readonly handlers: ChildHandlers) {}

	start(): void {
		const { child, dialect } = this.parts;
		child.once("close", (code: number | null) => this.close(`${dialect.label} CLI exited with code ${code}${this.detail()}`));
		child.once("error", (error) => {
			console.error(`${dialect.label} CLI process failed:`, error);
			this.close(`${dialect.label} CLI failed to start`);
		});
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk: string) => { this.stderr = (this.stderr + chunk).slice(-STDERR_LIMIT); });
		child.stdin.on("error", (error) => console.error(`${dialect.label} CLI stdin closed early:`, error));
		createInterface({ input: child.stdout }).on("line", (line) => { if (!this.stopping && line.trim()) this.handlers.line(line); });
	}

	send(text: string): void { if (!this.stopping) this.parts.child.stdin.end(`${text}\n`); }

	/** Not terminal by itself; named only if the turn then ends empty. */
	note(warning: string): void { this.warning = warning; }

	kill(): void {
		if (this.stopping || this.closed) return;
		this.stopping = true;
		this.parts.child.kill();
		this.killTimer = setTimeout(() => this.parts.child.kill("SIGKILL"), KILL_GRACE_MS);
		this.killTimer.unref();
	}

	detail(): string { return lastWords(this.warning, this.stderr); }

	private close(message: string): void {
		if (this.closed) return;
		this.closed = true;
		clearTimeout(this.killTimer);
		const { bridge, dialect, launch } = this.parts;
		if (this.stderr.trim()) console.error(`${dialect.label} CLI stderr:`, this.stderr.trim());
		this.handlers.close(message);
		Promise.all([bridge.close(), launch.cleanup()]).catch((error: unknown) => {
			console.error(`${dialect.label} CLI cleanup failed:`, error);
		});
	}
}
