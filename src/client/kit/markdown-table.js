/**
 * GFM pipe-table reader and DOM `<table>` builder (`L-1`) for CloudCanvas UI kit.
 */
import { appendKitInline } from "./markdown-inline.js";

const TABLE_SEP_CELL_RE = /^:?-{3,}:?$/;

function splitTableRow(line, skipSpanEnd) {
	const trimmed = line.trim();
	if (!trimmed.includes("|")) return null;
	const inner = trimmed.replace(/^\|/, "").replace(/\|$/, "");
	const cells = [];
	let cur = "";
	let i = 0;
	while (i < inner.length) {
		const ch = inner[i];
		if (ch === "\\" && i + 1 < inner.length) {
			cur += inner[i + 1] === "|" ? "|" : inner.slice(i, i + 2);
			i += 2;
			continue;
		}
		if (typeof skipSpanEnd === "function") {
			const jumped = skipSpanEnd(inner, i);
			if (jumped > i) { cur += inner.slice(i, jumped); i = jumped; continue; }
		}
		if (ch === "|") { cells.push(cur.trim()); cur = ""; i += 1; continue; }
		cur += ch;
		i += 1;
	}
	cells.push(cur.trim());
	return cells;
}

export function readKitTableBlock(lines, start, skipSpanEnd) {
	if (start + 1 >= lines.length) return null;
	const headers = splitTableRow(lines[start], skipSpanEnd);
	const sep = splitTableRow(lines[start + 1], skipSpanEnd);
	if (!headers || !sep || headers.length === 0 || headers.length !== sep.length) return null;
	if (!sep.every((cell) => TABLE_SEP_CELL_RE.test(cell))) return null;
	const alignments = sep.map((cell) => {
		const left = cell.startsWith(":");
		const right = cell.endsWith(":");
		return left && right ? "center" : right ? "right" : left ? "left" : null;
	});
	const rows = [];
	let end = start + 2;
	while (end < lines.length && lines[end].trim() !== "") {
		const cells = splitTableRow(lines[end], skipSpanEnd);
		if (!cells) break;
		rows.push(headers.map((_, idx) => cells[idx] ?? ""));
		end += 1;
	}
	return {
		block: { kind: "table", key: "table", headers, alignments, rows, raw: lines.slice(start, end).join("\n") },
		next: end,
	};
}

export function buildKitTableElement(doc, block, inlineCtx) {
	const table = doc.createElement("table");
	const thead = doc.createElement("thead");
	const headRow = doc.createElement("tr");
	block.headers.forEach((cell, idx) => {
		const th = doc.createElement("th");
		if (block.alignments[idx]) th.style.textAlign = block.alignments[idx];
		appendKitInline(inlineCtx, cell, th);
		headRow.append(th);
	});
	thead.append(headRow);
	table.append(thead);
	const tbody = doc.createElement("tbody");
	for (const row of block.rows) {
		const tr = doc.createElement("tr");
		row.forEach((cell, idx) => {
			const td = doc.createElement("td");
			if (block.alignments[idx]) td.style.textAlign = block.alignments[idx];
			appendKitInline(inlineCtx, cell, td);
			tr.append(td);
		});
		tbody.append(tr);
	}
	table.append(tbody);
	return table;
}
