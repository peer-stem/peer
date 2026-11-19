import assert from "node:assert/strict";
import test from "node:test";

await import("./helpers/client-env.ts");
const { installDom } = await import("./helpers/client-dom.ts");

interface MarkdownUpdateModel {
	source?: string;
	streaming?: boolean;
	mode?: "dark" | "light";
	displayOnly?: boolean;
}

interface MarkdownHandle {
	update(model?: MarkdownUpdateModel): void;
	destroy(): void;
}

interface PluginCodeBlockProps {
	language: string;
	source: string;
	meta: string;
	incomplete: boolean;
	signal: AbortSignal;
}

interface PluginCodeBlockRenderer {
	language: string;
	mount(container: HTMLElement, block: PluginCodeBlockProps): void | (() => void) | Promise<void | (() => void)>;
}

interface BlockRegistry {
	register(renderer: PluginCodeBlockRenderer): () => void;
	unregister(language: string): boolean;
	fenceFor(language: string): PluginCodeBlockRenderer | null;
	has(language: string): boolean;
	dispose(): void;
}

interface MarkdownModule {
	createMarkdown(
		host: Element,
		options?: {
			fenceFor?: (language: string) => PluginCodeBlockRenderer | null;
			onCopy?: (text: string) => void;
			onExpand?: (payload: unknown) => void;
			mermaidPlugin?: { getMermaid: (cfg: unknown) => { render: (id: string, chart: string) => Promise<{ svg: string }> } };
		},
	): MarkdownHandle;
}

interface RegistryModule {
	BUILTIN_MERMAID_LANGUAGE: string;
	createBlockRegistry(initial?: PluginCodeBlockRenderer[]): BlockRegistry;
}

interface CopyCornerModule {
	tableToMarkdown(tableEl: Element | null): string;
}

interface MermaidModule {
	mermaidConfig(mode?: "dark" | "light"): {
		fontFamily: string;
		fontSize: number;
		securityLevel: string;
		theme: string;
		startOnLoad: boolean;
	};
}

function loadMod<T>(relPath: string): Promise<T> {
	return import(new URL(relPath, import.meta.url).href) as Promise<T>;
}

async function waitForCondition(predicate: () => boolean, timeoutMs = 2500): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 15));
	}
}

test("prose, formatting, safe vs javascript links, and literal raw HTML", async () => {
	const dom = installDom();
	try {
		const { createMarkdown } = await loadMod<MarkdownModule>("../src/client/blocks/markdown.js");
		const host = dom.document.createElement("div");
		dom.document.body.append(host);
		const md = createMarkdown(host);
		md.update({
			source: [
				"# Heading One",
				"",
				"- alpha",
				"- beta",
				"",
				"Paragraph with **strong**, *emphasis*, `code()`, [Docs](https://example.com/docs), and [Trap](javascript:alert(1)).",
				"",
				"<script>evil()</script><img src=\"https://evil.example/x\" onerror=\"evil()\">",
			].join("\n"),
		});
		assert.equal(host.querySelector("h1")?.textContent, "Heading One");
		assert.equal(host.querySelectorAll("ul li").length, 2);
		assert.equal(host.querySelector("strong")?.textContent, "strong");
		assert.equal(host.querySelector("em")?.textContent, "emphasis");
		assert.equal(host.querySelector("code")?.textContent, "code()");
		const anchors = [...host.querySelectorAll("a")];
		assert.equal(anchors.some((a) => a.getAttribute("href")?.startsWith("javascript:")), false);
		assert.equal(anchors[0]?.getAttribute("href"), "https://example.com/docs");
		assert.equal(anchors[0]?.getAttribute("target"), "_blank");
		assert.equal(host.querySelectorAll("script").length, 0);
		assert.equal(host.querySelectorAll("img").length, 0);
		assert.equal(host.textContent?.includes("<script>evil()</script>"), true);
		md.destroy();
	} finally {
		await dom.cleanup();
	}
});

