/**
 * THE VIEW MODEL (Wave D, owner-approved 2026-09-26): the client's transcript
 * view — native record messages (+ the live turn's working messages) grouped
 * into today's exact render shape. The golden master is the pre-Wave-D UI
 * (owner fork 1): everything the agent produces is ONE continuous document
 * per run — step separators between the loop's steps, artifact and answered
 * cards inline, the teacher's reaction continuing below an answered quiz.
 *
 * This is the grouping canon of the deleted server-side projection
 * (core/projection.ts, Wave B), moved client-side, app-owned, with zero AI-SDK
 * types — plus the LIVE-TURN layer the projection never had: mid-turn tool
 * execution states (input-streaming → input-available/output-error/output),
 * so the dock mounts only after a call clears the validation boundary
 * (tool_execution_end) and the shimmer names the running activity.
 *
 * GROUPING RULE: one assistant view message per GROUP — consecutive assistant
 * + toolResult messages, bounded by user/marker messages; toolResults attach
 * to the tool part of their call (searching backward — an answered quiz's
 * result lands on the part that asked it, even turns later); a group's id is
 * its FIRST assistant message's id.
 *
 * Plan blocks: a plan-block marker has no message of its own — its data part
 * splices into the preceding assistant group, IN FLOW right after the last
 * successful plan_init call (the presentation moment).
 *
 * Question tools on the wire (owner fork 2): the agent's closing
 * tool_execution_end carries the in-memory "Question posed" placeholder —
 * projectView IGNORES clean question executions (the part stays
 * input-available; the learner's answer arrives as a real toolResult). The
 * placeholder never persists, so settled records never see it.
 *
 * Pure and deterministic: client-safe (no node deps), same input → same view.
 */

import type { AssistantMessage, ImageContent, ToolResultMessage } from "@earendil-works/pi-ai";
import type { LhMarkerMessage, LhMessage } from "./native-messages.ts";
import { modelSolutionForConclude, PRACTICE_CONCLUDE_TOOL, problemInputForConclude, SEND_TO_USER_TOOL, sendToUserText, pluginQuestionResultMatches } from "./native-messages.ts";
import { readPluginQuestionMessageAnnotation, readPluginQuestionCancellation, type PluginQuestionAnnotationRead } from "./plugin-questions.ts";
import { pluginProblemForCall, type PluginProblemSnapshot } from "./plugin-problems.ts";
import { activeCompactionOf } from "./compaction.ts";
import { QUESTION_TOOLS } from "./pending.ts";
import { projectMarker } from "./view-markers.ts";

/** One projected transcript part consumed by host renderers and phase/input
 * scanners. type selects the part vocabulary; common fields are optional
 * because text, tools and data parts carry different payloads. Additional
 * fields remain unknown through the index signature and require narrowing. */
export interface LhViewPart extends Record<string, unknown> {
	type: string;
	id?: string;
	text?: string;
	state?: string;
	toolCallId?: string;
	/** Native location, retained across display grouping (client-only). */
	sourceMessageId?: string;
	sourceContentIndex?: number;
	/** Must be selected before any generic tool renderer; never a raw trace. */
	pluginQuestion?: Exclude<PluginQuestionAnnotationRead, { status: "absent" }>;
	pluginProblem?: PluginProblemSnapshot;
	input?: unknown;
	output?: unknown;
	rawInput?: unknown;
	errorText?: string;
	/** Native result retained for public plugin renderers and readable fallbacks. */
	result?: Pick<ToolResultMessage, "content" | "details" | "isError">;
	data?: unknown;
}

/** A view message: user (bubble) or assistant (one continuous run). */
export interface LhViewMessage {
	id: string;
	role: "user" | "assistant";
	parts: LhViewPart[];
	/** The subagentResult meta the steer cards read (marker details). */
	metadata?: unknown;
}

/** A tool call's live execution outcome (from tool_execution_end). */
export interface LiveExecution {
	isError: boolean;
	/** The clean result's details payload (the card's output). */
	output?: unknown;
	/** The failure text (output-error parts). */
	errorText?: string;
	result?: Pick<ToolResultMessage, "content" | "details" | "isError">;
}

