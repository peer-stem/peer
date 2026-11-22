/**
 * Styles for the peer workspace sidebar, folder tree, context menus,
 * extraction coverage ring/popover, activity dock, and delete-session modal.
 * Uses strictly `--cc-*` and `--peer-*` custom properties (`views §1.2` rule 10).
 */

export const SIDEBAR_STYLE_ID = 'peer-sidebar-styles';

export const SIDEBAR_CSS = `/* ------------------ PEER: SIDEBAR ------------------ */

@keyframes peer-sidebar-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.42; }
}

.peer-sidebar-root [hidden],
.peer-coverage-root [hidden],
.peer-delete-dialog-backdrop [hidden],
.peer-sidebar-root[hidden],
.peer-coverage-root[hidden],
.peer-coverage-popover[hidden],
.peer-ctx-coverage[hidden],
.peer-sidebar-context-menu[hidden],
.peer-sidebar-error[hidden],
.peer-activity-list[hidden],
.peer-activity-detail[hidden],
.peer-delete-failure[hidden] {
  display: none;
}

.peer-sidebar-root {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  min-height: 0;
  color: var(--cc-text, #e6e6e6);
  font-family: var(--cc-font, sans-serif);
  box-sizing: border-box;
}

.peer-sidebar-top {
  display: flex;
  flex-direction: column;
  gap: var(--cc-space-1, 4px);
  padding: var(--cc-space-3, 12px) var(--cc-space-3, 12px) var(--cc-space-2, 8px);
}

.peer-sidebar-brand-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--cc-space-2, 8px);
}

.peer-sidebar-actions {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.peer-sidebar-action-btn,
.peer-sidebar-settings-btn {
  display: flex;
  align-items: center;
  gap: var(--cc-space-2, 6px);
  width: 100%;
  padding: 6px 8px;
  border: 0;
  border-radius: var(--cc-radius-sm, 6px);
  background: transparent;
  color: var(--cc-text-muted, #8d8d8d);
  font: var(--cc-type-xs, 11px) var(--cc-font, sans-serif);
  letter-spacing: 0.06em;
  text-transform: uppercase;
  text-align: left;
  cursor: pointer;
}

.peer-sidebar-action-btn:hover,
.peer-sidebar-settings-btn:hover {
  background: var(--cc-btn-bg-hover, var(--peer-hover, rgba(255, 255, 255, 0.08)));
  color: var(--cc-text, #e6e6e6);
}

.peer-sidebar-search-bar {
  display: flex;
  align-items: center;
  gap: var(--cc-space-2, 8px);
  padding: 0 var(--cc-space-3, 12px) var(--cc-space-2, 8px);
}

.peer-sidebar-section-label {
  font-size: var(--cc-type-xs, 11px);
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--cc-text-muted, #8d8d8d);
}

.peer-sidebar-search-input {
  flex: 1 1 0%;
  min-width: 0;
  height: 26px;
  padding: 2px 8px;
  border: 1px solid var(--cc-input-border, var(--cc-border, #434343));
  border-radius: var(--cc-radius-sm, 4px);
  background: var(--cc-input-bg, var(--cc-bg, #141414));
  color: var(--cc-text, #e6e6e6);
  font: var(--cc-type-xs, 12px) var(--cc-font, sans-serif);
}

.peer-sidebar-icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: var(--cc-radius-sm, 4px);
  background: transparent;
  color: var(--cc-text-muted, #8d8d8d);
  cursor: pointer;
  flex-shrink: 0;
}

.peer-sidebar-icon-btn:hover {
  background: var(--cc-btn-bg-hover, var(--peer-hover, rgba(255, 255, 255, 0.08)));
  color: var(--cc-text, #e6e6e6);
}

.peer-sidebar-filter-band { padding: 0 var(--cc-space-3, 12px) var(--cc-space-2, 8px); }

.peer-sidebar-filter-group {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 2px;
  border: 1px solid var(--cc-border, #434343);
  border-radius: var(--cc-radius-sm, 6px);
  background: var(--cc-bg, #141414);
}

.peer-sidebar-filter-btn {
  flex: 1 1 0%;
  padding: 4px 6px;
  border: 0;
  border-radius: var(--cc-radius-sm, 4px);
  background: transparent;
  color: var(--cc-text-muted, #8d8d8d);
  font: 11px var(--cc-font, sans-serif);
  letter-spacing: 0.05em;
  text-transform: uppercase;
  cursor: pointer;
}

.peer-sidebar-filter-btn[aria-pressed="true"] {
  background: var(--cc-ui-selected, var(--peer-hover, rgba(255, 255, 255, 0.12)));
  color: var(--cc-text, #e6e6e6);
}

.peer-sidebar-error {
  display: flex;
  align-items: flex-start;
  gap: var(--cc-space-2, 8px);
  margin: 0 var(--cc-space-3, 12px) var(--cc-space-2, 8px);
  font-size: var(--cc-type-xs, 12px);
  color: var(--cc-tone-danger, #ef4444);
}

.peer-sidebar-list {
  flex: 1 1 0%;
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow-y: auto;
}

.peer-sidebar-empty {
  padding: var(--cc-space-3, 12px) var(--cc-space-4, 16px);
  font-size: var(--cc-type-xs, 12px);
  color: var(--cc-text-muted, #8d8d8d);
}

.peer-sidebar-root-drop { flex: 1 1 auto; min-height: 3rem; }

.peer-sidebar-root-drop[data-drop-active="true"],
.peer-sidebar-folder-row[data-drop-active="true"],
.peer-sidebar-drag-row[data-drop-active="true"] {
  background: var(--cc-ui-selected, var(--peer-hover, rgba(255, 255, 255, 0.1)));
}

.peer-sidebar-folder-branch,
.peer-sidebar-drag-row,
.peer-sidebar-folder-row { position: relative; }

.peer-sidebar-folder-rule {
  position: absolute;
  right: 0;
  z-index: 1;
  border-bottom: 1px solid var(--cc-border, rgba(255, 255, 255, 0.12));
  pointer-events: none;
}

.peer-sidebar-folder-rule.is-top { top: 0; }
.peer-sidebar-folder-rule.is-bottom { bottom: 0; }

.peer-sidebar-folder-thread {
  position: absolute;
  top: 23px;
  bottom: 0;
  width: 1px;
  background: var(--cc-border, rgba(255, 255, 255, 0.14));
  pointer-events: none;
}

.peer-sidebar-folder-btn,
.peer-sidebar-folder-edit,
.peer-sidebar-session-row,
.peer-sidebar-rename-row {
  position: relative;
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 7px 12px;
  border: 0;
  background: transparent;
  color: var(--cc-text, #e6e6e6);
  text-align: left;
  box-sizing: border-box;
}

.peer-sidebar-folder-btn,
.peer-sidebar-session-row { cursor: pointer; }

.peer-sidebar-folder-btn:hover,
.peer-sidebar-session-row:hover,
.peer-sidebar-session-row[data-peer-active="true"],
.peer-sidebar-rename-row {
  background: var(--cc-ui-selected, var(--peer-hover, rgba(255, 255, 255, 0.08)));
}

.peer-sidebar-session-row[data-kbd-selected="true"]:not([data-peer-active="true"]) {
  box-shadow: inset 0 0 0 1px var(--cc-border, #434343);
}

.peer-sidebar-folder-btn.is-compact,
.peer-sidebar-folder-edit.is-compact,
.peer-sidebar-session-row.is-compact,
.peer-sidebar-rename-row.is-compact {
  height: 32px;
  padding-top: 0;
  padding-bottom: 0;
}

.peer-sidebar-row-body {
  display: flex;
  flex-direction: column;
  flex: 1 1 0%;
  min-width: 0;
}

.peer-sidebar-name {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--peer-font-prose, sans-serif);
  font-size: var(--peer-prose-size, 15px);
}

.peer-sidebar-name.is-serif { font-family: var(--peer-font-title, var(--peer-font-prose, serif)); }
.peer-sidebar-name.is-compact { font: var(--cc-type-sm, 13px) var(--cc-font, sans-serif); }

.peer-sidebar-meta {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--cc-type-xs, 11px);
  color: var(--cc-text-muted, #8d8d8d);
}

.peer-sidebar-inline-input {
  width: 100%;
  min-width: 0;
  padding: 0;
  border: 0;
  border-bottom: 1px solid var(--cc-border, #434343);
  background: transparent;
  color: var(--cc-text, #e6e6e6);
  font: var(--cc-type-sm, 13px) inherit;
  outline: none;
}

.peer-sidebar-footer { padding: var(--cc-space-1, 4px) var(--cc-space-3, 12px) var(--cc-space-3, 12px); }

.peer-sidebar-context-menu {
  position: fixed;
  z-index: var(--cc-z-ui-menu, 1400);
  display: flex;
  flex-direction: column;
  gap: 2px;
  width: 13.5rem;
  padding: var(--cc-space-2, 8px);
  border: 1px solid var(--cc-menu-border, var(--cc-border, #434343));
  border-radius: var(--cc-radius-md, 10px);
  background: var(--cc-menu-bg, var(--cc-ui-surface, #1c1c1c));
  box-shadow: var(--cc-shadow-2, 0 12px 32px rgba(0, 0, 0, 0.5));
  font-size: var(--cc-type-xs, 12px);
  pointer-events: auto;
}

.peer-sidebar-menu-item {
  display: flex;
  align-items: center;
  width: 100%;
  padding: 6px 10px;
  border: 0;
  border-radius: var(--cc-radius-sm, 6px);
  background: transparent;
  color: var(--cc-text, #e6e6e6);
  font: var(--cc-type-xs, 12px) var(--cc-font, sans-serif);
  text-align: left;
  cursor: pointer;
}

.peer-sidebar-menu-item:hover { background: var(--cc-menu-item-bg-hover, var(--peer-hover, rgba(255, 255, 255, 0.08))); }
.peer-sidebar-menu-sep { margin: 4px 0; border-top: 1px solid var(--cc-border, #434343); }

.peer-coverage-root { position: relative; display: inline-flex; align-items: center; }
.peer-coverage-root [data-testid="coverage-ring"][data-peer-running="true"] { animation: peer-sidebar-pulse 1.5s ease-in-out infinite; }

.peer-coverage-popover {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  z-index: var(--cc-z-ui-popover, 1380);
  display: flex;
  flex-direction: column;
  gap: var(--cc-space-2, 8px);
  width: 16rem;
  padding: var(--cc-space-3, 12px);
  border: 1px solid var(--cc-border, #434343);
  border-radius: var(--cc-radius-md, 10px);
  background: var(--cc-ui-surface, var(--cc-card-bg, #1c1c1c));
  box-shadow: var(--cc-shadow-2, 0 12px 32px rgba(0, 0, 0, 0.5));
  font-size: var(--cc-type-xs, 12px);
}

.peer-coverage-row,
.peer-activity-kv {
  display: flex;
  justify-content: space-between;
  gap: var(--cc-space-2, 8px);
  color: var(--cc-text-muted, #8d8d8d);
}

.peer-coverage-val { color: var(--cc-text, #e6e6e6); font-variant-numeric: tabular-nums; }
.peer-ctx-coverage { display: flex; flex-direction: column; gap: 6px; padding: 4px 10px 6px; }

.peer-ctx-extract-btn {
  padding: 4px 8px;
  border: 1px solid var(--cc-border, #434343);
  border-radius: var(--cc-radius-sm, 6px);
  background: transparent;
  color: var(--cc-text, #e6e6e6);
  font: var(--cc-type-xs, 12px) var(--cc-font, sans-serif);
  cursor: pointer;
}

.peer-ctx-extract-btn:disabled { opacity: 0.45; cursor: default; }

.peer-activity-section {
  border-top: 1px solid var(--cc-border, #434343);
  padding: var(--cc-space-2, 8px) var(--cc-space-3, 12px);
}

.peer-activity-header {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: var(--cc-type-xs, 11px);
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--cc-text-muted, #8d8d8d);
}

.peer-activity-cost-total { margin-left: auto; font-variant-numeric: tabular-nums; }
.peer-activity-list { display: flex; flex-direction: column; gap: 4px; max-height: 40dvh; margin-top: 6px; overflow-y: auto; }
.peer-activity-blob { border-radius: var(--cc-radius-sm, 6px); padding: 4px 6px; font-size: var(--cc-type-xs, 12px); }
.peer-activity-blob:hover { background: var(--cc-btn-bg-hover, var(--peer-hover, rgba(255, 255, 255, 0.06))); }
.peer-activity-face-wrap { position: relative; display: flex; align-items: center; }

.peer-activity-face {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 2px 26px 2px 2px;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.peer-activity-abort {
  position: absolute;
  right: 2px;
  top: 50%;
  transform: translateY(-50%);
  padding: 2px 5px;
  border: 0;
  border-radius: var(--cc-radius-sm, 4px);
  background: transparent;
  color: var(--cc-text-muted, #8d8d8d);
  font-size: 11px;
  cursor: pointer;
}

.peer-activity-abort:hover:not(:disabled) { color: var(--cc-tone-danger, #ef4444); }

.peer-activity-detail {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-top: 6px;
  padding: 8px;
  border-radius: var(--cc-radius-sm, 6px);
  background: var(--cc-card-bg, rgba(255, 255, 255, 0.04));
}

.peer-delete-dialog-title {
  margin: 0;
  font: var(--cc-weight-semibold, 600) var(--cc-type-sm, 14px) var(--cc-font, sans-serif);
  color: var(--cc-tone-danger, #ef4444);
}

.peer-delete-name-code { font: var(--cc-type-sm, 13px) var(--cc-font-mono, var(--peer-font-mono, monospace)); color: var(--cc-text, #e6e6e6); }
.peer-delete-traces-label { display: flex; align-items: flex-start; gap: 10px; padding: 10px 12px; border: 1px solid var(--cc-border, #434343); border-radius: var(--cc-radius-sm, 6px); cursor: pointer; }
.peer-delete-failure { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 8px 10px; border: 1px solid var(--cc-border, #434343); border-radius: var(--cc-radius-sm, 4px); font-size: var(--cc-type-xs, 12px); }
.peer-delete-actions { display: flex; justify-content: flex-end; gap: 8px; }
.peer-delete-confirm-btn { border-color: var(--cc-tone-danger, #ef4444); color: var(--cc-tone-danger, #ef4444); }
`;

export function injectSidebarStyles(doc = globalThis.document, { nonce } = {}) {
  if (!doc?.createElement || !doc.head) return null;
  const existing = doc.getElementById(SIDEBAR_STYLE_ID);
  if (existing) return existing;
  const style = doc.createElement('style');
  style.id = SIDEBAR_STYLE_ID;
  if (nonce) style.setAttribute('nonce', String(nonce));
  style.textContent = SIDEBAR_CSS;
  doc.head.append(style);
  return style;
}
