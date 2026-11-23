/**
 * Browser bundle entry for Shiki syntax highlighting (`C-04`, `C-12`).
 * Framework-free direct Shiki adapter consumed via import map by `src/client/blocks/`.
 */

import {
	bundledLanguages,
	bundledLanguagesInfo,
	createHighlighter,
	type BundledLanguage,
	type BundledTheme,
	type HighlighterGeneric,
	type ThemeRegistrationAny,
	type TokensResult,
} from "shiki";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";

export type ThemeInput = BundledTheme | ThemeRegistrationAny;
export type HighlightResult = TokensResult;

export interface HighlightOptions {
	code: string;
	language: string;
	themes: [ThemeInput, ThemeInput];
}

export interface CodeHighlighterPlugin {
	readonly name: "shiki";
	readonly type: "code-highlighter";
	getSupportedLanguages(): BundledLanguage[];
	getThemes(): [ThemeInput, ThemeInput];
	supportsLanguage(language: string): boolean;
	highlight(options: HighlightOptions, callback?: (result: HighlightResult) => void): HighlightResult | null;
}

const REGEX_ENGINE = createJavaScriptRegexEngine({ forgiving: true });
const ALIAS_MAP: Readonly<Record<string, string>> = Object.fromEntries(
	bundledLanguagesInfo.flatMap((info) => (info.aliases ?? []).map((alias) => [alias, info.id])),
);
const BUNDLED_IDS = new Set<string>(Object.keys(bundledLanguages));
const highlighters = new Map<string, Promise<HighlighterGeneric<BundledLanguage, BundledTheme>>>();
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
		pending = createHighlighter({ themes, langs: [lang as BundledLanguage], engine: REGEX_ENGINE });
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
			const loaded = hl.getLoadedLanguages().includes(lang as BundledLanguage) ? lang : "text";
			const tokens = hl.codeToTokens(src, {
				lang: loaded as BundledLanguage,
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
		getSupportedLanguages: () => Array.from(BUNDLED_IDS) as BundledLanguage[],
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