/** The live turn's execution layer, maintained by the session hook. */
export interface LiveTurnState {
	/** toolCallId → its execution outcome seen so far. */
	executions: ReadonlyMap<string, LiveExecution>;
	/** True while the turn runs — calls with no execution yet render
	 *  input-streaming (the shimmer); settled dangling calls render
	 *  input-available (the dock mounts from the record). */
	inFlight: boolean;
	/** Ids of the messages THIS consume is streaming (optimistic round 3,
	 *  2026-10-02): an arrived-but-empty streaming message projects one
	 *  empty reasoning part — the thinking row — so the placeholder's
	 *  handoff is seamless; settled empty messages stay hidden. */
	streamingIds: ReadonlySet<string>;
}

function textPart(text: string): LhViewPart {
	return { type: "text", text, state: "done" };
}

/** The result a tool part should show, from a native toolResult. */
function applyResult(part: LhViewPart, result: ToolResultMessage): void {
	if (part.pluginQuestion) {
		// Authored payload/error prose must never escape through generic trace.
		if (result.isError) { part.state = "output-error"; return; }
		part.state = "output-available";
		part.output = result.details;
		return;
	}
	part.result = { content: result.content, details: result.details, isError: result.isError };
	if (result.isError) {
		part.state = "output-error";
		part.rawInput = part.input;
		const text = result.content.find((c) => c.type === "text");
		part.errorText = text && text.type === "text" ? text.text : "The tool call failed.";
	} else {
		part.state = "output-available";
		part.output = result.details;
	}
}

function findToolPart(out: readonly LhViewMessage[], result: LhMessage & ToolResultMessage): LhViewPart | undefined {
	for (let i = out.length - 1; i >= 0; i--) {
		const parts = out[i]!.parts;
		for (let p = parts.length - 1; p >= 0; p--) {
			const part = parts[p]!;
			if (!part.type.startsWith("tool-") || part.toolCallId !== result.toolCallId) continue;
			if (part.pluginQuestion) {
				const occurrence = {
					messageId: part.sourceMessageId!,
					contentIndex: part.sourceContentIndex!,
					toolCallId: part.toolCallId!,
					toolName: part.type.slice(5),
				};
				if (pluginQuestionResultMatches(result, occurrence, part.pluginQuestion) || (result.isError && part.pluginQuestion.status !== "posed")) {
					return part;
				}
				continue;
			}
			if (!result.lhQuestionOccurrence && !readPluginQuestionCancellation(result.details)) return part;
		}
	}
	return undefined;
}

function projectUserMessage(m: LhMessage): LhViewMessage {
	const content = (m as { content: string | Array<{ type: string; text?: string }> }).content;
	const parts = typeof content === "string"
		? [textPart(content)]
		: content.flatMap((block): LhViewPart[] => {
			if (block.type === "text") return [textPart(block.text as string)];
			if (block.type === "image") return [{ ...(block as ImageContent) }];
			return [];
		});
	return { id: m.id, role: "user", parts };
}

