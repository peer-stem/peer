/**
 * Leaf part handles for `transcript-item.js` (`views §2.5`, `C2a` + `C2b`).
 * Keeps graph-context, compaction dividers, live reasoning timer, inline/snapshot
 * images, and generic fallback cards modular and bounded (`<= 50` lines/fn).
 */
import { createLife, el, textNode, writeText } from "cloudcanvas-lib/ui";
import { createKitMarkdown } from "peer-kit";

function wireImageExpand(life, imgNode, onExpand, title, imageSrc) {
	if (typeof onExpand !== "function") return;
	imgNode.classList.add("is-expandable");
	life.on(imgNode, "click", () => onExpand({ kind: "image", title, imageSrc }));
}

function populateGraphContextBody(doc, body, summaryText, part) {
	const count = part.propositions.length;
	writeText(summaryText, `Session knowledge context (${count} propositions)`);
	const children = [];
	if (part.propositions.length > 0) {
		const propList = el(doc, "ul", { className: "peer-session-context-list" });
		for (const prop of part.propositions) {
			propList.append(el(doc, "li", { text: `[${prop.id}] ${prop.name}: ${prop.statement}` }));
		}
		children.push(propList);
	}
	if (part.chains.length > 0) {
		const chainList = el(doc, "ul", { className: "peer-session-context-list" });
		for (const chain of part.chains) chainList.append(el(doc, "li", { text: chain }));
		children.push(chainList);
	}
	body.replaceChildren(...children);
}

export function createGraphContextHandle(doc, part) {
	const details = el(doc, "details", {
		className: "peer-session-context",
		attrs: { "data-peer-graph-context": "", "data-peer-part-type": "data-graph-context" },
	});
	const summary = el(doc, "summary");
	const summaryText = textNode(doc, summary, "");
	const body = el(doc, "div", { className: "peer-session-context-body" });
	details.append(summary, body);
	let sig = "";
	const update = (next) => {
		const nextSig = JSON.stringify({ p: next.propositions, c: next.chains });
		if (nextSig === sig) return;
		sig = nextSig;
		populateGraphContextBody(doc, body, summaryText, next);
	};
	update(part);
	return { key: `graph-context:${part.id}`, node: details, update, destroy: () => details.remove() };
}

export function createCompactionHandle(doc, part) {
	const isCut = part.kind === "compaction-cut";
	const root = el(doc, "div", {
		className: "peer-session-divider",
		attrs: {
			"data-peer-part-type": part.partType,
			[isCut ? "data-peer-compaction-cut" : "data-peer-compaction"]: "",
		},
	});
	const details = el(doc, "details");
	const summary = el(doc, "summary");
	const summaryText = textNode(doc, summary, "");
	const body = el(doc, "div", { className: "peer-session-divider-body" });
	const bodyText = textNode(doc, body, "");
	details.append(summary, body);
	root.append(details);
	const update = (next) => {
		const suffix = next.tokensBefore !== null ? ` (${next.tokensBefore.toLocaleString("en-US")} tokens)` : "";
		writeText(summaryText, `${next.label}${suffix}`);
		writeText(bodyText, next.content);
	};
	update(part);
	return { key: `${part.kind}:${part.id}`, node: root, update, destroy: () => root.remove() };
}

function syncReasoningTimer(timerState, details, labelNode, streaming) {
	const syncLabel = (isLive) => {
		if (isLive) {
			details.setAttribute("data-peer-streaming", "true");
			writeText(labelNode, `Thinking… ${timerState.elapsedSec}s`);
			return;
		}
		details.removeAttribute("data-peer-streaming");
		writeText(labelNode, timerState.elapsedSec > 0 ? `Thinking (${timerState.elapsedSec}s)` : "Thinking");
	};
	if (streaming && timerState.timerId === null) {
		timerState.startedAt = Date.now();
		timerState.elapsedSec = 0;
		const tick = () => {
			timerState.elapsedSec = Math.max(0, Math.floor((Date.now() - timerState.startedAt) / 1000));
			syncLabel(true);
		};
		timerState.timerId = setInterval(tick, 1000);
		timerState.timerId.unref?.();
	} else if (!streaming && timerState.timerId !== null) {
		timerState.elapsedSec = Math.max(timerState.elapsedSec, Math.floor((Date.now() - timerState.startedAt) / 1000));
		clearInterval(timerState.timerId);
		timerState.timerId = null;
	}
	syncLabel(streaming);
}

export function createReasoningHandle(doc, part, ctx) {
	const details = el(doc, "details", {
		className: "peer-session-thinking",
		attrs: { "data-peer-thinking": "", "data-peer-part-type": "reasoning" },
	});
	details.open = Boolean(ctx?.getThinkingOpen?.());
	const summary = el(doc, "summary", { className: "peer-session-thinking-summary" });
	const labelNode = textNode(doc, summary, "");
	const bodySlot = el(doc, "div", { className: "peer-session-thinking-body" });
	details.append(summary, bodySlot);
	const md = createKitMarkdown(bodySlot, { rootClassName: "peer-session-thinking-md", externalTarget: true });
	const timerState = { timerId: null, startedAt: 0, elapsedSec: 0 };

	const update = (nextPart) => {
		syncReasoningTimer(timerState, details, labelNode, Boolean(nextPart.streaming));
		md.update({
			source: String(nextPart.text ?? ""),
			streaming: Boolean(nextPart.streaming),
			mode: nextPart.mode,
			displayOnly: true,
		});
	};
	update(part);

	return {
		key: `reasoning:${part.id}`,
		node: details,
		update,
		setThinkingOpen: (open) => { details.open = Boolean(open); },
		destroy: () => {
			if (timerState.timerId !== null) clearInterval(timerState.timerId);
			timerState.timerId = null;
			md.destroy();
			details.remove();
		},
	};
}

