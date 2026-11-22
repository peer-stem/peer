/**
 * Rich static transcript card for answered questions (`[data-testid="answered-card"]`).
 * Consumes `answerForPresentation`, `answeredOptionLetters`, `parseAskInput`, `parseQuizInput`,
 * and `solveQuestionLayout` from `'peer-engine'`, with clean fallback for string/mock outputs.
 */
import { createLife, el, textNode, writeText } from "cloudcanvas-lib/ui";
import {
	ANSWER_COLUMN_INSET_CSS,
	COLUMN_GAP_CSS,
	answerForPresentation,
	answeredOptionLetters,
	layoutFontKey,
	parseAskInput,
	parseQuizInput,
	questionCardGeometry,
	rootRem,
	solveQuestionLayout,
} from "peer-engine";
import { createMarkdown } from "../../blocks/markdown.js";
import { createThinkingBlockHandle, formatQuestionCardLabel, renderSubmittedImages } from "./practice-cards.js";
import { CONFIDENCE_STOPS, toolQuestionKind } from "./question-grading.js";

const CONFIDENCE_COLORS = ["#ef4444", "#f97316", "#eab308", "#84cc16", "#22c55e", "#10b981"];

function applyConfidenceRailStyle(railEl, rawValue) {
	const value = Math.max(0, Math.min(100, Math.round(Number(rawValue) || 0)));
	const color = CONFIDENCE_COLORS[CONFIDENCE_STOPS.indexOf(value)] ?? CONFIDENCE_COLORS[2];
	const tick = "color-mix(in oklab, var(--cc-text, #e2e8f0) 35%, transparent)";
	const ticks = [30, 50, 70, 90];
	railEl.style.backgroundColor = "var(--cc-bg, #0b1120)";
	railEl.style.backgroundImage = [
		`linear-gradient(90deg, ${color} 0%, ${color} ${value}%, transparent ${value}%, transparent 100%)`,
		...ticks.map(() => `linear-gradient(90deg, ${tick}, ${tick})`),
	].join(", ");
	railEl.style.backgroundSize = ["100% 100%", "1px 100%", "1px 100%", "1px 100%", "1px 100%"].join(", ");
	railEl.style.backgroundPosition = ["0 0", ...ticks.map((p) => `${p}% 0`)].join(", ");
	railEl.style.backgroundRepeat = "no-repeat";
}

function synthesizeFallbackAnswer(rawOutput, rawInput, toolName) {
	const input = rawInput && typeof rawInput === "object" ? rawInput : {};
	const kind = toolQuestionKind(toolName);
	const rawOpts = Array.isArray(input.options) ? input.options : [];
	const options = rawOpts.map((opt, idx) => ({
		index: idx + 1,
		label: typeof opt === "string" ? opt : String(opt?.label ?? opt?.text ?? opt?.value ?? ""),
	})).filter((o) => o.label);
	let text = "";
	if (typeof rawOutput === "string") text = rawOutput;
	else if (rawOutput && typeof rawOutput === "object") {
		const direct = rawOutput.answer ?? rawOutput.selected ?? rawOutput.response ?? rawOutput.text;
		text = Array.isArray(direct) ? direct.map(String).join(", ") : String(direct ?? "");
	}
	return {
		kind, tool: toolName, questionText: String(input.question ?? input.prompt ?? ""),
		options, dontKnow: false, answers: [], ...(text ? { text } : {}), answeredAt: "",
	};
}

function resolvePresentationAnswer(part) {
	const out = part.output;
	const isStructured = out && typeof out === "object"
		&& (out.dismissed === true || Array.isArray(out.answers) || typeof out.kind === "string");
	const base = isStructured
		? {
			kind: out.kind ?? toolQuestionKind(part.toolName),
			tool: out.tool ?? part.toolName,
			...out,
			questionText: String(out.questionText ?? part.input?.question ?? ""),
			dontKnow: Boolean(out.dontKnow),
			answers: Array.isArray(out.answers) ? out.answers : [],
			answeredAt: String(out.answeredAt ?? ""),
		}
		: synthesizeFallbackAnswer(out, part.input, part.toolName);
	return { answer: answerForPresentation(base, part.input), letters: answeredOptionLetters(base, part.input) };
}