test("math pre-pass renders inline and display KaTeX and honors displayOnly", async () => {
	const dom = installDom();
	try {
		const { createMarkdown } = await loadMod<MarkdownModule>("../src/client/blocks/markdown.js");
		const host = dom.document.createElement("div");
		dom.document.body.append(host);
		const copied: string[] = [];
		const md = createMarkdown(host, { onCopy: (text) => copied.push(text) });
		const source = [
			"Inline \\(a^2 + b^2 = c^2\\) and $e^{i\\pi} + 1 = 0$ plus $\theta$.",
			"",
			"\\[x + y = z\\]",
			"",
			"$$\\sum_{k=1}^{n} k$$",
		].join("\n");
		md.update({ source, displayOnly: false });
		assert.equal(host.querySelectorAll(".katex").length, 5);
		assert.equal(host.querySelectorAll(".katex-display").length, 2);
		assert.equal(host.querySelectorAll(".katex-error").length, 0);
		const copyBtns = host.querySelectorAll('[data-testid="md-math"] [data-testid="md-copy"]');
		assert.equal(copyBtns.length, 2);
		(copyBtns[0] as HTMLElement).click();
		assert.equal(copied[0], "x + y = z");
		md.update({ source, displayOnly: true });
		assert.equal(host.querySelectorAll('[data-testid="md-math"] [data-testid="md-copy"]').length, 0);
		md.destroy();
	} finally {
		await dom.cleanup();
	}
});

test("fenced code blocks support Shiki highlighting, startLine=5, and noLineNumbers", async () => {
	const dom = installDom();
	try {
		const { createMarkdown } = await loadMod<MarkdownModule>("../src/client/blocks/markdown.js");
		const host = dom.document.createElement("div");
		dom.document.body.append(host);
		const md = createMarkdown(host);
		md.update({
			source: [
				"```ts startLine=5",
				"const value: number = 42;",
				"export default value;",
				"```",
				"",
				"```js noLineNumbers",
				"const bare = true;",
				"```",
			].join("\n"),
			mode: "dark",
		});
		const codeBlocks = host.querySelectorAll('[data-testid="md-code"]');
		assert.equal(codeBlocks.length, 2);
		const numberedLines = codeBlocks[0]?.querySelectorAll(".peer-blocks-code-line") ?? [];
		assert.equal(numberedLines[0]?.getAttribute("data-peer-line"), "5");
		assert.equal(numberedLines[1]?.getAttribute("data-peer-line"), "6");
		assert.equal(codeBlocks[1]?.getAttribute("data-peer-line-numbers"), "false");
		assert.equal(codeBlocks[1]?.querySelectorAll(".peer-blocks-code-line[data-peer-line]").length, 0);
		await waitForCondition(() => {
			const spans = Array.from(codeBlocks[0]?.querySelectorAll(".peer-blocks-code-token") ?? []);
			return spans.some((node) => Boolean((node as HTMLElement).style.getPropertyValue("--shiki-dark")));
		});
		const coloredCount = Array.from(codeBlocks[0]?.querySelectorAll(".peer-blocks-code-token") ?? [])
			.filter((node) => Boolean((node as HTMLElement).style.color)).length;
		assert.equal(coloredCount > 0, true);
		md.destroy();
	} finally {
		await dom.cleanup();
	}
});

