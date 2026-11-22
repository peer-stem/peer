/**
 * Interactive session screen view (`views §2.5`, `C2a §3.6`, `C2b`).
 * Composes `createTopBar`, `createHeaderRename`, `createCoverageRing`,
 * `createPlanDock`, `createSessionFind`, `createStickyScroll` (`'peer-kit'`),
 * `createSideThreadCompanion`, `createSelectionToolbar`, `createCitationCommentPopover`,
 * `createViewList`, docks, composer, stats bar, and `createAbortTurnDialog`.
 */
import { button, createLife, createStatus, documentOf, el, injectUiStyles, textNode, writeText } from "cloudcanvas-lib/ui";
import { createStickyScroll } from "peer-kit";
import { createTopBar } from "../shared/top-bar.js";
import { createViewList } from "../shared/view-list.js";
import { createAbortTurnDialog } from "./abort-turn-dialog.js";
import { createSessionComposer } from "./composer.js";
import { createPlanDock } from "./plan-dock.js";
import { createPracticeDock } from "./practice-dock.js";
import { createQuestionDock } from "./question-dock.js";
import { derivePlanTreeWithStatuses, deriveTopBarModel, deriveTranscriptItem } from "./session-models.js";
import { buildProblemSnapshotMap, buildTranscriptItemContext, mountSessionCompanions, syncSessionCompanions } from "./session-view-chrome.js";
import { injectSessionStyles } from "./session.css.js";
import { createHeaderRename, createStatsBar } from "./stats-bar.js";
import { createTranscriptItemView } from "./transcript-item.js";

function sameSnapshots(snapshotIds, nextMap, prevMap) {
	if (snapshotIds.length === 0 || nextMap === prevMap) return true;
	for (const id of snapshotIds) {
		if (nextMap?.[id] !== prevMap?.[id]) return false;
	}
	return true;
}

function resolveTranscriptMaxWidthCss(screenModel) {
	const app = screenModel?.appearanceSettings ?? screenModel?.appearance ?? null;
	const raw = app?.transcriptWidth ?? app?.transcriptMaxWidth ?? screenModel?.transcriptWidth ?? screenModel?.transcriptMaxWidth;
	if (raw === null) return "100%";
	if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) return `${raw}rem`;
	if (typeof raw === "string") {
		const trimmed = raw.trim();
		if (!trimmed) return "";
		if (trimmed.toLowerCase() === "full") return "100%";
		return /^\d+(\.\d+)?$/.test(trimmed) ? `${trimmed}rem` : trimmed;
	}
	return "";
}

function syncTranscriptMaxWidth(rootEl, screenModel) {
	const cssVal = resolveTranscriptMaxWidthCss(screenModel);
	if (cssVal) rootEl.style.setProperty("--peer-transcript-max-width", cssVal);
	else rootEl.style.removeProperty("--peer-transcript-max-width");
}

function deriveCachedItems(cache, screenModel) {
	const mode = screenModel?.mode === "light" ? "light" : "dark";
	const status = String(screenModel?.status ?? "ready");
	const imageSnapshots = screenModel?.imageSnapshots ?? {};
	const jobs = screenModel?.jobs ?? null;
	const plugins = screenModel?.plugins ?? null;
	const toolRendererNames = new Set((plugins?.toolRenderers ?? []).map((r) => r.renderer.toolName));
	const problemSnapshotsById = buildProblemSnapshotMap(screenModel?.state?.nativeMessages);
	const appearance = screenModel?.appearanceSettings ?? screenModel?.appearance ?? null;
	const adaptiveQuestions = appearance?.adaptiveQuestions !== false;
	const rawMessages = Array.isArray(screenModel?.messages) ? screenModel.messages : [];
	const nextCache = new Map();
	const items = [];
	for (let i = 0; i < rawMessages.length; i += 1) {
		const msg = rawMessages[i];
		const id = String(msg?.id ?? "");
		const isLastMessage = i === rawMessages.length - 1;
		const prev = id ? cache.get(id) : null;
		const canReuse = prev
			&& prev.rawMsg === msg
			&& prev.mode === mode
			&& prev.status === status
			&& prev.isLastMessage === isLastMessage
			&& prev.adaptiveQuestions === adaptiveQuestions
			&& prev.plugins === plugins
			&& (!prev.hasDispatch || prev.jobs === jobs)
			&& sameSnapshots(prev.snapshotIds, imageSnapshots, prev.imageSnapshots);
		const derived = canReuse
			? prev.derived
			: deriveTranscriptItem(msg, { mode, status, imageSnapshots, adaptiveQuestions, appearance, isLastMessage, toolRendererNames, problemSnapshotsById });
		const snapshotIds = derived?.snapshotIds ?? [];
		const hasDispatch = Boolean(derived?.parts?.some((p) => p.kind === "dispatch-card"));
		if (id) nextCache.set(id, { rawMsg: msg, mode, status, isLastMessage, adaptiveQuestions, plugins, imageSnapshots, snapshotIds, hasDispatch, jobs, derived });
		if (derived) items.push(derived);
	}
	cache.clear();
	for (const [k, v] of nextCache) cache.set(k, v);
	return items;
}

