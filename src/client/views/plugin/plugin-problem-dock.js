/**
 * Plugin practice problem dock (`[data-testid="plugin-problem-dock"]`,
 * `components/plugin-problem-dock.tsx` parity).
 */
import { button, createLife, documentOf, el, input, show, textNode, writeText } from "cloudcanvas-lib/ui";
import { createProblemEditorLease } from "peer-engine";
import { createMarkdown } from "../../blocks/markdown.js";
import { createDictationControl } from "../voice/dictation-control.js";

function findProblemRenderer(pluginsSnap, snapshot) {
	return (pluginsSnap?.problemRenderers ?? []).find(
		(r) => r.pluginId === snapshot.pluginId
			&& r.renderer.id === snapshot.rendererId
			&& r.renderer.supportedContractVersions.includes(snapshot.contractVersion),
	) ?? null;
}

function buildPluginProblemDom(doc, life, actions) {
	const root = el(doc, "section", { className: "peer-practice-dock", attrs: { "data-testid": "plugin-problem-dock", hidden: true } });
	const head = el(doc, "div", { className: "peer-dock-head" });
	const badgeEl = el(doc, "span", { className: "peer-dock-badge" });
	const badgeText = textNode(doc, badgeEl, "Problem");
	const headActions = el(doc, "div", { className: "peer-dock-head-actions" });
	const nextBtn = button(doc, { label: "Next problem", signal: life.signal, onClick: actions.onNext, attrs: { "data-peer-action": "next-problem" } });
	headActions.append(nextBtn, button(doc, { label: "Dismiss", signal: life.signal, onClick: actions.onDismiss, attrs: { "data-peer-action": "dismiss-problem" } }));
	head.append(badgeEl, headActions);

	const statementSlot = el(doc, "div", { className: "peer-practice-statement" });
	const statementMd = createMarkdown(statementSlot, { displayOnly: true });
	const editorSlot = el(doc, "div", { attrs: { "data-testid": "plugin-problem-editor" } });
	const unavailableEl = el(doc, "p", { className: "peer-settings-error", attrs: { hidden: true } });
	const unavailableText = textNode(doc, unavailableEl, "");
	const thinkingInput = input(doc, {
		type: "textarea", label: "Your thinking", placeholder: "Optional notes or reasoning…",
		className: "peer-practice-thinking", attrs: { "data-testid": "plugin-problem-thinking", rows: "2" },
	});
	const foot = el(doc, "div", { className: "peer-dock-foot" });
	const dictSlot = el(doc, "div");
	const submitBtn = button(doc, {
		className: "peer-practice-submit is-primary", label: "Submit solution", signal: life.signal,
		onClick: actions.onSubmit, attrs: { "data-peer-action": "submit-plugin-problem" },
	});
	foot.append(dictSlot, submitBtn);
	root.append(head, statementSlot, editorSlot, unavailableEl, thinkingInput, foot);
	return { root, badgeText, nextBtn, statementMd, editorSlot, unavailableEl, unavailableText, thinkingInput, dictSlot, submitBtn };
}

function mountProblemEditorForSnapshot(life, state, dom, snap, reg, onSaveDraft, paintControls) {
	state.clearMount();
	state.failed = false;
	if (!reg) {
		show(dom.unavailableEl, true);
		writeText(dom.unavailableText, "The plugin for this problem is unavailable. You can dismiss it to continue.");
		return;
	}
	show(dom.unavailableEl, false);
	const lease = createProblemEditorLease({
		props: { problemId: snap.problemId, prompt: snap.prompt, payload: snap.payload, submission: state.subState, active: !state.isBusy && !state.compacting, signal: life.signal, onChange: () => {} },
		publish: (nextSub) => { state.subState = nextSub; onSaveDraft?.({ snapshot: snap, patch: { submission: nextSub } }); },
		changed: paintControls,
		failed: () => { state.failed = true; show(dom.unavailableEl, true); writeText(dom.unavailableText, "Plugin problem editor failed."); paintControls(); },
	});
	state.lease = lease;
	try {
		const handle = reg.renderer.mountSubmissionEditor(dom.editorSlot, lease.props);
		if (handle && typeof handle.then === "function") handle.then((h) => lease.adopt(h), () => lease.fail());
		else lease.adopt(handle);
	} catch { lease.fail(); }
}