test("GFM pipe tables and GitHub [!IMPORTANT] / [!WARNING] callouts", async () => {
	const dom = installDom();
	try {
		const { createMarkdown } = await loadMod<MarkdownModule>("../src/client/blocks/markdown.js");
		const { tableToMarkdown } = await loadMod<CopyCornerModule>("../src/client/blocks/copy-corner.js");
		const host = dom.document.createElement("div");
		dom.document.body.append(host);
		const copied: string[] = [];
		const md = createMarkdown(host, { onCopy: (text) => copied.push(text) });
		md.update({
			source: [
				"| Quantity | Expression |",
				"| :--- | :---: |",
				"| Force | $F = ma$ |",
				"",
				"> [!IMPORTANT]",
				"> Preserve conservation of momentum.",
				"",
				"> [!WARNING] Check singular matrices first.",
			].join("\n"),
		});
		assert.equal(host.querySelectorAll('[data-testid="md-table"] th[scope="col"]').length, 2);
		assert.equal(host.querySelectorAll('[data-testid="md-table"] td').length, 2);
		assert.equal(host.querySelectorAll('[data-testid="md-table"] td .katex').length, 1);
		const tableEl = host.querySelector('[data-testid="md-table"] table');
		const serialized = tableToMarkdown(tableEl);
		assert.equal(serialized.includes("| Quantity | Expression |"), true);
		(host.querySelector('[data-testid="md-table"] [data-testid="md-copy"]') as HTMLElement).click();
		assert.equal(copied[0], serialized);
		const important = host.querySelector('[data-testid="md-callout"][data-alert-kind="important"]');
		assert.equal(important?.textContent?.includes("Preserve conservation of momentum."), true);
		assert.equal(important?.textContent?.includes("[!IMPORTANT]"), false);
		const warning = host.querySelector('[data-testid="md-callout"][data-alert-kind="warning"]');
		assert.equal(warning?.textContent?.includes("Check singular matrices first."), true);
		assert.equal(warning?.textContent?.includes("[!WARNING]"), false);
		md.destroy();
	} finally {
		await dom.cleanup();
	}
});

test("Markdown images render as [Image blocked: alt] badges with zero img or anchor nodes", async () => {
	const dom = installDom();
	try {
		const { createMarkdown } = await loadMod<MarkdownModule>("../src/client/blocks/markdown.js");
		const host = dom.document.createElement("div");
		dom.document.body.append(host);
		const md = createMarkdown(host);
		md.update({
			source: "Observe ![Diagram](https://evil.example/a.png) and ![](https://evil.example/b.png) inline.",
		});
		assert.equal(host.querySelectorAll("img").length, 0);
		assert.equal(host.querySelectorAll("a").length, 0);
		const badges = host.querySelectorAll("[data-peer-blocked-image]");
		assert.equal(badges.length, 2);
		assert.equal(badges[0]?.textContent, "[Image blocked: Diagram]");
		assert.equal(badges[1]?.textContent, "[Image blocked]");
		md.destroy();
	} finally {
		await dom.cleanup();
	}
});

function makeQuizRenderer(stats: { mounts: number; aborts: number }): PluginCodeBlockRenderer {
	return {
		language: "quiz-dsl",
		mount(container, block) {
			stats.mounts += 1;
			const badge = container.ownerDocument.createElement("div");
			badge.setAttribute("data-custom-quiz", block.source);
			container.append(badge);
			block.signal.addEventListener("abort", () => { stats.aborts += 1; }, { once: true });
		},
	};
}

function makeFakeMermaidPlugin(stats: { renders: number }) {
	const render = async (_id: string, chart: string) => {
		stats.renders += 1;
		if (chart.includes("BROKEN")) throw new Error("Lexical error");
		return { svg: '<svg viewBox="0 0 20 20" onload="evil()"><script>evil()</script><rect width="10" height="10"></rect></svg>' };
	};
	return { getMermaid: () => ({ render }) };
}

test("block registry reserves mermaid, mounts custom plugins, bypasses in displayOnly, and falls back on throw", async () => {
	const dom = installDom();
	try {
		const { createMarkdown } = await loadMod<MarkdownModule>("../src/client/blocks/markdown.js");
		const { createBlockRegistry } = await loadMod<RegistryModule>("../src/client/blocks/registry.js");
		const registry = createBlockRegistry();
		let hijacked = 0;
		registry.register({ language: "mermaid", mount: () => { hijacked += 1; } });
		assert.equal(registry.has("mermaid"), true);
		assert.equal(registry.unregister("mermaid"), false);
		const stats = { mounts: 0, aborts: 0 };
		registry.register(makeQuizRenderer(stats));
		registry.register({ language: "broken-dsl", mount: () => { throw new Error("plugin mount failed"); } });
		const host = dom.document.createElement("div");
		dom.document.body.append(host);
		const md = createMarkdown(host, { fenceFor: (lang) => registry.fenceFor(lang) });
		md.update({ source: "```quiz-dsl\nQ1\n```\n\n```broken-dsl\nfallback line\n```", displayOnly: false });
		assert.equal(hijacked, 0);
		assert.equal(stats.mounts, 1);
		assert.equal(host.querySelector("[data-custom-quiz]")?.getAttribute("data-custom-quiz"), "Q1");
		assert.equal(host.querySelector('[data-testid="md-code"]')?.textContent?.includes("fallback line"), true);
		md.update({ source: "```quiz-dsl\nQ1\n```\n\n```broken-dsl\nfallback line\n```\n\nStreaming tail...", streaming: true, displayOnly: false });
		assert.equal(stats.mounts, 1);
		assert.equal(stats.aborts, 0);
		md.update({ source: "```quiz-dsl\nQ1\n```", displayOnly: true });
		assert.equal(stats.aborts, 1);
		assert.equal(host.querySelectorAll("[data-custom-quiz]").length, 0);
		assert.equal(host.querySelector('[data-testid="md-code"]')?.textContent?.includes("Q1"), true);
		md.destroy();
	} finally {
		await dom.cleanup();
	}
});

