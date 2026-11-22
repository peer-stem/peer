/**
 * Plugin question dock (`[data-testid="plugin-question-dock"]`, `components/plugin-question-dock.tsx` parity).
 */
import { button, createLife, documentOf, el, input, show, textNode, writeText } from "cloudcanvas-lib/ui";
import { createQuestionEditorLease, ownPluginQuestionKeys, pluginQuestionOccurrenceKey } from "peer-engine";
import { createMarkdown } from "../../blocks/markdown.js";
import { createDictationControl } from "../voice/dictation-control.js";

function findQuestionRenderer(pluginsSnap, snapshot) {
	return (pluginsSnap?.questionRenderers ?? []).find(
		(r) => r.pluginId === snapshot.pluginId
			&& r.renderer.id === snapshot.rendererId
			&& r.renderer.supportedContractVersions.includes(snapshot.contractVersion),
	) ?? null;
}

function buildPluginQuestionDom(doc, life, onDismiss, onSubmit) {
	const root = el(doc, "section", { className: "peer-question-dock", attrs: { "data-testid": "plugin-question-dock", hidden: true } });
	const head = el(doc, "div", { className: "peer-dock-head" });
	const badgeEl = el(doc, "span", { className: "peer-dock-badge" });
	const badgeText = textNode(doc, badgeEl, "Question");
	head.append(badgeEl, button(doc, {
		className: "peer-dock-dismiss", label: "Dismiss", signal: life.signal,
		onClick: onDismiss, attrs: { "data-peer-action": "dismiss-plugin-question" },
	}));
	const promptSlot = el(doc, "div", { className: "peer-question-prompt" });
	const promptMd = createMarkdown(promptSlot, { displayOnly: true });
	const customQuestionSlot = el(doc, "div");
	const editorSlot = el(doc, "div", { attrs: { "data-testid": "plugin-question-editor" } });
	const unavailableEl = el(doc, "p", { className: "peer-settings-error", attrs: { hidden: true } });
	const unavailableText = textNode(doc, unavailableEl, "");
	const thinkingInput = input(doc, {
		type: "textarea", label: "Your thinking", placeholder: "Your thinking and reasoning…",
		className: "peer-question-thinking", attrs: { "data-testid": "plugin-question-thinking", rows: "2", hidden: true },
	});
	const foot = el(doc, "div", { className: "peer-dock-foot" });
	const dictSlot = el(doc, "div");
	const submitBtn = button(doc, {
		className: "peer-question-submit is-primary", label: "Submit answer", signal: life.signal,
		onClick: onSubmit, attrs: { "data-peer-action": "submit-plugin-answer" },
	});
	foot.append(dictSlot, submitBtn);
	root.append(head, promptSlot, customQuestionSlot, editorSlot, unavailableEl, thinkingInput, foot);
	return { root, badgeText, promptMd, customQuestionSlot, editorSlot, unavailableEl, unavailableText, thinkingInput, dictSlot, submitBtn };
}

function mountQuestionEditorForSnapshot(life, state, dom, snap, reg, onSaveDraft, paintControls) {
	state.clearMount();
	state.rendererFailed = false;
	if (!reg) {
		show(dom.unavailableEl, true);
		writeText(dom.unavailableText, "The plugin that posed this question is unavailable. You can dismiss it to continue.");
		return;
	}
	show(dom.unavailableEl, false);
	if (reg.renderer.mountQuestion) {
		const qCtrl = new AbortController();
		try {
			const clean = reg.renderer.mountQuestion(dom.customQuestionSlot, { questionId: snap.questionId, prompt: snap.prompt, payload: snap.payload, signal: qCtrl.signal });
			state.unmountQuestion = () => { qCtrl.abort(); if (typeof clean === "function") clean(); };
		} catch { /* fallback to markdown prompt */ }
	}
	const lease = createQuestionEditorLease({
		props: { questionId: snap.questionId, prompt: snap.prompt, payload: snap.payload, answer: state.answerState, active: true, signal: life.signal, onChange: () => {} },
		publish: (nextAns) => { state.answerState = nextAns; onSaveDraft?.({ snapshot: snap, patch: { answer: nextAns } }); },
		changed: paintControls,
		failed: () => { state.rendererFailed = true; show(dom.unavailableEl, true); writeText(dom.unavailableText, "Plugin question editor failed."); paintControls(); },
	});
	state.lease = lease;
	try {
		const handle = reg.renderer.mountAnswerEditor(dom.editorSlot, lease.props);
		if (handle && typeof handle.then === "function") handle.then((h) => lease.adopt(h), () => lease.fail());
		else lease.adopt(handle);
	} catch { lease.fail(); }
}