function scrollHashIntoView(transcriptEl, rawHash) {
	const clean = String(rawHash ?? "").replace(/^#/, "").trim();
	if (!clean) return false;
	let targetId = clean;
	try { targetId = decodeURIComponent(clean); } catch { /* keep literal */ }
	const candidates = transcriptEl.querySelectorAll("[data-peer-message-id], [data-peer-step-message-id]");
	for (const node of candidates) {
		const msgId = node.getAttribute("data-peer-message-id") ?? node.getAttribute("data-peer-step-message-id");
		if (msgId === targetId || `msg-${msgId}` === targetId) {
			node.scrollIntoView?.({ block: "start" });
			return true;
		}
	}
	return false;
}

function syncThinkingElements(transcriptEl, open) {
	for (const details of transcriptEl.querySelectorAll("[data-peer-thinking]")) {
		details.open = Boolean(open);
		const summary = details.querySelector(":scope > summary");
		if (summary?.hasAttribute("aria-expanded")) summary.setAttribute("aria-expanded", String(Boolean(open)));
	}
}

function syncSessionStatus(nodes, state, chatId, error, send) {
	if (state === "ready") {
		nodes.statusHost.hidden = true;
		nodes.mainRow.hidden = false;
		nodes.transcriptWrap.hidden = false;
		nodes.footerEl.hidden = false;
		nodes.notFoundHomeBtn.hidden = true;
		return;
	}
	nodes.statusHost.hidden = false;
	nodes.mainRow.hidden = true;
	nodes.transcriptWrap.hidden = true;
	nodes.footerEl.hidden = true;
	if (state === "loading") {
		nodes.notFoundHomeBtn.hidden = true;
		nodes.statusControl.update({ status: "loading", message: "Loading session…" });
		return;
	}
	if (state === "not-found") {
		nodes.notFoundHomeBtn.hidden = !nodes.hasNavigate;
		nodes.statusControl.update({
			status: "empty",
			labels: { empty: "Session not found" },
			message: error || `Session "${chatId}" could not be found.`,
		});
		return;
	}
	nodes.notFoundHomeBtn.hidden = true;
	nodes.statusControl.update({
		status: "error",
		message: error || "Could not load session.",
		retry: () => send?.({ type: "reload" }),
	});
}

function buildErrorBarNodes(doc, life, footerEl, send) {
	const errorBar = el(doc, "div", { className: "peer-session-error-bar", attrs: { hidden: true } });
	const turnErrorEl = el(doc, "span", {
		className: "peer-session-turn-error",
		attrs: { "data-peer-turn-error": "", hidden: true },
	});
	const turnErrorText = textNode(doc, turnErrorEl);
	const errorActions = el(doc, "div", { className: "peer-session-error-actions" });
	errorActions.append(
		button(doc, { label: "Retry", signal: life.signal, onClick: () => send?.({ type: "retry" }), attrs: { "data-peer-action": "retry-turn" } }),
		button(doc, { label: "Dismiss", signal: life.signal, onClick: () => send?.({ type: "clear-error" }), attrs: { "data-peer-action": "dismiss-error" } }),
	);
	errorBar.append(turnErrorEl, errorActions);
	footerEl.append(errorBar);
	return { errorBar, turnErrorEl, turnErrorText };
}

function buildFooterControls(doc, life, footerEl, callbacks) {
	const { send, onPickDirectory, onPickFiles } = callbacks;
	const errNodes = buildErrorBarNodes(doc, life, footerEl, send);
	const questionDock = createQuestionDock(footerEl, {
		onSubmit: ({ tool, toolCallId, questionKey, answer }) =>
			send?.({ type: "answer-question", tool, toolCallId, answer, ...(questionKey ? { questionKey } : {}) }),
		onDismiss: ({ toolCallId, questionKey, answer }) =>
			send?.({ type: "dismiss-question", toolCallId, answer, ...(questionKey ? { questionKey } : {}) }),
	});
	const practiceDock = createPracticeDock(footerEl, {
		onSubmitThinking: ({ problemCallId, text, images }) =>
			send?.({ type: "submit-thinking", problemCallId, text, ...(images ? { images } : {}) }),
		onNextProblem: () => send?.({ type: "next-problem" }),
		onDismissProblem: ({ problemCallId }) => send?.({ type: "dismiss-problem", problemCallId }),
	});
	const composer = createSessionComposer(footerEl, {
		onSend: ({ text, images }) => send?.({ type: "send-text", text, ...(images ? { images } : {}) }),
		onSteer: ({ text, images }) => send?.({ type: "steer", text, ...(images ? { images } : {}) }),
		onStop: () => send?.({ type: "stop" }),
		onOpenSetup: () => send?.({ type: "open-setup" }),
		onOpenDeepgramKey: () => send?.({ type: "open-settings", section: "keys" }),
		onPickDirectory,
		onPickFiles,
	});
	const statsBar = createStatsBar(footerEl, {
		onSaveChatSettings: (settings) => send?.({ type: "save-chat-settings", settings }),
	});
	return { ...errNodes, questionDock, practiceDock, composer, statsBar };
}

function buildSessionDom(doc, life, callbacks) {
	const root = el(doc, "section", { className: "peer-session", attrs: { "data-peer-screen": "session" } });
	const headerEl = el(doc, "div", { className: "peer-session-header" });
	const topBar = createTopBar(headerEl, {
		onToggleSidebar: callbacks.onToggleSidebar,
		onNavigateHome: callbacks.navigate ? () => callbacks.navigate({ name: "home" }) : undefined,
		onOpenSettings: callbacks.send ? () => callbacks.send({ type: "open-settings" }) : undefined,
	});
	const headerRename = createHeaderRename(headerEl, {
		onRename: (title) => callbacks.send?.({ type: "rename", title }),
	});
	const planHost = el(doc, "div", { className: "peer-session-plan-host" });
	const planDock = createPlanDock(planHost, {
		onExpand: callbacks.onExpand,
		onToggle: callbacks.send ? () => callbacks.send({ type: "toggle-plan" }) : undefined,
	});
	const findHost = el(doc, "div", { className: "peer-session-find-host" });

	const statusHost = el(doc, "div", { className: "peer-session-status" });
	const statusControl = createStatus(statusHost);
	const notFoundHomeBtn = button(doc, {
		label: "Back to Home",
		signal: life.signal,
		onClick: () => callbacks.navigate?.({ name: "home" }),
		attrs: { hidden: true },
	});
	statusHost.append(notFoundHomeBtn);

	const stickyHolder = el(doc, "div", { className: "peer-session-sticky-holder" });
	const stickyScroll = createStickyScroll(stickyHolder);
	stickyScroll.root.classList.add("peer-session-transcript-wrap");
	stickyScroll.root.setAttribute("data-peer-transcript", "");
	stickyScroll.root.hidden = true;
	stickyScroll.content.classList.add("peer-session-transcript");

	const sideSlot = el(doc, "div", { className: "peer-session-side-slot", attrs: { hidden: true } });
	const mainRow = el(doc, "div", { className: "peer-session-main-row", attrs: { hidden: true } });
	mainRow.append(stickyScroll.root, sideSlot);

	const footerEl = el(doc, "footer", { className: "peer-session-footer", attrs: { hidden: true } });
	const footerControls = buildFooterControls(doc, life, footerEl, callbacks);
	root.append(headerEl, planHost, findHost, statusHost, mainRow, footerEl);
	stickyHolder.remove();
	return {
		root, headerEl, topBar, headerRename, planDock, findHost, statusHost, statusControl, notFoundHomeBtn,
		hasNavigate: typeof callbacks.navigate === "function",
		mainRow, sideSlot, stickyScroll, transcriptWrap: stickyScroll.root, transcriptEl: stickyScroll.content,
		footerEl, ...footerControls,
	};
}

function readDockFlags(screenModel) {
	const status = String(screenModel?.status ?? "ready");
	const isBusy = status === "submitted" || status === "streaming";
	const hasBuiltinQuestion = Boolean(screenModel?.pendingQuestion && screenModel.pendingQuestion.toolCallId);
	const hasPluginQuestion = !hasBuiltinQuestion && Boolean(screenModel?.pendingPluginQuestion);
	const hasQuestion = hasBuiltinQuestion || hasPluginQuestion;
	const rawProb = screenModel?.activeProblem;
	const hasPluginProblem = !hasQuestion && Boolean(rawProb?.pluginProblem);
	const hasBuiltinProblem = !hasQuestion && !hasPluginProblem && Boolean(rawProb && (rawProb.toolCallId || rawProb.problemCallId));
	const hasProblem = hasBuiltinProblem || hasPluginProblem;
	return { status, isBusy, hasBuiltinQuestion, hasPluginQuestion, hasQuestion, hasBuiltinProblem, hasPluginProblem, hasProblem, rawProb };
}

function syncPluginDocks(companions, screenModel, flags) {
	companions.pluginQuestionDock.update({
		pendingPluginQuestion: flags.hasPluginQuestion ? screenModel.pendingPluginQuestion : null,
		pluginQuestionDraft: screenModel?.pluginQuestionDraft,
		plugins: screenModel?.plugins,
		dictation: screenModel?.dictation,
		compacting: screenModel?.compacting,
		mode: screenModel?.mode,
	});
	companions.pluginProblemDock.update({
		activeProblem: flags.hasPluginProblem ? flags.rawProb : null,
		activeProblemOccurrence: screenModel?.activeProblemOccurrence,
		pluginProblemDraft: screenModel?.pluginProblemDraft,
		plugins: screenModel?.plugins,
		dictation: screenModel?.dictation,
		compacting: screenModel?.compacting,
		status: screenModel?.status,
		mode: screenModel?.mode,
	});
}

function syncFooterAndDocks(state, screenModel, chatId) {
	const { nodes, companions } = state;
	const turnError = String(screenModel?.turnError ?? "").trim();
	writeText(nodes.turnErrorText, turnError);
	nodes.turnErrorEl.hidden = turnError === "";
	nodes.errorBar.hidden = turnError === "";

	const flags = readDockFlags(screenModel);
	nodes.questionDock.update({
		pendingQuestion: flags.hasBuiltinQuestion ? screenModel.pendingQuestion : null,
		questionDraft: screenModel?.questionDraft,
		compacting: screenModel?.compacting,
		mode: screenModel?.mode,
	});
	nodes.practiceDock.update({
		activeProblem: flags.hasBuiltinProblem ? flags.rawProb : null,
		compacting: screenModel?.compacting,
		status: screenModel?.status,
		mode: screenModel?.mode,
	});
	syncPluginDocks(companions, screenModel, flags);
	nodes.composer.update({
		chatId, configured: screenModel?.configured, status: screenModel?.status,
		compacting: screenModel?.compacting, queuedSteers: screenModel?.queuedSteers,
		openingDraft: screenModel?.openingDraft, dictation: screenModel?.dictation,
		hidden: flags.hasQuestion || flags.hasProblem,
	});
	nodes.statsBar.update({
		contextTokens: screenModel?.contextTokens ?? null, pricing: screenModel?.pricing ?? null,
		chatSettings: screenModel?.chatSettings ?? null, effectiveModel: screenModel?.effectiveModel ?? null,
		availableModels: screenModel?.availableModels ?? [],
	});
	syncAbortDialogState(state, screenModel, flags);
}

function readControlledAbortMode(screenModel) {
	if (screenModel?.abortDialogMode !== undefined) return screenModel.abortDialogMode;
	if (screenModel?.abortMode !== undefined) return screenModel.abortMode;
	return undefined;
}

function syncAbortDialogState(state, screenModel, flags) {
	const controlled = readControlledAbortMode(screenModel);
	if (controlled !== undefined) {
		state.abortControlled = screenModel?.abortDialogMode !== undefined && typeof state.send === "function";
		state.abortMode = controlled;
	} else if (
		(state.abortMode === "turn" && !flags.isBusy)
		|| (state.abortMode === "question" && !flags.hasQuestion)
		|| (state.abortMode === "problem" && !flags.hasProblem)
	) {
		state.abortMode = null;
	}
	state.abortDialog.update({ mode: state.abortMode, busy: flags.isBusy });
}

function applySessionUpdate(state, screenModel = {}) {
	if (state.life.dead || screenModel === state.lastModel) return;
	state.lastModel = screenModel;
	syncTranscriptMaxWidth(state.nodes.root, screenModel);
	if (typeof screenModel?.userThinkingOpen === "boolean" && screenModel.userThinkingOpen !== state.controlledThinking) {
		state.controlledThinking = screenModel.userThinkingOpen;
		state.thinkingOpen = screenModel.userThinkingOpen;
		state.thinkingExplicit = true;
		syncThinkingElements(state.nodes.transcriptEl, state.thinkingOpen);
	}
	const rawLoad = screenModel?.load;
	const loadState = rawLoad === "ready" || rawLoad === "not-found" || rawLoad === "error" ? rawLoad : "loading";
	const chatId = String(screenModel?.chatId ?? screenModel?.route?.id ?? "");
	const errText = screenModel?.error ? String(screenModel.error) : null;
	const topBarModel = deriveTopBarModel(screenModel);
	state.nodes.topBar.update(topBarModel);
	state.nodes.headerRename.update({ title: topBarModel.title, ready: loadState === "ready" });
	syncSessionStatus(state.nodes, loadState, chatId, errText, state.send);
	syncSessionCompanions(state, screenModel, chatId, loadState);
	if (loadState !== "ready") {
		state.nodes.planDock.update({ tree: null, open: screenModel?.planOpen });
		state.viewList.update([]);
		state.abortMode = null;
		state.abortDialog.update(null);
		return;
	}
	const rawMessages = Array.isArray(screenModel?.messages) ? screenModel.messages : [];
	state.nodes.planDock.update({
		tree: derivePlanTreeWithStatuses(screenModel?.tree, rawMessages),
		open: screenModel?.planOpen,
	});
	state.viewList.update(deriveCachedItems(state.itemCache, screenModel));
	state.nodes.stickyScroll.notifyGrowth();
	syncFooterAndDocks(state, screenModel, chatId);

	const nextHash = String(screenModel?.hash ?? "");
	if (nextHash && nextHash !== state.lastHash && scrollHashIntoView(state.nodes.transcriptEl, nextHash)) {
		state.lastHash = nextHash;
	} else if (!nextHash) {
		state.lastHash = "";
	}
}

function handleEscapeSession(state) {
	if (state.companions.citationPopover.isOpen()) {
		state.companions.citationPopover.close();
		return true;
	}
	if (state.companions.sessionFind.isOpen()) return state.companions.sessionFind.close();
	if (state.companions.sideThread.isOpen()) return state.companions.sideThread.close();
	if (state.abortDialog.isOpen()) {
		if (state.abortControlled) { state.send?.({ type: "cancel-abort" }); return true; }
		state.abortMode = null;
		state.abortDialog.update(null);
		return true;
	}
	const flags = readDockFlags(state.lastModel);
	const mode = flags.isBusy ? "turn" : flags.hasQuestion ? "question" : flags.hasProblem ? "problem" : null;
	if (!mode) return false;
	if (state.abortControlled) { state.send?.({ type: "request-abort", mode }); return true; }
	state.abortMode = mode;
	state.abortDialog.update({ mode, busy: flags.isBusy });
	return true;
}

function executeSessionCommand(state, action) {
	if (state.life.dead) return false;
	if (action === "find") return state.companions.sessionFind.open();
	if (action === "toggle-question-thread") return state.companions.sideThread.toggleCurrent();
	if (action === "toggle-user-thinking") {
		state.thinkingOpen = !state.thinkingOpen;
		state.thinkingExplicit = true;
		syncThinkingElements(state.nodes.transcriptEl, state.thinkingOpen);
		if (typeof state.lastModel?.userThinkingOpen === "boolean") state.send?.({ type: "toggle-user-thinking" });
		return true;
	}
	if (action === "focus-composer") {
		if (state.nodes.questionDock.focus()) return true;
		if (state.companions.pluginQuestionDock.focus()) return true;
		if (state.nodes.practiceDock.focus()) return true;
		if (state.companions.pluginProblemDock.focus()) return true;
		state.nodes.composer.focus();
		return true;
	}
	if (action === "toggle-dictation") return state.nodes.composer.toggleDictation();
	if (action === "escape-session") return handleEscapeSession(state);
	if (action === "rename-session") return state.nodes.headerRename.open();
	if (action === "cycle-thinking") return state.nodes.statsBar.cycleThinking();
	if (action === "open-model-picker") return state.nodes.statsBar.focusModelPicker();
	return false;
}

function mountAbortDialogForSession(root, state, nodes, send) {
	return createAbortTurnDialog(root, {
		onClose: () => {
			if (state.abortControlled) { send?.({ type: "cancel-abort" }); return; }
			state.abortMode = null;
			state.abortDialog.update(null);
		},
		onConfirm: (mode) => {
			if (state.abortControlled) { send?.({ type: "confirm-abort" }); return; }
			state.abortMode = null;
			state.abortDialog.update(null);
			if (mode === "turn") send?.({ type: "stop" });
			else if (mode === "question") { if (!nodes.questionDock.dismiss()) state.companions.pluginQuestionDock.dismiss(); }
			else if (mode === "problem") { if (!nodes.practiceDock.dismiss()) state.companions.pluginProblemDock.dismiss(); }
		},
	});
}

function destroySessionControls(state, nodes) {
	if (!state.life.destroy()) return;
	state.itemCache.clear();
	state.viewList.destroy();
	state.companions.destroy();
	state.abortDialog.destroy();
	for (const ctl of [nodes.stickyScroll, nodes.questionDock, nodes.practiceDock, nodes.composer, nodes.statsBar, nodes.planDock, nodes.headerRename, nodes.statusControl, nodes.topBar]) {
		ctl.destroy();
	}
	nodes.root.remove();
}

export function createSessionView(host, opts = {}) {
	const { send, navigate, blocks, onToggleSidebar, onExpand, onPickDirectory, onPickFiles } = opts;
	const doc = documentOf(host);
	injectUiStyles(doc);
	injectSessionStyles(doc);
	const life = createLife();
	const nodes = buildSessionDom(doc, life, { send, navigate, onToggleSidebar, onExpand, onPickDirectory, onPickFiles });
	const state = {
		life, nodes, send, thinkingOpen: false, thinkingExplicit: false, controlledThinking: undefined,
		abortControlled: false, abortMode: null, abortDialog: null, companions: null,
		lastModel: null, lastChatId: "", lastHash: "", itemCache: new Map(), viewList: null,
	};
	state.companions = mountSessionCompanions(nodes, state, { send, navigate, blocks, onExpand });
	state.abortDialog = mountAbortDialogForSession(nodes.root, state, nodes, send);
	const itemCtx = buildTranscriptItemContext(state, nodes, { send, blocks, onExpand });
	state.viewList = createViewList(nodes.transcriptEl, {
		key: (item) => item.key,
		model: (item) => item,
		itemClass: "peer-session-item",
		create: (slot) => createTranscriptItemView(slot, itemCtx),
	});
	host.append(nodes.root);
	return {
		update: (model) => applySessionUpdate(state, model),
		command: (action) => executeSessionCommand(state, action),
		destroy: () => destroySessionControls(state, nodes),
	};
}