test("streaming unclosed mermaid waits until fence closes, sanitizes SVG, and shows error fallback", async () => {
	const dom = installDom();
	try {
		const { createMarkdown } = await loadMod<MarkdownModule>("../src/client/blocks/markdown.js");
		const { mermaidConfig } = await loadMod<MermaidModule>("../src/client/blocks/mermaid.js");
		assert.equal(mermaidConfig("dark").securityLevel, "strict");
		assert.equal(mermaidConfig("light").theme, "default");
		const stats = { renders: 0 };
		const host = dom.document.createElement("div");
		dom.document.body.append(host);
		const md = createMarkdown(host, { mermaidPlugin: makeFakeMermaidPlugin(stats) });
		md.update({ source: "```mermaid\ngraph TD\nA --> B", streaming: true });
		assert.equal(stats.renders, 0);
		assert.equal(host.querySelector('[data-testid="md-mermaid"]')?.getAttribute("aria-busy"), "true");
		md.update({ source: "```mermaid\ngraph TD\nA --> B\n```", streaming: false });
		await waitForCondition(() => host.querySelector('[data-testid="md-mermaid"] svg') !== null);
		assert.equal(stats.renders, 1);
		assert.equal(host.querySelectorAll("script").length, 0);
		assert.equal(host.querySelector('[data-testid="md-mermaid"] svg')?.hasAttribute("onload"), false);
		md.update({ source: "```mermaid\nBROKEN\n```", streaming: false });
		await waitForCondition(() => host.querySelector('[data-streamdown="mermaid-error"]') !== null);
		assert.equal(host.querySelector('[data-streamdown="mermaid-error"]')?.textContent?.includes("Diagram failed to render"), true);
		assert.equal(host.querySelector('[data-streamdown="mermaid-error"] pre')?.textContent, "BROKEN");
		md.destroy();
	} finally {
		await dom.cleanup();
	}
});

test("destroy tears down host cleanly, is idempotent, and deduplicates injected styles", async () => {
	const dom = installDom();
	try {
		const { createMarkdown } = await loadMod<MarkdownModule>("../src/client/blocks/markdown.js");
		const hostA = dom.document.createElement("div");
		const hostB = dom.document.createElement("div");
		dom.document.body.append(hostA, hostB);
		const mdA = createMarkdown(hostA);
		const mdB = createMarkdown(hostB);
		mdA.update({ source: "# Title\n\n$$x = 1$$\n\n```js\nconst y = 2;\n```" });
		mdB.update({ source: "Second view" });
		assert.equal(dom.document.querySelectorAll("#peer-blocks-styles").length, 1);
		assert.equal(hostA.childElementCount, 1);
		mdA.destroy();
		assert.equal(hostA.childElementCount, 0);
		mdA.destroy();
		assert.equal(hostA.childElementCount, 0);
		mdA.update({ source: "Ignored after destroy" });
		assert.equal(hostA.childElementCount, 0);
		mdB.destroy();
		assert.equal(hostB.childElementCount, 0);
	} finally {
		await dom.cleanup();
	}
});
