/**
 * Strict-mode Mermaid diagram block (`securityLevel: "strict"`), streaming
 * source preview while fence is open, SVG sanitization, and error fallback.
 */
import { createLife, documentOf, el, injectUiStyles, safeHref, uniqueId } from "cloudcanvas-lib/ui";
import { createMermaidPlugin } from "peer-blocks-mermaid";
import { injectBlocksStyles } from "./blocks.css.js";
import { createCopyCorner } from "./copy-corner.js";

const FORBIDDEN_SVG_TAGS = /* @__PURE__ */ new Set([
	"script", "iframe", "object", "embed", "applet", "meta", "link", "base",
]);
const URL_ATTRS = /* @__PURE__ */ new Set(["href", "xlink:href", "src", "action", "formaction"]);

/**
 * Build the strict Mermaid configuration for `"dark"` or `"light"` mode.
 * @param {"dark" | "light"} [mode]
 */
export function mermaidConfig(mode = "dark") {
	return {
		fontFamily: "ui-sans-serif, system-ui, sans-serif",
		fontSize: 16,
		securityLevel: "strict",
		theme: mode === "light" ? "default" : "dark",
		startOnLoad: false,
	};
}

function scrubSvgAttributes(node) {
	const names = node.getAttributeNames ? node.getAttributeNames() : Array.from(node.attributes ?? [], (a) => a.name);
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

function sanitizeSvgSubtree(svgRoot) {
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

function parseSanitizedSvg(doc, svgMarkup) {
	const raw = String(svgMarkup ?? "").trim();
	if (!raw) return null;
	const Parser = doc.defaultView?.DOMParser ?? globalThis.DOMParser;
	if (typeof Parser !== "function") return null;
	const parser = new Parser();
	const xmlDoc = parser.parseFromString(raw, "image/svg+xml");
	let svgNode = null;
	if (!xmlDoc.querySelector("parsererror") && (xmlDoc.documentElement?.localName ?? "").toLowerCase() === "svg") {
		svgNode = xmlDoc.documentElement;
	} else {
		const htmlDoc = parser.parseFromString(raw, "text/html");
		svgNode = htmlDoc.querySelector("svg");
	}
	if (!svgNode) return null;
	sanitizeSvgSubtree(svgNode);
	return doc.importNode(svgNode, true);
}

function buildPreviewPre(doc, source) {
	const pre = el(doc, "pre", { className: "peer-blocks-mermaid-preview" });
	pre.append(el(doc, "code", { text: source }));
	return pre;
}

function buildErrorCard(doc, source, errorMessage) {
	const card = el(doc, "div", {
		className: "peer-blocks-mermaid-error",
		attrs: { "data-streamdown": "mermaid-error" },
	});
	card.append(
		el(doc, "p", { className: "peer-blocks-mermaid-error-title", text: "Diagram failed to render" }),
		el(doc, "p", { className: "peer-blocks-mermaid-error-detail", text: errorMessage }),
		el(doc, "pre", { className: "peer-blocks-mermaid-error-source", text: source }),
	);
	return card;
}

function syncMermaidCorner(state) {
	const wantCorner = state.status === "svg" && !state.displayOnly;
	if (wantCorner && !state.corner) {
		const onExpand = typeof state.onExpand === "function"
			? () => state.onExpand(state.source)
			: undefined;
		state.corner = createCopyCorner(state.root, {
			label: "Copy diagram source",
			expandLabel: "Expand diagram",
			getText: () => state.source,
			onCopy: state.onCopy,
			onExpand,
		});
	} else if (!wantCorner && state.corner) {
		state.corner.destroy();
		state.corner = null;
	}
}

function finishMermaidSvg(state, myTicket, chart, svgMarkup) {
	if (state.life.dead || myTicket !== state.ticket) return;
	const svgEl = parseSanitizedSvg(state.doc, svgMarkup);
	if (!svgEl) {
		finishMermaidError(state, myTicket, chart, "Invalid SVG output");
		return;
	}
	state.status = "svg";
	state.root.removeAttribute("aria-busy");
	state.root.setAttribute("data-streamdown", "mermaid");
	state.body.replaceChildren(svgEl);
	syncMermaidCorner(state);
}

function finishMermaidError(state, myTicket, chart, err) {
	if (state.life.dead || myTicket !== state.ticket) return;
	const detail = err instanceof Error ? err.message : String(err ?? "Parse error");
	state.status = "error";
	state.root.removeAttribute("aria-busy");
	state.root.removeAttribute("data-streamdown");
	state.body.replaceChildren(buildErrorCard(state.doc, chart, detail));
	syncMermaidCorner(state);
}

function startMermaidRender(state) {
	const myTicket = state.ticket;
	const chart = state.source;
	const renderId = uniqueId("peer-mermaid");
	state.status = "pending";
	state.root.setAttribute("aria-busy", "true");
	state.root.removeAttribute("data-streamdown");
	syncMermaidCorner(state);
	state.body.replaceChildren(buildPreviewPre(state.doc, chart));
	let pending;
	try {
		pending = Promise.resolve(state.plugin.getMermaid(mermaidConfig(state.mode)).render(renderId, chart));
	} catch (err) {
		pending = Promise.reject(err);
	}
	pending.then(
		(res) => finishMermaidSvg(state, myTicket, chart, res?.svg ?? ""),
		(err) => finishMermaidError(state, myTicket, chart, err),
	);
}

function updateMermaidBlock(state, model) {
	if (state.life.dead || model === state.prevModel) return;
	state.prevModel = model;
	const source = String(model?.source ?? "");
	const incomplete = Boolean(model?.incomplete);
	const mode = model?.mode === "light" ? "light" : "dark";
	const displayOnly = Boolean(model?.displayOnly);
	const renderKeyChanged = !state.initialized
		|| source !== state.source
		|| incomplete !== state.incomplete
		|| mode !== state.mode;
	state.source = source;
	state.incomplete = incomplete;
	state.mode = mode;
	state.displayOnly = displayOnly;
	state.initialized = true;
	if (!renderKeyChanged) {
		syncMermaidCorner(state);
		return;
	}
	state.ticket += 1;
	if (incomplete) {
		state.status = "incomplete";
		state.root.setAttribute("aria-busy", "true");
		state.root.removeAttribute("data-streamdown");
		syncMermaidCorner(state);
		state.body.replaceChildren(buildPreviewPre(state.doc, source));
		return;
	}
	startMermaidRender(state);
}

/**
 * Mount a Mermaid diagram block into `host` with zero module-level mutable state.
 * @param {Element} host
 * @param {{onCopy?: (source: string) => void, onExpand?: (source: string) => void, plugin?: {getMermaid: Function}}} [options]
 */
export function createMermaidBlock(host, { onCopy, onExpand, plugin } = {}) {
	const doc = documentOf(host);
	injectUiStyles(doc);
	injectBlocksStyles(doc);
	const life = createLife();
	const diagramPlugin = plugin ?? createMermaidPlugin();
	const root = el(doc, "div", {
		className: "peer-blocks-mermaid",
		attrs: { "data-testid": "md-mermaid", "data-peer-block": "mermaid" },
	});
	const body = el(doc, "div", { className: "peer-blocks-mermaid-body" });
	root.append(body);
	host.append(root);
	const state = {
		doc, life, root, body, plugin: diagramPlugin, onCopy, onExpand,
		source: "", incomplete: false, mode: "dark", displayOnly: false,
		initialized: false, status: "idle", ticket: 0, corner: null, prevModel: null,
	};
	const update = (model = {}) => updateMermaidBlock(state, model);
	const destroy = () => {
		if (!life.destroy()) return;
		state.corner?.destroy();
		state.corner = null;
		root.remove();
	};
	return { update, destroy };
}
