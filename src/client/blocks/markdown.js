/**
 * Transcript Markdown orchestrator (`views §4.1`).
 * Pre-processes math delimiters/escapes, parses top-level fences, display math,
 * GFM tables, GitHub alert callouts, and prose in linear time, blocks remote
 * Markdown images, keeps raw HTML strictly as literal text, and reuses child
 * block controllers across streaming updates.
 */
import { createLife, documentOf, el, injectUiStyles, renderMarkdown } from "cloudcanvas-lib/ui";
import { repairMathForDisplay, transformMathDelimiters } from "peer-blocks-math";
import { injectBlocksStyles } from "./blocks.css.js";
import { buildTableElement, readTableBlock, wrapTableBlock } from "./copy-corner.js";
import { countRun, createBlockedImageBadge, readCodeSpanEnd, readMarkdownImage } from "./image-policy.js";
import { createMathBlock, findInlineMathClose, readMathBlock, renderInlineMath } from "./math.js";
import { createCodeBlock } from "./code.js";
import { createMermaidBlock } from "./mermaid.js";
import { createPluginFenceBlock } from "./plugin-fence.js";
import { BUILTIN_MERMAID_LANGUAGE } from "./registry.js";

const MAX_CALLOUT_DEPTH = 4;
const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})[ \t]*([^\n]*)$/;
const FENCE_CLOSE_RE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
const QUOTE_LINE_RE = /^ {0,3}>\s?/;
const ALERT_MARKER_RE = /^\[!(note|tip|important|warning|caution)\][ \t]*(.*)$/i;

function uniqueTokenPrefix(text) {
	let prefix = "PEERMDTOKEN";
	while (text.includes(prefix)) prefix += "Z";
	return prefix;
}

function tokenizeInlineSpecials(sourceText) {
	const prefix = uniqueTokenPrefix(sourceText);
	const entries = [];
	let out = "";
	let i = 0;
	const mint = (kind, value, src = "") => {
		const token = `${prefix}${entries.length}X`;
		entries.push({ token, kind, value, src });
		return token;
	};
	while (i < sourceText.length) {
		const ch = sourceText[i];
		if (ch === "\\" && i + 1 < sourceText.length) {
			out += sourceText[i + 1] === "$" ? "$" : sourceText.slice(i, i + 2);
			i += 2;
			continue;
		}
		if (ch === "`") {
			const ticks = countRun(sourceText, i, "`");
			const end = readCodeSpanEnd(sourceText, i, ticks);
			const next = end === -1 ? i + ticks : end;
			out += sourceText.slice(i, next);
			i = next;
			continue;
		}
		if (ch === "!" && sourceText[i + 1] === "[") {
			const img = readMarkdownImage(sourceText, i);
			if (img) { out += mint("image", img.alt, img.src); i = img.next; continue; }
		}
		if (ch === "$") {
			const size = countRun(sourceText, i, "$");
			const closeAt = findInlineMathClose(sourceText, i, size);
			const body = closeAt === -1 ? "" : sourceText.slice(i + size, closeAt).trim();
			if (body) { out += mint("math", body); i = closeAt + size; continue; }
			out += sourceText.slice(i, i + size);
			i += size;
			continue;
		}
		out += ch;
		i += 1;
	}
	return { text: out, prefix, entries };
}

function replaceTextNodeTokens(doc, textNode, tokenRe, tokenMap) {
	const parts = textNode.data.split(tokenRe);
	if (parts.length <= 1) return;
	const frag = doc.createDocumentFragment();
	for (const part of parts) {
		if (!part) continue;
		const entry = tokenMap.get(part);
		if (!entry) {
			frag.append(doc.createTextNode(part));
		} else if (entry.kind === "math") {
			frag.append(renderInlineMath(doc, entry.value));
		} else {
			frag.append(createBlockedImageBadge(doc, { alt: entry.value, src: entry.src }));
		}
	}
	textNode.replaceWith(frag);
}

