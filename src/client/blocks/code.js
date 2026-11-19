/**
 * Fenced code block view with immediate plain-text rendering, async Shiki
 * syntax highlighting (`peer-blocks-code`), line numbers, and copy corner.
 */
import { createLife, documentOf, el, injectUiStyles } from "cloudcanvas-lib/ui";
import { code as shikiCode } from "peer-blocks-code";
import { injectBlocksStyles } from "./blocks.css.js";
import { createCopyCorner } from "./copy-corner.js";

const SHIKI_THEMES = ["github-light", "github-dark"];

function stripTrailingNewlines(source) {
	let end = source.length;
	while (end > 0 && source[end - 1] === "\n") end -= 1;
	return source.slice(0, end);
}

function parseCodeMeta(meta = "") {
	const raw = String(meta ?? "");
	const startMatch = /\bstartLine=(\d+)\b/.exec(raw);
	const parsed = startMatch ? Number.parseInt(startMatch[1], 10) : 1;
	return {
		startLine: Number.isFinite(parsed) && parsed >= 1 ? parsed : 1,
		lineNumbers: !/\bnoLineNumbers\b/.test(raw),
	};
}

function applyTokenColors(span, token, mode) {
	const styleMap = token.htmlStyle ?? {};
	const light = styleMap["--shiki-light"] ?? styleMap.color ?? token.color ?? "";
	const dark = styleMap["--shiki-dark"] ?? token.color ?? styleMap.color ?? "";
	if (light) span.style.setProperty("--shiki-light", light);
	if (dark) span.style.setProperty("--shiki-dark", dark);
	const active = mode === "light" ? (light || dark) : (dark || light);
	if (active) span.style.color = active;
	if (styleMap["font-style"]) span.style.fontStyle = styleMap["font-style"];
	if (styleMap["font-weight"]) span.style.fontWeight = styleMap["font-weight"];
}

function buildPlainLines(doc, displayCode, startLine, lineNumbers) {
	const frag = doc.createDocumentFragment();
	const lines = displayCode.split("\n");
	for (let i = 0; i < lines.length; i += 1) {
		const attrs = lineNumbers ? { "data-peer-line": String(startLine + i) } : undefined;
		const lineEl = el(doc, "span", { className: "peer-blocks-code-line", attrs });
		lineEl.append(el(doc, "span", { className: "peer-blocks-code-token", text: lines[i] }));
		frag.append(lineEl);
		if (i < lines.length - 1) frag.append(doc.createTextNode("\n"));
	}
	return frag;
}

function buildTokenLines(doc, tokenLines, startLine, lineNumbers, mode) {
	const frag = doc.createDocumentFragment();
	const rows = tokenLines.length > 0 ? tokenLines : [[]];
	for (let i = 0; i < rows.length; i += 1) {
		const attrs = lineNumbers ? { "data-peer-line": String(startLine + i) } : undefined;
		const lineEl = el(doc, "span", { className: "peer-blocks-code-line", attrs });
		for (const token of rows[i]) {
			const span = el(doc, "span", { className: "peer-blocks-code-token", text: token.content });
			applyTokenColors(span, token, mode);
			lineEl.append(span);
		}
		frag.append(lineEl);
		if (i < rows.length - 1) frag.append(doc.createTextNode("\n"));
	}
	return frag;
}

function syncCodeDomAttrs(state) {
	state.root.setAttribute("data-language", state.language);
	state.root.setAttribute("data-peer-mode", state.mode);
	state.root.setAttribute("data-peer-line-numbers", state.lineNumbers ? "true" : "false");
	state.root.setAttribute("data-peer-start-line", String(state.startLine));
	if (state.incomplete) state.root.setAttribute("data-incomplete", "true");
	else state.root.removeAttribute("data-incomplete");
	state.body.setAttribute("data-language", state.language);
}

function syncCodeCorner(state, displayOnly) {
	if (!displayOnly && !state.corner) {
		const onExpand = typeof state.onExpand === "function"
			? () => state.onExpand({ code: state.rawCode, language: state.language })
			: undefined;
		state.corner = createCopyCorner(state.root, {
			label: "Copy code",
			expandLabel: "Expand code",
			getText: () => state.rawCode,
			onCopy: state.onCopy,
			onExpand,
		});
	} else if (displayOnly && state.corner) {
		state.corner.destroy();
		state.corner = null;
	}
}

