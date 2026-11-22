/**
 * Practice dock view (`[data-testid="practice-dock"]`, `C2a §3.6`, `§4.1`).
 * Renders the active practice problem prompt, `[data-peer-practice-thinking]`,
 * PNG/JPEG paste & drop, `submit-thinking`, `next-problem`, and `dismiss-problem`.
 */
import { button, createLife, documentOf, el, input } from "cloudcanvas-lib/ui";
import { createMarkdown } from "../../blocks/markdown.js";
import {
	extractClipboardImageFiles,
	readDroppedOrPickedFiles,
	toAttachedImageInputs,
} from "./composer-tokens.js";

function readProblemInfo(activeProblem) {
	if (!activeProblem || typeof activeProblem !== "object") return null;
	const problemCallId = String(activeProblem.toolCallId ?? activeProblem.problemCallId ?? "");
	if (!problemCallId) return null;
	const rawIn = activeProblem.input && typeof activeProblem.input === "object" ? activeProblem.input : {};
	const statement = String(rawIn.statement ?? rawIn.prompt ?? rawIn.question ?? rawIn.title ?? "").trim();
	return { problemCallId, statement };
}

function buildPracticeHeader(doc, life, actions) {
	const head = el(doc, "div", { className: "peer-dock-head" });
	const badge = el(doc, "span", { className: "peer-dock-badge", text: "Problem" });
	const controls = el(doc, "div", { className: "peer-dock-head-actions" });
	const nextBtn = button(doc, {
		className: "peer-practice-next",
		label: "Next problem",
		signal: life.signal,
		onClick: () => actions.next(),
		attrs: { "data-peer-action": "next-problem" },
	});
	const dismissBtn = button(doc, {
		className: "peer-dock-dismiss",
		label: "Dismiss",
		signal: life.signal,
		onClick: () => actions.dismiss(),
		attrs: { "data-peer-action": "dismiss-problem" },
	});
	controls.append(nextBtn, dismissBtn);
	head.append(badge, controls);

	const confirmBar = el(doc, "div", {
		className: "peer-dock-confirm",
		attrs: { "data-peer-dismiss-confirm": "", hidden: true },
	});
	confirmBar.append(
		el(doc, "span", { text: "Dismiss this problem?" }),
		button(doc, {
			label: "Dismiss problem",
			signal: life.signal,
			onClick: () => actions.dismiss(),
			attrs: { "data-peer-action": "confirm-dismiss" },
		}),
		button(doc, {
			label: "Keep working",
			signal: life.signal,
			onClick: () => { confirmBar.hidden = true; },
			attrs: { "data-peer-action": "cancel-dismiss" },
		}),
	);
	return { head, confirmBar, nextBtn };
}

function buildPracticeNodes(doc, life, actions) {
	const root = el(doc, "section", {
		className: "peer-practice-dock",
		attrs: { "data-testid": "practice-dock", hidden: true },
	});
	const header = buildPracticeHeader(doc, life, actions);
	const statementSlot = el(doc, "div", {
		className: "peer-practice-statement",
		attrs: { "data-peer-problem-statement": "" },
	});
	const imagesRow = el(doc, "div", { className: "peer-composer-chips", attrs: { hidden: true } });
	const thinkingInput = input(doc, {
		type: "textarea",
		label: "Your thinking",
		placeholder: "Work here, think out loud.",
		className: "peer-practice-thinking",
		attrs: { "data-peer-practice-thinking": "", rows: "3" },
	});
	const foot = el(doc, "div", { className: "peer-dock-foot" });
	const submitBtn = button(doc, {
		className: "peer-practice-submit is-primary",
		label: "Submit thinking",
		signal: life.signal,
		onClick: () => actions.submit(),
		attrs: { "data-peer-action": "submit-thinking" },
	});
	foot.append(submitBtn);
	root.append(header.head, header.confirmBar, statementSlot, imagesRow, thinkingInput, foot);
	return {
		root,
		confirmBar: header.confirmBar,
		nextBtn: header.nextBtn,
		statementSlot,
		imagesRow,
		thinkingInput,
		submitBtn,
	};
}

function buildPracticeImageChip(doc, img, onRemove) {
	const chip = el(doc, "span", { className: "peer-composer-chip peer-composer-image-chip" });
	const rm = button(doc, {
		className: "peer-composer-chip-remove",
		label: "×",
		ariaLabel: `Remove image ${img.name}`,
		onClick: () => onRemove(img.id),
	});
	chip.append(el(doc, "span", { text: img.name }), rm);
	return chip;
}

function renderPracticeImages(doc, state, syncUi) {
	const { imagesRow } = state.nodes;
	imagesRow.hidden = state.images.length === 0;
	if (state.images.length === 0) {
		imagesRow.replaceChildren();
		return;
	}
	const onRemove = (id) => {
		state.images = state.images.filter((entry) => entry.id !== id);
		syncUi();
	};
	imagesRow.replaceChildren(...state.images.map((img) => buildPracticeImageChip(doc, img, onRemove)));
}