function syncPluginProblemUpdate(life, state, dom, onSaveDraft, paintControls, model = {}) {
	if (life.dead) return;
	const snap = model.activeProblem?.pluginProblem ?? null;
	const status = String(model.status ?? "ready");
	state.isBusy = status === "submitted" || status === "streaming";
	state.compacting = Boolean(model.compacting);
	state.dictCtl.update({ dictation: model.dictation ?? null, disabled: state.isBusy || state.compacting });
	if (!snap) {
		state.snapshot = null; state.occurrence = null; state.problemCallId = ""; state.activeKey = "";
		state.clearMount(); dom.root.hidden = true;
		return;
	}
	dom.root.hidden = false;
	state.snapshot = snap;
	state.occurrence = model.activeProblemOccurrence ?? snap.occurrence;
	state.problemCallId = String(model.activeProblem?.toolCallId ?? snap.occurrence?.toolCallId ?? "");
	writeText(dom.badgeText, snap.label || snap.toolName || "Problem");
	dom.statementMd.update({ source: snap.prompt ?? "", streaming: false, mode: model.mode === "light" ? "light" : "dark", displayOnly: true });

	const key = `${snap.problemId}:${snap.pluginId}:${snap.rendererId}`;
	const reg = findProblemRenderer(model.plugins, snap);
	if (key !== state.activeKey || (reg && !state.lease && !state.failed)) {
		state.activeKey = key;
		state.subState = model.pluginProblemDraft?.submission ?? { status: "empty" };
		dom.thinkingInput.value = model.pluginProblemDraft?.thinking ?? "";
		mountProblemEditorForSnapshot(life, state, dom, snap, reg, onSaveDraft, paintControls);
	} else {
		state.lease?.update(state.subState, !state.isBusy && !state.compacting);
	}
	paintControls();
}

export function createPluginProblemDock(host, { onSubmit, onNextProblem, onDismiss, onSaveDraft, onOpenDeepgramKey } = {}) {
	const doc = documentOf(host);
	const life = createLife();
	const state = {
		snapshot: null, occurrence: null, problemCallId: "", activeKey: "", subState: { status: "empty" },
		lease: null, isBusy: false, compacting: false, failed: false, dictCtl: null, clearMount: null,
	};
	const paintControls = () => {
		dom.submitBtn.disabled = state.compacting || state.isBusy || !state.lease?.ready;
		dom.nextBtn.disabled = state.compacting || state.isBusy;
	};
	const doSubmit = () => {
		if (!state.snapshot || !state.occurrence || dom.submitBtn.disabled || state.subState.status !== "ready") return;
		void state.dictCtl.finish().then(() => {
			if (state.subState.status !== "ready") return;
			const thinking = dom.thinkingInput.value.trim();
			onSubmit?.({ problemId: state.snapshot.problemId, occurrence: state.occurrence, submission: state.subState.value, ...(thinking ? { thinking } : {}) });
		});
	};
	const doDismiss = () => {
		if (!state.problemCallId) return false;
		onDismiss?.({ problemCallId: state.problemCallId });
		return true;
	};
	const dom = buildPluginProblemDom(doc, life, { onNext: () => onNextProblem?.(), onDismiss: doDismiss, onSubmit: doSubmit });
	state.clearMount = () => { state.lease?.dispose(); state.lease = null; dom.editorSlot.replaceChildren(); };
	state.dictCtl = createDictationControl(dom.dictSlot, {
		onTranscript: (c) => { if (state.lease?.speech) void state.lease.append(c); else { dom.thinkingInput.value = `${dom.thinkingInput.value ? `${dom.thinkingInput.value} ` : ""}${c}`; paintControls(); } },
		onOpenDeepgramKey,
	});
	dom.thinkingInput.addEventListener("input", () => { if (state.snapshot) onSaveDraft?.({ snapshot: state.snapshot, patch: { thinking: dom.thinkingInput.value } }); });
	host.append(dom.root);

	return {
		update: (model) => syncPluginProblemUpdate(life, state, dom, onSaveDraft, paintControls, model),
		focus: () => { if (!state.snapshot || dom.root.hidden) return false; state.lease?.focus(); return true; },
		dismiss: doDismiss,
		destroy: () => { if (life.destroy()) { state.clearMount(); state.dictCtl.destroy(); dom.statementMd.destroy(); dom.root.remove(); } },
	};
}
