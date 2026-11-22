/**
 * Isolated SVG figure artifact card (`visual-card.js`).
 * Exports `svgNaturalWidth` and `createVisualOutputHandle(doc, part, ctx)`.
 * Always isolates generated SVG markup inside `<img src="data:image/svg+xml,...">`
 * via `svgImageSource` (`'peer-engine'`) — never injecting raw `<svg>` into app DOM.
 */
import { createLife, el } from "cloudcanvas-lib/ui";
import { embedLearnerImage, svgImageSource } from "peer-engine";
import { downloadFile } from "./download.js";

export function svgNaturalWidth(svg) {
	const m = /<svg\b[^>]*?\bwidth\s*=\s*["']([^"']+)["'][^>]*>/i.exec(String(svg ?? ""));
	if (!m) return null;
	const value = m[1].trim();
	const px = /^(\d+(?:\.\d+)?)(?:px)?$/i.exec(value);
	if (!px) return null;
	const n = Number.parseFloat(px[1]);
	return Number.isFinite(n) && n > 0 ? n : null;
}

function resolveSnapshotState(part, result, ctx) {
	const snapshotId = result?.image?.snapshotId;
	if (!snapshotId) return { annotated: false, status: "ready", image: null };
	if (part?.snapshotImage && typeof part.snapshotImage.data === "string") {
		return { annotated: true, status: "ready", image: part.snapshotImage };
	}
	const entry = part?.snapshotEntry ?? ctx?.getImageSnapshot?.(snapshotId) ?? null;
	if (!entry) return { annotated: true, status: "loading", image: null };
	if (entry.status === "error") return { annotated: true, status: "error", image: null };
	if (entry.status === "ready" && entry.image) return { annotated: true, status: "ready", image: entry.image };
	if (typeof entry.data === "string" && typeof entry.mimeType === "string") {
		return { annotated: true, status: "ready", image: entry };
	}
	return { annotated: true, status: "loading", image: null };
}

function evaluateVisualPart(part, ctx) {
	const raw = part?.result ?? part?.output ?? null;
	const res = raw && typeof raw === "object" ? raw : null;
	if (!res || typeof res.svg !== "string" || res.svg.length === 0) {
		return { state: "failed", res };
	}
	const snap = resolveSnapshotState(part, res, ctx);
	if (snap.annotated && !snap.image) {
		return { state: "waiting", failed: snap.status === "error" };
	}
	const svg = snap.annotated && snap.image ? embedLearnerImage(res.svg, snap.image) : res.svg;
	return {
		state: "ready",
		svg,
		natural: svgNaturalWidth(res.svg),
		invertible: res.image === undefined,
		messageId: part?.messageId,
		inverted: Boolean(part?.inverted ?? part?.initialInverted ?? false),
	};
}

function buildVisualFallbackNode(doc, result) {
	if (!result || typeof result.svg !== "string") {
		return el(doc, "div", {
			className: "peer-artifact-fallback",
			text: "Figure completed, but the result could not be displayed.",
		});
	}
	const root = el(doc, "div", { className: "peer-demo-card", attrs: { "data-testid": "visual-card-failed" } });
	const head = el(doc, "div", { className: "peer-brief-head" });
	head.append(
		el(doc, "span", { className: "peer-visual-eyebrow", text: "Figure" }),
		el(doc, "span", { className: "peer-artifact-badge-error", text: "failed" }),
	);
	root.append(head, el(doc, "p", { className: "peer-artifact-note", text: result.notes ?? "The figure could not be drawn." }));
	return root;
}

function buildSnapshotWaitNode(doc, failed) {
	return el(doc, "div", {
		className: "peer-artifact-note",
		text: failed ? "Image snapshot could not be loaded." : "Loading image…",
		attrs: { role: "status", "data-testid": "visual-snapshot-status" },
	});
}

function buildVisualCardDom(doc, initialInverted) {
	const root = el(doc, "div", { className: "peer-visual-card", attrs: { "data-testid": "visual-card" } });
	const svgBox = el(doc, "div", { className: "peer-visual-svg", attrs: { "data-testid": "visual-svg" } });
	const imgEl = el(doc, "img", { attrs: { alt: "Figure", draggable: "false" } });
	svgBox.append(imgEl);
	const captionRow = el(doc, "div", { className: "peer-visual-caption-row" });
	const actions = el(doc, "div", { className: "peer-demo-actions" });
	const invertBtn = el(doc, "button", {
		className: "peer-artifact-icon-btn",
		text: "◐",
		attrs: {
			type: "button",
			"data-testid": "visual-invert",
			"aria-label": "Invert figure brightness",
			"aria-pressed": String(initialInverted),
			title: "Invert colors",
		},
	});
	const downloadBtn = el(doc, "button", {
		className: "peer-artifact-icon-btn",
		text: "↓",
		attrs: { type: "button", "data-testid": "visual-download", "aria-label": "Download figure as SVG", title: "Download as SVG" },
	});
	const openBtn = el(doc, "button", {
		className: "peer-artifact-icon-btn",
		text: "⤢",
		attrs: { type: "button", "data-testid": "visual-open", "aria-label": "Open figure fullscreen", title: "Open fullscreen" },
	});
	actions.append(invertBtn, downloadBtn, openBtn);
	captionRow.append(el(doc, "div", { className: "peer-visual-eyebrow", text: "Figure" }), actions);
	root.append(svgBox, captionRow);
	return { root, svgBox, imgEl, actions, invertBtn, downloadBtn, openBtn };
}

