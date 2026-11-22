/**
 * Fullscreen pan-zoom viewer (`[data-testid="pan-zoom-viewer"][data-peer-layer="viewer"]`).
 * Built on `createModal` + `createPanZoom` from `'peer-kit'`, safely rendering sanitized
 * SVG diagrams (`DOMParser` with script/event stripping), session images, or expanded code
 * with `Fit`, `Reset`, zoom `−`/`+`, and `Close` controls.
 */
import { button, clamp, createLife, documentOf, el, injectUiStyles, safeHref, textNode, writeText } from "cloudcanvas-lib/ui";
import { createModal, createPanZoom } from "peer-kit";
import { injectOverlaysStyles } from "./overlays.css.js";

const ZOOM_MIN = 0.1;
const ZOOM_MAX = 4;
const ZOOM_STEP = 1.25;
const FORBIDDEN_SVG_TAGS = /* @__PURE__ */ new Set([
	"script", "iframe", "object", "embed", "applet", "meta", "link", "base",
]);
const URL_ATTRS = /* @__PURE__ */ new Set(["href", "xlink:href", "src", "action", "formaction"]);

function scrubSvgAttributes(node) {
	const names = node.getAttributeNames
		? node.getAttributeNames()
		: Array.from(node.attributes ?? [], (attr) => attr.name);
	for (const name of names) {
		const lower = name.toLowerCase();
		if (lower.startsWith("on") || lower === "srcdoc") {
			node.removeAttribute(name);
			continue;
		}
		if (!URL_ATTRS.has(lower)) continue;
		const val = String(node.getAttribute(name) ?? "").trim();
		if (!val.startsWith("#") && !safeHref(val, { allowRelative: false })) {
			node.removeAttribute(name);
		}
	}
}

function sanitizeSvgTree(svgRoot) {
	scrubSvgAttributes(svgRoot);
	const stack = Array.from(svgRoot.children ?? []);
	while (stack.length > 0) {
		const node = stack.pop();
		const tag = (node.localName ?? node.tagName ?? "").toLowerCase();
		if (FORBIDDEN_SVG_TAGS.has(tag)) {
			node.remove();
			continue;
		}
		scrubSvgAttributes(node);
		for (const child of Array.from(node.children ?? [])) stack.push(child);
	}
}

function parseSafeSvg(doc, svgMarkup) {
	const raw = String(svgMarkup ?? "").trim();
	if (!raw) return null;
	const Parser = doc.defaultView?.DOMParser ?? globalThis.DOMParser;
	if (typeof Parser !== "function") return null;
	const parser = new Parser();
	const xmlDoc = parser.parseFromString(raw, "image/svg+xml");
	const isCleanSvg = !xmlDoc.querySelector("parsererror")
		&& (xmlDoc.documentElement?.localName ?? "").toLowerCase() === "svg";
	const svgNode = isCleanSvg
		? xmlDoc.documentElement
		: parser.parseFromString(raw, "text/html").querySelector("svg");
	if (!svgNode) return null;
	sanitizeSvgTree(svgNode);
	return doc.importNode(svgNode, true);
}

function isSafeImageSrc(rawSrc) {
	const src = String(rawSrc ?? "").trim();
	if (!src) return false;
	if (/^data:image\/(?:png|jpeg|jpg|gif|webp);base64,[a-z0-9+/=\s]+$/i.test(src)) return true;
	return Boolean(safeHref(src, { allowRelative: true }));
}

function normalizeViewerModel(raw) {
	if (typeof raw === "string") {
		const trimmed = raw.trim();
		if (trimmed.startsWith("<svg")) return { kind: "svg", title: "Diagram", svg: trimmed, imageSrc: "", code: "" };
		if (trimmed.startsWith("data:image/")) return { kind: "image", title: "Image", svg: "", imageSrc: trimmed, code: "" };
		return { kind: "code", title: "Expanded source", svg: "", imageSrc: "", code: raw };
	}
	const kind = String(raw?.kind ?? (raw?.svg ? "svg" : raw?.imageSrc ? "image" : "code"));
	const fallbackTitle = kind === "image" ? "Image" : kind === "code" ? "Code" : "Diagram";
	return {
		kind,
		title: String(raw?.title ?? fallbackTitle),
		svg: String(raw?.svg ?? ""),
		imageSrc: String(raw?.imageSrc ?? ""),
		code: String(raw?.code ?? ""),
	};
}