function projectAssistantToolCall(
	m: LhMessage & AssistantMessage,
	contentIndex: number,
	block: { id: string; name: string; arguments?: Record<string, unknown> },
	ctx: {
		messages: readonly LhMessage[];
		live?: LiveTurnState;
		streamingMessage: boolean;
		outputErrors: ReadonlyMap<string, ToolResultMessage>;
		nextTextId: () => string;
	},
): LhViewPart | null {
	const annotation = readPluginQuestionMessageAnnotation(m, contentIndex);
	if (annotation.status !== "absent") {
		return {
			type: `tool-${block.name}`,
			toolCallId: block.id,
			sourceMessageId: m.id,
			sourceContentIndex: contentIndex,
			pluginQuestion: annotation,
			state: annotation.status === "posed" ? "input-available" : ctx.streamingMessage ? "input-streaming" : "output-error",
		};
	}
	const part = toolPartOf(block, ctx.live, ctx.streamingMessage);
	const pluginProblem = pluginProblemForCall(ctx.messages, { messageId: m.id, contentIndex, toolCallId: block.id, toolName: block.name });
	if (pluginProblem) {
		part.pluginProblem = pluginProblem;
		part.input = pluginProblem.input;
	}
	if ((QUESTION_TOOLS as readonly string[]).includes(block.name)) {
		part.sourceMessageId = m.id;
		part.sourceContentIndex = contentIndex;
	}
	if (block.name === SEND_TO_USER_TOOL) {
		if (m.stopReason === "error" || m.stopReason === "aborted") return null;
		const error = ctx.outputErrors.get(block.id);
		if (error) applyResult(part, error);
		if (part.state === "output-error") return part;
		const text = sendToUserText(block as Parameters<typeof sendToUserText>[0]);
		return text !== undefined ? { type: "text", id: ctx.nextTextId(), text, state: "done" } : null;
	}
	if (block.name === PRACTICE_CONCLUDE_TOOL) {
		part.reveal = modelSolutionForConclude(ctx.messages, block.id);
		part.problemInput = problemInputForConclude(ctx.messages, block.id);
	}
	return part;
}

function projectAssistantMessage(
	m: LhMessage & AssistantMessage,
	messages: readonly LhMessage[],
	live: LiveTurnState | undefined,
	outputErrors: ReadonlyMap<string, ToolResultMessage>,
	out: LhViewMessage[],
): void {
	const rest: LhViewPart[] = [];
	const reasoning: LhViewPart[] = [];
	let textN = 0;
	let reasoningN = 0;
	const streamingMessage = live?.streamingIds.has(m.id) === true;
	const nextTextId = () => `${m.id}-t${textN++}`;
	for (const [contentIndex, block] of m.content.entries()) {
		if (block.type === "text") {
			rest.push({ type: "text", id: nextTextId(), text: block.text, state: "done" });
		} else if (block.type === "thinking") {
			reasoning.push({ type: "reasoning", id: `${m.id}-r${reasoningN++}`, text: block.thinking, state: "done" });
		} else if (block.type === "toolCall") {
			const part = projectAssistantToolCall(m, contentIndex, block, { messages, live, streamingMessage, outputErrors, nextTextId });
			if (part) rest.push(part);
		}
	}
	const parts: LhViewPart[] = [...reasoning, ...rest];
	if (parts.length === 0) {
		if (!streamingMessage) return;
		parts.push({ type: "reasoning", id: `${m.id}-r0`, text: "", state: "done" });
	}
	const last = out[out.length - 1];
	if (last && last.role === "assistant") {
		last.parts.push({ type: "step-start", sourceMessageId: m.id }, ...parts);
	} else {
		out.push({ id: m.id, role: "assistant", parts: [{ type: "step-start", sourceMessageId: m.id }, ...parts] });
	}
}

/** Project the native record (+ live turn working list) into the client's
 *  view messages. Pure: the same input always projects to the same list. */
export function projectView(messages: readonly LhMessage[], live?: LiveTurnState): LhViewMessage[] {
	const out: LhViewMessage[] = [];
	const outputErrors = new Map<string, ToolResultMessage>();
	for (const message of messages) {
		if (message.role === "toolResult" && message.toolName === SEND_TO_USER_TOOL && message.isError) {
			outputErrors.set(message.toolCallId, message);
		}
	}
	const compaction = activeCompactionOf(messages);
	for (const m of messages) {
		const role = (m as { role?: string }).role;
		if (compaction && m.id === compaction.details.firstKeptMessageId) {
			out.push({
				id: `cut_${compaction.id}`,
				role: "user",
				parts: [{ type: "data-compaction-cut", id: `cc_${compaction.id}`, data: { content: compaction.content, details: compaction.details } }],
			});
		}
		if (role === "user") out.push(projectUserMessage(m));
		else if (role === "custom") projectMarker(m as LhMarkerMessage, out);
		else if (role === "toolResult") applyResultTo(findToolPart(out, m as LhMessage & ToolResultMessage), m as ToolResultMessage);
		else if (role === "assistant") projectAssistantMessage(m as LhMessage & AssistantMessage, messages, live, outputErrors, out);
	}
	return out;
}