function createOptionRowElement(doc, opt, cfg, mds) {
	const { sel, key, isQuiz, letter, description, mode, onExpand } = cfg;
	const classes = ["peer-answered-option"];
	if (sel && key) classes.push("is-correct-selected");
	else if (sel && !key && isQuiz) classes.push("is-wrong-selected");
	else if (sel && !isQuiz) classes.push("is-ask-selected");
	else if (!sel && key) classes.push("is-correct-unselected");
	const row = el(doc, "div", { className: classes.join(" ") });
	if (letter) {
		row.append(el(doc, "span", { className: "peer-answered-option-letter", text: letter, attrs: { "data-option-letter": letter } }));
	}
	if (isQuiz) {
		const markKind = key ? "check" : (sel ? "x" : null);
		row.append(el(doc, "span", {
			className: markKind === "check" ? "peer-answered-mark is-check" : "peer-answered-mark is-x",
			text: markKind === "check" ? "✓" : (markKind === "x" ? "✗" : ""),
			attrs: { "aria-hidden": "true", ...(markKind ? { "data-mark": markKind } : {}) },
		}));
	}
	const labelWrap = el(doc, "span", {
		className: sel ? "peer-answered-option-label" : "peer-answered-option-label is-muted",
		attrs: { "data-answered-option-label": "" },
	});
	const labelSlot = el(doc, "span", { className: "peer-answered-option-md" });
	const labelMd = createMarkdown(labelSlot, { displayOnly: true, onExpand });
	labelMd.update({ source: String(opt.label ?? ""), streaming: false, mode, displayOnly: true });
	mds.push(labelMd);
	labelWrap.append(labelSlot);
	if (description) {
		const descSlot = el(doc, "div", { className: "peer-answered-option-desc" });
		const descMd = createMarkdown(descSlot, { displayOnly: true, onExpand });
		descMd.update({ source: String(description), streaming: false, mode, displayOnly: true });
		mds.push(descMd);
		labelWrap.append(descSlot);
	}
	row.append(labelWrap);
	return row;
}

function estimateColumnSpecs(answer, detailsText, geom) {
	const qChars = String(answer.questionText ?? "").length + String(detailsText ?? "").length;
	const optCount = (answer.options?.length ?? 0) + (answer.other ? 1 : 0);
	const optChars = (answer.options ?? []).reduce((sum, o) => sum + String(o.label ?? "").length, 0);
	const qSpec = {
		min: geom.floor,
		preferredMin: Math.max(geom.floor, Math.round(geom.base * 0.62)),
		max: Math.max(geom.base, 640),
		height: (w) => Math.max(48, Math.ceil(Math.max(1, qChars) / Math.max(18, Math.floor((w - 24) / 7.5))) * 22 + 36),
	};
	const aSpec = {
		min: geom.floor,
		preferredMin: Math.max(geom.floor, Math.round(geom.base * 0.52)),
		max: geom.base,
		height: (w) => Math.max(optCount, Math.ceil(Math.max(1, optChars) / Math.max(16, Math.floor((w - 40) / 7.5)))) * 36
			+ (answer.confidence != null ? 36 : 0),
	};
	const triggered = qChars >= 140 || qSpec.height(geom.base) >= aSpec.height(geom.base);
	return { triggered, question: qSpec, answer: aSpec };
}

