/**
 * Workspace companions (`C2b`) mounted inside `session-view.js`:
 * - `createCoverageRing` in the session header
 * - `createSessionFind` (`Mod+F`) below `planHost`
 * - `createSideThreadCompanion` (`Mod+J`, popover + docked panel)
 * - `createCitationCommentPopover` + `createSelectionToolbar` (`Cite` / `Ask`)
 */
import { revealCitationSource } from "peer-engine";
import { createCoverageRing } from "../sidebar/extraction-coverage.js";
import { createCitationCommentPopover } from "./citation-popover.js";
import { createSelectionToolbar } from "./selection-toolbar.js";
import { createSessionFind } from "./session-find.js";
import { createSideThreadCompanion } from "./side-thread-panel.js";

function navigateCitationHref(navigate, href) {
	if (typeof navigate !== "function" || !href) return;
	navigate(typeof href === "object" ? href : String(href).trim());
}

function createCitationRevealer(nodes, state, getScrollContext, navigate) {
	return (citation) => {
		if (!citation) return;
		revealCitationSource({
			transcript: nodes.transcriptEl,
			scroll: getScrollContext(),
			citation,
			currentChatId: String(state.lastChatId || citation.chatId || ""),
			navigate: (href) => navigateCitationHref(navigate, href),
		});
	};
}

export function mountSessionCompanions(nodes, state, opts = {}) {
	const { send, navigate, blocks, onExpand } = opts;
	const getScrollContext = () => ({ scrollRef: { current: nodes.transcriptWrap }, stopScroll: () => {} });
	const revealCitation = createCitationRevealer(nodes, state, getScrollContext, navigate);
	const coverageRing = createCoverageRing(nodes.headerEl, { onExtract: () => send?.({ type: "request-extract" }) });
	const sessionFind = createSessionFind(nodes.findHost, { getScope: () => nodes.transcriptEl, getScrollContext });
	const sideThread = createSideThreadCompanion({
		popoverHost: nodes.root,
		panelHost: nodes.sideSlot,
		getComposer: () => nodes.composer.element(),
		blocks,
		onExpand,
		onSideIntent: (action) => send?.({ type: "side-thread", action }),
		onRevealCitation: revealCitation,
	});
	const citationPopover = createCitationCommentPopover(nodes.root, {
		onSave: ({ target, citation, andSend }) => nodes.composer.replaceCitation(target, citation, andSend),
	});
	const selectionToolbar = createSelectionToolbar(nodes.root, {
		viewport: nodes.transcriptWrap,
		getComposer: () => nodes.composer.element(),
		onOpenCitationEditor: (target) => citationPopover.open(target),
		onOpenSideThread: (args) => sideThread.open(args),
	});
	return {
		coverageRing, sessionFind, sideThread, citationPopover, selectionToolbar,
		getScrollContext,
		navigateHref: (href) => navigateCitationHref(navigate, href),
		destroy() {
			selectionToolbar.destroy();
			citationPopover.destroy();
			sideThread.destroy();
			sessionFind.destroy();
			coverageRing.destroy();
		},
	};
}

export function syncSessionCompanions(state, screenModel, chatId, loadState) {
	const { companions } = state;
	if (chatId !== state.lastChatId) {
		if (state.lastChatId !== "") companions.sessionFind.resetSession();
		state.lastChatId = chatId;
	}
	if (loadState !== "ready") {
		companions.coverageRing.update({ chatId, graphEnabled: false, coverage: null });
		companions.selectionToolbar.update({ chatId });
		companions.sideThread.update({ chatId, sideThread: null, messages: [], mode: "dark" });
		return;
	}
	const mode = screenModel?.mode === "light" ? "light" : "dark";
	const nativeMsgs = screenModel?.state?.nativeMessages;
	const viewMsgs = Array.isArray(screenModel?.messages) ? screenModel.messages : [];
	companions.coverageRing.update({
		chatId,
		graphEnabled: screenModel?.graphEnabled !== false,
		chunkTokens: screenModel?.extractionChunkTokens ?? 4096,
		coverage: screenModel?.coverage ?? null,
	});
	companions.selectionToolbar.update({ chatId });
	companions.sideThread.update({
		chatId,
		sideThread: screenModel?.sideThread,
		messages: Array.isArray(nativeMsgs) ? nativeMsgs : viewMsgs,
		mode,
	});
}

export function buildTranscriptItemContext(state, nodes, opts = {}) {
	const { send, blocks, onExpand } = opts;
	return {
		blocks,
		onExpand,
		getThinkingOpen: () => state.thinkingOpen,
		isThinkingControlled: () => state.thinkingExplicit,
		getChatId: () => state.lastChatId,
		getJobs: () => state.lastModel?.jobs ?? [],
		getMode: () => (state.lastModel?.mode === "light" ? "light" : "dark"),
		getImageSnapshot: (snapshotId) => {
			const entry = state.lastModel?.imageSnapshots?.[snapshotId];
			if (!entry) return null;
			if (entry.status === "ready" && entry.image) return entry.image;
			if (typeof entry.data === "string" && typeof entry.mimeType === "string") return entry;
			return null;
		},
		getTranscript: () => nodes.transcriptEl,
		getScrollContext: () => state.companions.getScrollContext(),
		onNavigate: (href) => state.companions.navigateHref(href),
		onInvertArtifact: (messageId, inverted) => send?.({ type: "set-artifact-inverted", messageId, inverted }),
		onSendText: (text) => send?.({ type: "send-text", text }),
		onOpenSetup: () => send?.({ type: "open-setup" }),
		onOpenSideThread: (args) => state.companions.sideThread.open(args),
		onRetryQuestion: ({ toolCallId, messageId, contentIndex }) => send?.({
			type: "retry-question",
			...(toolCallId ? { toolCallId } : {}),
			...(messageId ? { messageId } : {}),
			...(typeof contentIndex === "number" ? { contentIndex } : {}),
		}),
	};
}
