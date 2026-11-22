/**
 * Practice & question transcript cards (`practice-cards.js`):
 * - `problem-card` (`[data-testid="problem-card"]`)
 * - `conclude-card` (`[data-testid="conclude-card"]`) + metadata popover (`[data-testid="metadata-toggle"]` -> `[data-testid="metadata-box"]`)
 * - `thinking-card` (`[data-testid="thinking-card"]`) & reusable `createThinkingBlockHandle`
 * - `question-preview` (`[data-testid="question-preview"]`)
 * - `malformed-question` (`[data-testid="malformed-question"]` with `[data-peer-action="retry-question"]`)
 */
import { button, createLife, el, textNode, writeText } from "cloudcanvas-lib/ui";
import { createMarkdown } from "../../blocks/markdown.js";

const OUTCOME_LABELS = Object.freeze({
	solved: "Solved",
	solvedWithHints: "Solved with hints",
	movedOn: "Moved on",
	surrendered: "Surrendered",
	dismissed: "Dismissed",
});

const OUTCOME_TONES = Object.freeze({
	solved: "is-success",
	solvedWithHints: "is-warning",
	surrendered: "is-danger",
	movedOn: "is-muted",
});

export function formatQuestionCardLabel(tool, kind, questionType) {
	if (tool === "probe") return "Probe";
	if (tool === "recall") return "Recall";
	if (kind === "quiz" || tool === "quiz") return questionType === "predict" ? "Prediction" : "Quiz";
	if (kind === "explain" || tool === "explain") return "Explain";
	return "Question";
}

export function renderSubmittedImages(doc, life, images, onExpand) {
	const list = Array.isArray(images)
		? images.filter((img) => img && typeof img.data === "string" && typeof img.mimeType === "string")
		: [];
	if (list.length === 0) return null;
	const wrap = el(doc, "div", { className: "peer-submitted-images", attrs: { "data-testid": "submitted-images" } });
	for (const image of list) {
		const src = `data:${image.mimeType};base64,${image.data}`;
		const fig = el(doc, "figure", { className: "peer-submitted-image-fig" });
		const imgEl = el(doc, "img", {
			className: typeof onExpand === "function" ? "peer-submitted-image is-expandable" : "peer-submitted-image",
			attrs: { src, alt: "Submitted image", draggable: "false" },
		});
		if (typeof onExpand === "function") {
			life.on(imgEl, "click", () => onExpand({ kind: "image", title: "Submitted image", imageSrc: src }));
		}
		fig.append(imgEl);
		wrap.append(fig);
	}
	return wrap;
}

function buildThinkingBlockDom(doc, life, initial) {
	const details = el(doc, "details", {
		className: initial.inCard ? "peer-thinking-block is-in-card" : "peer-thinking-block",
		attrs: {
			...(initial.testId ? { "data-testid": initial.testId } : {}),
			...(initial.partType ? { "data-peer-part-type": initial.partType } : {}),
			"data-peer-thinking": "",
		},
	});
	details.open = Boolean(initial.open);
	const summary = el(doc, "summary", {
		className: "peer-thinking-block-summary",
		attrs: {
			...(initial.testId ? { "data-testid": `${initial.testId}-trigger` } : {}),
			"aria-expanded": String(details.open),
		},
	});
	const summaryText = textNode(doc, summary, initial.label || "YOUR THINKING");
	const body = el(doc, "div", { className: "peer-thinking-block-body" });
	const textEl = el(doc, "div", { className: "peer-thinking-block-text" });
	const textContent = textNode(doc, textEl, "");
	const imagesSlot = el(doc, "div", { className: "peer-thinking-block-images", attrs: { hidden: true } });
	body.append(textEl, imagesSlot);
	details.append(summary, body);
	life.on(details, "toggle", () => summary.setAttribute("aria-expanded", String(details.open)));
	return { details, summary, summaryText, textEl, textContent, imagesSlot };
}

