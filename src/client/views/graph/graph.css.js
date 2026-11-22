/**
 * Styles for the peer knowledge-graph stage, folder filter, node detail card,
 * delete dialogs, chains table, source folder tree, and notes-import chrome.
 * Uses only `--cc-*` and `--peer-*` custom properties (`views §1.2` rule 10).
 */

export const GRAPH_STYLE_ID = 'peer-graph-styles';

export const GRAPH_CSS = `/* ------------------ PEER: GRAPH VIEWS ------------------ */

.peer-graph-view {
  position: relative;
  display: flex;
  flex-direction: column;
  flex: 1;
  width: 100%;
  height: 100%;
  min-height: 22rem;
  overflow: hidden;
  background: var(--cc-bg, #141414);
  color: var(--cc-text, #e6e6e6);
}

.peer-graph-stage-slot,
.peer-graph-stage-host {
  position: relative;
  flex: 1;
  width: 100%;
  height: 100%;
  min-height: 22rem;
}

.peer-graph-stage-host > *,
.peer-graph-stage-host [data-blit][data-type="peer-graph"],
.peer-graph-stage {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
}

.peer-graph-canvas {
  display: block;
  width: 100%;
  height: 100%;
  touch-action: none;
}

.peer-graph-canvas-fallback {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  gap: var(--cc-space-2, 8px);
  padding: var(--cc-space-4, 16px);
  overflow: auto;
  background: var(--cc-bg, #141414);
}

.peer-graph-fallback-nodes {
  display: flex;
  flex-wrap: wrap;
  gap: var(--cc-space-2, 8px);
}

.peer-graph-chrome {
  position: absolute;
  top: var(--cc-space-2, 8px);
  right: var(--cc-space-2, 8px);
  z-index: 10;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: var(--cc-space-2, 8px);
  max-width: calc(100% - 1rem);
  pointer-events: none;
}

.peer-graph-chrome-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: var(--cc-space-2, 8px);
  pointer-events: auto;
}

.peer-graph-search {
  width: 13rem;
  max-width: 45vw;
}

.peer-graph-empty,
.peer-graph-status {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  padding: var(--cc-space-6, 24px);
  text-align: center;
  color: var(--cc-text-muted, #8d8d8d);
  pointer-events: none;
}

.peer-graph-status {
  pointer-events: auto;
  z-index: 8;
  background: var(--cc-bg, #141414);
}

.peer-graph-empty[hidden],
.peer-graph-status[hidden] {
  display: none;
}

.peer-graph-folder-filter,
.peer-graph-costs-wrap,
.peer-graph-notes-bar {
  position: relative;
  display: inline-flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--cc-space-2, 8px);
  pointer-events: auto;
}

.peer-graph-popover {
  position: absolute;
  top: calc(100% + var(--cc-space-1, 4px));
  right: 0;
  z-index: 22;
  display: flex;
  flex-direction: column;
  gap: var(--cc-space-2, 8px);
  width: 18rem;
  max-height: 60vh;
  overflow-y: auto;
  padding: var(--cc-space-3, 12px);
  background: var(--cc-ui-surface, var(--cc-card-bg, #1c1c1c));
  border: 1px solid var(--cc-border, #434343);
  border-radius: var(--cc-radius-md, 10px);
  box-shadow: var(--cc-shadow-2, 0 12px 32px rgba(0, 0, 0, 0.45));
}

.peer-graph-popover-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--cc-space-2, 8px);
}

.peer-graph-folder-option {
  display: flex;
  align-items: center;
  gap: var(--cc-space-2, 8px);
  padding: 4px var(--cc-space-2, 8px);
  font-size: var(--cc-type-xs, 12px);
  border-radius: var(--cc-radius-sm, 6px);
  cursor: pointer;
}

.peer-graph-import-label {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: var(--cc-space-1, 4px);
  cursor: pointer;
}

.peer-graph-import-input {
  position: absolute;
  width: 1px;
  height: 1px;
  opacity: 0;
  overflow: hidden;
  pointer-events: none;
}

.peer-graph-runs-badge,
.peer-graph-costs-badge {
  display: inline-flex;
  align-items: center;
  gap: var(--cc-space-1, 4px);
  padding: 3px var(--cc-space-2, 8px);
  font-size: var(--cc-type-xs, 11px);
  color: var(--cc-text-muted, #8d8d8d);
  background: var(--cc-ui-surface, var(--cc-card-bg, #1c1c1c));
  border: 1px solid var(--cc-border, #434343);
  border-radius: var(--cc-radius-pill, 9999px);
}

.peer-graph-import-results {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: var(--cc-type-xs, 11px);
}

.peer-graph-import-error {
  margin: 0;
  color: var(--cc-tone-danger, #ef4444);
}

.peer-graph-import-notice {
  margin: 0;
  color: var(--cc-text-muted, #8d8d8d);
}

.peer-graph-render-panel {
  position: absolute;
  top: calc(100% + var(--cc-space-1, 4px));
  right: 0;
  z-index: 20;
  display: flex;
  flex-direction: column;
  gap: var(--cc-space-2, 8px);
  width: 18rem;
  max-height: 60vh;
  overflow-y: auto;
  padding: var(--cc-space-3, 12px);
  background: var(--cc-ui-surface, var(--cc-card-bg, #1c1c1c));
  border: 1px solid var(--cc-border, #434343);
  border-radius: var(--cc-radius-md, 10px);
  box-shadow: var(--cc-shadow-2, 0 12px 32px rgba(0, 0, 0, 0.45));
}

.peer-graph-setting-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--cc-space-2, 8px);
  font-size: var(--cc-type-xs, 11px);
  color: var(--cc-text-muted, #8d8d8d);
}

.peer-graph-node-card {
  position: absolute;
  left: var(--cc-space-3, 12px);
  bottom: var(--cc-space-3, 12px);
  z-index: 12;
  display: flex;
  flex-direction: column;
  gap: var(--cc-space-2, 8px);
  width: min(24rem, calc(100% - 1.5rem));
  max-height: min(26rem, calc(100% - 4rem));
  overflow-y: auto;
  padding: var(--cc-space-3, 12px);
  background: var(--cc-ui-surface, var(--cc-card-bg, #1c1c1c));
  border: 1px solid var(--cc-border, #434343);
  border-radius: var(--cc-radius-md, 10px);
  box-shadow: var(--cc-shadow-2, 0 12px 32px rgba(0, 0, 0, 0.45));
}

.peer-graph-node-head,
.peer-graph-node-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--cc-space-2, 8px);
}

.peer-graph-node-title {
  margin: 0;
  font-size: var(--cc-type-md, 14px);
  font-weight: var(--cc-weight-semibold, 600);
}

.peer-graph-node-statement {
  margin: 0;
  font-family: var(--peer-font-prose, var(--cc-font, sans-serif));
  font-size: var(--cc-type-sm, 13px);
  line-height: 1.45;
  color: var(--cc-text, #e6e6e6);
}

.peer-graph-mastery {
  font-size: var(--cc-type-xs, 11px);
  font-weight: var(--cc-weight-semibold, 600);
  color: var(--cc-tone-success, #22c55e);
}

.peer-graph-fsrs {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 4px var(--cc-space-2, 8px);
  margin: 0;
  padding: var(--cc-space-2, 8px);
  font-size: var(--cc-type-xs, 11px);
  background: var(--cc-input-bg, rgba(255, 255, 255, 0.04));
  border: 1px solid var(--cc-border, #434343);
  border-radius: var(--cc-radius-sm, 6px);
}

.peer-graph-fsrs-pair {
  display: flex;
  justify-content: space-between;
  gap: var(--cc-space-1, 4px);
}

.peer-graph-fsrs dt { color: var(--cc-text-muted, #8d8d8d); }
.peer-graph-fsrs dd { margin: 0; font-family: var(--peer-font-mono, monospace); }

.peer-graph-section-label {
  font-size: var(--cc-type-xs, 11px);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--cc-text-muted, #8d8d8d);
}

.peer-graph-list {
  margin: 0;
  padding-left: var(--cc-space-4, 16px);
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: var(--cc-type-xs, 12px);
}

.peer-graph-provenance-link {
  color: var(--cc-text, #e6e6e6);
  text-decoration: underline;
}

.peer-graph-danger-btn {
  color: var(--cc-tone-danger, #ef4444);
  border-color: var(--cc-tone-danger, #ef4444);
}

.peer-graph-chains-table {
  display: flex;
  flex-direction: column;
  gap: var(--cc-space-3, 12px);
  flex: 1;
  min-height: 0;
  padding: var(--cc-space-3, 12px) var(--cc-space-4, 16px);
}

.peer-graph-chains-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--cc-space-2, 8px);
}

.peer-graph-chains-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--cc-space-2, 8px);
}

.peer-graph-chains-groups {
  display: flex;
  flex-direction: column;
  gap: var(--cc-space-2, 8px);
  overflow-y: auto;
}

.peer-graph-folder-branch {
  display: flex;
  flex-direction: column;
  gap: var(--cc-space-2, 8px);
}

.peer-graph-folder-row {
  display: flex;
  align-items: center;
  gap: var(--cc-space-2, 8px);
  padding: var(--cc-space-2, 8px) var(--cc-space-3, 12px);
  background: var(--cc-ui-surface, var(--cc-card-bg, #1c1c1c));
  border: 1px solid var(--cc-border, #434343);
  border-radius: var(--cc-radius-md, 10px);
}

.peer-graph-folder-row[data-drop-active="true"],
.peer-graph-root-drop[data-drop-active="true"] {
  border-color: var(--cc-accent, #38bdf8);
  background: var(--cc-ui-selected, rgba(56, 189, 248, 0.12));
}

.peer-graph-root-drop {
  min-height: 2rem;
  border: 1px dashed transparent;
  border-radius: var(--cc-radius-sm, 6px);
}

.peer-graph-source-group {
  padding: var(--cc-space-2, 8px) var(--cc-space-3, 12px);
  background: var(--cc-ui-surface, var(--cc-card-bg, #1c1c1c));
  border: 1px solid var(--cc-border, #434343);
  border-radius: var(--cc-radius-md, 10px);
}

.peer-graph-source-summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--cc-space-2, 8px);
  cursor: pointer;
  font-size: var(--cc-type-sm, 13px);
  font-weight: var(--cc-weight-semibold, 600);
}

.peer-graph-chain-row {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-top: var(--cc-space-2, 8px);
  padding-top: var(--cc-space-2, 8px);
  border-top: 1px solid var(--cc-border, #434343);
}

.peer-graph-chain-line {
  font-size: var(--cc-type-xs, 12px);
  font-weight: var(--cc-weight-semibold, 600);
}

.peer-graph-prop-row {
  display: flex;
  align-items: flex-start;
  gap: var(--cc-space-2, 8px);
  padding-left: var(--cc-space-3, 12px);
  font-size: var(--cc-type-xs, 12px);
  color: var(--cc-text-muted, #8d8d8d);
}

.peer-graph-confirm-dialog {
  display: flex;
  flex-direction: column;
  gap: var(--cc-space-3, 12px);
  max-width: 32rem;
}

.peer-graph-confirm-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--cc-space-2, 8px);
}
`;

export function injectGraphStyles(doc = globalThis.document, { nonce } = {}) {
  if (!doc?.createElement || !doc.head) return null;
  const existing = doc.getElementById(GRAPH_STYLE_ID);
  if (existing) return existing;
  const style = doc.createElement('style');
  style.id = GRAPH_STYLE_ID;
  if (nonce) style.setAttribute('nonce', String(nonce));
  style.textContent = GRAPH_CSS;
  doc.head.append(style);
  return style;
}
