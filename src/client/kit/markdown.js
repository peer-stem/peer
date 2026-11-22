/**
 * Extensible streaming-safe Markdown DOM control (`L-1..L-4`) for CloudCanvas UI kit.
 * Supports GFM tables, GitHub alert callouts (`[!NOTE|TIP|IMPORTANT|WARNING|CAUTION]`),
 * block/fence/table/inline/image hooks, and keyed block-slot reuse across streaming
 * updates with zero `innerHTML` and zero string-token injection.
 */
import { createLife, documentOf, el } from "cloudcanvas-lib/ui";
import { appendKitInline } from "./markdown-inline.js";
import { buildKitTableElement, readKitTableBlock } from "./markdown-table.js";
import { injectKitStyles } from "./styles.js";

export { buildKitTableElement, readKitTableBlock };

const MAX_DEPTH = 6;
const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})[ \t]*([^\n]*)$/;
const FENCE_CLOSE_RE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
const HEADING_RE = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE_RE = /^ {0,3}([-*_])(\s*\1){2,}\s*$/;
const QUOTE_RE = /^ {0,3}>\s?/;
const ITEM_RE = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const TASK_RE = /^\[([ xX])\]\s+(.*)$/;
const ALERT_RE = /^\[!(note|tip|important|warning|caution)\][ \t]*(.*)$/i;