function injectInlineSpecials(doc, root, entries, prefix) {
	if (entries.length === 0) return;
	const tokenMap = new Map(entries.map((e) => [e.token, e]));
	const tokenRe = new RegExp(`(${prefix}\\d+X)`, "g");
	const textNodes = [];
	const stack = Array.from(root.childNodes ?? []);
	while (stack.length > 0) {
		const node = stack.pop();
		if (node.nodeType === 3) {
			if (node.data.includes(prefix)) textNodes.push(node);
			continue;
		}
		const tag = (node.tagName ?? "").toUpperCase();
		if (tag === "CODE" || tag === "PRE") continue;
		for (const child of Array.from(node.childNodes ?? [])) stack.push(child);
	}
	for (const textNode of textNodes) replaceTextNodeTokens(doc, textNode, tokenRe, tokenMap);
}

function renderProseFragment(doc, source) {
	const { text, prefix, entries } = tokenizeInlineSpecials(source);
	const frag = renderMarkdown(text, { doc, externalTarget: true });
	injectInlineSpecials(doc, frag, entries, prefix);
	return frag;
}

function renderInlineCellFragment(doc, cellText) {
	const flat = String(cellText ?? "").replace(/\r?\n+/g, " ").trim();
	if (!flat) return doc.createDocumentFragment();
	const { text, prefix, entries } = tokenizeInlineSpecials(flat);
	const guard = `${prefix}CELLGUARDX `;
	const frag = renderMarkdown(`${guard}${text}`, { doc, externalTarget: true });
	const para = frag.firstElementChild;
	if (para?.firstChild?.nodeType === 3 && para.firstChild.data.startsWith(guard)) {
		para.firstChild.data = para.firstChild.data.slice(guard.length);
	}
	injectInlineSpecials(doc, frag, entries, prefix);
	if (para && frag.childNodes.length === 1 && para.tagName?.toUpperCase() === "P") {
		const unwrapped = doc.createDocumentFragment();
		while (para.firstChild) unwrapped.append(para.firstChild);
		return unwrapped;
	}
	return frag;
}

function readFenceBlock(lines, start) {
	const open = FENCE_OPEN_RE.exec(lines[start]);
	if (!open) return null;
	const marker = open[1];
	const info = open[2].trim();
	if (marker[0] === "`" && info.includes("`")) return null;
	const infoParts = /^(\S+)(?:\s+(.*))?$/.exec(info);
	const language = infoParts?.[1] ?? "";
	const meta = infoParts?.[2]?.trim() ?? "";
	let end = start + 1;
	while (end < lines.length) {
		const close = FENCE_CLOSE_RE.exec(lines[end]);
		if (close && close[1][0] === marker[0] && close[1].length >= marker.length) break;
		end += 1;
	}
	const closed = end < lines.length;
	return {
		block: { kind: "fence", language, meta, source: lines.slice(start + 1, end).join("\n"), closed },
		next: closed ? end + 1 : lines.length,
	};
}

function readCalloutBlock(lines, start) {
	if (!QUOTE_LINE_RE.test(lines[start])) return null;
	const firstInner = lines[start].replace(QUOTE_LINE_RE, "");
	const marker = ALERT_MARKER_RE.exec(firstInner);
	if (!marker) return null;
	let end = start + 1;
	while (end < lines.length && QUOTE_LINE_RE.test(lines[end])) end += 1;
	const innerLines = lines.slice(start, end).map((l) => l.replace(QUOTE_LINE_RE, ""));
	const inlineRest = marker[2].trim();
	if (inlineRest) {
		innerLines[0] = inlineRest;
	} else {
		innerLines.shift();
		while (innerLines.length > 0 && innerLines[0].trim() === "") innerLines.shift();
	}
	return {
		block: { kind: "callout", alertKind: marker[1].toLowerCase(), source: innerLines.join("\n") },
		next: end,
	};
}

function readSpecialBlock(lines, index) {
	return readFenceBlock(lines, index)
		?? readMathBlock(lines, index)
		?? readCalloutBlock(lines, index)
		?? readTableBlock(lines, index, findInlineMathClose);
}

