/**
 * Question dock view (`[data-testid="question-dock"]`, `C2a §3.6`, `§4.1`).
 * Renders `quiz`/`probe` options with `A/B/C/D` letters, `1..9` shortcuts + confidence
 * slider, `ask_user_question` options or text input, `explain`/`recall` free-recall,
 * learner thinking input, `submit-answer`, and `dismiss-question`.
 */
import { button, createLife, documentOf, el, input, textNode, writeText } from "cloudcanvas-lib/ui";
import { createMarkdown } from "../../blocks/markdown.js";
import {
	CONFIDENCE_STOPS,
	DEFAULT_CONFIDENCE,
	OPTION_LETTERS,
	buildDismissedAnswer,
	buildQuestionAnswer,
	deriveQuestionData,
} from "./question-grading.js";

function formatKindBadge(qd) {
	if (qd.tool === "probe") return "Probe";
	if (qd.tool === "recall") return "Recall";
	if (qd.kind === "quiz") return qd.questionType === "predict" ? "Prediction" : "Quiz";
	if (qd.kind === "explain") return "Explain";
	return "Question";
}

function isTypingElement(target) {
	if (!target || typeof target.tagName !== "string") return false;
	const tag = target.tagName.toUpperCase();
	if (tag === "TEXTAREA" || tag === "SELECT") return true;
	if (tag === "INPUT" && String(target.type).toLowerCase() !== "range") return true;
	return Boolean(target.isContentEditable);
}

function canSubmitQuestion(qd, state) {
	if (!qd || state.compacting) return false;
	if (qd.mode === "text") {
		const ans = state.nodes.answerInput.value.trim();
		const thk = state.nodes.thinkingInput.value.trim();
		return ans.length > 0 || thk.length > 0;
	}
	if (state.dontKnow) return true;
	if (state.otherSelected && state.nodes.otherInput.value.trim().length > 0) return true;
	return state.selected.size > 0;
}

function buildQuestionHeaderNodes(doc, life, actions) {
	const head = el(doc, "div", { className: "peer-dock-head" });
	const badgeEl = el(doc, "span", { className: "peer-dock-badge" });
	const badgeText = textNode(doc, badgeEl, "Question");
	const dismissBtn = button(doc, {
		className: "peer-dock-dismiss",
		label: "Dismiss",
		signal: life.signal,
		onClick: () => actions.dismiss(),
		attrs: { "data-peer-action": "dismiss-question" },
	});
	head.append(badgeEl, dismissBtn);

	const confirmBar = el(doc, "div", {
		className: "peer-dock-confirm",
		attrs: { "data-peer-dismiss-confirm": "", hidden: true },
	});
	confirmBar.append(
		el(doc, "span", { text: "Skip this question?" }),
		button(doc, {
			label: "Skip question",
			signal: life.signal,
			onClick: () => actions.dismiss(),
			attrs: { "data-peer-action": "confirm-dismiss" },
		}),
		button(doc, {
			label: "Keep answering",
			signal: life.signal,
			onClick: () => actions.closeConfirm(),
			attrs: { "data-peer-action": "cancel-dismiss" },
		}),
	);
	return { head, badgeText, confirmBar };
}

function buildQuestionFieldNodes(doc, life, actions) {
	const otherRow = el(doc, "div", { className: "peer-question-other-row", attrs: { hidden: true } });
	const otherBtn = button(doc, {
		className: "peer-question-option",
		label: "Other…",
		signal: life.signal,
		onClick: () => actions.toggleOther(),
		attrs: { "data-peer-option-other": "" },
	});
	const otherInput = input(doc, {
		type: "text",
		label: "Other answer",
		placeholder: "Type custom answer…",
		className: "peer-question-other-input",
		attrs: { "data-peer-question-other": "" },
	});
	otherRow.append(otherBtn, otherInput);

	const answerWrap = el(doc, "div", { className: "peer-question-answer-wrap", attrs: { hidden: true } });
	const answerInput = input(doc, {
		type: "textarea",
		label: "Your answer",
		placeholder: "Write your answer…",
		className: "peer-question-answer",
		attrs: { "data-peer-question-answer": "", "data-peer-ask-input": "", rows: "2" },
	});
	answerWrap.append(answerInput);

	const confidenceRow = el(doc, "div", { className: "peer-question-confidence", attrs: { hidden: true } });
	const confSlider = el(doc, "input", {
		className: "peer-question-confidence-slider",
		attrs: { type: "range", min: "0", max: "100", value: String(DEFAULT_CONFIDENCE), "data-peer-confidence": "", "aria-label": "Confidence" },
	});
	const confValueEl = el(doc, "span", { className: "peer-question-confidence-value", attrs: { "data-peer-confidence-value": "" } });
	const confValueText = textNode(doc, confValueEl, `${DEFAULT_CONFIDENCE}%`);
	confidenceRow.append(el(doc, "span", { className: "peer-question-confidence-label", text: "Confidence" }), confSlider, confValueEl);

	const thinkingInput = input(doc, {
		type: "textarea",
		label: "Your thinking",
		placeholder: "Your thinking and reasoning…",
		className: "peer-question-thinking",
		attrs: { "data-peer-question-thinking": "", rows: "2" },
	});
	return { otherRow, otherBtn, otherInput, answerWrap, answerInput, confidenceRow, confSlider, confValueText, thinkingInput };
}

