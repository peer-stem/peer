/**
 * Plugin UI, chrome, tree, surface, and dock styles (`f4-c2c`), using `--cc-*` tokens.
 */

export const PLUGIN_STYLE_ID = "peer-plugin-styles";

export const PLUGIN_CSS = `
.peer-plugin-btn {
	display: inline-flex;
	align-items: center;
	justify-content: center;
	gap: 6px;
	padding: 6px 12px;
	border-radius: var(--cc-radius-sm, 6px);
	border: 1px solid var(--cc-border, rgba(128,128,128,0.28));
	background: var(--cc-surface-2, rgba(128,128,128,0.12));
	color: var(--cc-fg, inherit);
	font-size: 0.8125rem;
	cursor: pointer;
}
.peer-plugin-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.peer-plugin-btn[data-variant="default"] { background: var(--cc-accent, #3b82f6); color: #fff; border-color: transparent; }
.peer-plugin-btn[data-variant="destructive"] { background: var(--cc-danger, #ef4444); color: #fff; border-color: transparent; }
.peer-plugin-btn[data-variant="ghost"] { background: transparent; border-color: transparent; }
.peer-plugin-btn[data-variant="link"] { background: transparent; border-color: transparent; text-decoration: underline; }
.peer-plugin-btn[data-size="xs"], .peer-plugin-btn[data-size="icon-xs"] { padding: 2px 6px; font-size: 0.75rem; }
.peer-plugin-btn[data-size="sm"], .peer-plugin-btn[data-size="icon-sm"] { padding: 4px 8px; }
.peer-plugin-btn[data-size="lg"], .peer-plugin-btn[data-size="icon-lg"] { padding: 8px 16px; font-size: 0.9375rem; }
.peer-plugin-btn-icon { display: inline-flex; width: 1em; height: 1em; }
.peer-plugin-btn-icon svg { width: 100%; height: 100%; }

.peer-plugin-badge {
	display: inline-flex;
	align-items: center;
	padding: 2px 8px;
	border-radius: 999px;
	font-size: 0.75rem;
	font-weight: 500;
	background: var(--cc-surface-2, rgba(128,128,128,0.16));
	color: var(--cc-fg-muted, inherit);
}
.peer-plugin-tree {
	display: flex;
	flex-direction: column;
	gap: 2px;
	border: 1px solid var(--cc-border, rgba(128,128,128,0.22));
	border-radius: var(--cc-radius-md, 8px);
	padding: 6px;
}
.peer-plugin-tree-header, .peer-plugin-tree-row {
	display: flex;
	align-items: center;
	gap: 8px;
	padding: 4px 6px;
	border-radius: var(--cc-radius-sm, 6px);
}
.peer-plugin-tree-row:focus { outline: 2px solid var(--cc-accent, #3b82f6); outline-offset: -2px; }
.peer-plugin-tree-main { flex: 1 1 auto; min-width: 0; display: flex; align-items: center; gap: 6px; }
.peer-plugin-tree-cell { flex: 0 0 auto; font-size: 0.8125rem; }

.peer-plugin-view {
	display: flex;
	flex-direction: column;
	height: 100%;
	min-height: 0;
	position: relative;
}
.peer-plugin-view-body {
	flex: 1 1 auto;
	min-height: 0;
	position: relative;
	display: flex;
	flex-direction: column;
}
.peer-plugin-view-scroll {
	flex: 1 1 auto;
	min-height: 0;
	overflow: auto;
	padding: var(--cc-space-4, 16px);
	display: flex;
	flex-direction: column;
}
.peer-plugin-surface-region {
	position: absolute;
	inset: 0;
	pointer-events: none;
	z-index: 20;
}
.peer-plugin-surface {
	position: absolute;
	inset: 0;
	pointer-events: auto;
	display: flex;
	flex-direction: column;
	background: var(--cc-surface-1, rgba(18,18,22,0.92));
	backdrop-filter: blur(8px);
	padding: var(--cc-space-3, 12px);
	overflow: auto;
}
.peer-plugin-surface[data-background="opaque"] {
	background: var(--cc-bg, #121216);
	backdrop-filter: none;
}
.peer-plugin-actions-bar {
	display: inline-flex;
	align-items: center;
	gap: 6px;
	flex-wrap: wrap;
}
.peer-plugin-menu {
	position: fixed;
	z-index: 120;
	min-width: 160px;
	padding: 4px;
	border-radius: var(--cc-radius-md, 8px);
	border: 1px solid var(--cc-border, rgba(128,128,128,0.3));
	background: var(--cc-surface-1, #1c1c22);
	box-shadow: 0 8px 24px rgba(0,0,0,0.32);
	display: flex;
	flex-direction: column;
	gap: 2px;
}
.peer-plugin-menu-item {
	text-align: left;
	padding: 6px 10px;
	border: none;
	border-radius: var(--cc-radius-sm, 6px);
	background: transparent;
	color: var(--cc-fg, inherit);
	cursor: pointer;
	font-size: 0.8125rem;
}
.peer-plugin-menu-item:hover:not(:disabled) { background: var(--cc-surface-2, rgba(128,128,128,0.18)); }
.peer-plugin-menu-item:disabled { opacity: 0.45; cursor: not-allowed; }
`;

export function injectPluginStyles(doc = globalThis.document, { nonce } = {}) {
	if (!doc?.createElement || !doc.head) return null;
	const existing = doc.getElementById(PLUGIN_STYLE_ID);
	if (existing) return existing;
	const style = doc.createElement("style");
	style.id = PLUGIN_STYLE_ID;
	if (nonce) style.setAttribute("nonce", String(nonce));
	style.textContent = PLUGIN_CSS;
	doc.head.append(style);
	return style;
}
