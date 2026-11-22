/**
 * Single-pass DOM inline Markdown parser (`L-2`, `L-3`) for CloudCanvas UI kit.
 * Builds DOM nodes directly (`createElement` / `createTextNode`, never `innerHTML`
 * and never string-placeholder tokens) with `readInline`/`renderInline` and
 * `renderImage` extension hooks.
 */
import { safeHref } from "cloudcanvas-lib/ui";

function countChars(text, start, ch) {
	let end = start;
	while (end < text.length && text[end] === ch) end += 1;
	return end - start;
}

function findCodeEnd(text, openEnd, ticks) {
	let i = openEnd;
	while (i < text.length) {
		if (text[i] !== "`") { i += 1; continue; }
		const run = countChars(text, i, "`");
		if (run === ticks) return i;
		i += run;
	}
	return -1;
}

function readBracketed(text, openIndex, openChar, closeChar) {
	if (text[openIndex] !== openChar) return null;
	let depth = 1;
	let i = openIndex + 1;
	while (i < text.length && depth > 0) {
		if (text[i] === "\\") { i += 2; continue; }
		if (text[i] === openChar) depth += 1;
		else if (text[i] === closeChar) depth -= 1;
		i += 1;
	}
	return depth === 0 ? { value: text.slice(openIndex + 1, i - 1), next: i } : null;
}

