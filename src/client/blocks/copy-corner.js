/**
 * Corner copy/expand affordance and GFM table wrapper + Markdown serializer.
 */
import { button, createLife, documentOf, el, injectUiStyles, textNode, writeText } from "cloudcanvas-lib/ui";
import { injectBlocksStyles } from "./blocks.css.js";
import { countRun, isEscapedAt, readCodeSpanEnd } from "./image-policy.js";

const COPIED_RESET_MS = 1500;
const DELIM_CELL_RE = /^:?-+:?$/;
const NON_TABLE_START_RE = /^ {0,3}(?:`{3,}|~{3,}|\${2,}|>|#{1,6}\s|(?:[-*_])(?:\s*\1){2,}\s*$)/;

function splitPipeRow(rawLine, findMathClose) {
	let line = rawLine.trim();
	if (line.startsWith("|")) line = line.slice(1);
	if (line.endsWith("|") && !isEscapedAt(line, line.length - 1)) line = line.slice(0, -1);
	const cells = [];
	let current = "";
	let i = 0;
	while (i < line.length) {
		const ch = line[i];
		if (ch === "\\" && i + 1 < line.length) {
			current += line[i + 1] === "|" ? "|" : line.slice(i, i + 2);
			i += 2;
			continue;
		}
		if (ch === "`") {
			const ticks = countRun(line, i, "`");
			const close = readCodeSpanEnd(line, i, ticks);
			const next = close === -1 ? i + ticks : close;
			current += line.slice(i, next);
			i = next;
			continue;
		}
		if (ch === "$" && typeof findMathClose === "function") {
			const size = countRun(line, i, "$");
			const close = findMathClose(line, i, size);
			const next = close === -1 ? i + size : close + size;
			current += line.slice(i, next);
			i = next;
			continue;
		}
		if (ch === "|") { cells.push(current.trim()); current = ""; i += 1; continue; }
		current += ch;
		i += 1;
	}
	cells.push(current.trim());
	return cells;
}

function parseAlignSpec(spec) {
	const left = spec.startsWith(":");
	const right = spec.endsWith(":");
	if (left && right) return "center";
	if (right) return "right";
	return left ? "left" : "";
}

function normalizeRowWidth(cells, width) {
	const out = cells.slice(0, width);
	while (out.length < width) out.push("");
	return out;
}

export function readTableBlock(lines, start, findMathClose) {
	if (start + 1 >= lines.length) return null;
	if (!lines[start].includes("|") || !lines[start + 1].includes("|")) return null;
	const delims = splitPipeRow(lines[start + 1], findMathClose);
	if (delims.length === 0 || !delims.every((cell) => DELIM_CELL_RE.test(cell))) return null;
	const headers = splitPipeRow(lines[start], findMathClose);
	if (headers.length !== delims.length) return null;
	const aligns = delims.map(parseAlignSpec);
	const rows = [];
	let end = start + 2;
	while (end < lines.length) {
		const rowLine = lines[end];
		if (rowLine.trim() === "" || !rowLine.includes("|") || NON_TABLE_START_RE.test(rowLine)) break;
		rows.push(normalizeRowWidth(splitPipeRow(rowLine, findMathClose), headers.length));
		end += 1;
	}
	const raw = lines.slice(start, end).join("\n");
	return { block: { kind: "table", headers, aligns, rows, raw }, next: end };
}

export function buildTableElement(doc, block, renderCell) {
	const table = el(doc, "table");
	const thead = el(doc, "thead");
	const headRow = el(doc, "tr");
	for (let c = 0; c < block.headers.length; c += 1) {
		const align = block.aligns[c];
		const th = el(doc, "th", {
			attrs: { scope: "col", ...(align ? { "data-peer-align": align } : {}) },
		});
		if (align) th.style.textAlign = align;
		th.append(renderCell(doc, block.headers[c]));
		headRow.append(th);
	}
	thead.append(headRow);
	const tbody = el(doc, "tbody");
	for (const row of block.rows) {
		const tr = el(doc, "tr");
		for (let c = 0; c < block.headers.length; c += 1) {
			const align = block.aligns[c];
			const td = el(doc, "td");
			if (align) td.style.textAlign = align;
			td.append(renderCell(doc, row[c] ?? ""));
			tr.append(td);
		}
		tbody.append(tr);
	}
	table.append(thead, tbody);
	return table;
}

function escapeTableCell(value) {
	return String(value ?? "")
		.replace(/\r?\n+/g, " ")
		.trim()
		.replace(/\\/g, "\\\\")
		.replace(/\|/g, "\\|");
}

function alignMarker(cell) {
	const align = (cell?.getAttribute?.("data-peer-align") ?? cell?.style?.textAlign ?? "").toLowerCase();
	if (align === "center") return ":---:";
	if (align === "left") return ":---";
	if (align === "right") return "---:";
	return "---";
}

function readRowCells(row, selector, targetLength) {
	const nodes = Array.from(row.querySelectorAll(selector));
	const count = targetLength ?? nodes.length;
	const out = [];
	for (let i = 0; i < count; i += 1) {
		out.push(escapeTableCell(nodes[i]?.textContent ?? ""));
	}
	return out;
}

/**
 * Serialize a semantic HTML `<table>` element into GFM pipe-table Markdown.
 * @param {HTMLTableElement|Element|null} tableEl
 * @returns {string}
 */
