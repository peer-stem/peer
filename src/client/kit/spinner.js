/**
 * Indeterminate spinner (`L-8`, `role="status"`).
 */
import { SR_ONLY_CLASS, createLife, documentOf, el, textNode, writeText } from "cloudcanvas-lib/ui";
import { injectKitStyles } from "./styles.js";

const SVG_NS = "http://www.w3.org/2000/svg";

function buildSpinnerSvg(doc, size) {
	const svg = doc.createElementNS(SVG_NS, "svg");
	svg.setAttribute("class", "cloudcanvas-ui-spinner-svg");
	svg.setAttribute("width", String(size));
	svg.setAttribute("height", String(size));
	svg.setAttribute("viewBox", "0 0 24 24");
	svg.setAttribute("fill", "none");
	svg.setAttribute("aria-hidden", "true");
	const track = doc.createElementNS(SVG_NS, "circle");
	track.setAttribute("cx", "12");
	track.setAttribute("cy", "12");
	track.setAttribute("r", "9");
	track.setAttribute("stroke", "currentColor");
	track.setAttribute("stroke-opacity", "0.22");
	track.setAttribute("stroke-width", "2.5");
	const arc = doc.createElementNS(SVG_NS, "path");
	arc.setAttribute("d", "M21 12a9 9 0 0 0-9-9");
	arc.setAttribute("stroke", "currentColor");
	arc.setAttribute("stroke-width", "2.5");
	arc.setAttribute("stroke-linecap", "round");
	svg.append(track, arc);
	return svg;
}

function syncSpinnerSvg(doc, state, nextSize) {
	if (nextSize === state.size) return;
	state.size = nextSize;
	const nextSvg = buildSpinnerSvg(doc, nextSize);
	state.svg.replaceWith(nextSvg);
	state.svg = nextSvg;
}

/**
 * @param {HTMLElement} host
 */
export function createSpinner(host) {
	const doc = documentOf(host);
	injectKitStyles(doc);
	const life = createLife();
	const root = el(doc, "span", { className: "cloudcanvas-ui-spinner", attrs: { role: "status" } });
	const state = { size: 16, svg: buildSpinnerSvg(doc, 16) };
	const srLabel = el(doc, "span", { className: SR_ONLY_CLASS });
	const srText = textNode(doc, srLabel, "Loading");
	root.append(state.svg, srLabel);
	host.append(root);

	return {
		root,
		update(model = {}) {
			if (life.dead) return;
			const nextSize = Number(model.size) > 0 ? Number(model.size) : 16;
			syncSpinnerSvg(doc, state, nextSize);
			writeText(srText, model.label ?? "Loading");
			root.hidden = model.hidden === true;
		},
		destroy() {
			if (life.destroy()) root.remove();
		},
	};
}
