/**
 * Markdown image blocking policy (`[Image blocked: alt]`): prevents remote
 * network beacons (`![x](https://...)`) and avoids turning `![alt](url)` into
 * `!<a href="url">alt</a>` in `cloudcanvas-lib`'s inline link scanner.
 */
import { el } from "cloudcanvas-lib/ui";

const MAX_ALT_LENGTH = 1000;
const MAX_TARGET_LENGTH = 2048;

/**
 * Format the visible text of a blocked Markdown image badge.
 * @param {string} [alt]
 * @returns {string}
 */
export function formatBlockedImageLabel(alt = "") {
	const clean = String(alt ?? "").trim();
	return clean ? `[Image blocked: ${clean}]` : "[Image blocked]";
}

/**
 * Build the `<span class="peer-blocks-image-blocked" data-peer-blocked-image>` badge.
 * Never attaches `src` to a network-loading element or attribute.
 * @param {Document} doc
 * @param {{alt?: string, src?: string}} [image]
 * @returns {HTMLSpanElement}
 */
export function createBlockedImageBadge(doc, { alt = "" } = {}) {
	return el(doc, "span", {
		className: "peer-blocks-image-blocked",
		text: formatBlockedImageLabel(alt),
		attrs: { "data-peer-blocked-image": "" },
	});
}

function findAltEnd(text, from) {
	const limit = Math.min(text.length, from + MAX_ALT_LENGTH);
	let depth = 0;
	for (let i = from; i < limit; i += 1) {
		const ch = text[i];
		if (ch === "\n") return -1;
		if (ch === "\\" && i + 1 < limit) { i += 1; continue; }
		if (ch === "[") depth += 1;
		else if (ch === "]" && depth === 0) return i;
		else if (ch === "]") depth -= 1;
	}
	return -1;
}

function findTargetEnd(text, from) {
	const limit = Math.min(text.length, from + MAX_TARGET_LENGTH);
	let depth = 0;
	let quote = "";
	for (let i = from; i < limit; i += 1) {
		const ch = text[i];
		if (ch === "\n") return -1;
		if (ch === "\\" && i + 1 < limit) { i += 1; continue; }
		if (quote) {
			if (ch === quote) quote = "";
			continue;
		}
		if (ch === "\"" || ch === "'") { quote = ch; continue; }
		if (ch === "(") depth += 1;
		else if (ch === ")" && depth === 0) return i;
		else if (ch === ")") depth -= 1;
	}
	return -1;
}

function parseDestination(inside) {
	const trimmed = inside.trim();
	if (trimmed.startsWith("<")) {
		const closeAngle = trimmed.indexOf(">");
		if (closeAngle === -1) return null;
		const src = trimmed.slice(1, closeAngle);
		const rest = trimmed.slice(closeAngle + 1).trim();
		const titleMatch = /^(?:"([^"]*)"|'([^']*)')$/.exec(rest);
		if (rest && !titleMatch) return null;
		return { src, title: titleMatch?.[1] ?? titleMatch?.[2] ?? "" };
	}
	const titled = /^(\S+)\s+(?:"([^"]*)"|'([^']*)')$/.exec(trimmed);
	if (titled) return { src: titled[1], title: titled[2] ?? titled[3] ?? "" };
	if (/\s/.test(trimmed)) return null;
	return { src: trimmed, title: "" };
}

/**
 * Read a Markdown image `![alt](src "title")` starting at `start`, or `null`.
 * @param {string} text
 * @param {number} start
 */
export function readMarkdownImage(text, start) {
	if (text[start] !== "!" || text[start + 1] !== "[") return null;
	const altEnd = findAltEnd(text, start + 2);
	if (altEnd === -1 || text[altEnd + 1] !== "(") return null;
	const targetEnd = findTargetEnd(text, altEnd + 2);
	if (targetEnd === -1) return null;
	const dest = parseDestination(text.slice(altEnd + 2, targetEnd));
	if (!dest) return null;
	return {
		alt: text.slice(start + 2, altEnd),
		src: dest.src,
		title: dest.title,
		raw: text.slice(start, targetEnd + 1),
		next: targetEnd + 1,
	};
}

export function readCodeSpanEnd(text, start, tickLen) {
	const ticks = "`".repeat(tickLen);
	let i = start + tickLen;
	while (i < text.length) {
		const at = text.indexOf(ticks, i);
		if (at === -1) return -1;
		if (text[at - 1] !== "`" && text[at + tickLen] !== "`") return at + tickLen;
		i = at + countRun(text, at, "`");
	}
	return -1;
}

export function countRun(text, start, ch) {
	let n = 0;
	while (text[start + n] === ch) n += 1;
	return n;
}

export function isEscapedAt(text, index) {
	let slashes = 0;
	let pos = index - 1;
	while (pos >= 0 && text[pos] === "\\") {
		slashes += 1;
		pos -= 1;
	}
	return slashes % 2 === 1;
}

/**
 * Split inline Markdown text into `{ type: "text" | "code" | "image" }` tokens,
 * preserving escaped characters and backtick code spans untouched.
 * @param {string} text
 */
export function splitInlineTokens(text) {
	const source = String(text ?? "");
	const tokens = [];
	let plain = "";
	let i = 0;
	const flushPlain = () => { if (plain) { tokens.push({ type: "text", value: plain }); plain = ""; } };
	while (i < source.length) {
		const ch = source[i];
		if (ch === "\\" && i + 1 < source.length) { plain += source.slice(i, i + 2); i += 2; continue; }
		if (ch === "`") {
			const tickLen = countRun(source, i, "`");
			const end = readCodeSpanEnd(source, i, tickLen);
			if (end !== -1) { flushPlain(); tokens.push({ type: "code", raw: source.slice(i, end) }); i = end; continue; }
			plain += source.slice(i, i + tickLen);
			i += tickLen;
			continue;
		}
		if (ch === "!" && source[i + 1] === "[") {
			const image = readMarkdownImage(source, i);
			if (image) { flushPlain(); tokens.push({ type: "image", ...image }); i = image.next; continue; }
		}
		plain += ch;
		i += 1;
	}
	flushPlain();
	return tokens;
}

/**
 * Replace all unescaped, non-code Markdown images `![alt](url)` in `line`.
 * @param {string} line
 * @param {(image: {alt: string, src: string, title: string, raw: string}, index: number) => string} [replacer]
 * @returns {string}
 */
export function replaceMarkdownImagesInLine(line, replacer) {
	const format = typeof replacer === "function"
		? replacer
		: (img) => formatBlockedImageLabel(img.alt);
	let imageIndex = 0;
	let out = "";
	for (const token of splitInlineTokens(line)) {
		if (token.type === "image") {
			out += format(token, imageIndex);
			imageIndex += 1;
		} else {
			out += token.type === "code" ? token.raw : token.value;
		}
	}
	return out;
}