function buildQuestionDockNodes(doc, life, actions) {
	const root = el(doc, "section", {
		className: "peer-question-dock",
		attrs: { "data-testid": "question-dock", hidden: true },
	});
	const header = buildQuestionHeaderNodes(doc, life, actions);
	const promptSlot = el(doc, "div", { className: "peer-question-prompt", attrs: { "data-peer-question-prompt": "" } });
	const contextSlot = el(doc, "div", { className: "peer-question-context", attrs: { hidden: true } });
	const optionsHost = el(doc, "div", { className: "peer-question-options", attrs: { "data-peer-question-options": "" } });
	const fields = buildQuestionFieldNodes(doc, life, actions);
	const foot = el(doc, "div", { className: "peer-dock-foot" });
	const submitBtn = button(doc, {
		className: "peer-question-submit is-primary",
		label: "Submit answer",
		signal: life.signal,
		onClick: () => actions.submit(),
		attrs: { "data-peer-action": "submit-answer" },
	});
	foot.append(submitBtn);
	root.append(
		header.head, header.confirmBar, promptSlot, contextSlot, optionsHost,
		fields.otherRow, fields.answerWrap, fields.confidenceRow, fields.thinkingInput, foot,
	);
	return {
		root, badgeText: header.badgeText, confirmBar: header.confirmBar,
		promptSlot, contextSlot, optionsHost, submitBtn, ...fields,
	};
}

function buildOptionButton(doc, opt, idx, multiSelect, toggleIndex) {
	const hasLetter = !multiSelect && idx < OPTION_LETTERS.length;
	const prefix = hasLetter ? OPTION_LETTERS[idx] : `${idx + 1}`;
	const btn = button(doc, {
		className: "peer-question-option",
		label: `${prefix}. ${opt.label}`,
		onClick: () => toggleIndex(idx),
		attrs: {
			"data-peer-option-index": String(idx),
			"data-peer-option-value": opt.value,
			"data-option-letter": hasLetter ? OPTION_LETTERS[idx] : false,
			"aria-pressed": "false",
		},
	});
	if (opt.description) {
		btn.append(el(doc, "span", { className: "peer-question-option-desc", text: opt.description }));
	}
	return btn;
}

function renderOptionButtons(doc, state, toggleIndex, toggleDontKnow) {
	const { qd, nodes } = state;
	if (!qd || qd.mode === "text") {
		nodes.optionsHost.hidden = true;
		nodes.optionsHost.replaceChildren();
		state.optionButtons = [];
		state.dontKnowBtn = null;
		return;
	}
	nodes.optionsHost.hidden = false;
	nodes.optionsHost.setAttribute("role", qd.multiSelect ? "group" : "radiogroup");
	const buttons = qd.options.map((opt, idx) => buildOptionButton(doc, opt, idx, qd.multiSelect, toggleIndex));
	let dontKnowBtn = null;
	if (qd.kind === "quiz") {
		dontKnowBtn = button(doc, {
			className: "peer-question-option peer-question-dont-know",
			label: "I don't know",
			onClick: () => toggleDontKnow(),
			attrs: { "data-peer-option-dont-know": "", "aria-pressed": "false" },
		});
		buttons.push(dontKnowBtn);
	}
	state.optionButtons = buttons;
	state.dontKnowBtn = dontKnowBtn;
	nodes.optionsHost.replaceChildren(...buttons);
}

