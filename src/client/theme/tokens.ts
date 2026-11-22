/**
 * Theme-to-token adapter (client-contract-state §8.1, §8.3; C-13):
 * translates `peer`'s 12-color `Theme` + `EffectiveAppearance` + desktop zoom
 * into CloudCanvas `--cc-*` and application `--peer-*` custom properties.
 */

import { LIGHT_THEME } from "cloudcanvas/theme";
import { LIB_LIGHT_THEME } from "cloudcanvas-lib";
import { UI_LIGHT_THEME } from "peer-kit";
import { FACTORY_SETTINGS } from "../../core/settings.ts";
import type { EffectiveAppearance } from "../../core/settings-resolution.ts";
import {
	DEFAULT_THEME,
	effectiveColors,
	shiftHex,
	type Theme,
	type ThemeColors,
	type ThemeMode,
} from "../../core/themes.ts";

const HOVER_STEP = 14;
const WCAG_AA_CONTRAST = 4.5;
const DARK_ON_ACCENT = "#141414";
const LIGHT_ON_ACCENT = "#ffffff";
const DARK_BACKDROP = "rgba(0, 0, 0, 0.6)";
const LIGHT_BACKDROP = "rgba(15, 23, 42, 0.35)";
const PROSE_FALLBACK = '"Source Sans 3", ui-sans-serif, system-ui, sans-serif';
const TITLE_SERIF_STACK = '"lh-cmu", ui-serif, Georgia, serif';

export interface ThemeTokens {
	readonly mode: ThemeMode;
	readonly cc: Readonly<Record<`--cc-${string}`, string>>;
	readonly peer: Readonly<Record<`--peer-${string}`, string>>;
}

function parseHexChannels(hex: string): readonly [number, number, number] {
	if (hex.length === 4) {
		const r = hex.slice(1, 2);
		const g = hex.slice(2, 3);
		const b = hex.slice(3, 4);
		return [parseInt(r + r, 16), parseInt(g + g, 16), parseInt(b + b, 16)];
	}
	return [
		parseInt(hex.slice(1, 3), 16),
		parseInt(hex.slice(3, 5), 16),
		parseInt(hex.slice(5, 7), 16),
	];
}

function linearChannel(channel: number): number {
	const s = channel / 255;
	return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(hex: string): number {
	const [r, g, b] = parseHexChannels(hex);
	return 0.2126 * linearChannel(r) + 0.7152 * linearChannel(g) + 0.0722 * linearChannel(b);
}

/** WCAG 2.1 contrast ratio between two `#rgb` / `#rrggbb` colors (`1..21`). */
export function contrastRatio(hexA: string, hexB: string): number {
	const lumA = relativeLuminance(hexA);
	const lumB = relativeLuminance(hexB);
	const lighter = Math.max(lumA, lumB);
	const darker = Math.min(lumA, lumB);
	return (lighter + 0.05) / (darker + 0.05);
}

function resolveOnAccent(accent: string, background: string): string {
	if (contrastRatio(accent, background) >= WCAG_AA_CONTRAST) return background;
	const darkContrast = contrastRatio(accent, DARK_ON_ACCENT);
	const lightContrast = contrastRatio(accent, LIGHT_ON_ACCENT);
	return darkContrast >= lightContrast ? DARK_ON_ACCENT : LIGHT_ON_ACCENT;
}

function quoteFontFamily(name: string): string {
	const escaped = name.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
	return `"${escaped}"`;
}

function resolveProseFont(fontFamily: string | null): string {
	const raw = fontFamily?.replace(/[\0\r\n]+/g, " ").trim() ?? "";
	const unquoted = raw.replace(/^["']+|["']+$/g, "").trim();
	if (!unquoted) return PROSE_FALLBACK;
	if (unquoted === "JetBrains Mono") {
		return `"JetBrains Mono", ui-monospace, monospace, ${PROSE_FALLBACK}`;
	}
	return `${quoteFontFamily(unquoted)}, ${PROSE_FALLBACK}`;
}

function buildCcTokens(
	mode: ThemeMode,
	c: ThemeColors,
	hover: string,
	onAccent: string,
): Readonly<Record<`--cc-${string}`, string>> {
	const base: Readonly<Record<`--cc-${string}`, string>> =
		mode === "light" ? { ...LIGHT_THEME, ...LIB_LIGHT_THEME, ...UI_LIGHT_THEME } : {};
	const cc: Record<`--cc-${string}`, string> = {
		...base,
		"--cc-bg": c.background,
		"--cc-text": c.text,
		"--cc-text-muted": c.textMuted,
		"--cc-accent": c.accent,
		"--cc-focus-ring": c.accent,
		"--cc-card-bg": c.surface,
		"--cc-card-border": c.border,
		"--cc-card-border-hover": hover,
		"--cc-ui-surface": c.surface,
		"--cc-ui-selected": hover,
		"--cc-ui-backdrop": mode === "dark" ? DARK_BACKDROP : LIGHT_BACKDROP,
		"--cc-ui-on-accent": onAccent,
		"--cc-ui-drop": c.accent,
		"--cc-ui-grid-line": c.border,
		"--cc-border": c.border,
		"--cc-input-bg": c.surface,
		"--cc-input-border": c.border,
		"--cc-btn-bg": c.surface,
		"--cc-btn-bg-hover": hover,
		"--cc-btn-border": c.border,
		"--cc-btn-text": c.text,
		"--cc-menu-bg": c.surface,
		"--cc-menu-border": c.border,
		"--cc-menu-item-bg-hover": hover,
		"--cc-tone-danger": c.error,
		"--cc-tone-success": c.success,
		"--cc-tone-warning": c.warning,
		"--cc-tone-info": c.accent,
		"--cc-ink-strong": c.bold,
		"--cc-ink-em": c.italic,
		"--cc-ink-code": c.code,
		"--cc-font": "var(--peer-font-ui)",
		"--cc-font-mono": "var(--peer-font-mono)",
	};
	return Object.freeze(cc);
}

function buildPeerTokens(
	c: ThemeColors,
	hover: string,
	appearance: EffectiveAppearance,
	zoom: number,
): Readonly<Record<`--peer-${string}`, string>> {
	const safeZoom = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
	const peer: Record<`--peer-${string}`, string> = {
		"--peer-hover": hover,
		"--peer-line-strong": c.text,
		"--peer-font-prose": resolveProseFont(appearance.fontFamily),
		"--peer-prose-size": `${appearance.proseFontSize}px`,
		"--peer-prose-leading": "1.5",
		"--peer-code-ligatures": appearance.codeLigatures ? "normal" : "none",
		"--peer-font-title": appearance.sessionNameSerif ? TITLE_SERIF_STACK : "var(--peer-font-prose)",
		"--peer-heading-weight": `${appearance.mdRendering.headingWeight}`,
		"--peer-zoom": `${safeZoom}`,
	};
	return Object.freeze(peer);
}

export function buildThemeTokens(
	theme: Theme = DEFAULT_THEME,
	appearance: EffectiveAppearance = FACTORY_SETTINGS.appearance,
	zoom = 1,
): ThemeTokens {
	const c = effectiveColors(theme, appearance);
	const hover = shiftHex(c.surface, theme.mode === "dark" ? HOVER_STEP : -HOVER_STEP);
	const onAccent = resolveOnAccent(c.accent, c.background);
	return Object.freeze({
		mode: theme.mode,
		cc: buildCcTokens(theme.mode, c, hover, onAccent),
		peer: buildPeerTokens(c, hover, appearance, zoom),
	});
}
