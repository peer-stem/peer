import type { Element, ElementContent, Root, RootContent, Text } from "hast";

export const NOBREAK_CLASS = "lh-nobreak";

const LEADING = /^\p{P}+/u;
const TRAILING = /\p{P}+$/u;
const WRAPPERS = new Set(["a", "strong", "em", "b", "i", "del", "s"]);

function isInlineCode(node: RootContent | ElementContent | undefined): node is Element {
	if (node?.type !== "element") return false;
	if (node.tagName === "code") return true;
	return WRAPPERS.has(node.tagName) && node.children.length === 1 && isInlineCode(node.children[0]);
}

function consumeLeadingPunctuation(out: ElementContent[], group: ElementContent[]): void {
	const prev = out.at(-1);
	if (prev?.type !== "text") return;
	const lead = TRAILING.exec(prev.value)?.[0];
	if (!lead) return;
	prev.value = prev.value.slice(0, -lead.length);
	if (!prev.value) out.pop();
	group.push({ type: "text", value: lead } satisfies Text);
}

function consumeTrailingPunctuation(children: ElementContent[], startIndex: number, group: ElementContent[]): number {
	let i = startIndex;
	while (i + 1 < children.length) {
		const next = children[i + 1]!;
		if (next.type !== "text") break;
		const tail = LEADING.exec(next.value)?.[0];
		if (!tail) break;
		if (tail.length === next.value.length && isInlineCode(children[i + 2])) {
			group.push(next, children[i + 2]!);
			i += 2;
			continue;
		}
		group.push({ type: "text", value: tail });
		next.value = next.value.slice(tail.length);
		if (!next.value) i++;
		break;
	}
	return i;
}

function glueChildren(parent: Root | Element): void {
	const children = parent.children as ElementContent[];
	const out: ElementContent[] = [];
	for (let i = 0; i < children.length; i++) {
		const node = children[i]!;
		if (!isInlineCode(node)) {
			out.push(node);
			continue;
		}
		const group: ElementContent[] = [];
		consumeLeadingPunctuation(out, group);
		group.push(node);
		i = consumeTrailingPunctuation(children, i, group);
		if (group.length === 1) out.push(node);
		else out.push({ type: "element", tagName: "span", properties: { className: [NOBREAK_CLASS] }, children: group });
	}
	parent.children = out;
}

function isGlue(node: Element): boolean {
	const cls = node.properties?.className;
	return Array.isArray(cls) && cls.includes(NOBREAK_CLASS);
}

function walk(node: Root | Element): void {
	if (node.type === "element" && (node.tagName === "pre" || node.tagName === "code" || isGlue(node))) return;
	glueChildren(node);
	for (const child of node.children) {
		if (child.type === "element") walk(child);
	}
}

export function rehypeGluePunctuation() {
	return (tree: Root) => walk(tree);
}
