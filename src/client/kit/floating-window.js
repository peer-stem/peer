/**
 * Non-modal floating window (`L-18`), text-selection popover (`L-17`),
 * and in-container `Mod+F` find bar (`L-21`, `CSS.highlights` with DOM fallback).
 */
import { button, clamp, createLife, documentOf, el, input, isControlTarget, textNode, writeText } from "cloudcanvas-lib/ui";
import { injectKitStyles } from "./styles.js";

function clampAndApplyGeom(doc, root, geom, onGeometryChange, emit) {
	const win = doc.defaultView;
	const vw = win?.innerWidth || 1280;
	const vh = win?.innerHeight || 800;
	geom.width = clamp(geom.width, geom.minW, Math.max(geom.minW, vw - 16));
	geom.height = clamp(geom.height, geom.minH, Math.max(geom.minH, vh - 16));
	geom.x = clamp(geom.x, 8, Math.max(8, vw - geom.width - 8));
	geom.y = clamp(geom.y, 8, Math.max(8, vh - geom.height - 8));
	root.style.left = `${Math.round(geom.x)}px`;
	root.style.top = `${Math.round(geom.y)}px`;
	root.style.width = `${Math.round(geom.width)}px`;
	root.style.height = `${Math.round(geom.height)}px`;
	if (emit) onGeometryChange?.({ x: geom.x, y: geom.y, width: geom.width, height: geom.height });
}

function bindFloatingGestures(life, root, header, resizer, geom, applyGeom) {
	let gesture = null;
	life.on(header, "pointerdown", (e) => {
		if (e.button !== 0 || isControlTarget(e.target)) return;
		gesture = { kind: "move", id: e.pointerId, sx: e.clientX, sy: e.clientY, ox: geom.x, oy: geom.y };
		header.setPointerCapture?.(e.pointerId);
	});
	life.on(resizer, "pointerdown", (e) => {
		if (e.button !== 0) return;
		e.stopPropagation();
		gesture = { kind: "resize", id: e.pointerId, sx: e.clientX, sy: e.clientY, ow: geom.width, oh: geom.height };
		resizer.setPointerCapture?.(e.pointerId);
	});
	life.on(root, "pointermove", (e) => {
		if (!gesture || e.pointerId !== gesture.id) return;
		if (gesture.kind === "move") {
			geom.x = gesture.ox + (e.clientX - gesture.sx);
			geom.y = gesture.oy + (e.clientY - gesture.sy);
		} else {
			geom.width = gesture.ow + (e.clientX - gesture.sx);
			geom.height = gesture.oh + (e.clientY - gesture.sy);
		}
		applyGeom(true);
	});
	const endGesture = (e) => { if (gesture && e.pointerId === gesture.id) gesture = null; };
	life.on(root, "pointerup", endGesture);
	life.on(root, "pointercancel", endGesture);
}

/**
 * @param {HTMLElement} host
 * @param {{onClose?: () => void, onGeometryChange?: (rect: {x: number, y: number, width: number, height: number}) => void}} [callbacks]
 */
export function createFloatingWindow(host, { onClose, onGeometryChange } = {}) {
	const doc = documentOf(host);
	injectKitStyles(doc);
	const life = createLife();
	const root = el(doc, "section", { className: "cloudcanvas-ui-floating-window", attrs: { hidden: true } });
	const header = el(doc, "div", { className: "cloudcanvas-ui-floating-header" });
	const titleEl = el(doc, "strong", { className: "cloudcanvas-ui-floating-title" });
	const titleText = textNode(doc, titleEl, "");
	header.append(titleEl, button(doc, { label: "Close", signal: life.signal, onClick: () => onClose?.() }));
	const body = el(doc, "div", { className: "cloudcanvas-ui-floating-body" });
	const resizer = el(doc, "div", { className: "cloudcanvas-ui-floating-resize", attrs: { "aria-hidden": "true" } });
	root.append(header, body, resizer);
	host.append(root);

	const geom = { x: 48, y: 48, width: 380, height: 420, minW: 260, minH: 180 };
	const applyGeom = (emit = false) => clampAndApplyGeom(doc, root, geom, onGeometryChange, emit);
	bindFloatingGestures(life, root, header, resizer, geom, applyGeom);

	return {
		root,
		body,
		getGeometry: () => ({ x: geom.x, y: geom.y, width: geom.width, height: geom.height }),
		update(model = {}) {
			if (life.dead) return;
			const open = Boolean(model.open);
			root.hidden = !open;
			writeText(titleText, model.title ?? "");
			if (model.geometry) Object.assign(geom, model.geometry);
			if (model.content && body.firstChild !== model.content) body.replaceChildren(model.content);
			if (open) applyGeom(false);
		},
		destroy() {
			if (life.destroy()) root.remove();
		},
	};
}

