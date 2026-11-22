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

declare module "peer-kit" {
	export const UI_LIGHT_THEME: Readonly<Record<`--cc-${string}`, string>>;
	export const KIT_STYLE_ID: "cloudcanvas-ui-kit-staging-styles";
	export const KIT_CSS: string;
	export function injectKitStyles(doc?: Document): HTMLStyleElement | null;
	export function createKitMarkdown(host: Element, hooks?: Record<string, unknown>): { root: HTMLElement; update(model?: Record<string, unknown>): void; destroy(): void };
	export function renderKitInline(source: string, options?: Record<string, unknown>): DocumentFragment;
	export function createModal(host: HTMLElement, callbacks?: { onClose?: (reason: "escape" | "backdrop" | "button") => void }): { body: HTMLElement; update(model?: Record<string, unknown>): void; destroy(): void };
	export function createStickyScroll(host: HTMLElement, callbacks?: Record<string, unknown>): { root: HTMLElement; viewport: HTMLElement; content: HTMLElement; isAtBottom(): boolean; stickToBottom(): void; notifyGrowth(): void; update(model?: Record<string, unknown>): void; destroy(): void };
	export function createDisclosure(host: HTMLElement, callbacks?: { onToggle?: (open: boolean) => void }): { root: HTMLElement; header: HTMLButtonElement; body: HTMLElement; update(model?: Record<string, unknown>): void; destroy(): void };
	export function createTooltip(target: HTMLElement, options?: Record<string, unknown>): { bubble: HTMLElement; update(model?: Record<string, unknown>): void; destroy(): void };
	export function createSpinner(host: HTMLElement): { root: HTMLElement; update(model?: Record<string, unknown>): void; destroy(): void };
	export function createRingProgress(host: HTMLElement, options?: Record<string, unknown>): { root: HTMLElement; update(model?: Record<string, unknown>): void; destroy(): void };
	export function createNumberField(host: HTMLElement, callbacks?: { onChange?: (value: number) => void }): { root: HTMLElement; input: HTMLInputElement; update(model?: Record<string, unknown>): void; destroy(): void };
	export function createSliderField(host: HTMLElement, callbacks?: { onInput?: (value: number) => void; onChange?: (value: number) => void }): { root: HTMLElement; input: HTMLInputElement; update(model?: Record<string, unknown>): void; destroy(): void };
	export function createSearchMenu(host: HTMLElement, callbacks?: Record<string, unknown>): { root: HTMLElement; trigger: HTMLButtonElement; panel: HTMLElement; open(): void; close(): void; update(model?: Record<string, unknown>): void; destroy(): void };
	export function createTokenInput(host: HTMLElement, callbacks?: Record<string, unknown>): { root: HTMLElement; focus(): void; serialize(): { text: string; tokens: Array<{ id: string; kind: string; value: string }> }; insertToken(token: Record<string, unknown>): void; clear(): void; update(model?: Record<string, unknown>): void; destroy(): void };
	export function createPanZoom(host: HTMLElement, options?: Record<string, unknown>): { root: HTMLElement; stage: HTMLElement; getTransform(): { x: number; y: number; k: number }; setTransform(next: { x: number; y: number; k: number }): void; reset(): void; fit(bounds: { x?: number; y?: number; width: number; height: number }, padding?: number): void; update(model?: Record<string, unknown>): void; destroy(): void };
	export function createEditableTree(host: HTMLElement, callbacks?: Record<string, unknown>): { root: HTMLElement; startRename(id: string): void; update(model?: Record<string, unknown>): void; destroy(): void };
	export function createFloatingWindow(host: HTMLElement, callbacks?: Record<string, unknown>): { root: HTMLElement; body: HTMLElement; getGeometry(): { x: number; y: number; width: number; height: number }; update(model?: Record<string, unknown>): void; destroy(): void };
	export function createSelectionPopover(host: HTMLElement, options: Record<string, unknown>): { root: HTMLElement; hide(): void; update(model?: Record<string, unknown>): void; destroy(): void };
	export function createFindBar(host: HTMLElement, options: Record<string, unknown>): { root: HTMLElement; input: HTMLInputElement; getMatchCount(): number; focus(): void; step(delta: number): void; update(model?: Record<string, unknown>): void; destroy(): void };
}