function paintQuestionState(state) {
	const { qd, nodes } = state;
	if (!qd) return;
	for (let i = 0; i < qd.options.length; i += 1) {
		const btn = state.optionButtons[i];
		if (!btn) continue;
		const isSelected = state.selected.has(i);
		btn.classList.toggle("is-selected", isSelected);
		btn.setAttribute("aria-pressed", String(isSelected));
	}
	if (state.dontKnowBtn) {
		state.dontKnowBtn.classList.toggle("is-selected", state.dontKnow);
		state.dontKnowBtn.setAttribute("aria-pressed", String(state.dontKnow));
	}
	nodes.otherRow.hidden = !(qd.kind === "ask" && qd.mode !== "text");
	nodes.otherBtn.classList.toggle("is-selected", state.otherSelected);
	nodes.otherBtn.setAttribute("aria-pressed", String(state.otherSelected));
	nodes.answerWrap.hidden = qd.mode !== "text";
	nodes.confidenceRow.hidden = qd.kind !== "quiz";
	nodes.confSlider.disabled = state.dontKnow;
	writeText(nodes.confValueText, `${state.confidence}%`);
	nodes.submitBtn.disabled = !canSubmitQuestion(qd, state);
}

function seedFromDraft(state, draft) {
	state.selected = new Set();
	state.otherSelected = false;
	state.dontKnow = false;
	state.confidence = DEFAULT_CONFIDENCE;
	state.readingThinking = typeof draft?.readingThinking === "string" ? draft.readingThinking : "";
	state.nodes.otherInput.value = "";
	state.nodes.answerInput.value = "";
	state.nodes.thinkingInput.value = "";
	const form = draft?.form;
	if (!form || typeof form !== "object") {
		state.nodes.confSlider.value = String(state.confidence);
		return;
	}
	if (form.selection?.selected instanceof Set) state.selected = new Set(form.selection.selected);
	state.otherSelected = Boolean(form.selection?.otherSelected);
	state.dontKnow = Boolean(form.selection?.dontKnow);
	const stopVal = typeof form.confidenceIndex === "number" ? CONFIDENCE_STOPS[form.confidenceIndex] : undefined;
	if (stopVal !== undefined) state.confidence = stopVal;
	if (typeof form.other === "string") state.nodes.otherInput.value = form.other;
	if (typeof form.text === "string") state.nodes.answerInput.value = form.text;
	if (typeof form.thinking === "string") state.nodes.thinkingInput.value = form.thinking;
	state.nodes.confSlider.value = String(state.confidence);
}

function handleQuestionDocKeydown(event, state, toggleIndex, submit) {
	if (state.nodes.root.hidden || !state.qd || state.qd.mode === "text") return;
	if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return;
	if (isTypingElement(event.target)) return;
	const digit = event.key >= "1" && event.key <= "9" ? Number(event.key) - 1 : -1;
	if (digit >= 0 && digit < state.qd.options.length) {
		event.preventDefault();
		toggleIndex(digit);
		return;
	}
	if (event.key === "Enter" && canSubmitQuestion(state.qd, state)) {
		event.preventDefault();
		submit();
	}
}

function bindQuestionShortcuts(doc, life, state, toggleIndex, submit) {
	life.on(state.nodes.confSlider, "input", () => {
		state.confidence = Number(state.nodes.confSlider.value);
		paintQuestionState(state);
	});
	life.on(state.nodes.otherInput, "input", () => {
		if (state.nodes.otherInput.value.trim().length > 0 && !state.otherSelected) {
			if (!state.qd?.multiSelect) state.selected.clear();
			state.otherSelected = true;
			state.dontKnow = false;
		}
		paintQuestionState(state);
	});
	life.on(state.nodes.answerInput, "input", () => paintQuestionState(state));
	life.on(state.nodes.thinkingInput, "input", () => paintQuestionState(state));
	life.on(state.nodes.answerInput, "keydown", (event) => {
		if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
			event.preventDefault();
			submit();
		}
	});
	life.on(doc, "keydown", (event) => handleQuestionDocKeydown(event, state, toggleIndex, submit));
}

function toggleOptionSelection(state, idx) {
	if (!state.qd) return;
	if (state.qd.multiSelect) {
		if (state.selected.has(idx)) state.selected.delete(idx);
		else state.selected.add(idx);
		state.dontKnow = false;
	} else {
		state.selected = new Set([idx]);
		state.otherSelected = false;
		state.dontKnow = false;
	}
	paintQuestionState(state);
}

function submitQuestionState(state, onSubmit) {
	if (!state.qd || !canSubmitQuestion(state.qd, state)) return;
	const rawText = state.nodes.answerInput.value.trim();
	const rawThinking = state.nodes.thinkingInput.value.trim();
	const effectiveText = state.qd.mode === "text" ? (rawText || rawThinking) : "";
	const effectiveThinking = state.qd.mode === "text" && !rawText ? "" : rawThinking;
	const answer = buildQuestionAnswer(state.qd, {
		selected: state.selected,
		otherSelected: state.otherSelected,
		dontKnow: state.dontKnow,
		confidence: state.confidence,
		other: state.nodes.otherInput.value,
		text: effectiveText,
		thinking: effectiveThinking,
		readingThinking: state.readingThinking,
	});
	onSubmit?.({
		tool: state.qd.tool,
		toolCallId: state.qd.toolCallId,
		questionKey: state.qd.questionKey,
		answer,
	});
}

