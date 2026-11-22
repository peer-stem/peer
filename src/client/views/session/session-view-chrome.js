/**
 * Workspace, plugin & voice companions (`C2b` + `C2c`) mounted inside `session-view.js`:
 * - `createCoverageRing` + `createPluginActionsBar` (`plugin-top-bar-actions`) in header
 * - `registerSurfaceBoundary` (`[data-session-surface-region]`) on `mainRow`
 * - `createSessionFind` (`Mod+F`), `createSideThreadCompanion` (`Mod+J`),
 *   `createCitationCommentPopover` + `createSelectionToolbar` (`Cite` / `Ask`)
 * - `createPluginQuestionDock`, `createPluginProblemDock`, and `createAutoSpeakTracker`
 */
import { el } from "cloudcanvas-lib/ui";
import {
	createInteractionScopeController,
	createPluginSessionActionContext,
	registerSurfaceBoundary,
	revealCitationSource,
} from "peer-engine";
import { createPluginActionsBar } from "../plugin/plugin-chrome.js";
import { createPluginProblemDock } from "../plugin/plugin-problem-dock.js";
import { createPluginQuestionDock } from "../plugin/plugin-question-dock.js";
import { createCoverageRing } from "../sidebar/extraction-coverage.js";
import { createAutoSpeakTracker } from "../voice/speak-button.js";
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

function buildPluginDocks(nodes, send) {
	const onOpenDeepgramKey = () => send?.({ type: "open-settings", section: "keys" });
	const pluginQuestionDock = createPluginQuestionDock(nodes.footerEl, {
		onAnswer: (payload) => send?.({ type: "answer-plugin-question", ...payload }),
		onDismiss: (payload) => send?.({ type: "dismiss-plugin-question", ...payload }),
		onSaveDraft: (payload) => send?.({ type: "save-plugin-question-draft", ...payload }),
		onOpenDeepgramKey,
	});
	const pluginProblemDock = createPluginProblemDock(nodes.footerEl, {
		onSubmit: (payload) => send?.({ type: "submit-plugin-problem", ...payload }),
		onNextProblem: () => send?.({ type: "next-problem" }),
		onDismiss: (payload) => send?.({ type: "dismiss-problem", ...payload }),
		onSaveDraft: (payload) => send?.({ type: "save-plugin-problem-draft", ...payload }),
		onOpenDeepgramKey,
	});
	nodes.footerEl.insertBefore(pluginProblemDock.focus ? nodes.footerEl.lastElementChild : nodes.footerEl.lastElementChild, nodes.composer.element());
	return { pluginQuestionDock, pluginProblemDock };
}

export function mountSessionCompanions(nodes, state, opts = {}) {
	const { send, navigate, blocks, onExpand } = opts;
	const doc = nodes.root.ownerDocument;
	const surfReg = el(doc, "div", { className: "peer-plugin-surface-region", attrs: { "data-session-surface-region": "" } });
	surfReg.append(el(doc, "div", { attrs: { "data-session-surface-mounts": "" } }));
	nodes.mainRow.style.position = "relative";
	nodes.mainRow.append(surfReg);
	const surfaceBoundary = registerSurfaceBoundary(nodes.mainRow, state.life.signal, createInteractionScopeController());

	const getScrollContext = () => ({ scrollRef: { current: nodes.transcriptWrap }, stopScroll: () => {} });
	const revealCitation = createCitationRevealer(nodes, state, getScrollContext, navigate);
	const coverageRing = createCoverageRing(nodes.headerEl, { onExtract: () => send?.({ type: "request-extract" }) });
	const pluginTopBar = createPluginActionsBar(nodes.headerEl, { location: "top-bar", testId: "plugin-top-bar-actions" });
	const sessionFind = createSessionFind(nodes.findHost, { getScope: () => nodes.transcriptEl, getScrollContext });
	const sideThread = createSideThreadCompanion({
		popoverHost: nodes.root, panelHost: nodes.sideSlot, getComposer: () => nodes.composer.element(),
		blocks, onExpand, onSideIntent: (action) => send?.({ type: "side-thread", action }), onRevealCitation: revealCitation,
	});
	const citationPopover = createCitationCommentPopover(nodes.root, {
		onSave: ({ target, citation, andSend }) => nodes.composer.replaceCitation(target, citation, andSend),
	});
	const selectionToolbar = createSelectionToolbar(nodes.root, {
		viewport: nodes.transcriptWrap, getComposer: () => nodes.composer.element(),
		onOpenCitationEditor: (target) => citationPopover.open(target),
		onOpenSideThread: (args) => sideThread.open(args),
	});
	const { pluginQuestionDock, pluginProblemDock } = buildPluginDocks(nodes, send);
	const autoSpeak = createAutoSpeakTracker({
		onSpeak: (id, text) => send?.({ type: "speech", action: { type: "speak", id, text } }),
	});
	let unregisterShortcutPage = null;

	return {
		coverageRing, pluginTopBar, sessionFind, sideThread, citationPopover, selectionToolbar,
		pluginQuestionDock, pluginProblemDock, autoSpeak, surfaceBoundary, getScrollContext,
		setShortcutReg: (fn) => { unregisterShortcutPage?.(); unregisterShortcutPage = fn; },
		navigateHref: (href) => navigateCitationHref(navigate, href),
		destroy() {
			unregisterShortcutPage?.();
			pluginProblemDock.destroy();
			pluginQuestionDock.destroy();
			selectionToolbar.destroy();
			citationPopover.destroy();
			sideThread.destroy();
			sessionFind.destroy();
			pluginTopBar.destroy();
			coverageRing.destroy();
		},
	};
}

