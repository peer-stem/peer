import type { SideChatMessage, SideChatThread, TextSelector } from "../../../core/index.ts";

export type SideThreadAnchor =
	| { kind: "range"; range: Range }
	| { kind: "element"; element: HTMLElement }
	| { kind: "composer" };

export interface SidePassage {
	text: string;
	sourceMessageId: string;
	selector?: Omit<TextSelector, "text">;
}

export interface SideThreadOpenArgs {
	anchor: SideThreadAnchor;
	passage?: SidePassage;
	sourceMessageId?: string;
	questionCallId?: string;
}

export interface SideThreadState {
	threadId: string;
	segmentId: string;
	messages: SideChatMessage[];
	answering: boolean;
	streamText: string;
	pendingPassage?: SidePassage;
	mode: "popover" | "panel";
	anchor: SideThreadAnchor;
	error?: string;
	failedQuestion?: string;
}

export type SideThreadAction =
	| { type: "open"; segmentId: string; anchor: SideThreadAnchor; passage?: SidePassage; thread?: SideChatThread }
	| { type: "snapshot"; thread: SideChatThread; answering?: boolean; text?: string }
	| { type: "start"; threadId: string }
	| { type: "accepted"; threadId: string }
	| { type: "text"; threadId: string; text: string }
	| { type: "error"; threadId: string; error: string; question?: string }
	| { type: "done"; thread: SideChatThread }
	| { type: "mode"; mode: "popover" | "panel" }
	| { type: "close" };

function reduceSnapshotOrDone(
	state: SideThreadState,
	action: Extract<SideThreadAction, { type: "snapshot" | "done" }>,
): SideThreadState {
	const clearErr = action.type === "done"
		|| (action.answering === false && action.thread.messages.at(-1)?.role === "assistant");
	const tailPatch = action.type === "done"
		? { answering: false, streamText: "" }
		: {
			...(action.answering !== undefined ? { answering: action.answering } : {}),
			...(action.text !== undefined ? { streamText: action.text } : {}),
		};
	return {
		...state,
		messages: action.thread.messages,
		...(clearErr ? { error: undefined } : {}),
		...tailPatch,
	};
}

export function sideThreadReducer(state: SideThreadState | null, action: SideThreadAction): SideThreadState | null {
	if (action.type === "close") return null;
	if (action.type === "open") {
		const threadId = action.thread?.id ?? `side_${action.segmentId}`;
		if (state?.threadId === threadId) return { ...state, ...(action.passage ? { pendingPassage: action.passage } : {}) };
		return {
			threadId,
			segmentId: action.segmentId,
			messages: action.thread?.messages ?? [],
			answering: false,
			streamText: "",
			mode: state?.mode ?? "popover",
			anchor: action.anchor,
			pendingPassage: action.passage,
		};
	}
	if (!state) return state;
	if (action.type === "mode") return { ...state, mode: action.mode };
	const threadId = "thread" in action ? action.thread.id : action.threadId;
	if (threadId !== state.threadId) return state;
	if (action.type === "snapshot" || action.type === "done") return reduceSnapshotOrDone(state, action);
	if (action.type === "start") return { ...state, answering: true, streamText: "", error: undefined, failedQuestion: undefined };
	if (action.type === "accepted") return { ...state, pendingPassage: undefined };
	if (action.type === "text") return { ...state, answering: true, streamText: action.text };
	return { ...state, answering: false, error: action.error, failedQuestion: action.question };
}

async function readSideStreamLines(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	apply: (line: string) => void,
): Promise<void> {
	const decoder = new TextDecoder();
	let buffer = "";
	for (;;) {
		const { value, done } = await reader.read();
		if (done) {
			buffer += decoder.decode();
			if (buffer.trim()) apply(buffer);
			return;
		}
		buffer += decoder.decode(value, { stream: true });
		for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
			apply(buffer.slice(0, nl));
			buffer = buffer.slice(nl + 1);
		}
	}
}

export async function consumeSideThreadStream(options: {
	response: Response;
	isCurrent: () => boolean;
	onThread: (thread: SideChatThread, done: boolean) => void;
	onText: (text: string) => void;
}): Promise<void> {
	const { response, isCurrent, onThread, onText } = options;
	if (!isCurrent()) {
		await response.body?.cancel();
		return;
	}
	if (!response.ok) {
		const body = (await response.json().catch(() => null)) as { error?: string | { message?: string } } | null;
		throw new Error(typeof body?.error === "string" ? body.error : body?.error?.message ?? "The side conversation could not be reached.");
	}
	const reader = response.body?.getReader();
	if (!reader) throw new Error("The side answer had no response stream.");
	let terminal = false;
	const apply = (line: string) => {
		if (!line.trim() || !isCurrent()) return;
		const event = JSON.parse(line) as { type: string; thread?: SideChatThread; text?: string; error?: string };
		if (event.type === "done" || event.type === "error") terminal = true;
		if (event.thread) onThread(event.thread, event.type === "done");
		else if (event.type === "text") onText(event.text ?? "");
		else if (event.type === "error") throw new Error(event.error ?? "The side answer failed.");
	};
	try {
		await readSideStreamLines(reader, apply);
		if (!terminal && isCurrent()) {
			throw new Error("The side answer disconnected. Reopen the conversation to reconnect.");
		}
	} finally {
		reader.releaseLock();
	}
}