function parseLinkDestination(rawInner) {
	const trimmed = rawInner.trim();
	if (!trimmed) return { href: "", title: "" };
	if (trimmed.startsWith("<")) {
		const closeAngle = trimmed.indexOf(">");
		if (closeAngle > 0) {
			const href = trimmed.slice(1, closeAngle).trim();
			const rest = trimmed.slice(closeAngle + 1).trim();
			const titleMatch = /^["'](.*)["']$/.exec(rest);
			return { href, title: titleMatch ? titleMatch[1] : "" };
		}
	}
	const parts = /^(\S+)(?:\s+["'](.*)["'])?$/.exec(trimmed);
	return parts ? { href: parts[1], title: parts[2] ?? "" } : { href: trimmed, title: "" };
}

function tryReadImageOrLink(text, index) {
	const isImage = text[index] === "!" && text[index + 1] === "[";
	const bracketStart = isImage ? index + 1 : index;
	if (text[bracketStart] !== "[") return null;
	const label = readBracketed(text, bracketStart, "[", "]");
	if (!label || text[label.next] !== "(") return null;
	const dest = readBracketed(text, label.next, "(", ")");
	if (!dest) return null;
	const { href, title } = parseLinkDestination(dest.value);
	return { isImage, label: label.value, href, title, next: dest.next };
}

function findClosingDelim(text, from, delim) {
	let i = from;
	while (i <= text.length - delim.length) {
		if (text[i] === "\\") { i += 2; continue; }
		if (text[i] === "`") {
			const run = countChars(text, i, "`");
			const close = findCodeEnd(text, i + run, run);
			i = close === -1 ? i + run : close + run;
			continue;
		}
		if (text.startsWith(delim, i) && !/\s/.test(text[i - 1] ?? " ")) return i;
		i += 1;
	}
	return -1;
}

function tryReadDelimited(text, index) {
	for (const [delim, tag] of [["**", "strong"], ["__", "strong"], ["~~", "del"], ["*", "em"], ["_", "em"]]) {
		if (!text.startsWith(delim, index)) continue;
		const afterOpen = index + delim.length;
		if (afterOpen >= text.length || /\s/.test(text[afterOpen])) continue;
		if (delim.length === 1 && text[afterOpen] === delim[0]) continue;
		if (delim[0] === "_" && index > 0 && /\w/.test(text[index - 1])) continue;
		const closeAt = findClosingDelim(text, afterOpen, delim);
		if (closeAt === -1) continue;
		if (delim[0] === "_" && /\w/.test(text[closeAt + delim.length] ?? "")) continue;
		return { tag, inner: text.slice(afterOpen, closeAt), next: closeAt + delim.length };
	}
	return null;
}

function buildImageNode(ctx, link) {
	if (typeof ctx.renderImage === "function") {
		const custom = ctx.renderImage({ doc: ctx.doc, alt: link.label, src: link.href, title: link.title });
		if (custom) return custom;
	}
	const badge = ctx.doc.createElement("span");
	badge.className = "cloudcanvas-ui-md-image-blocked";
	badge.textContent = `[Image blocked: ${link.label || "image"}]`;
	return badge;
}

function buildLinkNode(ctx, link, depth) {
	const safe = safeHref(link.href, { allowRelative: ctx.allowRelative !== false });
	if (!safe) {
		const span = ctx.doc.createElement("span");
		appendKitInline(ctx, link.label, span, depth + 1);
		return span;
	}
	const anchor = ctx.doc.createElement("a");
	anchor.setAttribute("href", safe.href);
	if (link.title) anchor.setAttribute("title", link.title);
	if (ctx.externalTarget && safe.external) {
		anchor.setAttribute("target", "_blank");
		anchor.setAttribute("rel", "noopener noreferrer");
	}
	appendKitInline(ctx, link.label, anchor, depth + 1);
	return anchor;
}

function stepInline(ctx, text, index, parent, flushBuf, depth) {
	if (typeof ctx.readInline === "function") {
		const custom = ctx.readInline(text, index);
		if (custom && custom.next > index) {
			flushBuf();
			const node = ctx.renderInline?.(ctx.doc, custom.token);
			if (node) parent.append(node);
			return custom.next;
		}
	}
	const ch = text[index];
	if (ch === "\\" && index + 1 < text.length && /[\\`*_{}[\]()#+\-.!~$|<>]/.test(text[index + 1])) {
		flushBuf(text[index + 1]);
		return index + 2;
	}
	if (ch === "`") {
		const ticks = countChars(text, index, "`");
		const closeAt = findCodeEnd(text, index + ticks, ticks);
		if (closeAt === -1) {
			flushBuf(text.slice(index, index + ticks));
			return index + ticks;
		}
		flushBuf();
		const code = ctx.doc.createElement("code");
		const raw = text.slice(index + ticks, closeAt);
		const stripPad = raw.length >= 2 && raw.startsWith(" ") && raw.endsWith(" ") && raw.trim() !== "";
		code.textContent = stripPad ? raw.slice(1, -1) : raw;
		parent.append(code);
		return closeAt + ticks;
	}
	const link = (ch === "!" || ch === "[") ? tryReadImageOrLink(text, index) : null;
	if (link) {
		flushBuf();
		parent.append(link.isImage ? buildImageNode(ctx, link) : buildLinkNode(ctx, link, depth));
		return link.next;
	}
	const emph = tryReadDelimited(text, index);
	if (emph) {
		flushBuf();
		const el = ctx.doc.createElement(emph.tag);
		appendKitInline(ctx, emph.inner, el, depth + 1);
		parent.append(el);
		return emph.next;
	}
	return -1;
}

export function appendKitInline(ctx, text, parent, depth = 0) {
	if (!text) return;
	if (depth > 8) {
		parent.append(ctx.doc.createTextNode(text));
		return;
	}
	let buf = "";
	const flushBuf = (extra = "") => {
		const combined = buf + extra;
		buf = "";
		if (combined) parent.append(ctx.doc.createTextNode(combined));
	};
	let i = 0;
	while (i < text.length) {
		const next = stepInline(ctx, text, i, parent, flushBuf, depth);
		if (next > i) { i = next; continue; }
		buf += text[i];
		i += 1;
	}
	flushBuf();
}

export function renderKitInline(source, options = {}) {
	const doc = options.doc ?? globalThis.document;
	const frag = doc.createDocumentFragment();
	appendKitInline({ ...options, doc }, String(source ?? ""), frag, 0);
	return frag;
}