function parseTopBlocks(normalized) {
	if (!normalized.trim()) return [];
	const lines = normalized.split("\n");
	const blocks = [];
	let i = 0;
	while (i < lines.length) {
		if (lines[i].trim() === "") { i += 1; continue; }
		const special = readSpecialBlock(lines, i);
		if (special) {
			blocks.push(special.block);
			i = special.next;
			continue;
		}
		let end = i + 1;
		while (end < lines.length && !readSpecialBlock(lines, end)) end += 1;
		const chunk = lines.slice(i, end).join("\n").trimEnd();
		if (chunk.trim()) blocks.push({ kind: "prose", source: chunk });
		i = end;
	}
	return blocks;
}

function slotKeyFor(block, displayOnly, fenceFor) {
	if (block.kind === "fence") {
		if (block.language.toLowerCase() === BUILTIN_MERMAID_LANGUAGE) return "mermaid";
		if (!displayOnly && fenceFor?.(block.language)) return `plugin:${block.language.toLowerCase()}`;
		return "code";
	}
	if (block.kind === "callout") return `callout:${block.alertKind}`;
	return block.kind;
}

function createProseSlot(doc) {
	const node = el(doc, "div", { className: "peer-blocks-prose", attrs: { "data-peer-block": "prose" } });
	let prevSource = null;
	const update = (block) => {
		if (block.source === prevSource) return;
		prevSource = block.source;
		node.replaceChildren(renderProseFragment(doc, block.source));
	};
	const destroy = () => node.remove();
	return { key: "prose", el: node, update, destroy };
}

function createTableSlot(doc, onCopy) {
	let wrapped = null;
	let prevRaw = null;
	let prevDisplayOnly = null;
	const mountInitial = (block, opts) => {
		prevRaw = block.raw;
		prevDisplayOnly = opts.displayOnly;
		const tableEl = buildTableElement(doc, block, renderInlineCellFragment);
		wrapped = wrapTableBlock(doc, tableEl, { displayOnly: opts.displayOnly, onCopy });
	};
	const update = (block, opts) => {
		if (block.raw === prevRaw && opts.displayOnly === prevDisplayOnly) return;
		const nextTable = block.raw === prevRaw ? null : buildTableElement(doc, block, renderInlineCellFragment);
		prevRaw = block.raw;
		prevDisplayOnly = opts.displayOnly;
		wrapped.replaceTable(nextTable, opts.displayOnly);
	};
	const destroy = () => { wrapped?.destroy(); wrapped = null; };
	return { key: "table", get el() { return wrapped?.node ?? null; }, mountInitial, update, destroy };
}

function createCalloutSlot(doc, alertKind, ctx) {
	const node = el(doc, "div", {
		className: "peer-blocks-callout",
		attrs: { "data-testid": "md-callout", "data-alert-kind": alertKind, "data-peer-block": "callout" },
	});
	const inner = ctx.depth < MAX_CALLOUT_DEPTH
		? createMarkdownInternal(node, ctx.callbacks, ctx.depth + 1)
		: null;
	let prevText = null;
	const update = (block, opts) => {
		if (inner) {
			inner.update({ source: block.source, streaming: opts.streaming, mode: opts.mode, displayOnly: opts.displayOnly });
			return;
		}
		if (block.source !== prevText) {
			prevText = block.source;
			node.textContent = block.source;
		}
	};
	const destroy = () => { inner?.destroy(); node.remove(); };
	return { key: `callout:${alertKind}`, el: node, update, destroy };
}

function createMountedControlSlot(doc, key, factory, mapModel) {
	const staging = doc.createElement("div");
	const handle = factory(staging);
	const node = staging.firstElementChild;
	const update = (block, opts) => handle.update(mapModel(block, opts));
	const destroy = () => handle.destroy();
	return { key, el: node, update, destroy };
}

