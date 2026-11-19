/**
 * Applies resolved `ThemeTokens` (`--cc-*` + `--peer-*`) onto `<html>`
 * (`document.documentElement`) and clears the anti-FOUC `data-theme-pending`
 * gate (client-contract-state §8.2; seam R6, C-01).
 */

import { applyTheme } from "cloudcanvas/theme";

export const PEER_TOKEN_PREFIX = "--peer-";

/**
 * Sync `--peer-*` inline properties on `style`: removes stale `--peer-*`
 * keys absent from `peer` before writing current `--peer-*` entries.
 *
 * @param {{
 *   length: number,
 *   item(index: number): string,
 *   setProperty(property: string, value: string): void,
 *   removeProperty(property: string): string | void
 * }} style
 * @param {Readonly<Record<string, string | null | undefined>> | null | undefined} peer
 */
function syncPeerTokens(style, peer) {
	const next = peer && typeof peer === "object" ? peer : null;
	const stale = [];
	for (let i = 0; i < style.length; i += 1) {
		const name = style.item(i);
		if (!name || !name.startsWith(PEER_TOKEN_PREFIX)) continue;
		if (!next || next[name] === undefined || next[name] === null) stale.push(name);
	}
	for (const name of stale) style.removeProperty(name);
	if (!next) return;
	for (const [name, value] of Object.entries(next)) {
		if (!name.startsWith(PEER_TOKEN_PREFIX)) continue;
		if (value === null || value === undefined) style.removeProperty(name);
		else style.setProperty(name, String(value));
	}
}

/**
 * Write `ThemeTokens` onto a root element (`document.documentElement`),
 * toggle `dark`/`light` classes and `colorScheme`, and clear `data-theme-pending`.
 *
 * @template {{
 *   style?: {
 *     length: number,
 *     item(index: number): string,
 *     setProperty(property: string, value: string): void,
 *     removeProperty(property: string): string | void,
 *     colorScheme?: string
 *   } | null,
 *   classList?: { toggle(token: string, force?: boolean): boolean },
 *   removeAttribute?: (qualifiedName: string) => void
 * }} T
 * @param {T | null | undefined} root
 * @param {{
 *   mode?: "dark" | "light",
 *   cc?: Readonly<Record<string, string | null | undefined>> | null,
 *   peer?: Readonly<Record<string, string | null | undefined>> | null
 * } | null | undefined} [tokens]
 * @returns {T | null}
 */
export function applyThemeTokens(root, tokens) {
	if (!root?.style) return null;
	const mode = tokens?.mode === "light" ? "light" : "dark";
	root.classList?.toggle("dark", mode === "dark");
	root.classList?.toggle("light", mode === "light");
	root.style.colorScheme = mode;
	applyTheme(root, null);
	applyTheme(root, tokens?.cc ?? null);
	syncPeerTokens(root.style, tokens?.peer);
	root.removeAttribute?.("data-theme-pending");
	return root;
}