function applyAdaptiveLayout(doc, cardEl, gridEl, part, answer, detailsText) {
	const adaptable = part.adaptiveQuestions !== false && Boolean(part.toolCallId) && !answer.dismissed
		&& (answer.kind === "quiz" || answer.kind === "ask") && (answer.options?.length ?? 0) > 0;
	const available = Number(part.availableWidth ?? cardEl.clientWidth ?? 0);
	if (adaptable && available > 0) {
		const geom = questionCardGeometry(rootRem(doc));
		layoutFontKey(part.appearance ?? {});
		const solved = solveQuestionLayout({
			available, base: geom.base, stackedNeed: geom.base, columns: estimateColumnSpecs(answer, detailsText, geom),
		});
		if (solved.kind === "columns") {
			cardEl.setAttribute("data-question-layout", "columns");
			gridEl.className = "peer-answered-grid is-columns";
			gridEl.style.gridTemplateColumns = `minmax(0, 1fr) calc(${solved.answer}px - ${ANSWER_COLUMN_INSET_CSS})`;
			gridEl.style.columnGap = COLUMN_GAP_CSS;
			return;
		}
	}
	cardEl.setAttribute("data-question-layout", "stacked");
	gridEl.className = "peer-answered-grid is-stacked";
	gridEl.style.removeProperty("grid-template-columns");
	gridEl.style.removeProperty("column-gap");
}

function buildAnsweredColumns(doc) {
	const grid = el(doc, "div", { className: "peer-answered-grid is-stacked" });
	const qCol = el(doc, "div", { className: "peer-answered-q-col" });
	const eyebrowRow = el(doc, "div", { className: "peer-card-eyebrow-row" });
	const eyebrowEl = el(doc, "span", { className: "peer-card-eyebrow" });
	const eyebrowText = textNode(doc, eyebrowEl, "");
	const statusBadge = el(doc, "span", { className: "peer-status-badge", attrs: { "data-status-badge": "", hidden: true } });
	const statusText = textNode(doc, statusBadge, "");
	eyebrowRow.append(eyebrowEl, statusBadge);
	const questionSlot = el(doc, "div", { className: "peer-answered-question" });
	const detailsSlot = el(doc, "div", { className: "peer-answered-details", attrs: { hidden: true } });
	qCol.append(eyebrowRow, questionSlot, detailsSlot);

	const aCol = el(doc, "div", { className: "peer-answered-a-col" });
	const optionsEl = el(doc, "div", { className: "peer-answered-options", attrs: { hidden: true } });
	const freeTextEl = el(doc, "div", { className: "peer-answered-free-text", attrs: { hidden: true } });
	const freeTextNode = textNode(doc, freeTextEl, "");
	const answerImgsHost = el(doc, "div", { attrs: { hidden: true } });
	const confWrap = el(doc, "div", { className: "peer-answered-confidence", attrs: { "data-testid": "answered-confidence", hidden: true } });
	const confRail = el(doc, "div", { className: "peer-confidence-rail", attrs: { "data-testid": "confidence-rail", "aria-hidden": "true" } });
	const confPct = el(doc, "span", { className: "peer-confidence-pct" });
	const confPctText = textNode(doc, confPct, "");
	confWrap.append(confRail, confPct);
	const dontKnowEl = el(doc, "div", { className: "peer-answered-dont-know", text: "Answered “I don't know”.", attrs: { hidden: true } });
	aCol.append(optionsEl, freeTextEl, answerImgsHost, confWrap, dontKnowEl);
	grid.append(qCol, aCol);
	return {
		grid, eyebrowText, statusBadge, statusText, questionSlot, detailsSlot,
		optionsEl, freeTextEl, freeTextNode, answerImgsHost, confWrap, confRail, confPctText, dontKnowEl,
	};
}