function createSlot(doc, block, key, ctx, opts) {
	const { fenceFor, onCopy, onExpand, mermaidPlugin } = ctx.callbacks;
	if (key === "prose") return createProseSlot(doc);
	if (key === "table") {
		const slot = createTableSlot(doc, onCopy);
		slot.mountInitial(block, opts);
		return slot;
	}
	if (key.startsWith("callout:")) return createCalloutSlot(doc, block.alertKind, ctx);
	if (key === "math") {
		return createMountedControlSlot(doc, key, (h) => createMathBlock(h, { onCopy }),
			(b, o) => ({ tex: b.tex, displayOnly: o.displayOnly }));
	}
	if (key === "mermaid") {
		return createMountedControlSlot(doc, key, (h) => createMermaidBlock(h, { onCopy, onExpand, plugin: mermaidPlugin }),
			(b, o) => ({ source: b.source, incomplete: !b.closed, mode: o.mode, displayOnly: o.displayOnly }));
	}
	if (key.startsWith("plugin:")) {
		const renderer = fenceFor?.(block.language);
		return createMountedControlSlot(doc, key, (h) => createPluginFenceBlock(h, { renderer, onCopy, onExpand }),
			(b, o) => ({ language: b.language, source: b.source, meta: b.meta, incomplete: !b.closed, mode: o.mode, displayOnly: o.displayOnly }));
	}
	return createMountedControlSlot(doc, "code", (h) => createCodeBlock(h, { onCopy, onExpand }),
		(b, o) => ({ code: b.source, language: b.language, meta: b.meta, incomplete: !b.closed, mode: o.mode, displayOnly: o.displayOnly }));
}

function reconcileSlots(state, blocks, opts) {
	const { doc, root, slots, ctx } = state;
	while (slots.length > blocks.length) slots.pop().destroy();
	for (let i = 0; i < blocks.length; i += 1) {
		const block = blocks[i];
		const key = slotKeyFor(block, opts.displayOnly, ctx.callbacks.fenceFor);
		const current = slots[i];
		if (current && current.key === key) {
			current.update(block, opts);
			continue;
		}
		if (current) current.destroy();
		const created = createSlot(doc, block, key, ctx, opts);
		root.insertBefore(created.el, root.children[i] ?? null);
		created.update(block, opts);
		slots[i] = created;
	}
}

function updateMarkdownState(state, model) {
	if (state.life.dead || model === state.prevModel) return;
	state.prevModel = model;
	const rawSource = String(model?.source ?? "").slice(0, 100000);
	const streaming = Boolean(model?.streaming);
	const mode = model?.mode === "light" ? "light" : "dark";
	const displayOnly = Boolean(model?.displayOnly);
	const sameInputs = state.initialized
		&& rawSource === state.rawSource
		&& streaming === state.streaming
		&& mode === state.mode
		&& displayOnly === state.displayOnly;
	if (sameInputs) return;
	state.initialized = true;
	state.rawSource = rawSource;
	state.streaming = streaming;
	state.mode = mode;
	state.displayOnly = displayOnly;
	state.root.setAttribute("data-peer-mode", mode);
	const normalized = rawSource
		? transformMathDelimiters(repairMathForDisplay(rawSource)).replace(/\r\n?/g, "\n")
		: "";
	const blocks = parseTopBlocks(normalized);
	reconcileSlots(state, blocks, { streaming, mode, displayOnly });
}

function createMarkdownInternal(host, callbacks = {}, depth = 0) {
	const doc = documentOf(host);
	injectUiStyles(doc);
	injectBlocksStyles(doc);
	const life = createLife();
	const root = el(doc, "div", {
		className: "peer-blocks-markdown peer-prose",
		attrs: { "data-peer-markdown": "" },
	});
	host.append(root);
	const slots = [];
	const state = {
		doc, life, root, slots,
		ctx: { callbacks, depth },
		initialized: false, rawSource: "", streaming: false, mode: "dark", displayOnly: false,
		prevModel: null,
	};
	const update = (model = {}) => updateMarkdownState(state, model);
	const destroy = () => {
		if (!life.destroy()) return;
		while (slots.length > 0) slots.pop().destroy();
		root.remove();
	};
	return { update, destroy };
}

/**
 * Mount a transcript Markdown view into `host`.
 * @param {Element} host
 * @param {{fenceFor?: (language: string) => ({language: string, mount: Function}|null), onCopy?: (text: string) => void, onExpand?: Function, mermaidPlugin?: {getMermaid: Function}}} [options]
 */
export function createMarkdown(host, options = {}) {
	return createMarkdownInternal(host, options, 0);
}