function readFence(lines, start) {
	const open = FENCE_OPEN_RE.exec(lines[start]);
	if (!open) return null;
	const marker = open[1];
	const info = open[2].trim();
	if (marker[0] === "`" && info.includes("`")) return null;
	const parts = /^(\S+)(?:\s+(.*))?$/.exec(info);
	const language = parts?.[1] ?? "";
	const meta = parts?.[2]?.trim() ?? "";
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

function readCallout(lines, start) {
	if (!QUOTE_RE.test(lines[start])) return null;
	const firstInner = lines[start].replace(QUOTE_RE, "");
	const match = ALERT_RE.exec(firstInner);
	if (!match) return null;
	let end = start + 1;
	while (end < lines.length && QUOTE_RE.test(lines[end])) end += 1;
	const inner = lines.slice(start, end).map((l) => l.replace(QUOTE_RE, ""));
	if (match[2].trim()) inner[0] = match[2].trim();
	else {
		inner.shift();
		while (inner.length > 0 && inner[0].trim() === "") inner.shift();
	}
	const alertKind = match[1].toLowerCase();
	return {
		block: { kind: "callout", key: `callout:${alertKind}`, alertKind, source: inner.join("\n") },
		next: end,
	};
}

function renderListBlock(ctx, lines, start, parent, depth) {
	const firstMatch = ITEM_RE.exec(lines[start]);
	const base = firstMatch[1].length;
	const ordered = /\d/.test(firstMatch[2]);
	const list = ctx.doc.createElement(ordered ? "ol" : "ul");
	const startNum = Number.parseInt(firstMatch[2], 10);
	if (ordered && startNum !== 1) list.setAttribute("start", String(startNum));
	let i = start;
	while (i < lines.length) {
		const item = ITEM_RE.exec(lines[i]);
		if (!item || item[1].length !== base || /\d/.test(item[2]) !== ordered) break;
		let end = i + 1;
		while (end < lines.length) {
			const ln = lines[end];
			const nextItem = ITEM_RE.exec(ln);
			if (nextItem && nextItem[1].length === base) break;
			if (ln.trim() === "" && (end + 1 >= lines.length || (lines[end + 1].length - lines[end + 1].trimStart().length) <= base)) break;
			if (ln.trim() !== "" && (ln.length - ln.trimStart().length) <= base) break;
			end += 1;
		}
		const li = ctx.doc.createElement("li");
		const task = TASK_RE.exec(item[3]);
		const headText = task ? task[2] : item[3];
		if (task) {
			const box = el(ctx.doc, "input", { attrs: { type: "checkbox", disabled: true } });
			box.checked = task[1] !== " ";
			li.append(box, ctx.doc.createTextNode(" "));
		}
		appendKitInline(ctx, headText.trim(), li);
		const sub = lines.slice(i + 1, end).map((ln) => ln.slice(Math.min(ln.length - ln.trimStart().length, base + 2)));
		if (sub.some((ln) => ln.trim() !== "")) renderProseBlocks(ctx, sub, li, depth + 1);
		list.append(li);
		i = end;
	}
	parent.append(list);
	return i;
}

function renderProseBlocks(ctx, lines, parent, depth) {
	if (depth > MAX_DEPTH) { parent.append(ctx.doc.createTextNode(lines.join("\n"))); return; }
	let i = 0;
	while (i < lines.length) {
		const line = lines[i];
		if (line.trim() === "") { i += 1; continue; }
		const heading = HEADING_RE.exec(line);
		if (heading) {
			const h = ctx.doc.createElement(`h${heading[1].length}`);
			appendKitInline(ctx, heading[2], h);
			parent.append(h);
			i += 1;
			continue;
		}
		if (RULE_RE.test(line)) { parent.append(ctx.doc.createElement("hr")); i += 1; continue; }
		if (QUOTE_RE.test(line)) {
			let end = i + 1;
			while (end < lines.length && QUOTE_RE.test(lines[end])) end += 1;
			const bq = ctx.doc.createElement("blockquote");
			renderProseBlocks(ctx, lines.slice(i, end).map((l) => l.replace(QUOTE_RE, "")), bq, depth + 1);
			parent.append(bq);
			i = end;
			continue;
		}
		if (ITEM_RE.test(line)) { i = renderListBlock(ctx, lines, i, parent, depth); continue; }
		let end = i + 1;
		while (end < lines.length && lines[end].trim() !== "" && !HEADING_RE.test(lines[end]) && !RULE_RE.test(lines[end]) && !QUOTE_RE.test(lines[end]) && !ITEM_RE.test(lines[end])) {
			end += 1;
		}
		const p = ctx.doc.createElement("p");
		lines.slice(i, end).forEach((ln, idx) => {
			if (idx > 0) p.append(ctx.doc.createElement("br"));
			appendKitInline(ctx, ln.trim(), p);
		});
		parent.append(p);
		i = end;
	}
}

function parseTopBlocks(text, hooks) {
	if (!text.trim()) return [];
	const lines = text.split("\n");
	const readSpecial = (idx) => readFence(lines, idx)
		?? hooks.readBlock?.(lines, idx)
		?? readCallout(lines, idx)
		?? readKitTableBlock(lines, idx, hooks.skipTableCellSpan);
	const blocks = [];
	let i = 0;
	while (i < lines.length) {
		if (lines[i].trim() === "") { i += 1; continue; }
		const special = readSpecial(i);
		if (special) { blocks.push(special.block); i = special.next; continue; }
		let end = i + 1;
		while (end < lines.length && !readSpecial(end)) end += 1;
		const chunk = lines.slice(i, end).join("\n").trimEnd();
		if (chunk.trim()) blocks.push({ kind: "prose", key: "prose", source: chunk });
		i = end;
	}
	return blocks;
}

function createPlainFenceSlot(doc, key) {
	const pre = doc.createElement("pre");
	const code = doc.createElement("code");
	pre.append(code);
	const update = (b) => {
		if (b.language) code.setAttribute("data-language", b.language);
		else code.removeAttribute("data-language");
		code.textContent = b.source;
	};
	return { key, el: pre, update, destroy: () => pre.remove() };
}

function createSlotForBlock(doc, block, key, hooks, depth, opts) {
	const inlineCtx = {
		doc,
		externalTarget: hooks.externalTarget !== false,
		readInline: hooks.readInline,
		renderInline: hooks.renderInline,
		renderImage: hooks.renderImage,
	};
	if (key === "prose") {
		const node = el(doc, "div", { className: hooks.proseClassName ?? "cloudcanvas-ui-md-prose", attrs: hooks.proseAttrs });
		let prev = null;
		const update = (b) => { if (b.source !== prev) { prev = b.source; node.replaceChildren(); renderProseBlocks(inlineCtx, b.source.split("\n"), node, 0); } };
		return { key, el: node, update, destroy: () => node.remove() };
	}
	if (key === "table") {
		if (typeof hooks.createTableSlot === "function") {
			return hooks.createTableSlot({ doc, block, opts, buildTable: (b) => buildKitTableElement(doc, b, inlineCtx) });
		}
		const holder = el(doc, "div", { className: "cloudcanvas-ui-md-table" });
		let prevRaw = null;
		const update = (b) => { if (b.raw !== prevRaw) { prevRaw = b.raw; holder.replaceChildren(buildKitTableElement(doc, b, inlineCtx)); } };
		return { key, el: holder, update, destroy: () => holder.remove() };
	}
	if (key.startsWith("callout:")) {
		const node = el(doc, "div", {
			className: hooks.calloutClassName ?? "cloudcanvas-ui-md-callout",
			attrs: { ...(hooks.calloutAttrs ?? {}), "data-alert-kind": block.alertKind },
		});
		const inner = depth < 4 ? createKitMarkdownInternal(node, hooks, depth + 1) : null;
		const update = (b, o) => { if (inner) inner.update({ ...o, source: b.source }); else node.textContent = b.source; };
		return { key, el: node, update, destroy: () => { inner?.destroy(); node.remove(); } };
	}
	if (block.kind === "fence") {
		return hooks.createFenceSlot?.({ doc, block, key, opts }) ?? createPlainFenceSlot(doc, key);
	}
	const custom = hooks.createBlockSlot?.({ doc, block, key, opts });
	if (custom) return custom;
	const fallback = el(doc, "div");
	return { key, el: fallback, update: (b) => { fallback.textContent = String(b.source ?? ""); }, destroy: () => fallback.remove() };
}

function reconcileMarkdownSlots(doc, root, slots, blocks, hooks, depth, opts) {
	while (slots.length > blocks.length) slots.pop().destroy();
	for (let i = 0; i < blocks.length; i += 1) {
		const b = blocks[i];
		const key = b.kind === "fence"
			? (hooks.fenceKeyFor?.(b, opts) ?? `fence:${b.language.toLowerCase()}`)
			: (b.key ?? b.kind);
		if (slots[i] && slots[i].key === key) { slots[i].update(b, opts); continue; }
		if (slots[i]) slots[i].destroy();
		const slot = createSlotForBlock(doc, b, key, hooks, depth, opts);
		root.insertBefore(slot.el, root.children[i] ?? null);
		slot.update(b, opts);
		slots[i] = slot;
	}
}

function createKitMarkdownInternal(host, hooks = {}, depth = 0) {
	const doc = documentOf(host);
	injectKitStyles(doc);
	const life = createLife();
	const root = el(doc, "div", { className: hooks.rootClassName ?? "cloudcanvas-ui-markdown", attrs: hooks.rootAttrs });
	host.append(root);
	const slots = [];
	let prevKey = null;
	return {
		root,
		update(model = {}) {
			if (life.dead) return;
			const raw = String(model.source ?? "").slice(0, hooks.maxLength ?? 100000);
			const streaming = Boolean(model.streaming);
			const mode = model.mode === "light" ? "light" : "dark";
			const displayOnly = Boolean(model.displayOnly);
			const stateKey = `${mode}|${streaming ? 1 : 0}|${displayOnly ? 1 : 0}|${raw}`;
			if (stateKey === prevKey) return;
			prevKey = stateKey;
			const opts = { streaming, mode, displayOnly };
			hooks.onRootUpdate?.(root, opts);
			const text = (hooks.preprocess ? hooks.preprocess(raw) : raw).replace(/\r\n?/g, "\n");
			reconcileMarkdownSlots(doc, root, slots, parseTopBlocks(text, hooks), hooks, depth, opts);
		},
		destroy() {
			if (!life.destroy()) return;
			while (slots.length > 0) slots.pop().destroy();
			root.remove();
		},
	};
}

export function createKitMarkdown(host, hooks = {}) {
	return createKitMarkdownInternal(host, hooks, 0);
}
