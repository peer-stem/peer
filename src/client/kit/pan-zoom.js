/**
 * Interactive 2D pan/zoom viewport (`L-14`) for SVG diagrams and PlanTrees.
 * Supports wheel zoom-to-cursor, pointer drag panning (ignoring interactive child
 * controls), `fit(bounds)`, `reset()`, and `setTransform({ x, y, k })`.
 */
import { clamp, createLife, documentOf, el, isControlTarget } from "cloudcanvas-lib/ui";
import { injectKitStyles } from "./styles.js";

const CLASS = "cloudcanvas-ui-pan-zoom";

function bindPanZoomGestures(life, root, state, applyTransform) {
	let drag = null;
	life.on(root, "wheel", (event) => {
		event.preventDefault();
		const rect = root.getBoundingClientRect?.() ?? { left: 0, top: 0 };
		const px = (event.clientX ?? 0) - rect.left;
		const py = (event.clientY ?? 0) - rect.top;
		const nextK = clamp(state.t.k * Math.exp(-event.deltaY * 0.002), state.min, state.max);
		const ratio = nextK / state.t.k;
		applyTransform({
			x: px - (px - state.t.x) * ratio,
			y: py - (py - state.t.y) * ratio,
			k: nextK,
		});
	}, { passive: false });

	life.on(root, "pointerdown", (event) => {
		if (event.button !== 0 || isControlTarget(event.target)) return;
		drag = { id: event.pointerId, sx: event.clientX, sy: event.clientY, ox: state.t.x, oy: state.t.y };
		root.setPointerCapture?.(event.pointerId);
	});
	life.on(root, "pointermove", (event) => {
		if (!drag || event.pointerId !== drag.id) return;
		applyTransform({ x: drag.ox + (event.clientX - drag.sx), y: drag.oy + (event.clientY - drag.sy), k: state.t.k });
	});
	const endDrag = (event) => {
		if (!drag || event.pointerId !== drag.id) return;
		root.releasePointerCapture?.(event.pointerId);
		drag = null;
	};
	life.on(root, "pointerup", endDrag);
	life.on(root, "pointercancel", endDrag);
}

function fitBoundsTransform(root, state, bounds, padding = 16) {
	const vw = root.clientWidth || 320;
	const vh = root.clientHeight || 240;
	const bw = Math.max(1, bounds?.width ?? 1);
	const bh = Math.max(1, bounds?.height ?? 1);
	const ox = bounds?.x ?? 0;
	const oy = bounds?.y ?? 0;
	const k = clamp(Math.min((vw - 2 * padding) / bw, (vh - 2 * padding) / bh), state.min, state.max);
	return { x: (vw - bw * k) / 2 - ox * k, y: (vh - bh * k) / 2 - oy * k, k };
}

/**
 * @param {HTMLElement} host
 * @param {{minScale?: number, maxScale?: number, onTransform?: (t: {x: number, y: number, k: number}) => void}} [options]
 */
export function createPanZoom(host, options = {}) {
	const doc = documentOf(host);
	injectKitStyles(doc);
	const life = createLife();
	const state = {
		min: options.minScale ?? 0.2,
		max: options.maxScale ?? 4,
		t: { x: 0, y: 0, k: 1 },
	};
	const root = el(doc, "div", { className: CLASS });
	const stage = el(doc, "div", { className: `${CLASS}-stage` });
	root.append(stage);
	host.append(root);

	const applyTransform = (next, notify = true) => {
		state.t = {
			x: Number.isFinite(next.x) ? next.x : 0,
			y: Number.isFinite(next.y) ? next.y : 0,
			k: clamp(Number.isFinite(next.k) ? next.k : 1, state.min, state.max),
		};
		stage.style.transform = `translate(${state.t.x}px, ${state.t.y}px) scale(${state.t.k})`;
		if (notify) options.onTransform?.({ ...state.t });
	};
	bindPanZoomGestures(life, root, state, applyTransform);

	return {
		root,
		stage,
		getTransform: () => ({ ...state.t }),
		setTransform: (next) => applyTransform(next, false),
		reset: () => applyTransform({ x: 0, y: 0, k: 1 }, false),
		fit: (bounds, padding = 16) => applyTransform(fitBoundsTransform(root, state, bounds, padding), false),
		update(model = {}) {
			if (life.dead) return;
			if (model.content && stage.firstChild !== model.content) stage.replaceChildren(model.content);
			if (model.transform) applyTransform(model.transform, false);
		},
		destroy() {
			if (life.destroy()) root.remove();
		},
	};
}
