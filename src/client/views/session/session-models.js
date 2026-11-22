/**
 * Pure, DOM-free view-model derivation for the interactive session screen (`views §1.3`, `§2.5`).
 * Enforces `C-09` (skipping hidden MFN `graph-context` markers where `data.source === "mfn"`),
 * emits rich card descriptors (`answered-card`, `problem-card`, `conclude-card`, `thinking-card`,
 * `question-preview`, `malformed-question`), and resolves LumberJack `/objects` 64-hex `snapshotId`s.
 */
import { derivePlanStatuses, derivedNodeStatus } from "peer-engine";

const SNAPSHOT_ID_RE = /^[0-9a-f]{64}$/i;
const SAFE_IMAGE_MIME_RE = /^image\/(?:png|jpeg|jpg|gif|webp)$/i;
const QUESTION_TOOL_NAMES = new Set(["quiz", "probe", "ask_user_question", "explain", "recall"]);

export function isSnapshotId(value) {
	return typeof value === "string" && SNAPSHOT_ID_RE.test(value);
}

function asRecord(value) {
	return value && typeof value === "object" ? value : null;
}

function findSnapshotId(part) {
	const output = asRecord(part.output);
	const outputImg = asRecord(output?.image);
	const data = asRecord(part.data);
	const result = asRecord(data?.result);
	const resultImg = asRecord(result?.image);
	const input = asRecord(part.input);
	const candidates = [
		output?.snapshotId,
		outputImg?.snapshotId,
		resultImg?.snapshotId,
		part.snapshotId,
		part.type === "tool-show_image" ? input?.snapshotId : null,
	];
	for (const candidate of candidates) {
		if (isSnapshotId(candidate)) return candidate;
	}
	return null;
}

function deriveSnapshotPart(part, msgId, index, imageSnapshots) {
	const snapshotId = findSnapshotId(part);
	if (!snapshotId) return null;
	const output = asRecord(part.output);
	const input = asRecord(part.input);
	const caption = String(output?.caption ?? input?.caption ?? output?.notes ?? "").trim();
	const entry = asRecord(imageSnapshots?.[snapshotId]);
	let status = "loading";
	let image = null;
	if (entry?.status === "error") {
		status = "error";
	} else if (entry?.status === "ready" && asRecord(entry.image)) {
		status = "ready";
		image = entry.image;
	} else if (typeof entry?.data === "string" && typeof entry?.mimeType === "string") {
		status = "ready";
		image = entry;
	}
	return {
		kind: "snapshot-image",
		id: String(part.toolCallId ?? part.id ?? `${msgId}_snap_${index}`),
		partType: String(part.type),
		snapshotId,
		status,
		image,
		caption,
	};
}

function deriveGraphContextPart(part, msg) {
	const data = asRecord(part.data);
	if (data?.source === "mfn" || data?.display === false || part.display === false || msg.display === false) {
		return null;
	}
	const rawProps = Array.isArray(data?.propositions) ? data.propositions : [];
	const propositions = rawProps.map((p) => ({
		id: String(p?.id ?? ""),
		name: String(p?.name ?? ""),
		statement: String(p?.statement ?? ""),
	}));
	const rawChains = Array.isArray(data?.chains) ? data.chains : [];
	const chains = rawChains.map((c) => String(c ?? ""));
	return {
		kind: "graph-context",
		id: String(part.id ?? `gc_${msg.id}`),
		partType: "data-graph-context",
		propositions,
		chains,
	};
}

function deriveCompactionPart(part, msgId) {
	const isCut = part.type === "data-compaction-cut";
	const data = asRecord(part.data);
	const details = asRecord(data?.details);
	const tokensBefore = typeof details?.tokensBefore === "number" ? details.tokensBefore : null;
	return {
		kind: isCut ? "compaction-cut" : "compaction",
		id: String(part.id ?? msgId),
		partType: String(part.type),
		label: isCut ? "Earlier history compacted" : "Session compacted",
		content: String(data?.content ?? ""),
		tokensBefore,
		model: details?.model ? String(details.model) : null,
		at: details?.at ? String(details.at) : null,
	};
}

function summarizeAnswerValue(output) {
	if (output === null || output === undefined) return "";
	if (typeof output === "string") return output;
	const rec = asRecord(output);
	if (!rec) return String(output);
	const direct = rec.answer ?? rec.selected ?? rec.response ?? rec.summary ?? rec.text;
	if (typeof direct === "string") return direct;
	if (Array.isArray(direct)) return direct.map((v) => String(v)).join(", ");
	return "";
}

