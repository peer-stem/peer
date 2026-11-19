/**
 * Unit tests for Sprint C1 Track T:
 * - `src/client/types/cloudcanvas.d.ts`
 * - `src/client/theme/tokens.ts` (`buildThemeTokens`, `contrastRatio`)
 * - `src/client/theme/apply.js` (`applyThemeTokens`, `PEER_TOKEN_PREFIX`)
 * - `public/client/peer.css` (`:root` Default parity, `C-06` focus-visible, `C-13` local fonts)
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { FACTORY_SETTINGS } from "../src/core/settings.ts";
import type { EffectiveAppearance } from "../src/core/settings-resolution.ts";
import { BUILTIN_THEMES, DEFAULT_THEME, shiftHex } from "../src/core/themes.ts";

const clientEnv: object = await import("./helpers/client-env.ts");
if ("installClientResolve" in clientEnv) {
	const install = clientEnv.installClientResolve;
	if (typeof install === "function") await (install as () => unknown)();
}

const { buildThemeTokens, contrastRatio } = await import("../src/client/theme/tokens.ts");
const { applyThemeTokens, PEER_TOKEN_PREFIX } = await import("../src/client/theme/apply.js");
const { LIGHT_THEME, TOKEN_PREFIX } = await import("cloudcanvas/theme");
const { isToken } = await import("cloudcanvas/tokens");
const { LIB_LIGHT_THEME, LIB_TOKENS } = await import("cloudcanvas-lib");
const { UI_TOKENS } = await import("cloudcanvas-lib/ui");

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INTERIM_INK_TOKENS = new Set(["--cc-ink-strong", "--cc-ink-em", "--cc-ink-code"]);

function isCataloguedCcToken(name: string): boolean {
	if (isToken(name)) return true;
	if (Object.prototype.hasOwnProperty.call(LIB_TOKENS, name)) return true;
	if (Object.prototype.hasOwnProperty.call(UI_TOKENS, name)) return true;
	return INTERIM_INK_TOKENS.has(name);
}

function makeAppearance(overrides: Partial<EffectiveAppearance> = {}): EffectiveAppearance {
	return {
		...FACTORY_SETTINGS.appearance,
		...overrides,
		mdRendering: {
			...FACTORY_SETTINGS.appearance.mdRendering,
			...overrides.mdRendering,
		},
	};
}

function createMockStyle() {
	const props = new Map<string, string>();
	return {
		colorScheme: "",
		get length(): number {
			return props.size;
		},
		item(index: number): string {
			return [...props.keys()][index] ?? "";
		},
		setProperty(name: string, value: string): void {
			props.set(name, String(value));
		},
		removeProperty(name: string): string {
			const prev = props.get(name) ?? "";
			props.delete(name);
			return prev;
		},
		getPropertyValue(name: string): string {
			return props.get(name) ?? "";
		},
	};
}

function createMockClassList(initial: readonly string[]) {
	const classes = new Set<string>(initial);
	return {
		toggle(token: string, force?: boolean): boolean {
			const shouldAdd = force === undefined ? !classes.has(token) : force;
			if (shouldAdd) classes.add(token);
			else classes.delete(token);
			return shouldAdd;
		},
		contains(token: string): boolean {
			return classes.has(token);
		},
	};
}

function createMockRoot() {
	const attrs = new Map<string, string>([["data-theme-pending", ""]]);
	return {
		style: createMockStyle(),
		classList: createMockClassList(["dark"]),
		removeAttribute(name: string): void {
			attrs.delete(name);
		},
		hasAttribute(name: string): boolean {
			return attrs.has(name);
		},
	};
}

function parseRootCssVars(css: string): Map<string, string> {
	const start = css.indexOf(":root {");
	assert.equal(start >= 0, true, "missing :root block in peer.css");
	const body = css.slice(start, css.indexOf("}", start));
	const vars = new Map<string, string>();
	for (const match of body.matchAll(/(--[\w-]+):\s*([^;]+);/g)) {
		vars.set(match[1] ?? "", (match[2] ?? "").trim());
	}
	return vars;
}

test("buildThemeTokens maps every built-in dark and light preset accurately", () => {
	assert.equal(BUILTIN_THEMES.length, 11);
	for (const theme of BUILTIN_THEMES) {
		const tokens = buildThemeTokens(theme);
		assert.equal(tokens.mode, theme.mode, theme.id);
		assert.equal(tokens.cc["--cc-bg"], theme.colors.background, theme.id);
		assert.equal(tokens.cc["--cc-text"], theme.colors.text, theme.id);
		assert.equal(tokens.cc["--cc-text-muted"], theme.colors.textMuted, theme.id);
		assert.equal(tokens.cc["--cc-accent"], theme.colors.accent, theme.id);
		assert.equal(tokens.cc["--cc-focus-ring"], theme.colors.accent, theme.id);
		assert.equal(tokens.cc["--cc-card-bg"], theme.colors.surface, theme.id);
		assert.equal(tokens.cc["--cc-border"], theme.colors.border, theme.id);
		assert.equal(tokens.cc["--cc-ink-strong"], theme.colors.bold, theme.id);
		assert.equal(tokens.cc["--cc-ink-em"], theme.colors.italic, theme.id);
		assert.equal(tokens.cc["--cc-ink-code"], theme.colors.code, theme.id);
		assert.equal(tokens.cc["--cc-tone-danger"], theme.colors.error, theme.id);
		assert.equal(tokens.cc["--cc-tone-success"], theme.colors.success, theme.id);
		assert.equal(tokens.cc["--cc-tone-warning"], theme.colors.warning, theme.id);
		assert.equal(tokens.cc["--cc-tone-info"], theme.colors.accent, theme.id);
		assert.equal(tokens.peer["--peer-line-strong"], theme.colors.text, theme.id);
	}
});

test("every emitted token obeys CloudCanvas catalogue and prefix invariants", () => {
	const latte = BUILTIN_THEMES.find((t) => t.id === "catppuccin-latte") ?? DEFAULT_THEME;
	for (const theme of [DEFAULT_THEME, latte]) {
		const tokens = buildThemeTokens(theme);
		for (const key of Object.keys(tokens.cc)) {
			assert.equal(key.startsWith(TOKEN_PREFIX), true, key);
			assert.equal(isCataloguedCcToken(key), true, `uncatalogued token: ${key}`);
		}
		for (const key of Object.keys(tokens.peer)) {
			assert.equal(key.startsWith(PEER_TOKEN_PREFIX), true, key);
		}
	}
});

test("light mode spreads LIGHT_THEME and LIB_LIGHT_THEME while dark mode omits light-only keys", () => {
	const latte = BUILTIN_THEMES.find((t) => t.id === "catppuccin-latte");
	assert.notEqual(latte, undefined);
	const lightTokens = buildThemeTokens(latte);
	const darkTokens = buildThemeTokens(DEFAULT_THEME);
	for (const key of Object.keys(LIGHT_THEME)) {
		assert.equal(key in lightTokens.cc, true, `missing LIGHT_THEME key ${key}`);
	}
	for (const key of Object.keys(LIB_LIGHT_THEME)) {
		assert.equal(key in lightTokens.cc, true, `missing LIB_LIGHT_THEME key ${key}`);
	}
	assert.equal(lightTokens.cc["--cc-grid-dot"], LIGHT_THEME["--cc-grid-dot"]);
	assert.equal(lightTokens.cc["--cc-thumb-bg"], LIB_LIGHT_THEME["--cc-thumb-bg"]);
	assert.equal(lightTokens.cc["--cc-ui-backdrop"], "rgba(15, 23, 42, 0.35)");
	assert.equal(lightTokens.cc["--cc-ui-grid-line"], latte?.colors.border);
	assert.equal(darkTokens.cc["--cc-ui-backdrop"], "rgba(0, 0, 0, 0.6)");
	assert.equal(darkTokens.cc["--cc-grid-dot"], undefined);
	assert.equal(darkTokens.cc["--cc-thumb-bg"], undefined);
});

test("color overrides update surfaces, hover step, semantic tones, and emphasis inks", () => {
	const appearance = makeAppearance({
		background: "#101216",
		colors: {
			surface: "#20242c",
			border: "#3a404d",
			text: "#f0f4fc",
			textMuted: "#9aa4b8",
			accent: "#38bdf8",
			code: "#fbbf24",
			error: "#f43f5e",
			success: "#10b981",
			warning: "#f97316",
		},
		mdRendering: { headingWeight: 700, boldColor: "#c084fc", italicColor: "#f472b6" },
	});
	const tokens = buildThemeTokens(DEFAULT_THEME, appearance);
	const expectedHover = shiftHex("#20242c", 14);
	assert.equal(tokens.cc["--cc-bg"], "#101216");
	assert.equal(tokens.cc["--cc-card-bg"], "#20242c");
	assert.equal(tokens.cc["--cc-ui-surface"], "#20242c");
	assert.equal(tokens.cc["--cc-card-border-hover"], expectedHover);
	assert.equal(tokens.cc["--cc-ui-selected"], expectedHover);
	assert.equal(tokens.cc["--cc-btn-bg-hover"], expectedHover);
	assert.equal(tokens.cc["--cc-menu-item-bg-hover"], expectedHover);
	assert.equal(tokens.peer["--peer-hover"], expectedHover);
	assert.equal(tokens.cc["--cc-ink-strong"], "#c084fc");
	assert.equal(tokens.cc["--cc-ink-em"], "#f472b6");
	assert.equal(tokens.cc["--cc-ink-code"], "#fbbf24");
	assert.equal(tokens.cc["--cc-ui-drop"], "#38bdf8");
	assert.equal(tokens.cc["--cc-input-bg"], "#20242c");
	assert.equal(tokens.cc["--cc-input-border"], "#3a404d");
});

test("onAccent maintains WCAG contrast across default, light-accent, and dark-accent palettes", () => {
	const defaultTokens = buildThemeTokens(DEFAULT_THEME);
	assert.equal(defaultTokens.cc["--cc-ui-on-accent"], "#141414");
	assert.equal(contrastRatio("#8d8d8d", defaultTokens.cc["--cc-ui-on-accent"] ?? "#000000") >= 4.5, true);

	const ivory = BUILTIN_THEMES.find((t) => t.id === "ivory") ?? DEFAULT_THEME;
	const ivoryTokens = buildThemeTokens(ivory);
	assert.equal(ivoryTokens.cc["--cc-ui-on-accent"], "#141414");
	assert.equal(contrastRatio(ivory.colors.accent, ivoryTokens.cc["--cc-ui-on-accent"] ?? "#000000") >= 4.5, true);

	const darkBlueAccent = buildThemeTokens(DEFAULT_THEME, makeAppearance({ colors: { accent: "#1d4ed8" } }));
	assert.equal(darkBlueAccent.cc["--cc-ui-on-accent"], "#ffffff");
	assert.equal(contrastRatio("#1d4ed8", darkBlueAccent.cc["--cc-ui-on-accent"] ?? "#000000") >= 4.5, true);
});

test("reading font, title serif, code ligatures, heading weight, and zoom map cleanly", () => {
	const defaults = buildThemeTokens(DEFAULT_THEME);
	assert.equal(defaults.peer["--peer-font-prose"], '"Source Sans 3", ui-sans-serif, system-ui, sans-serif');
	assert.equal(defaults.peer["--peer-font-title"], '"lh-cmu", ui-serif, Georgia, serif');
	assert.equal(defaults.peer["--peer-code-ligatures"], "none");
	assert.equal(defaults.peer["--peer-prose-size"], "16px");
	assert.equal(defaults.peer["--peer-prose-leading"], "1.5");
	assert.equal(defaults.peer["--peer-heading-weight"], "900");
	assert.equal(defaults.peer["--peer-zoom"], "1");

	const custom = buildThemeTokens(
		DEFAULT_THEME,
		makeAppearance({
			fontFamily: "IBM Plex Sans",
			proseFontSize: 19,
			codeLigatures: true,
			sessionNameSerif: false,
			mdRendering: { headingWeight: 600, boldColor: null, italicColor: null },
		}),
		1.25,
	);
	assert.equal(
		custom.peer["--peer-font-prose"],
		'"IBM Plex Sans", "Source Sans 3", ui-sans-serif, system-ui, sans-serif',
	);
	assert.equal(custom.peer["--peer-font-title"], "var(--peer-font-prose)");
	assert.equal(custom.peer["--peer-code-ligatures"], "normal");
	assert.equal(custom.peer["--peer-prose-size"], "19px");
	assert.equal(custom.peer["--peer-heading-weight"], "600");
	assert.equal(custom.peer["--peer-zoom"], "1.25");

	const monoReading = buildThemeTokens(DEFAULT_THEME, makeAppearance({ fontFamily: "JetBrains Mono" }), 0);
	assert.equal(
		monoReading.peer["--peer-font-prose"]?.startsWith('"JetBrains Mono", ui-monospace, monospace'),
		true,
	);
	assert.equal(monoReading.peer["--peer-zoom"], "1");
	assert.equal(buildThemeTokens(DEFAULT_THEME, FACTORY_SETTINGS.appearance, Number.NaN).peer["--peer-zoom"], "1");
});

test("applyThemeTokens switches light to dark cleanly, preserves unrelated styles, and clears FOUC flag", () => {
	assert.equal(applyThemeTokens(null, buildThemeTokens(DEFAULT_THEME)), null);

	const root = createMockRoot();
	root.style.setProperty("min-height", "100vh");
	root.style.setProperty("--peer-obsolete", "stale");

	const latte = BUILTIN_THEMES.find((t) => t.id === "catppuccin-latte") ?? DEFAULT_THEME;
	const appliedLight = applyThemeTokens(root, buildThemeTokens(latte));
	assert.equal(appliedLight, root);
	assert.equal(root.hasAttribute("data-theme-pending"), false);
	assert.equal(root.classList.contains("light"), true);
	assert.equal(root.classList.contains("dark"), false);
	assert.equal(root.style.colorScheme, "light");
	assert.equal(root.style.getPropertyValue("--cc-grid-dot"), LIGHT_THEME["--cc-grid-dot"]);
	assert.equal(root.style.getPropertyValue("--peer-obsolete"), "");
	assert.equal(root.style.getPropertyValue("min-height"), "100vh");

	applyThemeTokens(root, buildThemeTokens(DEFAULT_THEME));
	assert.equal(root.classList.contains("dark"), true);
	assert.equal(root.classList.contains("light"), false);
	assert.equal(root.style.colorScheme, "dark");
	assert.equal(root.style.getPropertyValue("--cc-grid-dot"), "");
	assert.equal(root.style.getPropertyValue("--cc-thumb-bg"), "");
	assert.equal(root.style.getPropertyValue("--cc-bg"), "#141414");
	assert.equal(root.style.getPropertyValue("--peer-hover"), "#2a2a2a");
	assert.equal(root.style.getPropertyValue("min-height"), "100vh");
});

test("public/client/peer.css matches Default tokens, preserves :focus-visible, and uses local fonts", () => {
	const cssPath = path.join(REPO_ROOT, "public", "client", "peer.css");
	const css = fs.readFileSync(cssPath, "utf8");
	const rootVars = parseRootCssVars(css);
	const defaultTokens = buildThemeTokens(DEFAULT_THEME);

	for (const [token, value] of Object.entries(defaultTokens.cc)) {
		assert.equal(rootVars.get(token), value, `peer.css :root mismatch for ${token}`);
	}
	for (const [token, value] of Object.entries(defaultTokens.peer)) {
		assert.equal(rootVars.get(token), value, `peer.css :root mismatch for ${token}`);
	}

	assert.equal(css.includes("html[data-theme-pending] body"), true);
	assert.equal(css.includes(":focus-visible"), true);
	assert.equal(/focus-visible\s*\{[^}]*outline:\s*none/.test(css), false);

	const fontUrls = [...css.matchAll(/url\("([^"]+)"\)/g)].map((m) => m[1] ?? "");
	assert.equal(fontUrls.length, 5);
	for (const fontUrl of fontUrls) {
		assert.equal(fontUrl.startsWith("/"), true, fontUrl);
		const diskPath = path.join(REPO_ROOT, "public", fontUrl.slice(1));
		assert.equal(fs.existsSync(diskPath), true, `missing local font asset: ${fontUrl}`);
	}
});