function buildSessionActionContext(screenModel, chatId, surfaceTarget, getComposerText) {
	const kind = screenModel?.kind === "practice" ? "practice" : "teaching";
	return createPluginSessionActionContext(
		{ placement: "top-bar", surface: "session", sessionId: chatId, kind, surfaceTarget },
		() => ({
			sessionId: chatId,
			kind,
			title: String(screenModel?.title ?? ""),
			messages: Array.isArray(screenModel?.state?.nativeMessages) ? screenModel.state.nativeMessages : [],
			transcript: Array.isArray(screenModel?.messages) ? screenModel.messages : [],
			status: screenModel?.status ?? "ready",
			reconciliation: screenModel?.reconciliation ?? "ready",
			busy: Boolean(screenModel?.busy),
			compacting: Boolean(screenModel?.compacting),
			phase: screenModel?.phase ?? (kind === "practice" ? "practice" : "plan"),
			contextTokens: typeof screenModel?.contextTokens === "number" ? screenModel.contextTokens : null,
			queuedSteers: Array.isArray(screenModel?.queuedSteers) ? screenModel.queuedSteers : [],
			composer: { text: String(getComposerText?.() ?? "") },
			input: { type: "text", surfaceTarget, occurrence: { type: "composer" } },
		}),
	);
}

export function syncSessionCompanions(state, screenModel, chatId, loadState) {
	const { companions } = state;
	if (chatId !== state.lastChatId) {
		if (state.lastChatId !== "") companions.sessionFind.resetSession();
		state.lastChatId = chatId;
	}
	if (loadState !== "ready") {
		companions.coverageRing.update({ chatId, graphEnabled: false, coverage: null });
		companions.pluginTopBar.update({ plugins: null, manager: null, context: null });
		companions.selectionToolbar.update({ chatId });
		companions.sideThread.update({ chatId, sideThread: null, messages: [], mode: "dark" });
		companions.pluginQuestionDock.update({ pendingPluginQuestion: null });
		companions.pluginProblemDock.update({ activeProblem: null });
		return;
	}
	const mode = screenModel?.mode === "light" ? "light" : "dark";
	const nativeMsgs = screenModel?.state?.nativeMessages;
	const viewMsgs = Array.isArray(screenModel?.messages) ? screenModel.messages : [];
	companions.coverageRing.update({
		chatId, graphEnabled: screenModel?.graphEnabled !== false,
		chunkTokens: screenModel?.extractionChunkTokens ?? 4096, coverage: screenModel?.coverage ?? null,
	});
	const pathname = `/chat/${encodeURIComponent(chatId)}`;
	const actionCtx = buildSessionActionContext(
		screenModel, chatId, companions.surfaceBoundary.target, () => state.composer?.getText?.() ?? "",
	);
	companions.pluginTopBar.update({ plugins: screenModel?.plugins ?? null, manager: screenModel?.pluginManager ?? null, context: actionCtx });
	companions.setShortcutReg(
		screenModel?.pluginManager?.registerShortcutPage?.(pathname, () => actionCtx) ?? null,
	);
	companions.selectionToolbar.update({ chatId });
	companions.sideThread.update({ chatId, sideThread: screenModel?.sideThread, messages: Array.isArray(nativeMsgs) ? nativeMsgs : viewMsgs, mode });
	companions.autoSpeak.observe({ nextChatId: chatId, messages: viewMsgs, status: screenModel?.status, speech: screenModel?.speech });
}

export function buildProblemSnapshotMap(nativeMessages) {
	const map = new Map();
	if (!Array.isArray(nativeMessages)) return map;
	for (const msg of nativeMessages) {
		const anns = msg?.lhPluginQuestions;
		if (!anns || typeof anns !== "object") continue;
		for (const val of Object.values(anns)) {
			if (val && typeof val === "object" && typeof val.problemId === "string") map.set(val.problemId, val);
		}
	}
	return map;
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
		getPlugins: () => state.lastModel?.plugins ?? null,
		getPluginManager: () => state.lastModel?.pluginManager ?? null,
		getSpeech: () => state.lastModel?.speech ?? null,
		onSpeak: send ? (id, text) => send({ type: "speech", action: { type: "speak", id, text } }) : undefined,
		onStopSpeak: send ? () => send({ type: "speech", action: { type: "stop-speaking" } }) : undefined,
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