export function tableToMarkdown(tableEl) {
	if (!tableEl?.querySelectorAll) return "";
	const headerNodes = Array.from(tableEl.querySelectorAll("thead th"));
	if (headerNodes.length === 0) return "";
	const headers = headerNodes.map((th) => escapeTableCell(th.textContent ?? ""));
	const delimiters = headerNodes.map(alignMarker);
	const lines = [
		`| ${headers.join(" | ")} |`,
		`| ${delimiters.join(" | ")} |`,
	];
	const bodyRows = Array.from(tableEl.querySelectorAll("tbody tr"));
	for (const row of bodyRows) {
		const cells = readRowCells(row, "td", headers.length);
		lines.push(`| ${cells.join(" | ")} |`);
	}
	return lines.join("\n");
}

function writeClipboardBestEffort(doc, text) {
	const clip = doc.defaultView?.navigator?.clipboard ?? globalThis.navigator?.clipboard;
	if (typeof clip?.writeText !== "function") return;
	try {
		const pending = clip.writeText(text);
		if (pending && typeof pending.catch === "function") pending.catch(() => {});
	} catch {
		/* clipboard permissions are optional in headless/desktop sandboxes */
	}
}

function handleCopyPress(state) {
	if (state.life.dead) return;
	const text = String(state.getText?.() ?? "");
	state.onCopy?.(text);
	writeClipboardBestEffort(state.doc, text);
	state.cancelTimer();
	state.root.setAttribute("data-peer-copied", "true");
	writeText(state.copyText, "Copied");
	state.cancelTimer = state.life.later(() => {
		state.root.removeAttribute("data-peer-copied");
		writeText(state.copyText, "Copy");
	}, COPIED_RESET_MS);
}

function applyCornerModel(state, model) {
	if (state.life.dead || model === state.prevModel) return;
	state.prevModel = model;
	if (typeof model?.getText === "function") state.getText = model.getText;
	if (typeof model?.label === "string" && model.label) {
		state.copyBtn.setAttribute("aria-label", model.label);
		state.copyBtn.title = model.label;
	}
	if (state.expandBtn && typeof model?.expandLabel === "string" && model.expandLabel) {
		state.expandBtn.setAttribute("aria-label", model.expandLabel);
		state.expandBtn.title = model.expandLabel;
	}
}

/**
 * Mount a top-right copy (and optional expand) corner control inside `host`.
 * @param {Element} host
 * @param {{getText?: () => string, label?: string, expandLabel?: string, onCopy?: (text: string) => void, onExpand?: () => void}} [options]
 */
export function createCopyCorner(host, options = {}) {
	const doc = documentOf(host);
	injectUiStyles(doc);
	injectBlocksStyles(doc);
	const life = createLife();
	const label = options.label || "Copy";
	const root = el(doc, "span", {
		className: "peer-blocks-corner",
		attrs: { "data-peer-copy-corner": "" },
	});
	const copyBtn = button(doc, {
		className: "peer-blocks-corner-btn",
		ariaLabel: label,
		title: label,
		signal: life.signal,
		attrs: { "data-testid": "md-copy", "data-peer-action": "copy" },
		onClick: () => handleCopyPress(state),
	});
	const copyText = textNode(doc, copyBtn, "Copy");
	root.append(copyBtn);
	let expandBtn = null;
	if (typeof options.onExpand === "function") {
		const expLabel = options.expandLabel || "Expand";
		expandBtn = button(doc, {
			label: "Expand",
			className: "peer-blocks-corner-btn",
			ariaLabel: expLabel,
			title: expLabel,
			signal: life.signal,
			attrs: { "data-testid": "md-mermaid-expand", "data-peer-action": "expand" },
			onClick: () => options.onExpand(),
		});
		root.append(expandBtn);
	}
	const state = {
		doc, life, root, copyBtn, copyText, expandBtn,
		getText: options.getText, onCopy: options.onCopy,
		cancelTimer: () => {}, prevModel: null,
	};
	host.append(root);
	const update = (model = {}) => applyCornerModel(state, model);
	const destroy = () => { if (life.destroy()) root.remove(); };
	return { update, destroy };
}

/**
 * Wrap a semantic `<table>` inside a horizontal scroller and optional Markdown copy corner.
 * @param {Document} doc
 * @param {HTMLTableElement} tableEl
 * @param {{displayOnly?: boolean, onCopy?: (text: string) => void}} [options]
 */
export function wrapTableBlock(doc, tableEl, { displayOnly = false, onCopy } = {}) {
	injectBlocksStyles(doc);
	const wrap = el(doc, "div", {
		className: "peer-blocks-table-wrap",
		attrs: { "data-testid": "md-table", "data-peer-block": "table" },
	});
	const scroller = el(doc, "div", { className: "peer-blocks-table-scroll" });
	let activeTable = tableEl;
	activeTable.classList.add("peer-blocks-table");
	activeTable.setAttribute("data-streamdown", "table");
	scroller.append(activeTable);
	wrap.append(scroller);
	let corner = displayOnly
		? null
		: createCopyCorner(wrap, { label: "Copy table", getText: () => tableToMarkdown(activeTable), onCopy });
	const replaceTable = (nextTable, nextDisplayOnly = false) => {
		if (nextTable && nextTable !== activeTable) {
			nextTable.classList.add("peer-blocks-table");
			nextTable.setAttribute("data-streamdown", "table");
			scroller.replaceChildren(nextTable);
			activeTable = nextTable;
		}
		if (!nextDisplayOnly && !corner) {
			corner = createCopyCorner(wrap, { label: "Copy table", getText: () => tableToMarkdown(activeTable), onCopy });
		} else if (nextDisplayOnly && corner) {
			corner.destroy();
			corner = null;
		}
	};
	const destroy = () => {
		corner?.destroy();
		corner = null;
		wrap.remove();
	};
	return { node: wrap, replaceTable, destroy };
}