function syncPluginQuestionUpdate(life, state, dom, onSaveDraft, paintControls, model = {}) {
	if (life.dead) return;
	const snap = model.pendingPluginQuestion ?? null;
	state.compacting = Boolean(model.compacting);
	state.dictCtl.update({ dictation: model.dictation ?? null, disabled: state.compacting });
	if (!snap) {
		state.snapshot = null; state.occKey = ""; state.clearMount(); dom.root.hidden = true;
		return;
	}
	dom.root.hidden = false;
	state.snapshot = snap;
	writeText(dom.badgeText, snap.label || snap.toolName || "Question");
	const mode = model.mode === "light" ? "light" : "dark";
	dom.promptMd.update({ source: snap.prompt ?? "", streaming: false, mode, displayOnly: true });
	show(dom.thinkingInput, snap.thinkingMode !== "none");

	const key = `${pluginQuestionOccurrenceKey(snap.occurrence)}:${snap.pluginId}:${snap.rendererId}`;
	const reg = findQuestionRenderer(model.plugins, snap);
	if (key !== state.occKey || (reg && !state.lease && !state.rendererFailed)) {
		state.occKey = key;
		state.answerState = model.pluginQuestionDraft?.answer ?? { status: "empty" };
		dom.thinkingInput.value = model.pluginQuestionDraft?.thinking ?? "";
		mountQuestionEditorForSnapshot(life, state, dom, snap, reg, onSaveDraft, paintControls);
	} else {
		state.lease?.update(state.answerState, !state.compacting);
	}
	paintControls();
}

export function createPluginQuestionDock(host, { onAnswer, onDismiss, onSaveDraft, onOpenDeepgramKey } = {}) {
	const doc = documentOf(host);
	const life = createLife();
	const state = {
		snapshot: null, occKey: "", answerState: { status: "empty" }, lease: null,
		unmountQuestion: null, compacting: false, rendererFailed: false, dictCtl: null, clearMount: null,
	};
	const paintControls = () => {
		if (!state.snapshot) return;
		const reqThinking = state.snapshot.thinkingMode === "required";
		dom.submitBtn.disabled = state.compacting || !state.lease?.ready || (reqThinking && !dom.thinkingInput.value.trim());
	};
	const doSubmit = () => {
		const snap = state.snapshot;
		if (!snap || dom.submitBtn.disabled || state.answerState.status !== "ready") return;
		void state.dictCtl.finish().then(() => {
			if (state.answerState.status !== "ready") return;
			const thinking = snap.thinkingMode !== "none" ? dom.thinkingInput.value.trim() : "";
			onAnswer?.({ questionId: snap.questionId, occurrence: snap.occurrence, answer: state.answerState.value, ...(thinking ? { thinking } : {}) });
		});
	};
	const doDismiss = () => {
		if (!state.snapshot) return false;
		onDismiss?.({ occurrence: state.snapshot.occurrence, questionId: state.snapshot.questionId });
		return true;
	};
	const dom = buildPluginQuestionDom(doc, life, doDismiss, doSubmit);
	state.clearMount = () => { state.lease?.dispose(); state.lease = null; state.unmountQuestion?.(); state.unmountQuestion = null; dom.customQuestionSlot.replaceChildren(); dom.editorSlot.replaceChildren(); };
	state.dictCtl = createDictationControl(dom.dictSlot, {
		onTranscript: (c) => { if (state.lease?.speech) void state.lease.append(c); else { dom.thinkingInput.value = `${dom.thinkingInput.value ? `${dom.thinkingInput.value} ` : ""}${c}`; paintControls(); } },
		onOpenDeepgramKey,
	});
	dom.thinkingInput.addEventListener("input", () => { if (state.snapshot) onSaveDraft?.({ snapshot: state.snapshot, patch: { thinking: dom.thinkingInput.value } }); paintControls(); });
	life.on(dom.root, "keydown", (ev) => { if (state.lease) ownPluginQuestionKeys(ev, (k) => state.lease.key(k), doSubmit); });
	host.append(dom.root);

	return {
		update: (model) => syncPluginQuestionUpdate(life, state, dom, onSaveDraft, paintControls, model),
		focus: () => { if (!state.snapshot || dom.root.hidden) return false; state.lease?.focus(); return true; },
		dismiss: doDismiss,
		destroy: () => { if (life.destroy()) { state.clearMount(); state.dictCtl.destroy(); dom.promptMd.destroy(); dom.root.remove(); } },
	};
}
