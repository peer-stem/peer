import { findSessionTextMatches } from "../../../core/index.ts";

const EXCLUDED = [
	"script", "style", "noscript", "textarea", "input", "select", "iframe", "canvas", '[contenteditable="true"]',
	"title", "defs", "metadata", "desc", ".katex-mathml", ".sr-only", "[hidden]",
	"[data-session-find-exclude]", "[data-lh-menu]", '[role="menu"]', '[role="dialog"]', '[role="tooltip"]',
].join(",");

interface TextPoint { node: Text; offset: number }
interface DisplayCharacter { start: TextPoint; end: TextPoint; collapsedSpace: boolean }
interface DisplayRun { text: string; characters: DisplayCharacter[] }
interface RunBuffer { runs: DisplayRun[]; text: string; characters: DisplayCharacter[] }

const BLOCK_DISPLAYS = new Set(["block", "flex", "grid", "list-item", "table", "table-row", "table-cell", "table-caption", "flow-root"]);

function styleOf(element: Element): CSSStyleDeclaration | null {
	const view = element.ownerDocument.defaultView;
	return typeof view?.getComputedStyle === "function" ? view.getComputedStyle(element) : null;
}

function hidden(element: Element, style: CSSStyleDeclaration | null): boolean {
	return element.matches(EXCLUDED)
		|| Boolean(style && (
			style.display === "none" ||
			style.visibility === "hidden" ||
			style.visibility === "collapse" ||
			style.opacity === "0" ||
			style.contentVisibility === "hidden"
		));
}

function displayedRoot(root: Element): boolean {
	for (let element: Element | null = root; element; element = element.parentElement) {
		if (hidden(element, styleOf(element))) return false;
	}
	return true;
}

function flushRunBuffer(buf: RunBuffer): void {
	if (buf.characters.at(-1)?.collapsedSpace) {
		buf.text = buf.text.slice(0, -1);
		buf.characters.pop();
	}
	if (buf.text) buf.runs.push({ text: buf.text, characters: buf.characters });
	buf.text = "";
	buf.characters = [];
}

function appendDisplayText(buf: RunBuffer, node: Text, whiteSpace: string): void {
	const collapse = !["pre", "pre-wrap", "break-spaces"].includes(whiteSpace);
	for (let i = 0; i < node.data.length; i++) {
		const char = node.data[i]!;
		if (whiteSpace === "pre-line" && /[\r\n]/.test(char)) {
			flushRunBuffer(buf);
			continue;
		}
		const space = collapse && /[\t\n\r\f ]/.test(char);
		if (space && !buf.text) continue;
		if (space && buf.characters.at(-1)?.collapsedSpace) {
			buf.characters.at(-1)!.end = { node, offset: i + 1 };
			continue;
		}
		buf.text += space ? " " : char;
		buf.characters.push({ start: { node, offset: i }, end: { node, offset: i + 1 }, collapsedSpace: space });
	}
}

function visitDisplayElement(buf: RunBuffer, element: Element): void {
	const style = styleOf(element);
	if (hidden(element, style)) return;
	if (element.tagName === "BR") {
		flushRunBuffer(buf);
		return;
	}
	const block = Boolean(style && BLOCK_DISPLAYS.has(style.display));
	const whiteSpace = style?.whiteSpace ?? (element.matches("pre, listing, plaintext") ? "pre" : "normal");
	if (block) flushRunBuffer(buf);
	for (const child of element.childNodes) {
		if (child.nodeType === 3) appendDisplayText(buf, child as Text, whiteSpace);
		else if (child.nodeType === 1) visitDisplayElement(buf, child as Element);
	}
	if (block) flushRunBuffer(buf);
}

function displayRuns(root: Element): DisplayRun[] {
	const buf: RunBuffer = { runs: [], text: "", characters: [] };
	visitDisplayElement(buf, root);
	flushRunBuffer(buf);
	return buf.runs;
}

class StaticRangeLike {
	startContainer: Node = null as unknown as Node;
	startOffset = 0;
	endContainer: Node = null as unknown as Node;
	endOffset = 0;

	setStart(node: Node, offset: number): void {
		this.startContainer = node;
		this.startOffset = offset;
	}

	setEnd(node: Node, offset: number): void {
		this.endContainer = node;
		this.endOffset = offset;
	}

	get collapsed(): boolean {
		return this.startContainer === this.endContainer && this.startOffset === this.endOffset;
	}

	toString(): string {
		const text = (node: Node) => (node.nodeType === 3 ? (node as Text).data : "");
		if (this.startContainer === this.endContainer) return text(this.startContainer).slice(this.startOffset, this.endOffset);
		const texts: Text[] = [];
		const walk = (node: Node | null): void => {
			if (!node) return;
			if (node.nodeType === 3) texts.push(node as Text);
			for (const child of node.childNodes) walk(child);
		};
		walk(this.startContainer.ownerDocument);
		const start = texts.indexOf(this.startContainer as Text);
		const end = texts.indexOf(this.endContainer as Text);
		let out = text(this.startContainer).slice(this.startOffset);
		for (let i = start + 1; i < end && i >= 0; i++) out += texts[i]!.data;
		if (end >= 0) out += text(this.endContainer).slice(0, this.endOffset);
		return out;
	}
}

function collectRunRanges(doc: Document, run: DisplayRun, query: string, ranges: Range[]): void {
	for (const match of findSessionTextMatches(run.text, query)) {
		const start = run.characters[match.start]!.start;
		const end = run.characters[match.end - 1]!.end;
		const native = doc.createRange?.();
		const range = typeof native?.setStart === "function" ? native : (new StaticRangeLike() as unknown as Range);
		range.setStart(start.node, start.offset);
		range.setEnd(end.node, end.offset);
		ranges.push(range);
	}
}

export function sessionFindRanges(scope: HTMLElement, query: string): Range[] {
	if (!query) return [];
	const roots = [
		...(scope.matches("[data-session-find-root]") ? [scope] : []),
		...scope.querySelectorAll<HTMLElement>("[data-session-find-root]"),
	];
	const ranges: Range[] = [];
	for (const root of roots) {
		if (roots.some((other) => other !== root && other.contains(root)) || !displayedRoot(root)) continue;
		for (const run of displayRuns(root)) collectRunRanges(scope.ownerDocument, run, query, ranges);
	}
	return ranges;
}

export interface SessionRangeIdentity {
	start: Node;
	startOffset: number;
	end: Node;
	endOffset: number;
}

export function sessionRangeIdentity(range: Range): SessionRangeIdentity {
	return { start: range.startContainer, startOffset: range.startOffset, end: range.endContainer, endOffset: range.endOffset };
}

export function sameSessionRange(range: Range, identity: SessionRangeIdentity | null): boolean {
	return Boolean(
		identity &&
		range.startContainer === identity.start &&
		range.startOffset === identity.startOffset &&
		range.endContainer === identity.end &&
		range.endOffset === identity.endOffset,
	);
}