function deriveQuestionToolPart(part, id, toolName, options) {
	const toolCallId = String(part.toolCallId ?? id);
	const state = String(part.state ?? "");
	if (state === "output-available" && part.output !== undefined && part.output !== null) {
		return {
			kind: "answered-card",
			id,
			partType: String(part.type),
			toolName,
			toolCallId,
			input: part.input,
			output: part.output,
			mode: options.mode,
			adaptiveQuestions: options.adaptiveQuestions,
			availableWidth: options.availableWidth,
			appearance: options.appearance,
		};
	}
	if (state === "input-error" || state === "output-error" || part.malformed === true) {
		return {
			kind: "malformed-question",
			id,
			partType: String(part.type),
			toolName,
			toolCallId,
			sourceMessageId: part.sourceMessageId ? String(part.sourceMessageId) : undefined,
			sourceContentIndex: typeof part.sourceContentIndex === "number" ? part.sourceContentIndex : undefined,
			errorText: part.errorText ? String(part.errorText) : null,
			canRetry: options.isLastMessage !== false,
			busy: options.status === "streaming" || options.status === "submitted",
		};
	}
	return {
		kind: "question-preview",
		id,
		partType: String(part.type),
		toolName,
		toolCallId,
		state,
		input: part.input,
		mode: options.mode,
	};
}

function derivePracticeToolPart(part, id, toolName, options) {
	const input = asRecord(part.input) ?? {};
	if (toolName === "problem") {
		return {
			kind: "problem-card",
			id,
			partType: "tool-problem",
			toolCallId: String(part.toolCallId ?? id),
			statement: String(input.statement ?? input.prompt ?? ""),
			mode: options.mode,
		};
	}
	return {
		kind: "conclude-card",
		id,
		partType: "tool-conclude",
		toolCallId: String(part.toolCallId ?? id),
		input,
		problemInput: asRecord(part.problemInput) ?? {},
		reveal: typeof part.reveal === "string" ? part.reveal : String(input.solutionReveal ?? ""),
		mode: options.mode,
		nodeNames: options.nodeNames ?? null,
	};
}

function derivePluginCard(part, id, toolName) {
	const pq = asRecord(part.pluginQuestion);
	const pp = asRecord(part.pluginProblem);
	const input = asRecord(part.input);
	const prompt = String(
		input?.question ?? input?.prompt ?? input?.statement ?? input?.title ?? pq?.prompt ?? pp?.title ?? "",
	).trim();
	const answer = summarizeAnswerValue(part.output);
	const lines = [];
	if (prompt) lines.push(prompt);
	if (answer) lines.push(`Answer: ${answer}`);
	return {
		kind: "card",
		id,
		partType: String(part.type),
		cardKind: pp ? "problem" : "question",
		title: pp ? `Problem (${toolName})` : `Question (${toolName})`,
		meta: String(part.state ?? pq?.status ?? ""),
		lines,
		errorText: part.errorText ? String(part.errorText) : null,
	};
}

function deriveDataCard(part, id, options) {
	const data = asRecord(part.data);
	if (part.type === "data-practice-thinking") {
		return {
			kind: "thinking-card",
			id,
			partType: part.type,
			text: String(data?.text ?? ""),
			commit: data?.commit,
			images: Array.isArray(data?.images) ? data.images : [],
			mode: options.mode,
		};
	}
	if (part.type === "data-practice-next") {
		return { kind: "card", id, partType: part.type, cardKind: "divider", title: "Next problem", meta: "", lines: [], errorText: null };
	}
	if (part.type === "data-probe-handoff") {
		return {
			kind: "card", id, partType: part.type, cardKind: "divider",
			title: "Assessment complete — planning lesson", meta: "", lines: [], errorText: null,
		};
	}
	if (part.type === "data-plan-block") {
		const nodes = Array.isArray(data?.nodes) ? data.nodes : [];
		const lines = nodes.map((n) => `[${String(n?.status ?? "pending")}] ${String(n?.title ?? n?.id ?? "")}`);
		return { kind: "card", id, partType: part.type, cardKind: "plan", title: "Lesson plan", meta: `${nodes.length} steps`, lines, errorText: null };
	}
	if (part.type === "data-subagent-artifact" || part.type === "data-subagent-aborted") {
		const subKind = String(data?.kind ?? "job");
		const result = asRecord(data?.result);
		const detail = String(result?.title ?? result?.brief ?? result?.notes ?? data?.failure ?? "").trim();
		const aborted = part.type === "data-subagent-aborted";
		return {
			kind: "card", id, partType: part.type, cardKind: "artifact",
			title: aborted ? `Sub-agent ${subKind} aborted` : `Sub-agent ${subKind}`,
			meta: aborted ? "aborted" : "ready", lines: detail ? [detail] : [], errorText: null,
		};
	}
	const fallback = summarizeAnswerValue(data);
	return {
		kind: "card", id, partType: String(part.type), cardKind: "data",
		title: String(part.type.replace(/^data-/, "")), meta: "", lines: fallback ? [fallback] : [], errorText: null,
	};
}