export function createThinkingBlockHandle(doc, initial = {}) {
	const life = createLife();
	let imgLife = createLife();
	const nodes = buildThinkingBlockDom(doc, life, initial);
	let prevImgSig = "";

	const update = (opts = {}) => {
		if (life.dead) return;
		writeText(nodes.summaryText, opts.label || "YOUR THINKING");
		const txt = String(opts.text ?? "");
		writeText(nodes.textContent, txt);
		nodes.textEl.hidden = txt === "";
		if (opts.commit !== undefined) nodes.details.setAttribute("data-commit", opts.commit ? "true" : "false");
		const imgs = Array.isArray(opts.images) ? opts.images : [];
		const sig = imgs.map((i) => `${i?.mimeType}:${String(i?.data ?? "").slice(0, 24)}`).join("|");
		if (sig === prevImgSig) return;
		prevImgSig = sig;
		imgLife.destroy();
		imgLife = createLife();
		const rendered = renderSubmittedImages(doc, imgLife, imgs, opts.onExpand);
		nodes.imagesSlot.hidden = !rendered;
		nodes.imagesSlot.replaceChildren(...(rendered ? [rendered] : []));
	};
	update(initial);

	return {
		key: initial.key ?? "thinking-block",
		node: nodes.details,
		update,
		setThinkingOpen: (open) => {
			nodes.details.open = Boolean(open);
			nodes.summary.setAttribute("aria-expanded", String(nodes.details.open));
		},
		destroy: () => {
			if (!life.destroy()) return;
			imgLife.destroy();
			nodes.details.remove();
		},
	};
}

export function createThinkingCardHandle(doc, part, ctx) {
	const initialOpen = ctx?.isThinkingControlled?.() ? ctx.getThinkingOpen() : true;
	const block = createThinkingBlockHandle(doc, {
		key: `thinking-card:${part.id}`,
		testId: "thinking-card",
		partType: part.partType,
		label: "YOUR THINKING",
		text: part.text,
		images: part.images,
		commit: part.commit,
		open: initialOpen,
		onExpand: ctx?.onExpand,
	});
	return {
		key: `thinking-card:${part.id}`,
		node: block.node,
		update: (nextPart, nextCtx) => block.update({
			label: "YOUR THINKING",
			text: nextPart.text,
			images: nextPart.images,
			commit: nextPart.commit,
			onExpand: nextCtx?.onExpand,
		}),
		setThinkingOpen: block.setThinkingOpen,
		destroy: block.destroy,
	};
}

export function createProblemCardHandle(doc, part, ctx) {
	const root = el(doc, "div", {
		className: "peer-problem-card",
		attrs: { "data-testid": "problem-card", "data-peer-part-type": part.partType || "tool-problem" },
	});
	const eyebrow = el(doc, "div", { className: "peer-card-eyebrow", text: "Problem" });
	const bodySlot = el(doc, "div", { className: "peer-problem-card-body" });
	root.append(eyebrow, bodySlot);
	const md = createMarkdown(bodySlot, { displayOnly: true, onExpand: ctx?.onExpand });
	const update = (nextPart) => {
		md.update({ source: String(nextPart.statement ?? ""), streaming: false, mode: nextPart.mode, displayOnly: true });
	};
	update(part);
	return {
		key: `problem-card:${part.id}`,
		node: root,
		update,
		destroy: () => { md.destroy(); root.remove(); },
	};
}

function buildMetadataRows(doc, meta) {
	const dl = el(doc, "dl", { className: "peer-metadata-grid" });
	const pairs = [
		["Mode", meta.mode || "—"],
		["Targets", meta.targetsText],
		["Outcome", meta.outcome || "—"],
		["Hint rung", meta.rung || "none"],
		["Miss class", meta.missClass || "none"],
		["Retest", meta.retest === undefined ? "—" : (meta.retest ? "yes" : "no")],
	];
	for (const [term, val] of pairs) {
		dl.append(
			el(doc, "dt", { className: "peer-metadata-dt", text: term }),
			el(doc, "dd", { className: "peer-metadata-dd", text: val }),
		);
	}
	return dl;
}

function readConcludeMeta(part) {
	const concludeIn = part.input && typeof part.input === "object" ? part.input : {};
	const problemIn = part.problemInput && typeof part.problemInput === "object" ? part.problemInput : {};
	const rawTargets = Array.isArray(problemIn.target) ? problemIn.target.filter((t) => typeof t === "string") : [];
	const names = part.nodeNames && typeof part.nodeNames === "object" ? part.nodeNames : null;
	const targetsText = rawTargets.length === 0 ? "untagged" : rawTargets.map((id) => String(names?.[id] ?? id)).join(", ");
	const mode = typeof problemIn.mode === "string" ? problemIn.mode : "";
	const rung = typeof concludeIn.rung === "string" ? concludeIn.rung : "";
	const missClass = typeof concludeIn.missClass === "string" ? concludeIn.missClass : "";
	const retest = typeof concludeIn.retest === "boolean" ? concludeIn.retest : undefined;
	const outcome = typeof concludeIn.outcome === "string" ? concludeIn.outcome : "";
	const hasAny = Boolean(mode || rawTargets.length > 0 || rung || missClass || retest !== undefined);
	return { hasAny, mode, targetsText, outcome, rung, missClass, retest };
}

