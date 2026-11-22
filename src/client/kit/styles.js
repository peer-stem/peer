/**
 * Shared `--cc-*` stylesheet for staged CloudCanvas UI controls (`src/client/kit/`).
 * Uses exclusively `--cc-*` tokens so every control drops cleanly into `cloudcanvas-lib/ui`.
 */
import { injectUiStyles } from "cloudcanvas-lib/ui";

export const KIT_STYLE_ID = "cloudcanvas-ui-kit-staging-styles";

export const KIT_CSS = `
.cloudcanvas-ui-sticky-scroll { position: relative; display: flex; flex-direction: column; min-height: 0; flex: 1 1 auto; }
.cloudcanvas-ui-sticky-viewport { flex: 1 1 auto; min-height: 0; overflow-y: auto; overscroll-behavior: contain; }
.cloudcanvas-ui-sticky-jump {
	position: absolute; right: 16px; bottom: 14px; z-index: var(--cc-z-ui-raised, 10);
	border-radius: 999px; box-shadow: 0 4px 12px rgba(0,0,0,0.22);
}
.cloudcanvas-ui-disclosure {
	border: 1px solid var(--cc-border, rgba(128,128,128,0.25)); border-radius: var(--cc-radius-md, 8px);
	background: var(--cc-card-bg, transparent);
}
.cloudcanvas-ui-disclosure-header {
	display: flex; align-items: center; gap: 8px; width: 100%; padding: 8px 12px;
	background: transparent; border: 0; color: var(--cc-text, inherit); cursor: pointer;
	font: inherit; text-align: left;
}
.cloudcanvas-ui-disclosure-chevron { transition: transform 140ms ease; display: inline-flex; color: var(--cc-text-muted, inherit); }
.cloudcanvas-ui-disclosure.is-open > .cloudcanvas-ui-disclosure-header .cloudcanvas-ui-disclosure-chevron { transform: rotate(90deg); }
.cloudcanvas-ui-disclosure-body { padding: 0 12px 10px; border-top: 1px solid var(--cc-border, rgba(128,128,128,0.18)); }
.cloudcanvas-ui-tooltip {
	position: fixed; z-index: var(--cc-z-ui-menu, 60); max-width: 280px; padding: 5px 9px;
	border-radius: var(--cc-radius-sm, 6px); background: var(--cc-ui-surface, #1f242c);
	border: 1px solid var(--cc-border, rgba(128,128,128,0.3)); color: var(--cc-text, #f1f5f9);
	font-size: 12px; line-height: 1.35; pointer-events: none; box-shadow: 0 6px 18px rgba(0,0,0,0.28);
}
@keyframes cc-ui-spin { to { transform: rotate(360deg); } }
.cloudcanvas-ui-spinner { display: inline-flex; align-items: center; gap: 6px; color: var(--cc-text-muted, inherit); }
.cloudcanvas-ui-spinner-svg { animation: cc-ui-spin 0.85s linear infinite; }
.cloudcanvas-ui-ring { display: inline-flex; align-items: center; gap: 6px; background: transparent; border: 0; color: var(--cc-text, inherit); padding: 2px; }
.cloudcanvas-ui-number-field, .cloudcanvas-ui-slider-field { display: inline-flex; align-items: center; gap: 8px; }
.cloudcanvas-ui-slider-input { accent-color: var(--cc-accent, #3b82f6); cursor: pointer; }
.cloudcanvas-ui-search-menu { position: relative; display: inline-block; }
.cloudcanvas-ui-search-menu-panel {
	position: fixed; z-index: var(--cc-z-ui-menu, 60); min-width: 240px; max-width: 360px;
	background: var(--cc-menu-bg, var(--cc-ui-surface, #1e1e24));
	border: 1px solid var(--cc-menu-border, var(--cc-border, rgba(128,128,128,0.3)));
	border-radius: var(--cc-radius-md, 8px); padding: 6px; display: flex; flex-direction: column; gap: 6px;
	box-shadow: 0 10px 28px rgba(0,0,0,0.34);
}
.cloudcanvas-ui-search-menu-list { max-height: 260px; overflow-y: auto; display: flex; flex-direction: column; gap: 2px; }
.cloudcanvas-ui-search-menu-group { font-size: 11px; font-weight: 600; color: var(--cc-text-muted, inherit); padding: 6px 8px 2px; text-transform: uppercase; letter-spacing: 0.04em; }
.cloudcanvas-ui-search-menu-option {
	display: flex; align-items: center; justify-content: space-between; gap: 8px; width: 100%;
	padding: 6px 8px; border: 0; border-radius: var(--cc-radius-sm, 6px); background: transparent;
	color: var(--cc-text, inherit); text-align: left; cursor: pointer; font: inherit;
}
.cloudcanvas-ui-search-menu-option.is-active, .cloudcanvas-ui-search-menu-option:hover {
	background: var(--cc-menu-item-bg-hover, var(--cc-ui-selected, rgba(128,128,128,0.16)));
}
.cloudcanvas-ui-token-input {
	min-height: 40px; padding: 8px 10px; border-radius: var(--cc-radius-md, 8px);
	border: 1px solid var(--cc-input-border, var(--cc-border, rgba(128,128,128,0.3)));
	background: var(--cc-input-bg, transparent); color: var(--cc-text, inherit);
	line-height: 1.5; white-space: pre-wrap; word-break: break-word; outline: none;
}
.cloudcanvas-ui-token-input:focus { border-color: var(--cc-focus-ring, var(--cc-accent, #3b82f6)); }
.cloudcanvas-ui-token-input[data-empty="true"]::before {
	content: attr(data-placeholder); color: var(--cc-text-muted, rgba(128,128,128,0.75)); pointer-events: none;
}
.cloudcanvas-ui-token-chip {
	display: inline-flex; align-items: center; gap: 4px; padding: 1px 6px; margin: 0 2px;
	border-radius: 5px; background: var(--cc-ui-selected, rgba(128,128,128,0.18));
	border: 1px solid var(--cc-border, rgba(128,128,128,0.28)); font-size: 0.9em; user-select: all;
}
.cloudcanvas-ui-pan-zoom { position: relative; overflow: hidden; touch-action: none; user-select: none; }
.cloudcanvas-ui-pan-zoom-stage { transform-origin: 0 0; will-change: transform; }
.cloudcanvas-ui-editable-tree { display: flex; flex-direction: column; gap: 1px; outline: none; }
.cloudcanvas-ui-editable-tree-row {
	display: flex; align-items: center; gap: 6px; padding: 4px 8px; border-radius: var(--cc-radius-sm, 6px);
	cursor: pointer; color: var(--cc-text, inherit); user-select: none;
}
.cloudcanvas-ui-editable-tree-row.is-selected, .cloudcanvas-ui-editable-tree-row:hover {
	background: var(--cc-ui-selected, rgba(128,128,128,0.14));
}
.cloudcanvas-ui-editable-tree-row.is-drop-target { outline: 2px solid var(--cc-ui-drop, #3b82f6); outline-offset: -2px; }
.cloudcanvas-ui-floating-window {
	position: fixed; z-index: var(--cc-z-ui-context, 30); display: flex; flex-direction: column;
	background: var(--cc-ui-surface, #1e1e24); border: 1px solid var(--cc-border, rgba(128,128,128,0.3));
	border-radius: var(--cc-radius-md, 10px); box-shadow: 0 12px 36px rgba(0,0,0,0.36); overflow: hidden;
}
.cloudcanvas-ui-floating-header {
	display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 8px 10px;
	border-bottom: 1px solid var(--cc-border, rgba(128,128,128,0.22)); cursor: move; user-select: none;
}
.cloudcanvas-ui-floating-body { flex: 1 1 auto; min-height: 0; overflow: auto; }
.cloudcanvas-ui-floating-resize { position: absolute; right: 0; bottom: 0; width: 14px; height: 14px; cursor: nwse-resize; }
.cloudcanvas-ui-selection-popover {
	position: fixed; z-index: var(--cc-z-ui-popover, 50); display: inline-flex; align-items: center; gap: 4px;
	padding: 4px; border-radius: var(--cc-radius-sm, 6px); background: var(--cc-ui-surface, #1e1e24);
	border: 1px solid var(--cc-border, rgba(128,128,128,0.3)); box-shadow: 0 6px 18px rgba(0,0,0,0.3);
}
.cloudcanvas-ui-find-bar {
	display: inline-flex; align-items: center; gap: 6px; padding: 6px 8px;
	border-radius: var(--cc-radius-md, 8px); background: var(--cc-ui-surface, #1e1e24);
	border: 1px solid var(--cc-border, rgba(128,128,128,0.3)); box-shadow: 0 6px 18px rgba(0,0,0,0.28);
}
.cloudcanvas-ui-md-callout {
	border-left: 3px solid var(--cc-tone-info, var(--cc-accent, #3b82f6));
	padding: 8px 12px; margin: 8px 0; border-radius: 0 var(--cc-radius-sm, 6px) var(--cc-radius-sm, 6px) 0;
	background: var(--cc-card-bg, rgba(128,128,128,0.08));
}
.cloudcanvas-ui-md-callout[data-alert-kind="warning"] { border-left-color: var(--cc-tone-warning, #d97706); }
.cloudcanvas-ui-md-callout[data-alert-kind="caution"] { border-left-color: var(--cc-tone-danger, #dc2626); }
.cloudcanvas-ui-md-callout[data-alert-kind="tip"] { border-left-color: var(--cc-tone-success, #059669); }
`;

/**
 * Inject both `cloudcanvas-lib/ui` base styles and staged kit styles once per document.
 * @param {Document} [doc]
 */
export function injectKitStyles(doc = globalThis.document) {
	if (!doc?.head) return null;
	injectUiStyles(doc);
	const existing = doc.getElementById(KIT_STYLE_ID);
	if (existing) return existing;
	const style = doc.createElement("style");
	style.id = KIT_STYLE_ID;
	style.textContent = KIT_CSS;
	doc.head.append(style);
	return style;
}