function createQuestionActions(state, onSubmit, onDismiss) {
	const toggleDontKnow = () => {
		state.dontKnow = !state.dontKnow;
		if (state.dontKnow) {
			state.selected.clear();
			state.otherSelected = false;
		}
		paintQuestionState(state);
	};
	const toggleOther = () => {
		if (!state.qd) return;
		if (!state.qd.multiSelect) state.selected.clear();
		state.otherSelected = !state.otherSelected;
		state.dontKnow = false;
		paintQuestionState(state);
		if (state.otherSelected) state.nodes.otherInput.focus();
	};
	const dismiss = () => {
		if (!state.qd) return false;
		state.nodes.confirmBar.hidden = true;
		onDismiss?.({
			toolCallId: state.qd.toolCallId,
			questionKey: state.qd.questionKey,
			answer: buildDismissedAnswer(state.qd),
		});
		return true;
	};
	return {
		toggleIndex: (idx) => toggleOptionSelection(state, idx),
		toggleDontKnow,
		toggleOther,
		submit: () => submitQuestionState(state, onSubmit),
		dismiss,
		closeConfirm: () => { state.nodes.confirmBar.hidden = true; },
	};
}

function applyQuestionDockUpdate(doc, state, actions, model) {
	const qd = deriveQuestionData(model.pendingQuestion);
	state.compacting = Boolean(model.compacting);
	state.mode = model.mode === "light" ? "light" : "dark";
	if (!qd) {
		state.qd = null;
		state.activeKey = "";
		state.nodes.root.hidden = true;
		state.nodes.confirmBar.hidden = true;
		return;
	}
	state.nodes.root.hidden = false;
	state.qd = qd;
	const suffix = qd.multiSelect ? " · select all that apply" : "";
	writeText(state.nodes.badgeText, `${formatKindBadge(qd)}${suffix}`);
	state.promptMd.update({ source: qd.question, streaming: false, mode: state.mode, displayOnly: true });
	state.nodes.contextSlot.hidden = qd.context === "";
	if (qd.context) state.contextMd.update({ source: qd.context, streaming: false, mode: state.mode, displayOnly: true });
	if (qd.questionKey !== state.activeKey) {
		state.activeKey = qd.questionKey;
		state.nodes.confirmBar.hidden = true;
		seedFromDraft(state, model.questionDraft);
		renderOptionButtons(doc, state, actions.toggleIndex, actions.toggleDontKnow);
	}
	paintQuestionState(state);
}

export function createQuestionDock(host, { onSubmit, onDismiss } = {}) {
	const doc = documentOf(host);
	const life = createLife();
	const state = {
		life, qd: null, activeKey: "", mode: "dark", compacting: false, readingThinking: "",
		selected: new Set(), otherSelected: false, dontKnow: false, confidence: DEFAULT_CONFIDENCE,
		optionButtons: [], dontKnowBtn: null, nodes: null, promptMd: null, contextMd: null,
	};
	const actions = createQuestionActions(state, onSubmit, onDismiss);
	state.nodes = buildQuestionDockNodes(doc, life, actions);
	state.promptMd = createMarkdown(state.nodes.promptSlot, { displayOnly: true });
	state.contextMd = createMarkdown(state.nodes.contextSlot, { displayOnly: true });
	bindQuestionShortcuts(doc, life, state, actions.toggleIndex, actions.submit);
	host.append(state.nodes.root);

	const focus = () => {
		if (life.dead || !state.qd) return false;
		const field = state.qd.mode === "text" ? state.nodes.answerInput : state.nodes.thinkingInput;
		field.focus();
		return true;
	};
	const requestEscape = () => {
		if (life.dead || !state.qd || state.nodes.root.hidden) return false;
		if (!state.nodes.confirmBar.hidden) actions.dismiss();
		else state.nodes.confirmBar.hidden = false;
		return true;
	};
	const destroy = () => {
		if (!life.destroy()) return;
		state.contextMd.destroy();
		state.promptMd.destroy();
		state.nodes.root.remove();
	};
	return {
		update: (model = {}) => { if (!life.dead) applyQuestionDockUpdate(doc, state, actions, model); },
		focus,
		dismiss: actions.dismiss,
		requestEscape,
		destroy,
	};
}