function syncVisualPresentation(st, dom) {
	const shownInverted = st.invertible && st.inverted;
	const isNatural = !st.invertible || st.natural !== null;
	dom.root.classList.toggle("is-natural", isNatural);
	dom.svgBox.classList.toggle("is-natural", isNatural);
	dom.svgBox.classList.toggle("is-annotated", !st.invertible);
	dom.svgBox.style.filter = shownInverted ? "invert(1) hue-rotate(180deg)" : "";
	if (st.invertible && !dom.invertBtn.isConnected) dom.actions.prepend(dom.invertBtn);
	else if (!st.invertible && dom.invertBtn.isConnected) dom.invertBtn.remove();
	dom.invertBtn.setAttribute("aria-pressed", String(st.inverted));
	if (st.natural !== null) dom.imgEl.setAttribute("width", String(st.natural));
	else dom.imgEl.removeAttribute("width");
}

function buildHealthyVisualView(doc, initial, getCtx) {
	const life = createLife();
	const st = {
		svg: initial.svg,
		natural: initial.natural,
		invertible: initial.invertible,
		messageId: initial.messageId,
		inverted: Boolean(initial.inverted),
		propInverted: Boolean(initial.inverted),
	};
	const dom = buildVisualCardDom(doc, st.inverted);
	const setImageSrc = (nextSvg) => {
		dom.imgEl.setAttribute("src", `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgImageSource(nextSvg))}`);
	};
	const openExpanded = () => {
		getCtx()?.onExpand?.({ kind: "svg", title: "Figure", svg: st.svg, inverted: st.invertible && st.inverted });
	};
	life.on(dom.invertBtn, "click", () => {
		if (!st.invertible) return;
		st.inverted = !st.inverted;
		syncVisualPresentation(st, dom);
		getCtx()?.onInvertArtifact?.(st.messageId, st.inverted);
	});
	life.on(dom.downloadBtn, "click", () => downloadFile("figure.svg", st.svg, "image/svg+xml", doc));
	life.on(dom.openBtn, "click", openExpanded);
	life.on(dom.imgEl, "click", openExpanded);
	setImageSrc(st.svg);
	syncVisualPresentation(st, dom);
	return {
		root: dom.root,
		update(next) {
			if (next.svg !== st.svg) { st.svg = next.svg; setImageSrc(st.svg); }
			st.natural = next.natural;
			st.invertible = next.invertible;
			st.messageId = next.messageId;
			if (Boolean(next.inverted) !== st.propInverted) {
				st.propInverted = Boolean(next.inverted);
				st.inverted = st.propInverted;
			}
			syncVisualPresentation(st, dom);
		},
		destroy: () => { life.destroy(); dom.root.remove(); },
	};
}

export function createVisualOutputHandle(doc, part, ctx) {
	let currentCtx = ctx;
	let healthy = null;
	const handle = {
		key: `visual-output:${part?.id ?? "visual"}`,
		node: el(doc, "div"),
		update(nextPart, nextCtx) {
			if (nextCtx !== undefined) currentCtx = nextCtx;
			const next = evaluateVisualPart(nextPart, currentCtx);
			if (next.state !== "ready") {
				const prevHealthy = healthy;
				healthy = null;
				const node = next.state === "waiting" ? buildSnapshotWaitNode(doc, next.failed) : buildVisualFallbackNode(doc, next.res);
				handle.node.replaceWith(node);
				prevHealthy?.destroy();
				handle.node = node;
				return;
			}
			if (healthy) { healthy.update(next); return; }
			healthy = buildHealthyVisualView(doc, next, () => currentCtx);
			handle.node.replaceWith(healthy.root);
			handle.node = healthy.root;
		},
		destroy() {
			if (healthy) { healthy.destroy(); healthy = null; return; }
			handle.node.remove();
		},
	};
	handle.update(part, ctx);
	return handle;
}
