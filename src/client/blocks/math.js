/**
 * KaTeX inline and display math blocks (`trust: false`, strict DOM import).
 */
import { createLife, documentOf, el } from "cloudcanvas-lib/ui";
import { katex } from "peer-blocks-math";
import { injectBlocksStyles } from "./blocks.css.js";
import { createCopyCorner } from "./copy-corner.js";
import { countRun, isEscapedAt } from "./image-policy.js";

const MATH_FENCE_RE = /^ {0,3}(\${2,})[ \t]*$/;
const BLOCKED_TAGS = /* @__PURE__ */ new Set(["script", "iframe", "object", "embed", "applet", "meta", "link", "base"]);

function isValidMathBoundary(text, closePos, size) {
	if (size > 1) return true;
	return !/\s/.test(text[closePos - 1] ?? " ") && !/\d/.test(text[closePos + size] ?? "");
}

export function findInlineMathClose(text, start, size) {
	if (size === 1 && /\s/.test(text[start + 1] ?? " ")) return -1;
	let pos = start + size;
	while (pos < text.length) {
		if (text[pos] === "\n" && /^[ \t]*\n/.test(text.slice(pos + 1))) return -1;
		if (text[pos] !== "$" || isEscapedAt(text, pos)) {
			pos += 1;
			continue;
		}
		const run = countRun(text, pos, "$");
		if (run === size) return isValidMathBoundary(text, pos, size) ? pos : -1;
		pos += run;
	}
	return -1;
}

function readSingleLineMath(line) {
	if (line.length - line.trimStart().length > 3) return null;
	const trimmed = line.trim();
	if (!trimmed.startsWith("$$")) return null;
	const openLen = countRun(trimmed, 0, "$");
	if (trimmed.length <= openLen * 2) return null;
	const closeAt = findInlineMathClose(trimmed, 0, openLen);
	if (closeAt !== trimmed.length - openLen) return null;
	const tex = trimmed.slice(openLen, closeAt).trim();
	return tex ? { kind: "math", tex, closed: true } : null;
}

export function readMathBlock(lines, start) {
	const fence = MATH_FENCE_RE.exec(lines[start]);
	if (fence) {
		const openLen = fence[1].length;
		let end = start + 1;
		while (end < lines.length) {
			const close = MATH_FENCE_RE.exec(lines[end]);
			if (close && close[1].length >= openLen) break;
			end += 1;
		}
		const closed = end < lines.length;
		const tex = lines.slice(start + 1, end).join("\n").trim();
		return { block: { kind: "math", tex, closed }, next: closed ? end + 1 : lines.length };
	}
	const single = readSingleLineMath(lines[start]);
	return single ? { block: single, next: start + 1 } : null;
}

function scrubAttributes(node) {
	const names = node.getAttributeNames ? node.getAttributeNames() : Array.from(node.attributes ?? [], (a) => a.name);
	for (const name of names) {
		const lower = name.toLowerCase();
		if (lower.startsWith("on") || lower === "srcdoc") node.removeAttribute(name);
	}
}

function scrubSubtree(root) {
	const stack = Array.from(root.children ?? []);
	while (stack.length > 0) {
		const node = stack.pop();
		const tag = (node.localName ?? node.tagName ?? "").toLowerCase();
		if (BLOCKED_TAGS.has(tag)) {
			node.remove();
			continue;
		}
		scrubAttributes(node);
		for (const child of Array.from(node.children ?? [])) stack.push(child);
	}
}

function parseTrustedKatexMarkup(doc, markup, fallbackText, displayMode) {
	const Parser = doc.defaultView?.DOMParser ?? globalThis.DOMParser;
	if (typeof Parser !== "function") {
		return el(doc, "span", { className: displayMode ? "katex-display" : "katex", text: fallbackText });
	}
	const parsed = new Parser().parseFromString(markup, "text/html");
	scrubSubtree(parsed.body);
	const first = parsed.body.firstElementChild;
	if (!first) {
		return el(doc, "span", { className: displayMode ? "katex-display" : "katex", text: fallbackText });
	}
	const imported = doc.importNode(first, true);
	if (displayMode && !imported.classList?.contains("katex-display")) {
		const wrapper = el(doc, "span", { className: "katex-display" });
		wrapper.append(imported);
		return wrapper;
	}
	return imported;
}

function renderKatexElement(doc, tex, displayMode) {
	const source = String(tex ?? "");
	const markup = katex.renderToString(source, {
		displayMode,
		throwOnError: false,
		strict: "ignore",
		trust: false,
		output: "htmlAndMathml",
	});
	return parseTrustedKatexMarkup(doc, markup, source, displayMode);
}

/**
 * Render an inline `$...$` TeX formula into a safe DOM element.
 * @param {Document} doc
 * @param {string} tex
 * @returns {Element}
 */
export function renderInlineMath(doc, tex) {
	return renderKatexElement(doc, tex, false);
}

function updateMathBlock(state, model) {
	if (state.life.dead || model === state.prevModel) return;
	state.prevModel = model;
	const nextTex = String(model?.tex ?? "");
	const displayOnly = Boolean(model?.displayOnly);
	if (!state.rendered || nextTex !== state.tex) {
		state.tex = nextTex;
		state.rendered = true;
		state.body.replaceChildren(renderKatexElement(state.doc, nextTex, true));
	}
	if (!displayOnly && !state.corner) {
		state.corner = createCopyCorner(state.root, {
			label: "Copy equation source",
			getText: () => state.tex,
			onCopy: state.onCopy,
		});
	} else if (displayOnly && state.corner) {
		state.corner.destroy();
		state.corner = null;
	}
}

/**
 * Mount a display-mode KaTeX block (`$$ ... $$`) with an optional TeX copy corner.
 * @param {Element} host
 * @param {{onCopy?: (tex: string) => void}} [options]
 */
export function createMathBlock(host, { onCopy } = {}) {
	const doc = documentOf(host);
	injectBlocksStyles(doc);
	const life = createLife();
	const root = el(doc, "div", {
		className: "peer-blocks-math",
		attrs: { "data-testid": "md-math", "data-peer-block": "math" },
	});
	const body = el(doc, "div", { className: "peer-blocks-math-body" });
	root.append(body);
	host.append(root);
	const state = {
		doc, life, root, body, onCopy,
		tex: "", rendered: false, corner: null, prevModel: null,
	};
	const update = (model = {}) => updateMathBlock(state, model);
	const destroy = () => {
		if (!life.destroy()) return;
		state.corner?.destroy();
		state.corner = null;
		root.remove();
	};
	return { update, destroy };
}
