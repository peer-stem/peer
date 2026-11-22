/**
 * Circular SVG progress ring (`L-8`, `0..1` fraction) with `role="progressbar"`.
 */
import { clamp, createLife, documentOf, el } from "cloudcanvas-lib/ui";
import { injectKitStyles } from "./styles.js";

const SVG_NS = "http://www.w3.org/2000/svg";

function buildRingNodes(doc, size, strokeWidth) {
	const r = Math.max(2, (size - strokeWidth) / 2);
	const circumference = 2 * Math.PI * r;
	const svg = doc.createElementNS(SVG_NS, "svg");
	svg.setAttribute("width", String(size));
	svg.setAttribute("height", String(size));
	svg.setAttribute("viewBox", `0 0 ${size} ${size}`);
	svg.setAttribute("aria-hidden", "true");
	const track = doc.createElementNS(SVG_NS, "circle");
	track.setAttribute("cx", String(size / 2));
	track.setAttribute("cy", String(size / 2));
	track.setAttribute("r", String(r));
	track.setAttribute("fill", "none");
	track.setAttribute("stroke", "var(--cc-border, rgba(128,128,128,0.28))");
	track.setAttribute("stroke-width", String(strokeWidth));
	const bar = doc.createElementNS(SVG_NS, "circle");
	bar.setAttribute("cx", String(size / 2));
	bar.setAttribute("cy", String(size / 2));
	bar.setAttribute("r", String(r));
	bar.setAttribute("fill", "none");
	bar.setAttribute("stroke", "var(--cc-accent, currentColor)");
	bar.setAttribute("stroke-width", String(strokeWidth));
	bar.setAttribute("stroke-linecap", "round");
	bar.setAttribute("stroke-dasharray", String(circumference));
	bar.setAttribute("stroke-dashoffset", String(circumference));
	bar.setAttribute("transform", `rotate(-90 ${size / 2} ${size / 2})`);
	svg.append(track, bar);
	return { svg, bar, circumference };
}

function applyRingModel(root, ring, interactive, model = {}) {
	const value = clamp(Number(model.value) || 0, 0, 1);
	const pct = Math.round(value * 100);
	ring.bar.setAttribute("stroke-dashoffset", String(ring.circumference * (1 - value)));
	if (model.tone === "success") ring.bar.setAttribute("stroke", "var(--cc-tone-success, #10b981)");
	else if (model.tone === "warning") ring.bar.setAttribute("stroke", "var(--cc-tone-warning, #f59e0b)");
	else ring.bar.setAttribute("stroke", "var(--cc-accent, currentColor)");
	if (interactive) {
		root.disabled = Boolean(model.disabled);
		root.setAttribute("aria-label", String(model.label ?? `${pct}%`));
	} else {
		root.setAttribute("aria-valuenow", String(pct));
		if (model.label) root.setAttribute("aria-label", String(model.label));
	}
	if (model.title) root.title = String(model.title);
	root.hidden = model.hidden === true;
}

/**
 * @param {HTMLElement} host
 * @param {{onClick?: (event: MouseEvent) => void, size?: number, strokeWidth?: number}} [options]
 */
export function createRingProgress(host, options = {}) {
	const doc = documentOf(host);
	injectKitStyles(doc);
	const life = createLife();
	const interactive = typeof options.onClick === "function";
	const root = el(doc, interactive ? "button" : "span", {
		className: "cloudcanvas-ui-ring",
		attrs: interactive
			? { type: "button" }
			: { role: "progressbar", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": "0" },
	});
	const ring = buildRingNodes(doc, options.size ?? 18, options.strokeWidth ?? 2.25);
	root.append(ring.svg);
	host.append(root);

	if (interactive) {
		life.on(root, "click", (event) => {
			if (!life.dead && !root.disabled) options.onClick(event);
		});
	}

	return {
		root,
		update(model = {}) {
			if (!life.dead) applyRingModel(root, ring, interactive, model);
		},
		destroy() {
			if (life.destroy()) root.remove();
		},
	};
}