function buildAnsweredDom(doc, life, toggleWhy) {
	const slot = el(doc, "div", { className: "peer-answered-slot" });
	const readingHost = el(doc, "div", { className: "peer-answered-reading-host", attrs: { hidden: true } });
	const card = el(doc, "div", {
		className: "peer-answered-card",
		attrs: { "data-testid": "answered-card", "data-question-layout": "stacked" },
	});
	const dismissedWrap = el(doc, "div", { className: "peer-answered-dismissed-text", attrs: { hidden: true } });
	const dismissedQ = el(doc, "span", { className: "peer-answered-dismissed-q" });
	const dismissedQText = textNode(doc, dismissedQ, "");
	dismissedWrap.append(dismissedQ, doc.createTextNode(" — skipped"));

	const activeWrap = el(doc, "div", { className: "peer-answered-active" });
	const cols = buildAnsweredColumns(doc);
	const thinkingHost = el(doc, "div", { attrs: { hidden: true } });
	const whyWrap = el(doc, "div", { className: "peer-answered-why", attrs: { "data-testid": "tucked-explanation", hidden: true } });
	const whyBtn = el(doc, "button", { className: "peer-answered-why-btn", attrs: { type: "button" } });
	const whyBtnText = textNode(doc, whyBtn, "Why");
	life.on(whyBtn, "click", () => toggleWhy());
	const whyBody = el(doc, "div", { className: "peer-answered-why-body", attrs: { hidden: true } });
	const whySlot = el(doc, "div", { className: "peer-answered-why-md" });
	whyBody.append(el(doc, "span", { className: "peer-answered-why-prefix", text: "Why: " }), whySlot);
	whyWrap.append(whyBtn, whyBody);

	const committedWrap = el(doc, "div", { className: "peer-answered-committed", attrs: { hidden: true } });
	const committedSlot = el(doc, "div", { className: "peer-answered-committed-md" });
	committedWrap.append(el(doc, "span", { className: "peer-answered-committed-prefix", text: "The answer: " }), committedSlot);

	activeWrap.append(cols.grid, thinkingHost, whyWrap, committedWrap);
	card.append(dismissedWrap, activeWrap);
	slot.append(readingHost, card);
	return {
		slot, readingHost, card, dismissedWrap, dismissedQText, activeWrap,
		...cols, thinkingHost, whyWrap, whyBtnText, whyBody, whySlot, committedWrap, committedSlot,
	};
}

function syncQuizBadge(nodes, isQuiz, answer) {
	nodes.statusBadge.hidden = !isQuiz;
	if (!isQuiz) return;
	const tone = answer.dontKnow ? "is-muted" : (answer.correct ? "is-success" : "is-danger");
	const key = answer.dontKnow ? "didnt-know" : (answer.correct ? "correct" : "incorrect");
	const label = answer.dontKnow ? "didn't know" : (answer.correct ? "correct" : "incorrect");
	nodes.statusBadge.className = `peer-status-badge ${tone}`;
	nodes.statusBadge.setAttribute("data-status-badge", key);
	writeText(nodes.statusText, label);
}

function rebuildOptionNodes(doc, state, answer, letters, descByIndex, mode, onExpand) {
	for (const md of state.optionMds) md.destroy();
	state.optionMds = [];
	const hasOpts = (answer.options?.length ?? 0) > 0 || Boolean(answer.other);
	state.nodes.optionsEl.hidden = !hasOpts;
	if (!hasOpts) {
		state.nodes.optionsEl.replaceChildren();
		return;
	}
	const isQuiz = answer.kind === "quiz";
	const selectedIdx = new Set((answer.answers ?? []).map((a) => a.index));
	const correctIdx = new Set(answer.correctIndices ?? []);
	const children = [];
	for (const opt of answer.options ?? []) {
		children.push(createOptionRowElement(doc, opt, {
			sel: selectedIdx.has(opt.index),
			key: isQuiz && correctIdx.has(opt.index),
			isQuiz,
			letter: letters.get(opt.index),
			description: descByIndex.get(opt.index),
			mode,
			onExpand,
		}, state.optionMds));
	}
	if (answer.other) {
		children.push(el(doc, "div", {
			className: "peer-answered-option is-ask-selected",
			text: `“${answer.other}”`,
			attrs: { "data-testid": "answered-other" },
		}));
	}
	state.nodes.optionsEl.replaceChildren(...children);
}

function ensureThinkingHandle(doc, hostEl, existing, testId, inCard, initOpen, onExpand) {
	if (existing) return existing;
	const created = createThinkingBlockHandle(doc, { testId, label: "YOUR THINKING", inCard, open: initOpen, onExpand });
	hostEl.append(created.node);
	return created;
}

