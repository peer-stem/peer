/**
 * Browser bundle entry for Shiki syntax highlighting (`C-04`, `C-12`).
 * Curated web + STEM/systems language bundle on `shiki/core` + JS RegExp engine,
 * keeping chunk count minimal while preserving lazy grammar loading and `text` fallback.
 */

import {
	createBundledHighlighter,
	type HighlighterGeneric,
	type LanguageInput,
	type ThemeInput as CoreThemeInput,
	type ThemeRegistrationAny,
	type TokensResult,
} from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";

const CURATED_LANGS = {
	asm: () => import("shiki/langs/asm.mjs"),
	bash: () => import("shiki/langs/bash.mjs"),
	c: () => import("shiki/langs/c.mjs"),
	cpp: () => import("shiki/langs/cpp.mjs"),
	csharp: () => import("shiki/langs/csharp.mjs"),
	css: () => import("shiki/langs/css.mjs"),
	csv: () => import("shiki/langs/csv.mjs"),
	diff: () => import("shiki/langs/diff.mjs"),
	dockerfile: () => import("shiki/langs/dockerfile.mjs"),
	glsl: () => import("shiki/langs/glsl.mjs"),
	go: () => import("shiki/langs/go.mjs"),
	graphql: () => import("shiki/langs/graphql.mjs"),
	haskell: () => import("shiki/langs/haskell.mjs"),
	html: () => import("shiki/langs/html.mjs"),
	java: () => import("shiki/langs/java.mjs"),
	javascript: () => import("shiki/langs/javascript.mjs"),
	json: () => import("shiki/langs/json.mjs"),
	jsonc: () => import("shiki/langs/jsonc.mjs"),
	jsx: () => import("shiki/langs/jsx.mjs"),
	julia: () => import("shiki/langs/julia.mjs"),
	kotlin: () => import("shiki/langs/kotlin.mjs"),
	latex: () => import("shiki/langs/latex.mjs"),
	lean4: () => import("shiki/langs/lean4.mjs"),
	makefile: () => import("shiki/langs/makefile.mjs"),
	markdown: () => import("shiki/langs/markdown.mjs"),
	matlab: () => import("shiki/langs/matlab.mjs"),
	mdx: () => import("shiki/langs/mdx.mjs"),
	ocaml: () => import("shiki/langs/ocaml.mjs"),
	php: () => import("shiki/langs/php.mjs"),
	powershell: () => import("shiki/langs/powershell.mjs"),
	python: () => import("shiki/langs/python.mjs"),
	r: () => import("shiki/langs/r.mjs"),
	regex: () => import("shiki/langs/regex.mjs"),
	ruby: () => import("shiki/langs/ruby.mjs"),
	rust: () => import("shiki/langs/rust.mjs"),
	shellscript: () => import("shiki/langs/shellscript.mjs"),
	sql: () => import("shiki/langs/sql.mjs"),
	swift: () => import("shiki/langs/swift.mjs"),
	tex: () => import("shiki/langs/tex.mjs"),
	toml: () => import("shiki/langs/toml.mjs"),
	tsx: () => import("shiki/langs/tsx.mjs"),
	typescript: () => import("shiki/langs/typescript.mjs"),
	verilog: () => import("shiki/langs/verilog.mjs"),
	vhdl: () => import("shiki/langs/vhdl.mjs"),
	wasm: () => import("shiki/langs/wasm.mjs"),
	wgsl: () => import("shiki/langs/wgsl.mjs"),
	xml: () => import("shiki/langs/xml.mjs"),
	yaml: () => import("shiki/langs/yaml.mjs"),
	zig: () => import("shiki/langs/zig.mjs"),
} as const satisfies Record<string, LanguageInput>;

const CURATED_THEMES = {
	"github-dark": () => import("shiki/themes/github-dark.mjs"),
	"github-light": () => import("shiki/themes/github-light.mjs"),
} as const satisfies Record<string, CoreThemeInput>;

export type CuratedLanguage = keyof typeof CURATED_LANGS;
export type CuratedTheme = keyof typeof CURATED_THEMES;
export type ThemeInput = CuratedTheme | ThemeRegistrationAny;
export type HighlightResult = TokensResult;

export interface HighlightOptions {
	code: string;
	language: string;
	themes: [ThemeInput, ThemeInput];
}

export interface CodeHighlighterPlugin {
	readonly name: "shiki";
	readonly type: "code-highlighter";
	getSupportedLanguages(): CuratedLanguage[];
	getThemes(): [ThemeInput, ThemeInput];
	supportsLanguage(language: string): boolean;
	highlight(options: HighlightOptions, callback?: (result: HighlightResult) => void): HighlightResult | null;
}