function rebuildSelectionButtons(doc, life, bar, actions, onClickAction) {
	bar.replaceChildren();
	for (const act of actions ?? []) {
		bar.append(button(doc, { label: act.label, signal: life.signal, onClick: () => onClickAction(act.id) }));
	}
}

function syncSelectionPopover(doc, bar, targetRoot, state, hide) {
	const sel = doc.getSelection?.();
	if (!targetRoot || !sel || sel.isCollapsed || sel.rangeCount === 0) { hide(); return; }
	const range = sel.getRangeAt(0);
	if (!targetRoot.contains(range.commonAncestorContainer)) { hide(); return; }
	const text = sel.toString().trim();
	if (!text) { hide(); return; }
	state.range = range.cloneRange();
	state.text = text;
	const rect = range.getBoundingClientRect?.() ?? { left: 16, top: 16, width: 0 };
	bar.hidden = false;
	bar.style.left = `${Math.max(8, Math.round(rect.left + rect.width / 2 - (bar.offsetWidth || 80) / 2))}px`;
	bar.style.top = `${Math.max(8, Math.round(rect.top - 38))}px`;
}

/**
 * @param {HTMLElement} host
 * @param {{targetRoot: HTMLElement, actions?: Array<{id: string, label: string}>, onAction?: (actionId: string, selectedText: string, range: Range) => void}} options
 */
export function createSelectionPopover(host, options) {
	const doc = documentOf(host);
	injectKitStyles(doc);
	const life = createLife();
	const bar = el(doc, "div", { className: "cloudcanvas-ui-selection-popover", attrs: { role: "toolbar", hidden: true } });
	host.append(bar);
	const state = { range: null, text: "" };
	const hide = () => { bar.hidden = true; state.range = null; state.text = ""; };
	const triggerAction = (id) => {
		if (state.text && state.range) options?.onAction?.(id, state.text, state.range);
		hide();
	};
	rebuildSelectionButtons(doc, life, bar, options?.actions ?? [], triggerAction);
	life.on(doc, "selectionchange", () => syncSelectionPopover(doc, bar, options?.targetRoot, state, hide));
	life.on(doc, "keydown", (e) => { if (e.key === "Escape") hide(); }, { capture: true });

	return {
		root: bar,
		hide,
		update(model = {}) {
			if (life.dead || !Array.isArray(model.actions)) return;
			rebuildSelectionButtons(doc, life, bar, model.actions, triggerAction);
		},
		destroy() {
			if (life.destroy()) bar.remove();
		},
	};
}

function scanTextNodeMatches(doc, textNodeEl, q, matches) {
	const hay = textNodeEl.data.toLowerCase();
	let pos = 0;
	while ((pos = hay.indexOf(q, pos)) !== -1) {
		let range = null;
		if (doc.createRange) {
			range = doc.createRange();
			range.setStart(textNodeEl, pos);
			range.setEnd(textNodeEl, pos + q.length);
		}
		matches.push({ node: textNodeEl, start: pos, end: pos + q.length, range });
		pos += q.length;
	}
}

function collectTextMatches(container, query) {
	const q = query.toLowerCase();
	if (!q || !container) return [];
	const doc = container.ownerDocument;
	const matches = [];
	const stack = [container];
	while (stack.length > 0) {
		const cur = stack.pop();
		if (cur.nodeType === 3) {
			scanTextNodeMatches(doc, cur, q, matches);
		} else if (cur.nodeType === 1 && !cur.hidden && cur.getAttribute("aria-hidden") !== "true") {
			for (let i = cur.childNodes.length - 1; i >= 0; i -= 1) stack.push(cur.childNodes[i]);
		}
	}
	return matches;
}

