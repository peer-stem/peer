/**
 * Transcript Markdown orchestrator (`views §4.1`), powered by `peer-kit` (`createKitMarkdown`
 * + `renderKitInline`, `L-1..L-4`). Pre-processes math delimiters/escapes, delegates block/inline
 * parsing to `peer-kit` hooks with zero string-token injection (`PEERMDTOKEN`/`CELLGUARDX` retired),
 * blocks remote Markdown images, keeps raw HTML strictly as literal text, and reuses child
 * block controllers across streaming updates.
 */
import { documentOf } from "cloudcanvas-lib/ui";
import { createKitMarkdown, renderKitInline } from "peer-kit";
import { repairMathForDisplay, transformMathDelimiters } from "peer-blocks-math";
import { injectBlocksStyles } from "./blocks.css.js";
import { buildTableElement, wrapTableBlock } from "./copy-corner.js";
import { countRun, createBlockedImageBadge, readCodeSpanEnd } from "./image-policy.js";
import { createMathBlock, findInlineMathClose, readMathBlock, renderInlineMath } from "./math.js";
import { createCodeBlock } from "./code.js";
import { createMermaidBlock } from "./mermaid.js";
import { createPluginFenceBlock } from "./plugin-fence.js";
import { BUILTIN_MERMAID_LANGUAGE } from "./registry.js";

function readPeerInlineMath(text, index) {
	if (text[index] !== "$") return null;
	const size = countRun(text, index, "$");
	const closeAt = findInlineMathClose(text, index, size);
	const body = closeAt === -1 ? "" : text.slice(index + size, closeAt).trim();
	if (body) return { token: { kind: "math", tex: body }, next: closeAt + size };
	return { token: { kind: "literal", raw: text.slice(index, index + size) }, next: index + size };
}

function renderPeerInlineMath(doc, token) {
	if (token?.kind === "math") return renderInlineMath(doc, token.tex);
	return doc.createTextNode(String(token?.raw ?? ""));
}

function skipCellCodeOrMath(line, index) {
	if (line[index] === "`") {
		const ticks = countRun(line, index, "`");
		const end = readCodeSpanEnd(line, index, ticks);
		return end === -1 ? index + ticks : end;
	}
	if (line[index] === "$") {
		const size = countRun(line, index, "$");
		const close = findInlineMathClose(line, index, size);
		return close === -1 ? index + size : close + size;
	}
	return -1;
}

function createMountedSlot(doc, key, factory, mapModel) {
	const staging = doc.createElement("div");
	const handle = factory(staging);
	const node = staging.firstElementChild;
	return {
		key,
		el: node,
		update: (block, opts) => handle.update(mapModel(block, opts)),
		destroy: () => handle.destroy(),
	};
}

function buildTableCellRenderer() {
	return (doc, cellText) => {
		const flat = String(cellText ?? "").replace(/\r?\n+/g, " ").trim();
		if (!flat) return doc.createDocumentFragment();
		return renderKitInline(flat, {
			doc,
			externalTarget: true,
			readInline: readPeerInlineMath,
			renderInline: renderPeerInlineMath,
			renderImage: ({ doc: d, alt, src }) => createBlockedImageBadge(d, { alt, src }),
		});
	};
}

function createPeerTableSlot({ doc, block, opts }, onCopy) {
	const renderCell = buildTableCellRenderer();
	const adapt = (b) => ({ headers: b.headers, aligns: b.alignments.map((a) => a ?? ""), rows: b.rows, raw: b.raw });
	let prevRaw = block.raw;
	let prevDisplayOnly = opts.displayOnly;
	const wrapped = wrapTableBlock(doc, buildTableElement(doc, adapt(block), renderCell), {
		displayOnly: opts.displayOnly,
		onCopy,
	});
	return {
		key: "table",
		el: wrapped.node,
		update(b, o) {
			if (b.raw === prevRaw && o.displayOnly === prevDisplayOnly) return;
			const nextTable = b.raw === prevRaw ? null : buildTableElement(doc, adapt(b), renderCell);
			prevRaw = b.raw;
			prevDisplayOnly = o.displayOnly;
			wrapped.replaceTable(nextTable, o.displayOnly);
		},
		destroy: () => wrapped.destroy(),
	};
}

function createPeerFenceSlot({ doc, block, key }, callbacks) {
	const { fenceFor, onCopy, onExpand, mermaidPlugin } = callbacks;
	if (key === "mermaid") {
		return createMountedSlot(doc, key, (h) => createMermaidBlock(h, { onCopy, onExpand, plugin: mermaidPlugin }),
			(b, o) => ({ source: b.source, incomplete: !b.closed, mode: o.mode, displayOnly: o.displayOnly }));
	}
	if (key.startsWith("plugin:")) {
		const renderer = fenceFor?.(block.language);
		return createMountedSlot(doc, key, (h) => createPluginFenceBlock(h, { renderer, onCopy, onExpand }),
			(b, o) => ({ language: b.language, source: b.source, meta: b.meta, incomplete: !b.closed, mode: o.mode, displayOnly: o.displayOnly }));
	}
	return createMountedSlot(doc, "code", (h) => createCodeBlock(h, { onCopy, onExpand }),
		(b, o) => ({ code: b.source, language: b.language, meta: b.meta, incomplete: !b.closed, mode: o.mode, displayOnly: o.displayOnly }));
}

/**
 * Mount a transcript Markdown view into `host`.
 * @param {Element} host
 * @param {{fenceFor?: (language: string) => ({language: string, mount: Function}|null), onCopy?: (text: string) => void, onExpand?: Function, mermaidPlugin?: {getMermaid: Function}}} [options]
 */
export function createMarkdown(host, options = {}) {
	const doc = documentOf(host);
	injectBlocksStyles(doc);
	const handle = createKitMarkdown(host, {
		rootClassName: "peer-blocks-markdown peer-prose",
		rootAttrs: { "data-peer-markdown": "" },
		proseClassName: "peer-blocks-prose",
		proseAttrs: { "data-peer-block": "prose" },
		calloutClassName: "peer-blocks-callout",
		calloutAttrs: { "data-testid": "md-callout", "data-peer-block": "callout" },
		externalTarget: true,
		onRootUpdate: (root, { mode }) => root.setAttribute("data-peer-mode", mode),
		preprocess: (raw) => (raw ? transformMathDelimiters(repairMathForDisplay(raw)) : ""),
		readBlock: (lines, idx) => readMathBlock(lines, idx),
		skipTableCellSpan: skipCellCodeOrMath,
		readInline: readPeerInlineMath,
		renderInline: renderPeerInlineMath,
		renderImage: ({ doc: d, alt, src }) => createBlockedImageBadge(d, { alt, src }),
		fenceKeyFor: (block, opts) => {
			if (block.language.toLowerCase() === BUILTIN_MERMAID_LANGUAGE) return "mermaid";
			if (!opts.displayOnly && options.fenceFor?.(block.language)) return `plugin:${block.language.toLowerCase()}`;
			return "code";
		},
		createTableSlot: (ctx) => createPeerTableSlot(ctx, options.onCopy),
		createFenceSlot: (ctx) => createPeerFenceSlot(ctx, options),
		createBlockSlot: ({ doc: d, key }) => {
			if (key !== "math") return null;
			return createMountedSlot(d, "math", (h) => createMathBlock(h, { onCopy: options.onCopy }),
				(b, o) => ({ tex: b.tex, displayOnly: o.displayOnly }));
		},
	});
	return { update: handle.update, destroy: handle.destroy };
}