function syncThinkingBlocks(doc, state, answer, ctx) {
	const hasReading = Boolean(answer.readingThinking || answer.images?.readingThinking?.length);
	state.nodes.readingHost.hidden = !hasReading;
	if (hasReading) {
		const open = ctx?.isThinkingControlled?.() ? ctx.getThinkingOpen() : true;
		state.readingBlock = ensureThinkingHandle(doc, state.nodes.readingHost, state.readingBlock, "reading-thinking-block", false, open, ctx?.onExpand);
		state.readingBlock.update({ label: "YOUR THINKING", text: answer.readingThinking ?? "", images: answer.images?.readingThinking, onExpand: ctx?.onExpand });
	}
	const inCardText = answer.thinking ?? answer.note ?? "";
	const hasInCard = Boolean(inCardText || answer.images?.thinking?.length);
	state.nodes.thinkingHost.hidden = !hasInCard;
	if (hasInCard) {
		const open = ctx?.isThinkingControlled?.() ? ctx.getThinkingOpen() : false;
		state.inCardBlock = ensureThinkingHandle(doc, state.nodes.thinkingHost, state.inCardBlock, "your-thinking", true, open, ctx?.onExpand);
		state.inCardBlock.update({ label: "YOUR THINKING", text: inCardText, images: answer.images?.thinking, onExpand: ctx?.onExpand });
	}
}

function syncSupplementalSections(doc, state, answer, parsedDetails, ctx, mode) {
	const { nodes } = state;
	nodes.detailsSlot.hidden = !parsedDetails;
	if (parsedDetails) state.detailsMd.update({ source: parsedDetails, streaming: false, mode, displayOnly: true });
	const freeText = String(answer.text ?? "").trim();
	nodes.freeTextEl.hidden = freeText === "";
	writeText(nodes.freeTextNode, freeText ? `“${freeText}”` : "");

	state.imgLife.destroy();
	state.imgLife = createLife();
	const imgsNode = renderSubmittedImages(doc, state.imgLife, answer.images?.answer, ctx?.onExpand);
	nodes.answerImgsHost.hidden = !imgsNode;
	if (imgsNode) nodes.answerImgsHost.replaceChildren(imgsNode);
	else nodes.answerImgsHost.replaceChildren();

	const isQuiz = answer.kind === "quiz";
	const hasConf = isQuiz && answer.confidence !== undefined && answer.confidence !== null;
	nodes.confWrap.hidden = !hasConf;
	if (hasConf) {
		applyConfidenceRailStyle(nodes.confRail, answer.confidence);
		writeText(nodes.confPctText, `${answer.confidence}%`);
	}
	nodes.dontKnowEl.hidden = !(isQuiz && answer.dontKnow);

	const hasWhy = Boolean(isQuiz && answer.explanation);
	nodes.whyWrap.hidden = !hasWhy;
	if (hasWhy) {
		state.whyMd.update({ source: String(answer.explanation), streaming: false, mode, displayOnly: true });
		nodes.whyBody.hidden = !state.whyOpen;
		writeText(nodes.whyBtnText, state.whyOpen ? "Hide why" : "Why");
	}
	const hasCommitted = Boolean(answer.kind === "explain" && answer.committed);
	nodes.committedWrap.hidden = !hasCommitted;
	if (hasCommitted) state.committedMd.update({ source: String(answer.committed), streaming: false, mode, displayOnly: true });
}

