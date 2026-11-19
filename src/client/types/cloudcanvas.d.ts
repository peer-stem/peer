/**
 * Interim TypeScript module declarations for CloudCanvas (`extern/cloudcanvas`)
 * and CloudCanvas Lib (`extern/cloudcanvas-lib`) symbols consumed by
 * `src/client/theme/` and `tests/client-theme.test.ts` (client-contract-state §7).
 *
 * Replaced once upstream JSDoc-generated `.d.ts` PRs land in both submodules.
 */

declare module "cloudcanvas/theme" {
	export const TOKEN_PREFIX: "--cc-";
	export const LIGHT_THEME: Readonly<Record<`--cc-${string}`, string>>;

	export interface ThemeStyleTarget {
		readonly style: {
			readonly length: number;
			item(index: number): string;
			setProperty(property: string, value: string): void;
			removeProperty(property: string): string | void;
		};
	}

	export function applyTheme<T extends Element | ThemeStyleTarget>(
		hostElement: T | null | undefined,
		vars?: Readonly<Record<string, string | null | undefined>> | null,
	): T | null;
}

declare module "cloudcanvas/tokens" {
	export const TOKEN_PREFIX: "--cc-";

	export const TOKEN_CATEGORY: Readonly<{
		COLOR: "color";
		SPACE: "space";
		RADIUS: "radius";
		SHADOW: "shadow";
		TYPE: "type";
		Z_INDEX: "z-index";
		SIZE: "size";
		LAYOUT: "layout";
	}>;

	export type TokenCategory = (typeof TOKEN_CATEGORY)[keyof typeof TOKEN_CATEGORY];

	export interface TokenMeta {
		readonly category: TokenCategory;
		readonly purpose: string;
	}

	export const TOKENS: Readonly<Record<`--cc-${string}`, TokenMeta>>;
	export const TOKEN_NAMES: readonly `--cc-${string}`[];

	export function isToken(name: string): boolean;
	export function tokensInCategory(
		category: TokenCategory | string,
	): Array<[`--cc-${string}`, TokenMeta]>;
	export function lightThemeValue(name: string): string | undefined;
}

declare module "cloudcanvas-lib" {
	export const LIB_DEFAULT_CSS: string;
	export const LIB_STYLE_ID: "cloudcanvas-lib-styles";
	export const LIB_TOKENS: Readonly<Record<`--cc-${string}`, string>>;
	export const LIB_LIGHT_THEME: Readonly<Record<`--cc-${string}`, string>>;

	export function injectLibStyles(customCSS?: string): HTMLStyleElement | null;
	export function registerBaseTypes(): string[];
}

declare module "cloudcanvas-lib/ui" {
	export interface UiTokenMeta {
		readonly category: "color" | "size" | "shadow" | "z-index";
		readonly purpose: string;
	}

	export const UI_TOKENS: Readonly<Record<`--cc-${string}`, UiTokenMeta>>;
	export const UI_STYLE_ID: "cloudcanvas-ui-styles";
	export const UI_CSS: string;

	export function injectUiStyles(
		doc?: Document,
		options?: { readonly nonce?: string },
	): HTMLStyleElement | null;
}