function wireMetadataDismiss(doc, close) {
	const popLife = createLife();
	const win = doc.defaultView;
	popLife.on(doc, "pointerdown", (ev) => close(ev.target), { capture: true });
	if (!win || typeof win.addEventListener !== "function") return popLife;
	popLife.on(win, "scroll", () => close(null), { capture: true, passive: true });
	popLife.on(win, "keydown", (ev) => {
		if (ev.key !== "Escape") return;
		ev.preventDefault();
		ev.stopPropagation();
		close(null);
	});
	return popLife;
}

function createMetadataPopover(doc, life) {
	const wrap = el(doc, "div", { className: "peer-metadata-wrap", attrs: { hidden: true } });
	const toggleBtn = el(doc, "button", {
		className: "peer-metadata-toggle",
		text: "Metadata",
		attrs: { type: "button", "data-testid": "metadata-toggle", "aria-expanded": "false" },
	});
	const box = el(doc, "div", { className: "peer-metadata-box", attrs: { "data-testid": "metadata-box", hidden: true } });
	wrap.append(toggleBtn);
	let open = false;
	let openLife = null;
	let currentMeta = null;

	const setOpen = (next) => {
		if (open === next) return;
		open = next;
		toggleBtn.setAttribute("aria-expanded", String(open));
		openLife?.destroy();
		openLife = null;
		if (!open) {
			box.hidden = true;
			box.remove();
			return;
		}
		box.hidden = false;
		box.replaceChildren(buildMetadataRows(doc, currentMeta));
		wrap.append(box);
		openLife = wireMetadataDismiss(doc, (target) => { if (!target || !wrap.contains(target)) setOpen(false); });
	};
	life.on(toggleBtn, "click", () => setOpen(!open));

	return {
		wrap,
		update(meta) {
			currentMeta = meta;
			wrap.hidden = !meta.hasAny;
			if (!meta.hasAny && open) setOpen(false);
			else if (open) box.replaceChildren(buildMetadataRows(doc, meta));
		},
		destroy: () => setOpen(false),
	};
}

function buildConcludeDom(doc, life, part) {
	const root = el(doc, "div", {
		className: "peer-conclude-card",
		attrs: { "data-testid": "conclude-card", "data-peer-part-type": part.partType || "tool-conclude" },
	});
	const dismissedLine = el(doc, "span", { text: "Problem dismissed.", attrs: { hidden: true } });
	const activeWrap = el(doc, "div", { className: "peer-conclude-active" });
	const head = el(doc, "div", { className: "peer-card-eyebrow-row" });
	const badge = el(doc, "span", { className: "peer-status-badge", attrs: { "data-status-badge": "", hidden: true } });
	const badgeText = textNode(doc, badge, "");
	head.append(el(doc, "span", { className: "peer-card-eyebrow", text: "Concluded" }), badge);

	const verdictSlot = el(doc, "div", { className: "peer-conclude-verdict", attrs: { hidden: true } });
	const revealWrap = el(doc, "div", { className: "peer-conclude-reveal", attrs: { hidden: true } });
	const revealSlot = el(doc, "div", { className: "peer-conclude-solution" });
	revealWrap.append(
		el(doc, "div", { className: "peer-conclude-divider" }),
		el(doc, "div", { className: "peer-card-eyebrow", text: "Model solution" }),
		revealSlot,
	);
	const metadata = createMetadataPopover(doc, life);
	activeWrap.append(head, verdictSlot, revealWrap, metadata.wrap);
	root.append(dismissedLine, activeWrap);
	return { root, dismissedLine, activeWrap, badge, badgeText, verdictSlot, revealWrap, revealSlot, metadata };
}

function applyConcludeUpdate(nodes, verdictMd, revealMd, nextPart) {
	const rawIn = nextPart.input && typeof nextPart.input === "object" ? nextPart.input : {};
	const outcome = typeof rawIn.outcome === "string" ? rawIn.outcome : "";
	const isDismissed = outcome === "dismissed";
	nodes.root.classList.toggle("is-dismissed", isDismissed);
	nodes.dismissedLine.hidden = !isDismissed;
	nodes.activeWrap.hidden = isDismissed;
	if (isDismissed) {
		nodes.metadata.update({ hasAny: false });
		return;
	}
	const label = OUTCOME_LABELS[outcome] ?? "";
	nodes.badge.hidden = !label;
	nodes.badge.className = `peer-status-badge ${OUTCOME_TONES[outcome] ?? "is-muted"}`;
	writeText(nodes.badgeText, label);
	const verdict = typeof rawIn.verdict === "string" ? rawIn.verdict : "";
	nodes.verdictSlot.hidden = verdict.length === 0;
	if (verdict) verdictMd.update({ source: verdict, streaming: false, mode: nextPart.mode, displayOnly: true });
	const reveal = String(nextPart.reveal ?? "");
	nodes.revealWrap.hidden = reveal.length === 0;
	if (reveal) revealMd.update({ source: reveal, streaming: false, mode: nextPart.mode, displayOnly: true });
	nodes.metadata.update(readConcludeMeta(nextPart));
}