function applyAnsweredUpdate(doc, state, nextPart, effCtx) {
	state.lastPart = nextPart;
	state.nodes.card.setAttribute("data-peer-part-type", nextPart.partType);
	const { answer, letters } = resolvePresentationAnswer(nextPart);
	state.lastAnswer = answer;
	if (answer.dismissed) {
		state.nodes.card.classList.add("is-dismissed");
		state.nodes.dismissedWrap.hidden = false;
		state.nodes.activeWrap.hidden = true;
		state.nodes.readingHost.hidden = true;
		writeText(state.nodes.dismissedQText, answer.questionText || "Question");
		return;
	}
	state.nodes.card.classList.remove("is-dismissed");
	state.nodes.dismissedWrap.hidden = true;
	state.nodes.activeWrap.hidden = false;

	const mode = nextPart.mode === "light" ? "light" : "dark";
	const askIn = answer.kind === "ask" ? parseAskInput(nextPart.input) : undefined;
	const quizIn = answer.kind === "quiz" ? parseQuizInput(nextPart.input) : undefined;
	const parsedDetails = askIn?.details ?? quizIn?.details ?? "";
	state.lastDetails = parsedDetails;
	const descByIndex = new Map((askIn?.options ?? []).map((o, i) => [i + 1, o.description]));

	writeText(state.nodes.eyebrowText, formatQuestionCardLabel(answer.tool ?? nextPart.toolName, answer.kind, answer.questionType));
	syncQuizBadge(state.nodes, answer.kind === "quiz", answer);
	state.questionMd.update({ source: String(answer.questionText ?? ""), streaming: false, mode, displayOnly: true });

	const nextOptSig = JSON.stringify({ o: answer.options, a: answer.answers, c: answer.correctIndices, ot: answer.other, mode });
	if (nextOptSig !== state.optSig) {
		state.optSig = nextOptSig;
		rebuildOptionNodes(doc, state, answer, letters, descByIndex, mode, effCtx?.onExpand);
	}
	syncThinkingBlocks(doc, state, answer, effCtx);
	syncSupplementalSections(doc, state, answer, parsedDetails, effCtx, mode);
	applyAdaptiveLayout(doc, state.nodes.card, state.nodes.grid, nextPart, answer, parsedDetails);
}

function destroyAnsweredState(state) {
	state.imgLife.destroy();
	for (const md of state.optionMds) md.destroy();
	state.readingBlock?.destroy();
	state.inCardBlock?.destroy();
	state.committedMd.destroy();
	state.whyMd.destroy();
	state.detailsMd.destroy();
	state.questionMd.destroy();
	state.nodes.slot.remove();
}

export function createAnsweredCardHandle(doc, part, ctx) {
	const life = createLife();
	const state = {
		nodes: null, whyOpen: false, optionMds: [], optSig: "",
		imgLife: createLife(), readingBlock: null, inCardBlock: null,
		questionMd: null, detailsMd: null, whyMd: null, committedMd: null,
		lastPart: part, lastAnswer: null, lastDetails: "",
	};
	const toggleWhy = () => {
		state.whyOpen = !state.whyOpen;
		state.nodes.whyBody.hidden = !state.whyOpen;
		writeText(state.nodes.whyBtnText, state.whyOpen ? "Hide why" : "Why");
	};
	state.nodes = buildAnsweredDom(doc, life, toggleWhy);
	state.questionMd = createMarkdown(state.nodes.questionSlot, { displayOnly: true, onExpand: ctx?.onExpand });
	state.detailsMd = createMarkdown(state.nodes.detailsSlot, { displayOnly: true, onExpand: ctx?.onExpand });
	state.whyMd = createMarkdown(state.nodes.whySlot, { displayOnly: true, onExpand: ctx?.onExpand });
	state.committedMd = createMarkdown(state.nodes.committedSlot, { displayOnly: true, onExpand: ctx?.onExpand });

	if (typeof ResizeObserver === "function") {
		const onResize = () => {
			if (state.lastAnswer) applyAdaptiveLayout(doc, state.nodes.card, state.nodes.grid, state.lastPart, state.lastAnswer, state.lastDetails);
		};
		const ro = new ResizeObserver(onResize);
		ro.observe(state.nodes.card);
		life.add(() => ro.disconnect());
	}
	const update = (nextPart, nextCtx) => {
		if (!life.dead) applyAnsweredUpdate(doc, state, nextPart, nextCtx ?? ctx);
	};
	update(part, ctx);

	return {
		key: `answered-card:${part.id}`,
		node: state.nodes.slot,
		update,
		setThinkingOpen: (open) => {
			state.readingBlock?.setThinkingOpen(open);
			state.inCardBlock?.setThinkingOpen(open);
		},
		destroy: () => { if (life.destroy()) destroyAnsweredState(state); },
	};
}