function ingestPracticeImages(state, files, syncUi) {
	void readDroppedOrPickedFiles(files).then(({ images }) => {
		if (state.life.dead || images.length === 0) return;
		state.images = [...state.images, ...images];
		syncUi();
	});
}

function bindPracticeEvents(state, submit, syncUi) {
	const { life, nodes } = state;
	life.on(nodes.thinkingInput, "input", () => syncUi());
	life.on(nodes.thinkingInput, "keydown", (event) => {
		if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
		event.preventDefault();
		submit();
	});
	life.on(nodes.thinkingInput, "paste", (event) => {
		const files = extractClipboardImageFiles(event.clipboardData);
		if (files.length === 0) return;
		if (!event.clipboardData?.getData?.("text/plain")) event.preventDefault();
		ingestPracticeImages(state, files, syncUi);
	});
	life.on(nodes.root, "dragover", (event) => {
		if (event.dataTransfer?.types?.includes?.("Files")) event.preventDefault();
	});
	life.on(nodes.root, "drop", (event) => {
		if (!event.dataTransfer?.files?.length) return;
		event.preventDefault();
		ingestPracticeImages(state, event.dataTransfer.files, syncUi);
	});
}

function applyPracticeDockUpdate(state, syncUi, model) {
	const nextProb = readProblemInfo(model.activeProblem);
	const status = String(model.status ?? "ready");
	state.compacting = Boolean(model.compacting);
	state.isBusy = status === "submitted" || status === "streaming";
	if (!nextProb) {
		state.problem = null;
		state.nodes.root.hidden = true;
		state.nodes.confirmBar.hidden = true;
		return;
	}
	if (state.problem?.problemCallId !== nextProb.problemCallId) {
		state.nodes.thinkingInput.value = "";
		state.images = [];
		state.nodes.confirmBar.hidden = true;
	}
	state.problem = nextProb;
	state.nodes.root.hidden = false;
	state.nodes.root.setAttribute("data-problem", nextProb.problemCallId);
	const mode = model.mode === "light" ? "light" : "dark";
	state.statementMd.update({ source: nextProb.statement, streaming: false, mode, displayOnly: true });
	syncUi();
}

function submitPracticeThinking(state, syncUi, onSubmitThinking) {
	if (!state.problem || state.compacting || state.isBusy) return;
	const text = state.nodes.thinkingInput.value.trim();
	const images = toAttachedImageInputs(state.images);
	if (!text && images.length === 0) return;
	state.nodes.thinkingInput.value = "";
	state.images = [];
	syncUi();
	onSubmitThinking?.({
		problemCallId: state.problem.problemCallId,
		text,
		...(images.length > 0 ? { images } : {}),
	});
}

export function createPracticeDock(host, { onSubmitThinking, onNextProblem, onDismissProblem } = {}) {
	const doc = documentOf(host);
	const life = createLife();
	const state = { life, problem: null, images: [], compacting: false, isBusy: false, nodes: null, statementMd: null };

	const syncUi = () => {
		if (life.dead) return;
		renderPracticeImages(doc, state, syncUi);
		const hasContent = state.nodes.thinkingInput.value.trim().length > 0 || state.images.length > 0;
		state.nodes.submitBtn.disabled = !state.problem || state.compacting || state.isBusy || !hasContent;
		state.nodes.nextBtn.disabled = state.compacting || state.isBusy;
	};
	const submit = () => submitPracticeThinking(state, syncUi, onSubmitThinking);
	const dismiss = () => {
		if (!state.problem) return false;
		state.nodes.confirmBar.hidden = true;
		onDismissProblem?.({ problemCallId: state.problem.problemCallId });
		return true;
	};

	state.nodes = buildPracticeNodes(doc, life, { submit, dismiss, next: () => onNextProblem?.() });
	state.statementMd = createMarkdown(state.nodes.statementSlot, { displayOnly: true });
	bindPracticeEvents(state, submit, syncUi);
	host.append(state.nodes.root);

	const focus = () => {
		if (life.dead || !state.problem) return false;
		state.nodes.thinkingInput.focus();
		return true;
	};
	const requestEscape = () => {
		if (life.dead || !state.problem || state.nodes.root.hidden) return false;
		if (!state.nodes.confirmBar.hidden) dismiss();
		else state.nodes.confirmBar.hidden = false;
		return true;
	};
	const destroy = () => {
		if (!life.destroy()) return;
		state.statementMd.destroy();
		state.nodes.root.remove();
	};
	return {
		update: (model = {}) => { if (!life.dead) applyPracticeDockUpdate(state, syncUi, model); },
		focus,
		dismiss,
		requestEscape,
		destroy,
	};
}