function deriveStructuredPart(part, msgId, index, options) {
	const id = String(part.toolCallId ?? part.id ?? `${msgId}_part_${index}`);
	if (!part.type.startsWith("tool-")) return deriveDataCard(part, id, options);
	const toolName = part.type.slice(5);
	if (part.pluginQuestion || part.pluginProblem) return derivePluginCard(part, id, toolName);
	if (QUESTION_TOOL_NAMES.has(toolName)) return deriveQuestionToolPart(part, id, toolName, options);
	if (toolName === "problem" || toolName === "conclude") return derivePracticeToolPart(part, id, toolName, options);
	const input = asRecord(part.input);
	const summary = String(input?.path ?? input?.question ?? input?.brief ?? input?.title ?? input?.query ?? "").trim();
	return {
		kind: "card",
		id,
		partType: String(part.type),
		cardKind: "tool",
		title: `Tool: ${toolName}`,
		meta: String(part.state ?? ""),
		lines: summary ? [summary] : [],
		errorText: part.errorText ? String(part.errorText) : null,
	};
}

function deriveSinglePart(part, msg, index, totalParts, options) {
	if (!part || typeof part.type !== "string") return null;
	if (part.type === "data-graph-context") return deriveGraphContextPart(part, msg);
	if (part.type === "data-compaction-cut" || part.type === "data-compaction") {
		return deriveCompactionPart(part, msg.id);
	}
	if (part.type === "step-start") {
		if (!part.sourceMessageId || part.sourceMessageId === msg.id) return null;
		return { kind: "step-anchor", id: `step_${part.sourceMessageId}`, sourceMessageId: String(part.sourceMessageId) };
	}
	if (part.type === "reasoning") {
		const text = String(part.text ?? "");
		const streaming = Boolean(part.streaming)
			|| (options.status === "streaming" && options.isLastMessage !== false && (index === totalParts - 1 || text === ""));
		return {
			kind: "reasoning",
			id: String(part.id ?? `${msg.id}_r${index}`),
			partType: "reasoning",
			text,
			mode: options.mode,
			streaming,
		};
	}
	if (part.type === "text") {
		const streaming = Boolean(part.streaming) || (options.status === "streaming" && options.isLastMessage !== false);
		return {
			kind: "text",
			id: String(part.id ?? `${msg.id}_t${index}`),
			partType: "text",
			source: String(part.text ?? ""),
			mode: options.mode,
			streaming,
		};
	}
	const snap = deriveSnapshotPart(part, msg.id, index, options.imageSnapshots);
	if (snap) return snap;
	if (part.type === "image" && typeof part.data === "string" && SAFE_IMAGE_MIME_RE.test(String(part.mimeType ?? ""))) {
		return {
			kind: "inline-image",
			id: String(part.id ?? `${msg.id}_img${index}`),
			partType: "image",
			mimeType: String(part.mimeType),
			data: part.data,
			alt: String(part.alt ?? "Attached image"),
		};
	}
	return deriveStructuredPart(part, msg.id, index, options);
}

export function deriveTranscriptItem(message, options = {}) {
	if (!message || typeof message !== "object" || message.display === false) return null;
	const rawParts = Array.isArray(message.parts) ? message.parts : [];
	const parts = [];
	const snapshotIds = [];
	for (let i = 0; i < rawParts.length; i += 1) {
		const derived = deriveSinglePart(rawParts[i], message, i, rawParts.length, options);
		if (!derived) continue;
		parts.push(derived);
		if (derived.kind === "snapshot-image") snapshotIds.push(derived.snapshotId);
	}
	if (parts.length === 0) return null;
	const only = parts.length === 1 ? parts[0].kind : null;
	const standalone = only === "graph-context" || only === "compaction-cut" || only === "compaction";
	return {
		key: String(message.id),
		id: String(message.id),
		role: message.role === "assistant" ? "assistant" : "user",
		standalone,
		parts,
		snapshotIds,
	};
}