const ALIAS_MAP: Readonly<Record<string, CuratedLanguage>> = {
	"c++": "cpp",
	"c#": "csharp",
	cs: "csharp",
	docker: "dockerfile",
	gql: "graphql",
	hs: "haskell",
	jl: "julia",
	js: "javascript",
	kt: "kotlin",
	lean: "lean4",
	make: "makefile",
	md: "markdown",
	ml: "ocaml",
	mjs: "javascript",
	cjs: "javascript",
	mts: "typescript",
	cts: "typescript",
	ps1: "powershell",
	py: "python",
	rb: "ruby",
	rs: "rust",
	sh: "bash",
	shell: "shellscript",
	sv: "verilog",
	ts: "typescript",
	wat: "wasm",
	yml: "yaml",
	zsh: "bash",
};

const createCuratedHighlighter = createBundledHighlighter<CuratedLanguage, CuratedTheme>({
	langs: CURATED_LANGS,
	themes: CURATED_THEMES,
	engine: () => createJavaScriptRegexEngine({ forgiving: true }),
});

const BUNDLED_IDS = new Set<string>(Object.keys(CURATED_LANGS));
const highlighters = new Map<string, Promise<HighlighterGeneric<CuratedLanguage, CuratedTheme>>>();
const tokenCache = new Map<string, HighlightResult>();
const waiters = new Map<string, Set<(result: HighlightResult) => void>>();

function resolveLanguageId(raw: string): string {
	const clean = raw.trim().toLowerCase();
	return ALIAS_MAP[clean] ?? clean;
}

function themeKey(theme: ThemeInput): string {
	return typeof theme === "string" ? theme : (theme.name ?? "custom");
}

function cacheKey(src: string, lang: string, light: string, dark: string): string {
	const head = src.slice(0, 100);
	const tail = src.length > 100 ? src.slice(-100) : "";
	return `${lang}:${light}:${dark}:${src.length}:${head}:${tail}`;
}

function loadHighlighter(lang: string, themes: [ThemeInput, ThemeInput]) {
	const key = `${lang}-${themeKey(themes[0])}-${themeKey(themes[1])}`;
	let pending = highlighters.get(key);
	if (!pending) {
		const langs = BUNDLED_IDS.has(lang) ? [lang as CuratedLanguage] : [];
		pending = createCuratedHighlighter({ themes, langs });
		highlighters.set(key, pending);
	}
	return pending;
}

function runAsyncHighlight(
	key: string,
	src: string,
	lang: string,
	themes: [ThemeInput, ThemeInput],
	lightName: string,
	darkName: string,
): void {
	const targetLang = BUNDLED_IDS.has(lang) ? lang : "text";
	void loadHighlighter(targetLang, themes)
		.then((hl) => {
			const loaded = hl.getLoadedLanguages().includes(lang as CuratedLanguage) ? lang : "text";
			const tokens = hl.codeToTokens(src, {
				lang: loaded as CuratedLanguage,
				themes: { light: lightName, dark: darkName },
			});
			tokenCache.set(key, tokens);
			const listeners = waiters.get(key);
			if (!listeners) return;
			waiters.delete(key);
			for (const cb of listeners) cb(tokens);
		})
		.catch(() => {
			waiters.delete(key);
		});
}

function enqueueHighlightWaiter(key: string, callback?: (result: TokensResult) => void): void {
	if (!callback) return;
	let set = waiters.get(key);
	if (!set) {
		set = new Set();
		waiters.set(key, set);
	}
	set.add(callback);
}

export function createCodePlugin(options?: { themes?: [ThemeInput, ThemeInput] }): CodeHighlighterPlugin {
	const defaultThemes: [ThemeInput, ThemeInput] = options?.themes ?? ["github-light", "github-dark"];
	return {
		name: "shiki",
		type: "code-highlighter",
		supportsLanguage: (lang) => BUNDLED_IDS.has(resolveLanguageId(lang)),
		getSupportedLanguages: () => Array.from(BUNDLED_IDS) as CuratedLanguage[],
		getThemes: () => defaultThemes,
		highlight({ code: src, language, themes }, callback) {
			const lang = resolveLanguageId(language);
			const lightName = themeKey(themes[0]);
			const darkName = themeKey(themes[1]);
			const key = cacheKey(src, lang, lightName, darkName);
			const hit = tokenCache.get(key);
			if (hit) return hit;
			enqueueHighlightWaiter(key, callback);
			runAsyncHighlight(key, src, lang, themes, lightName, darkName);
			return null;
		},
	};
}

export const code: CodeHighlighterPlugin = createCodePlugin();