/** The dock-owned tools: question tools (client-owned results — the dock
 *  mounts on the dangling call) and the practice pose (its ack is FINAL —
 *  details: null, never replaced — and the card + dock read the call's
 *  input; the placeholder must never flip the part to output-available).
 *  PRACTICE (2026-10-04): problem joins the placeholder fork; conclude is
 *  a NORMAL tool part (its result acks with no payload, details null —
 *  but the ConcludeCard reads the call's input, and output-available with
 *  output undefined renders fine). */
function isPlaceholderResultTool(name: string): boolean {
	return (QUESTION_TOOLS as readonly string[]).includes(name) || name === "problem";
}

/** A tool call block → its view part, with the live execution layer.
 * `streamingMessage` — POSITIVE EVIDENCE (owner, 2026-10-05): this call's
 * own message is streaming THIS turn. The input-streaming shimmer keys on
 * it, never on session busyness: a call from a settled message can never
 * render live, whatever else is running. */
function toolPartOf(
	block: { id: string; name: string; arguments?: unknown },
	live: LiveTurnState | undefined,
	streamingMessage: boolean,
): LhViewPart {
	const part: LhViewPart = {
		type: `tool-${block.name}`,
		toolCallId: block.id,
		input: block.arguments,
	};
	const exec = live?.executions.get(block.id);
	const isQuestion = isPlaceholderResultTool(block.name);
	if (exec) {
		if (exec.result) part.result = exec.result;
		if (exec.isError) {
			// An invalid call NEVER becomes input-available — the dock's mount
			// gate keys on the clean execution end (the live modal-realism
			// crash: a malformed quiz must never mount).
			part.state = "output-error";
			part.rawInput = block.arguments;
			part.errorText = exec.errorText ?? "The tool call failed.";
		} else if (isQuestion) {
			// Fork 2: the clean "Question posed" placeholder is IGNORED —
			// question tools are client-owned; the dock mounts on the clean
			// end, the answer arrives as a real toolResult.
			part.state = "input-available";
		} else {
			part.state = "output-available";
			part.output = exec.output;
		}
	} else {
		// No execution yet: live ONLY on positive evidence — the call's own
		// message is streaming this turn (its arguments may literally be
		// mid-write). Anything else is a dangling call from a settled
		// message — the dock's pending state, never a shimmer.
		part.state = streamingMessage ? "input-streaming" : "input-available";
	}
	return part;
}

function applyResultTo(part: LhViewPart | undefined, result: ToolResultMessage): void {
	if (part) {
		// Fork 2 (owner, Wave D): the clean "Question posed" placeholder
		// (details: null — tool-execute questionResult) is client-owned
		// question territory. The dock mounts on the dangling call; the
		// AnsweredCard renders only the learner's REAL answer (details set).
		// Flipping the part to output-available on the placeholder would hand
		// AnsweredCard a null and crash the render (the live crash, 2026-09-26).
		const tool = part.type.startsWith("tool-") ? part.type.slice("tool-".length) : part.type;
		const isQuestion = isPlaceholderResultTool(tool);
		if (!result.isError && ((isQuestion && result.details == null) || part.pluginProblem)) {
			// The placeholder fork (fork 2) stands: the clean pose/ask ack carries
			// no card data — NEVER output-available. But the call IS settled
			// (the practice bug, 2026-10-05: this early-return left the part on
			// whatever toolPartOf guessed, which mid-turn resurrected a settled
			// problem as a live spinner). input-available is the settled truth:
			// the ProblemCard reads the call's input, the dock keys on the
			// native fold — neither wants the ack's (null) payload.
			part.state = "input-available";
			return;
		}
		applyResult(part, result);
	}
	// A result with no visible part (e.g. a call whose assistant message
	// rendered nothing) is dropped from the view — the record keeps it.
}