function requestHighlight(state) {
	const myTicket = state.ticket;
	const lang = state.language || "text";
	const applyResult = (result) => {
		if (state.life.dead || myTicket !== state.ticket || !Array.isArray(result?.tokens)) return;
		state.tokens = result.tokens;
		state.codeEl.replaceChildren(
			buildTokenLines(state.doc, state.tokens, state.startLine, state.lineNumbers, state.mode),
		);
	};
	const cached = shikiCode.highlight(
		{ code: state.displayCode, language: lang, themes: SHIKI_THEMES },
		applyResult,
	);
	if (cached) applyResult(cached);
}

function updateCodeBlock(state, model) {
	if (state.life.dead || model === state.prevModel) return;
	state.prevModel = model;
	const rawCode = String(model?.code ?? "");
	const displayCode = stripTrailingNewlines(rawCode);
	const language = String(model?.language ?? "").trim();
	const { startLine, lineNumbers } = parseCodeMeta(model?.meta ?? "");
	const mode = model?.mode === "light" ? "light" : "dark";
	const incomplete = Boolean(model?.incomplete);
	const displayOnly = Boolean(model?.displayOnly);
	const sourceChanged = !state.rendered || displayCode !== state.displayCode || language !== state.language;
	const layoutChanged = startLine !== state.startLine || lineNumbers !== state.lineNumbers || mode !== state.mode;
	state.rawCode = rawCode;
	state.displayCode = displayCode;
	state.language = language;
	state.startLine = startLine;
	state.lineNumbers = lineNumbers;
	state.mode = mode;
	state.incomplete = incomplete;
	syncCodeDomAttrs(state);
	syncCodeCorner(state, displayOnly);
	if (sourceChanged) {
		state.rendered = true;
		state.ticket += 1;
		state.tokens = null;
		state.codeEl.replaceChildren(buildPlainLines(state.doc, displayCode, startLine, lineNumbers));
		if (displayCode.length > 0) requestHighlight(state);
	} else if (layoutChanged) {
		const content = state.tokens
			? buildTokenLines(state.doc, state.tokens, startLine, lineNumbers, mode)
			: buildPlainLines(state.doc, displayCode, startLine, lineNumbers);
		state.codeEl.replaceChildren(content);
	}
}

/**
 * Mount a syntax-highlighted fenced code block into `host`.
 * @param {Element} host
 * @param {{onCopy?: (code: string) => void, onExpand?: (payload: {code: string, language: string}) => void}} [options]
 */
export function createCodeBlock(host, { onCopy, onExpand } = {}) {
	const doc = documentOf(host);
	injectUiStyles(doc);
	injectBlocksStyles(doc);
	const life = createLife();
	const root = el(doc, "div", {
		className: "peer-blocks-code",
		attrs: {
			"data-testid": "md-code",
			"data-streamdown": "code-block",
			"data-peer-block": "code",
		},
	});
	const body = el(doc, "div", {
		className: "peer-blocks-code-body",
		attrs: { "data-streamdown": "code-block-body" },
	});
	const preEl = el(doc, "pre", { className: "peer-blocks-code-pre" });
	const codeEl = el(doc, "code", { className: "peer-blocks-code-content" });
	preEl.append(codeEl);
	body.append(preEl);
	root.append(body);
	host.append(root);
	const state = {
		doc, life, root, body, codeEl, onCopy, onExpand,
		rawCode: "", displayCode: "", language: "",
		startLine: 1, lineNumbers: true, mode: "dark", incomplete: false,
		rendered: false, ticket: 0, tokens: null, corner: null, prevModel: null,
	};
	const update = (model = {}) => updateCodeBlock(state, model);
	const destroy = () => {
		if (!life.destroy()) return;
		state.corner?.destroy();
		state.corner = null;
		root.remove();
	};
	return { update, destroy };
}
