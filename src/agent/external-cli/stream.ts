import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import {
	createAssistantMessageEventStream,
	type Api, type Message, type Model, type SimpleStreamOptions, type StreamFunction, type TranscriptContext,
} from "@earendil-works/pi-ai";

import { getLiveProcess } from "../claude-code/live-processes.ts";
import { configurationForReuse, conversationForReuse } from "../claude-code/reuse-context.ts";
import { createToolBridge, type ToolBridge } from "../claude-code/tool-bridge.ts";
import { toClaudeInput } from "../claude-code/transcript.ts";
import { CliLaunchError, toPromptText, type CliDialect, type CliLaunch } from "./dialect.ts";
import { ABORT_MESSAGE, LineCliProcess } from "./process.ts";
import { CliTurn } from "./turn.ts";

export type LineCliOptions = {
	/** The CLI's configuration home from settings, read fresh for every turn. */
	home?: () => string | undefined;
	spawnProcess?: typeof spawn;
};

type StartInput = {
	dialect: CliDialect;
	spawnProcess: typeof spawn;
	owner: symbol;
	home: string | undefined;
	model: Model<Api>;
	context: TranscriptContext;
	options: SimpleStreamOptions | undefined;
	configuration: unknown;
};

function continueLiveProcess(turn: CliTurn, owner: symbol, configuration: unknown, messages: Message[], options: SimpleStreamOptions | undefined): boolean {
	const assistantIndex = messages.findLastIndex((message) => message.role === "assistant");
	const assistant = messages[assistantIndex];
	if (assistant?.role !== "assistant") return false;
	const ids = assistant.content.flatMap((block) => block.type === "toolCall" ? [block.id] : []);
	const live = getLiveProcess(ids, owner, options?.sessionId);
	if (!(live instanceof LineCliProcess)) return false;
	if (live.consumeFailure(turn)) return true;
	const trailing = messages.slice(assistantIndex + 1);
	const results = trailing.filter((message) => message.role === "toolResult");
	if (trailing.length !== results.length || !live.canContinue(options?.sessionId, configuration, messages, results)) {
		live.kill();
		return false;
	}
	live.continueTurn(turn, messages, results, options?.signal);
	return true;
}

async function closeUnused(bridge: ToolBridge, launch?: CliLaunch): Promise<void> {
	await Promise.all([bridge.close(), launch?.cleanup()]);
}

async function startProcess(input: StartInput, turn: CliTurn): Promise<void> {
	const { dialect, options } = input;
	if (options?.signal?.aborted) { turn.fail(ABORT_MESSAGE, "aborted"); return; }
	const request = toClaudeInput(input.context.messages);
	let cli: LineCliProcess | undefined;
	const bridge = await createToolBridge(request.tools, {
		onCall: () => cli?.scheduleAdmission(),
		onError: (error) => cli?.fail(error.message),
	}, "minted", dialect.label);
	let launch: CliLaunch;
	try {
		launch = await dialect.prepare({
			model: input.model.id,
			effort: options?.reasoning,
			systemPrompt: request.systemPrompt,
			prompt: toPromptText(request.userContent),
			tools: request.tools,
			bridge: bridge.endpoint,
			home: input.home,
		});
	} catch (error) {
		await closeUnused(bridge);
		throw error;
	}
	if (options?.signal?.aborted) {
		turn.fail(ABORT_MESSAGE, "aborted");
		await closeUnused(bridge, launch);
		return;
	}
	let child: ChildProcessWithoutNullStreams;
	try {
		child = input.spawnProcess(launch.binary, launch.args, { cwd: launch.cwd, env: launch.env, stdio: "pipe" });
	} catch (error) {
		await closeUnused(bridge, launch);
		throw error;
	}
	const parts = { child, bridge, launch, dialect, owner: input.owner, sessionId: options?.sessionId, configuration: input.configuration };
	cli = new LineCliProcess(parts, turn, structuredClone(conversationForReuse(input.context.messages)));
	cli.start(options?.signal);
}

function startFailure(dialect: CliDialect, error: unknown, aborted: boolean): string {
	if (aborted) return ABORT_MESSAGE;
	return error instanceof CliLaunchError ? error.message : `${dialect.label} CLI failed to start`;
}

/** A Pi stream function over a line-oriented CLI. One child serves a model
 * turn and its tool round trips; a later turn replays the saved conversation. */
export function createLineCliStreamFunction(dialect: CliDialect, { home = () => undefined, spawnProcess = spawn }: LineCliOptions = {}): StreamFunction<Api, SimpleStreamOptions> {
	const owner = Symbol(`${dialect.id} stream owner`);
	return (model, context, options) => {
		const stream = createAssistantMessageEventStream();
		const turn = new CliTurn(stream, model);
		const cliHome = home();
		// A changed home is another account: never resume an existing child across it.
		const configuration = { request: configurationForReuse(model, context, options?.reasoning ?? ""), home: cliHome ?? null };
		if (continueLiveProcess(turn, owner, configuration, context.messages, options)) return stream;

		const input = { dialect, spawnProcess, owner, home: cliHome, model, context, options, configuration };
		startProcess(input, turn).catch((error: unknown) => {
			console.error(`${dialect.label} CLI turn failed:`, error);
			const aborted = options?.signal?.aborted === true;
			turn.fail(startFailure(dialect, error, aborted), aborted ? "aborted" : "error");
		});
		return stream;
	};
}