export function derivePlanTreeWithStatuses(tree, messages = []) {
	const rawNodes = Array.isArray(tree?.nodes) ? tree.nodes : [];
	if (rawNodes.length === 0) return null;
	const safeMsgs = Array.isArray(messages) ? messages : [];
	const derivedStatuses = derivePlanStatuses(tree, safeMsgs);
	const nodes = rawNodes.map((n) => {
		const id = String(n?.id ?? "");
		const title = String(n?.title ?? n?.label ?? id);
		const computed = derivedNodeStatus(derivedStatuses, id);
		return {
			id,
			title,
			label: String(n?.label ?? title),
			summary: n?.summary ? String(n.summary) : undefined,
			status: typeof n?.status === "string" ? n.status : computed,
		};
	});
	const rawEdges = Array.isArray(tree?.edges) ? tree.edges : [];
	const edges = rawEdges.map((e) => ({ from: String(e?.from ?? ""), to: String(e?.to ?? "") }));
	return {
		nodes,
		edges,
		version: typeof tree?.version === "number" ? tree.version : 1,
		current: derivedStatuses.current,
		visitedCount: derivedStatuses.visited.size,
	};
}

export function deriveTopBarModel(screenModel = {}) {
	const chatId = String(screenModel?.chatId ?? screenModel?.route?.id ?? "");
	const title = String(screenModel?.title || (chatId ? `Session ${chatId}` : "Session"));
	const kind = screenModel?.kind === "practice" ? "practice" : "teach";
	const compacting = Boolean(screenModel?.compacting);
	const status = String(screenModel?.status ?? "ready");
	const contextTokens = typeof screenModel?.contextTokens === "number" ? screenModel.contextTokens : null;
	let subtitle = "";
	if (compacting) subtitle = "Compacting context…";
	else if (status === "streaming") subtitle = "Streaming…";
	else if (status === "submitted") subtitle = "Starting turn…";
	const badge = contextTokens !== null ? `${contextTokens.toLocaleString("en-US")} tokens` : "";
	return { title, kind, compacting, status, contextTokens, subtitle, badge };
}

export function deriveSessionViewModel(screenModel = {}) {
	const rawLoad = screenModel?.load;
	const state = rawLoad === "ready" || rawLoad === "not-found" || rawLoad === "error" ? rawLoad : "loading";
	const chatId = String(screenModel?.chatId ?? screenModel?.route?.id ?? "");
	const mode = screenModel?.mode === "light" ? "light" : "dark";
	const status = String(screenModel?.status ?? "ready");
	const imageSnapshots = asRecord(screenModel?.imageSnapshots) ?? {};
	const appearance = asRecord(screenModel?.appearanceSettings ?? screenModel?.appearance);
	const adaptiveQuestions = appearance?.adaptiveQuestions !== false;
	const rawMessages = Array.isArray(screenModel?.messages) ? screenModel.messages : [];
	const items = [];
	for (let i = 0; i < rawMessages.length; i += 1) {
		const item = deriveTranscriptItem(rawMessages[i], {
			mode,
			status,
			imageSnapshots,
			adaptiveQuestions,
			appearance,
			isLastMessage: i === rawMessages.length - 1,
		});
		if (item) items.push(item);
	}
	return {
		state,
		chatId,
		mode,
		status,
		configured: screenModel?.configured !== false,
		isBusy: status === "submitted" || status === "streaming",
		hash: String(screenModel?.hash ?? ""),
		error: screenModel?.error ? String(screenModel.error) : null,
		turnError: screenModel?.turnError ? String(screenModel.turnError) : null,
		topBar: deriveTopBarModel(screenModel),
		items,
		planTree: derivePlanTreeWithStatuses(screenModel?.tree, rawMessages),
		pendingQuestion: asRecord(screenModel?.pendingQuestion),
		activeProblem: asRecord(screenModel?.activeProblem),
		queuedSteers: Array.isArray(screenModel?.queuedSteers) ? screenModel.queuedSteers : [],
	};
}