function readContentBounds(node) {
	if (!node) return { width: 320, height: 240 };
	const vb = node.getAttribute?.("viewBox");
	if (vb) {
		const nums = vb.trim().split(/[\s,]+/).map(Number);
		if (nums.length === 4 && nums[2] > 0 && nums[3] > 0) return { x: 0, y: 0, width: nums[2], height: nums[3] };
	}
	const w = Number(node.naturalWidth || node.getAttribute?.("width") || node.clientWidth || 320);
	const h = Number(node.naturalHeight || node.getAttribute?.("height") || node.clientHeight || 240);
	return { x: 0, y: 0, width: Math.max(1, w), height: Math.max(1, h) };
}

function buildViewerContent(doc, normalized) {
	if (normalized.svg) {
		const svgEl = parseSafeSvg(doc, normalized.svg);
		if (svgEl) return svgEl;
	}
	if (normalized.imageSrc && isSafeImageSrc(normalized.imageSrc)) {
		return el(doc, "img", {
			className: "peer-overlays-viewer-img",
			attrs: { src: normalized.imageSrc, alt: normalized.title || "Expanded image" },
		});
	}
	const pre = el(doc, "pre", { className: "peer-overlays-viewer-code" });
	pre.append(el(doc, "code", { text: normalized.code || normalized.svg || "" }));
	return pre;
}

function buildViewerToolbar(doc, life, actions) {
	const bar = el(doc, "header", { className: "peer-overlays-viewer-bar" });
	const titleEl = el(doc, "h2", { className: "peer-overlays-viewer-title", attrs: { "data-peer-viewer-title": "" } });
	const titleText = textNode(doc, titleEl, "Viewer");
	const controls = el(doc, "div", { className: "peer-overlays-viewer-controls" });
	const scaleEl = el(doc, "span", { className: "peer-overlays-viewer-scale", attrs: { "data-peer-viewer-zoom": "" } });
	const scaleText = textNode(doc, scaleEl, "100%");
	controls.append(
		button(doc, { label: "−", ariaLabel: "Zoom out", signal: life.signal, attrs: { "data-testid": "viewer-zoom-out", "data-peer-action": "zoom-out" }, onClick: actions.zoomOut }),
		scaleEl,
		button(doc, { label: "+", ariaLabel: "Zoom in", signal: life.signal, attrs: { "data-testid": "viewer-zoom-in", "data-peer-action": "zoom-in" }, onClick: actions.zoomIn }),
		button(doc, { label: "Fit", ariaLabel: "Fit to view", signal: life.signal, attrs: { "data-testid": "viewer-zoom-fit", "data-peer-action": "zoom-fit" }, onClick: actions.fit }),
		button(doc, { label: "Reset", ariaLabel: "Reset zoom", signal: life.signal, attrs: { "data-testid": "viewer-zoom-reset", "data-peer-action": "zoom-reset" }, onClick: actions.resetZoom }),
		button(doc, { label: "Close", ariaLabel: "Close viewer", signal: life.signal, attrs: { "data-testid": "viewer-close", "data-peer-action": "close-viewer" }, onClick: actions.close }),
	);
	bar.append(titleEl, controls);
	return { bar, titleText, scaleText };
}

function syncViewerDialogAttrs(dialogEl, isOpen, kind) {
	if (!dialogEl) return;
	dialogEl.classList.add("peer-overlays-viewer-dialog");
	const header = dialogEl.querySelector(".cloudcanvas-ui-dialog-header");
	if (header) header.hidden = true;
	if (isOpen) {
		dialogEl.setAttribute("data-testid", "pan-zoom-viewer");
		dialogEl.setAttribute("data-peer-layer", "viewer");
		dialogEl.setAttribute("data-peer-viewer-kind", kind);
	} else {
		dialogEl.removeAttribute("data-testid");
		dialogEl.removeAttribute("data-peer-layer");
		dialogEl.removeAttribute("data-peer-viewer-kind");
	}
}

