import { createMathPlugin } from "@streamdown/math";
import type { Element, Root } from "hast";
import type { Plugin, Transformer } from "unified";

const math = createMathPlugin({ singleDollarTextMath: true });
type KatexOptions = { output?: "html"; errorColor?: string };
type File = Parameters<Transformer<Root>>[1];
type RenderKatex = (this: ThisParameterType<Plugin>, options: KatexOptions) => (tree: Root, file: File) => void;
const [renderKatex, options] = math.rehypePlugin as [RenderKatex, KatexOptions];

function hasClass(node: Element, name: string): boolean {
	const classes = node.properties.className;
	return Array.isArray(classes) && classes.includes(name);
}

interface MathSourceEntry {
	parent: Root | Element;
	index: number;
	tex: string;
}

function collectMathSources(parent: Root | Element, sources: MathSourceEntry[]): void {
	parent.children.forEach((node, index) => {
		if (node.type !== "element") return;
		const token = node.tagName === "pre"
			? node.children.find((c): c is Element => c.type === "element" && c.tagName === "code" && hasClass(c, "language-math"))
			: node;
		if (token && (hasClass(token, "language-math") || hasClass(token, "math-inline") || hasClass(token, "math-display"))) {
			const tex = token.children.map((child) => (child.type === "text" ? child.value : "")).join("");
			sources.push({ parent, index, tex });
		} else {
			collectMathSources(node, sources);
		}
	});
}

function stampFormulaTex(sources: readonly MathSourceEntry[]): void {
	for (const { parent, index, tex } of sources) {
		const result = parent.children[index];
		if (result?.type !== "element") continue;
		const formula = hasClass(result, "katex-display")
			? result.children.find((child): child is Element => child.type === "element" && hasClass(child, "katex"))
			: result;
		if (formula && hasClass(formula, "katex")) formula.properties.dataTex = tex;
	}
}

const htmlWithSource: Plugin<[], Root> = function () {
	const render = renderKatex.call(this, { ...options, output: "html" });
	return (tree, file) => {
		const sources: MathSourceEntry[] = [];
		collectMathSources(tree, sources);
		render(tree, file);
		stampFormulaTex(sources);
	};
};

export const transcriptMath = { ...math, rehypePlugin: htmlWithSource };