export function createConcludeCardHandle(doc, part, ctx) {
	const life = createLife();
	const nodes = buildConcludeDom(doc, life, part);
	const verdictMd = createMarkdown(nodes.verdictSlot, { displayOnly: true, onExpand: ctx?.onExpand });
	const revealMd = createMarkdown(nodes.revealSlot, { displayOnly: true, onExpand: ctx?.onExpand });
	const update = (nextPart) => { if (!life.dead) applyConcludeUpdate(nodes, verdictMd, revealMd, nextPart); };
	update(part);
	return {
		key: `conclude-card:${part.id}`,
		node: nodes.root,
		update,
		destroy: () => {
			if (!life.destroy()) return;
			nodes.metadata.destroy();
			revealMd.destroy();
			verdictMd.destroy();
			nodes.root.remove();
		},
	};
}

export function createQuestionPreviewHandle(doc, part, ctx) {
	const root = el(doc, "div", {
		className: "peer-session-card peer-question-preview",
		attrs: { "data-testid": "question-preview", "data-peer-part-type": part.partType },
	});
	const head = el(doc, "div", { className: "peer-session-card-head" });
	const titleEl = el(doc, "span", { className: "peer-card-eyebrow" });
	const titleText = textNode(doc, titleEl, "");
	const metaEl = el(doc, "span", { className: "peer-session-card-meta" });
	const metaText = textNode(doc, metaEl, "");
	head.append(titleEl, metaEl);
	const bodySlot = el(doc, "div", { className: "peer-question-preview-body", attrs: { hidden: true } });
	root.append(head, bodySlot);
	const md = createMarkdown(bodySlot, { displayOnly: true, onExpand: ctx?.onExpand });

	const update = (nextPart) => {
		const rawIn = nextPart.input && typeof nextPart.input === "object" ? nextPart.input : {};
		writeText(titleText, formatQuestionCardLabel(nextPart.toolName, undefined, rawIn.type));
		writeText(metaText, nextPart.state === "input-streaming" ? "Writing a question…" : "Pending");
		const prompt = String(rawIn.question ?? rawIn.prompt ?? "").trim();
		bodySlot.hidden = prompt === "";
		if (prompt) md.update({ source: prompt, streaming: nextPart.state === "input-streaming", mode: nextPart.mode, displayOnly: true });
	};
	update(part);
	return { key: `question-preview:${part.id}`, node: root, update, destroy: () => { md.destroy(); root.remove(); } };
}

export function createMalformedQuestionHandle(doc, part, ctx) {
	const life = createLife();
	const root = el(doc, "div", {
		className: "peer-malformed-question",
		attrs: { "data-testid": "malformed-question", "data-peer-part-type": part.partType },
	});
	const msgEl = el(doc, "p", { className: "peer-malformed-question-text" });
	const msgText = textNode(doc, msgEl, "");
	let currentPart = part;
	let currentCtx = ctx;
	const onRetry = () => currentCtx?.onRetryQuestion?.({
		toolCallId: currentPart.toolCallId,
		messageId: currentPart.sourceMessageId,
		contentIndex: currentPart.sourceContentIndex,
	});
	const retryBtn = button(doc, {
		className: "peer-malformed-question-retry",
		label: "Retry question",
		signal: life.signal,
		onClick: onRetry,
		attrs: { "data-testid": "retry-malformed-question", "data-peer-action": "retry-question" },
	});
	const reasonEl = el(doc, "p", { className: "peer-malformed-question-reason", attrs: { hidden: true } });
	const reasonText = textNode(doc, reasonEl, "");
	root.append(msgEl, retryBtn, reasonEl);

	const update = (nextPart, nextCtx) => {
		currentPart = nextPart;
		currentCtx = nextCtx ?? currentCtx;
		const canRetry = nextPart.canRetry !== false && typeof currentCtx?.onRetryQuestion === "function";
		const copy = canRetry
			? "This question could not be displayed. Retry it or send a message to continue."
			: "This question could not be displayed.";
		writeText(msgText, copy);
		retryBtn.hidden = !canRetry;
		retryBtn.disabled = Boolean(nextPart.busy);
		const reason = String(nextPart.errorText ?? "").trim();
		reasonEl.hidden = reason === "";
		writeText(reasonText, reason);
	};
	update(part, ctx);
	return { key: `malformed-question:${part.id}`, node: root, update, destroy: () => { if (life.destroy()) root.remove(); } };
}