function bindViewerEscape(life, win, isOpenFn, onClose) {
	if (!win || typeof win.addEventListener !== "function") return;
	life.on(win, "keydown", (event) => {
		if (!isOpenFn() || event.key !== "Escape" || event.defaultPrevented) return;
		event.preventDefault();
		onClose?.();
	});
}

function applyViewerUpdate(state, payload = {}) {
	if (state.life.dead || payload === state.prevPayload) return;
	state.prevPayload = payload;
	if (payload === null || payload === false || payload?.open === false) {
		state.isOpen = false;
		state.modal.update({ open: false, closeButton: false, content: state.wrapper });
		syncViewerDialogAttrs(state.dialogEl, false, "");
		return;
	}
	state.isOpen = true;
	const normalized = normalizeViewerModel(payload);
	writeText(state.titleText, normalized.title);
	state.contentNode = buildViewerContent(state.doc, normalized);
	state.modal.update({ open: true, title: normalized.title, closeButton: false, content: state.wrapper });
	syncViewerDialogAttrs(state.dialogEl, true, normalized.kind);
	state.panZoom.update({ content: state.contentNode, transform: { x: 0, y: 0, k: 1 } });
	state.syncReadout(1);
}

export function createPanZoomViewer(host, { onClose } = {}) {
	const doc = documentOf(host);
	injectUiStyles(doc);
	injectOverlaysStyles(doc);
	const life = createLife();
	const modal = createModal(host, { onClose: () => onClose?.() });
	const dialogEl = modal.body.closest("dialog");
	const wrapper = el(doc, "div", { className: "peer-overlays-viewer-frame" });
	const stageHost = el(doc, "div", { className: "peer-overlays-viewer-stage", attrs: { "data-peer-viewer-stage": "" } });
	const state = {
		doc, life, modal, dialogEl, wrapper, panZoom: null, scaleText: null, titleText: null,
		contentNode: null, isOpen: false, prevPayload: undefined, syncReadout: null,
	};
	state.syncReadout = (k) => {
		state.panZoom.stage.setAttribute("data-peer-zoom", k.toFixed(2));
		if (state.scaleText) writeText(state.scaleText, `${Math.round(k * 100)}%`);
	};
	state.panZoom = createPanZoom(stageHost, { minScale: ZOOM_MIN, maxScale: ZOOM_MAX, onTransform: (t) => state.syncReadout(t.k) });
	state.panZoom.stage.setAttribute("data-peer-viewer-canvas", "");

	const stepZoom = (factor) => {
		const cur = state.panZoom.getTransform();
		const nextK = clamp(cur.k * factor, ZOOM_MIN, ZOOM_MAX);
		state.panZoom.setTransform({ x: cur.x, y: cur.y, k: nextK });
		state.syncReadout(nextK);
	};
	const zoomIn = () => stepZoom(ZOOM_STEP);
	const zoomOut = () => stepZoom(1 / ZOOM_STEP);
	const resetZoom = () => { state.panZoom.reset(); state.syncReadout(1); };
	const fit = () => { state.panZoom.fit(readContentBounds(state.contentNode), 24); state.syncReadout(state.panZoom.getTransform().k); };

	const toolbar = buildViewerToolbar(doc, life, { zoomIn, zoomOut, fit, resetZoom, close: () => onClose?.() });
	state.scaleText = toolbar.scaleText;
	state.titleText = toolbar.titleText;
	wrapper.append(toolbar.bar, stageHost);
	bindViewerEscape(life, doc.defaultView, () => state.isOpen, onClose);

	const destroy = () => {
		if (!life.destroy()) return;
		state.isOpen = false;
		state.panZoom.destroy();
		modal.destroy();
	};
	return { node: dialogEl, update: (p) => applyViewerUpdate(state, p), fit, zoomIn, zoomOut, resetZoom, destroy };
}