function applyFindHighlights(matches, index, countText) {
	const hlApi = globalThis.CSS?.highlights;
	const HighlightCtor = globalThis.Highlight;
	if (hlApi && typeof HighlightCtor === "function") {
		const ranges = matches.map((m) => m.range).filter(Boolean);
		if (ranges.length > 0) hlApi.set("cc-find-match", new HighlightCtor(...ranges));
		else hlApi.delete("cc-find-match");
	}
	writeText(countText, matches.length ? `${index + 1}/${matches.length}` : "0/0");
	matches[index]?.node?.parentElement?.scrollIntoView?.({ block: "nearest" });
}

function applyFindBarModel(state, root, field, runSearch, model = {}) {
	const open = Boolean(model.open);
	const wasHidden = root.hidden;
	root.hidden = !open;
	if (!open) {
		state.matches = [];
		globalThis.CSS?.highlights?.delete?.("cc-find-match");
		return;
	}
	if (model.query !== undefined && field.value !== model.query) {
		field.value = String(model.query);
		runSearch(field.value, 0);
	} else if (wasHidden) {
		runSearch(field.value, 0);
		field.focus();
	}
}

function buildFindBarDom(doc, life, runSearch, step, close) {
	const root = el(doc, "div", { className: "cloudcanvas-ui-find-bar", attrs: { role: "search", hidden: true } });
	const countEl = el(doc, "span", { className: "cloudcanvas-ui-find-count" });
	const countText = textNode(doc, countEl, "0/0");
	const field = input(doc, { label: "Find in page", placeholder: "Find…", signal: life.signal, onInput: (v) => runSearch(v, 0) });
	root.append(
		field, countEl,
		button(doc, { label: "Prev", signal: life.signal, onClick: () => step(-1) }),
		button(doc, { label: "Next", signal: life.signal, onClick: () => step(1) }),
		button(doc, { label: "Close", signal: life.signal, onClick: close }),
	);
	life.on(field, "keydown", (e) => {
		if (e.key === "Enter") { e.preventDefault(); step(e.shiftKey ? -1 : 1); }
		else if (e.key === "Escape") { e.preventDefault(); close(); }
	});
	return { root, field, countText };
}

/**
 * @param {HTMLElement} host
 * @param {{targetRoot: HTMLElement, onClose?: () => void}} options
 */
export function createFindBar(host, options) {
	const doc = documentOf(host);
	injectKitStyles(doc);
	const life = createLife();
	const state = { matches: [], index: 0 };
	let dom = null;

	const runSearch = (query, nextIdx = 0) => {
		state.matches = collectTextMatches(options?.targetRoot, String(query ?? ""));
		const len = state.matches.length;
		state.index = len ? ((nextIdx % len) + len) % len : 0;
		applyFindHighlights(state.matches, state.index, dom.countText);
	};
	const step = (delta) => {
		const len = state.matches.length;
		if (!len) return;
		state.index = ((state.index + delta) % len + len) % len;
		applyFindHighlights(state.matches, state.index, dom.countText);
	};
	const close = () => {
		state.matches = [];
		state.index = 0;
		globalThis.CSS?.highlights?.delete?.("cc-find-match");
		dom.root.hidden = true;
		options?.onClose?.();
	};
	dom = buildFindBarDom(doc, life, runSearch, step, close);
	host.append(dom.root);

	return {
		root: dom.root,
		input: dom.field,
		getMatchCount: () => state.matches.length,
		focus: () => dom.field.focus(),
		step,
		update: (model = {}) => { if (!life.dead) applyFindBarModel(state, dom.root, dom.field, runSearch, model); },
		destroy() {
			if (!life.destroy()) return;
			globalThis.CSS?.highlights?.delete?.("cc-find-match");
			dom.root.remove();
		},
	};
}