export function createInlineImageHandle(doc, part, ctx) {
	let life = createLife();
	const figure = el(doc, "figure", {
		className: "peer-session-image",
		attrs: { "data-peer-image": "", "data-peer-part-type": "image" },
	});
	let prevSig = "";
	const update = (nextPart, nextCtx) => {
		const src = `data:${nextPart.mimeType};base64,${nextPart.data}`;
		const alt = nextPart.alt || "Attached image";
		const sig = `${src.length}:${alt}`;
		if (sig === prevSig) return;
		prevSig = sig;
		life.destroy();
		life = createLife();
		const imgNode = el(doc, "img", { attrs: { src, alt } });
		wireImageExpand(life, imgNode, (nextCtx ?? ctx)?.onExpand, alt, src);
		figure.replaceChildren(imgNode);
	};
	update(part, ctx);
	return {
		key: `inline-image:${part.id}`,
		node: figure,
		update,
		destroy: () => {
			life.destroy();
			figure.remove();
		},
	};
}

function buildSnapshotDom(doc, life, part, onExpand) {
	if (part.status === "loading") {
		return el(doc, "div", {
			className: "peer-session-card",
			text: "Loading image…",
			attrs: { "data-peer-part-type": part.partType, "data-peer-snapshot-id": part.snapshotId, "data-peer-snapshot-status": "loading" },
		});
	}
	if (part.status === "error" || !part.image) {
		return el(doc, "div", {
			className: "peer-session-card peer-session-card-error",
			text: "Could not load session image.",
			attrs: { "data-peer-part-type": part.partType, "data-peer-snapshot-id": part.snapshotId, "data-peer-snapshot-status": "error" },
		});
	}
	const img = part.image;
	const src = `data:${img.mimeType};base64,${img.data}`;
	const alt = part.caption || "Session image";
	const figure = el(doc, "figure", {
		className: "peer-session-image",
		attrs: {
			"data-testid": "image-card",
			"data-peer-snapshot-id": part.snapshotId,
			"data-peer-snapshot-status": "ready",
			"data-peer-part-type": part.partType,
		},
	});
	const imgNode = el(doc, "img", { attrs: { src, width: img.width, height: img.height, alt } });
	wireImageExpand(life, imgNode, onExpand, alt, src);
	const caption = el(doc, "figcaption", { text: part.caption || "", attrs: { hidden: !part.caption } });
	figure.append(imgNode, caption);
	return figure;
}

export function createSnapshotImageHandle(doc, part, ctx) {
	let life = createLife();
	let node = buildSnapshotDom(doc, life, part, ctx?.onExpand);
	let sig = `${part.status}:${part.snapshotId}:${part.caption}`;
	const handle = {
		key: `snapshot-image:${part.id}`,
		node,
		update(nextPart, nextCtx) {
			const nextSig = `${nextPart.status}:${nextPart.snapshotId}:${nextPart.caption}`;
			if (nextSig === sig) return;
			sig = nextSig;
			life.destroy();
			life = createLife();
			const nextNode = buildSnapshotDom(doc, life, nextPart, (nextCtx ?? ctx)?.onExpand);
			node.replaceWith(nextNode);
			node = nextNode;
			handle.node = nextNode;
		},
		destroy() {
			life.destroy();
			node.remove();
		},
	};
	return handle;
}

export function createGenericCardHandle(doc, part) {
	const card = el(doc, "div", {
		className: "peer-session-card",
		attrs: { "data-peer-part-type": part.partType, "data-peer-card-kind": part.cardKind },
	});
	const head = el(doc, "div", { className: "peer-session-card-head" });
	const titleEl = el(doc, "span", { className: "peer-session-card-title" });
	const titleText = textNode(doc, titleEl, "");
	const metaEl = el(doc, "span", { className: "peer-session-card-meta", attrs: { hidden: true } });
	const metaText = textNode(doc, metaEl, "");
	head.append(titleEl, metaEl);
	const linesWrap = el(doc, "div", { className: "peer-session-card-lines" });
	const errEl = el(doc, "div", { className: "peer-session-card-error", attrs: { hidden: true } });
	const errText = textNode(doc, errEl, "");
	card.append(head, linesWrap, errEl);

	const update = (next) => {
		card.setAttribute("data-peer-part-type", next.partType);
		card.setAttribute("data-peer-card-kind", next.cardKind);
		writeText(titleText, next.title ?? "");
		const meta = String(next.meta ?? "");
		metaEl.hidden = meta === "";
		writeText(metaText, meta);
		linesWrap.replaceChildren(...(next.lines ?? []).map((ln) => el(doc, "div", { className: "peer-session-card-line", text: ln })));
		const err = String(next.errorText ?? "");
		errEl.hidden = err === "";
		writeText(errText, err);
	};
	update(part);
	return { key: `card:${part.id}`, node: card, update, destroy: () => card.remove() };
}
