import type { ThinkingLevel, Tool } from "@earendil-works/pi-ai";

import type { CliUsage } from "../claude-code/cli-events.ts";
import { BRIDGE_SERVER_NAME } from "../claude-code/tool-bridge.ts";
import type { ClaudeContentBlock } from "../claude-code/transcript.ts";

export { BRIDGE_SERVER_NAME };

/** A launch refusal the learner can act on; its message is shown as is. */
export class CliLaunchError extends Error {}

export type CliLineEvent =
	| { type: "text"; delta: string; paragraph?: boolean }
	| { type: "usage"; usage: CliUsage }
	| { type: "done"; text?: string }
	/** Not terminal by itself; reported only if the turn then ends empty. */
	| { type: "warning"; message: string }
	| { type: "error"; message: string };

export type CliPrepareInput = {
	model: string;
	effort: ThinkingLevel | undefined;
	systemPrompt: string;
	prompt: string;
	tools: Tool[];
	bridge: { url: string; authorization: string };
	/** The CLI's own configuration home, when the binding names one. */
	home: string | undefined;
};

export type CliLaunch = {
	binary: string;
	args: string[];
	env: NodeJS.ProcessEnv;
	cwd: string;
	stdin: string;
	cleanup(): Promise<void>;
};

/** What differs between line-oriented CLIs: how one turn is launched in
 * isolation from the user's own agent setup, and what its stdout means. */
export interface CliDialect {
	readonly id: string;
	readonly label: string;
	prepare(input: CliPrepareInput): Promise<CliLaunch>;
	parse(line: string): CliLineEvent[];
}

export const PRIVATE_FILE_MODE = 0o600;
export const PRIVATE_DIR_MODE = 0o700;
/** A learner question holds its tool call open; the CLI must not time it out first. */
export const TOOL_TIMEOUT_SECONDS = 30 * 60;

const IMAGE_PLACEHOLDER = "[image omitted: this CLI binding passes text only]";

/** These bindings pass text; an image is named, never silently dropped. */
export function toPromptText(blocks: ClaudeContentBlock[]): string {
	return blocks.map((block) => block.type === "text" ? block.text : IMAGE_PLACEHOLDER).join("\n\n");
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function parseJsonLine(line: string): Record<string, unknown> | undefined {
	try {
		return asRecord(JSON.parse(line));
	} catch {
		return undefined;
	}
}

export function countOf(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}
