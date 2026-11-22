/**
 * Styles for the peer Settings modal, section panels, 12-color customizer,
 * prompt segment dialog, and First-Run Setup wizard.
 * Uses only `--cc-*` and `--peer-*` custom properties (`views §1.2` rule 10).
 */

export const SETTINGS_STYLE_ID = 'peer-settings-styles';

export const SETTINGS_CSS = `/* ------------------ PEER: SETTINGS ------------------ */

.peer-settings-modal {
  width: min(56rem, calc(100vw - 2rem));
  max-height: calc(100dvh - 2rem);
}

.peer-settings-setup-modal {
  width: min(42rem, calc(100vw - 2rem));
  max-height: calc(100dvh - 2rem);
}

.peer-settings-modal [hidden],
.peer-settings-setup-modal [hidden],
.peer-prompt-dialog [hidden] {
  display: none !important;
}

.peer-settings-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: var(--cc-space-1, 4px);
  padding-bottom: var(--cc-space-2, 8px);
  border-bottom: 1px solid var(--cc-border, rgba(255, 255, 255, 0.1));
}

.peer-settings-tab {
  padding: 6px 10px;
  font-family: var(--cc-font, sans-serif);
  font-size: var(--cc-type-sm, 12px);
  color: var(--cc-text-muted, #94a3b8);
  background: transparent;
  border: 1px solid transparent;
  border-radius: var(--cc-radius-sm, 6px);
  cursor: pointer;
}

.peer-settings-tab:hover {
  color: var(--cc-text, #e2e8f0);
  background: var(--cc-input-bg, rgba(255, 255, 255, 0.05));
}

.peer-settings-tab[aria-selected="true"] {
  color: var(--cc-text, #e2e8f0);
  background: var(--cc-input-bg, rgba(255, 255, 255, 0.08));
  border-color: var(--cc-border, rgba(255, 255, 255, 0.18));
  font-weight: var(--cc-weight-semibold, 600);
}

.peer-settings-tab:focus-visible {
  outline: var(--cc-focus-ring-width, 2px) solid var(--cc-focus-ring, var(--cc-accent, #38bdf8));
  outline-offset: 2px;
}

.peer-settings-panels {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: var(--cc-space-4, 16px);
}

.peer-settings-panel {
  display: flex;
  flex-direction: column;
  gap: var(--cc-space-4, 16px);
}

.peer-settings-group {
  display: flex;
  flex-direction: column;
  gap: var(--cc-space-2, 8px);
  padding-bottom: var(--cc-space-3, 12px);
  border-bottom: 1px solid var(--cc-border, rgba(255, 255, 255, 0.08));
}

.peer-settings-group:last-child {
  border-bottom: none;
  padding-bottom: 0;
}

.peer-settings-group-title {
  margin: 0;
  font-size: var(--cc-type-xs, 11px);
  font-weight: var(--cc-weight-semibold, 600);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--cc-text-muted, #94a3b8);
}

.peer-settings-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--cc-space-3, 12px);
}

.peer-settings-row-meta {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1;
  min-width: 12rem;
}

.peer-settings-row-label {
  font-size: var(--cc-type-sm, 13px);
  font-weight: var(--cc-weight-medium, 500);
  color: var(--cc-text, #e2e8f0);
}

.peer-settings-hint {
  margin: 0;
  font-size: var(--cc-type-xs, 11px);
  color: var(--cc-text-muted, #94a3b8);
}

.peer-settings-controls {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--cc-space-2, 8px);
}

.peer-settings-segmented {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 2px;
  background: var(--cc-input-bg, rgba(15, 23, 42, 0.8));
  border: 1px solid var(--cc-border, rgba(255, 255, 255, 0.14));
  border-radius: var(--cc-radius-sm, 6px);
}

.peer-settings-segmented [aria-pressed="true"] {
  background: var(--cc-ui-selected, rgba(255, 255, 255, 0.12));
  color: var(--cc-text, #e2e8f0);
}

.peer-settings-select {
  min-width: 10rem;
  max-width: 22rem;
  height: 2rem;
  padding: 0 var(--cc-space-2, 8px);
  font-family: var(--cc-font, sans-serif);
  font-size: var(--cc-type-sm, 12px);
  color: var(--cc-text, #e2e8f0);
  background: var(--cc-input-bg, rgba(15, 23, 42, 0.8));
  border: 1px solid var(--cc-border, rgba(255, 255, 255, 0.16));
  border-radius: var(--cc-radius-sm, 6px);
}

.peer-settings-select-narrow {
  min-width: 6.5rem;
}

.peer-settings-textarea {
  width: 100%;
  min-height: 5.5rem;
  padding: var(--cc-space-2, 8px);
  font-family: var(--cc-font-mono, ui-monospace, monospace);
  font-size: var(--cc-type-xs, 11px);
  color: var(--cc-text, #e2e8f0);
  background: var(--cc-input-bg, rgba(15, 23, 42, 0.8));
  border: 1px solid var(--cc-border, rgba(255, 255, 255, 0.16));
  border-radius: var(--cc-radius-sm, 6px);
  resize: vertical;
  box-sizing: border-box;
}

.peer-settings-error {
  margin: 0;
  font-size: var(--cc-type-sm, 12px);
  color: var(--cc-tone-danger, #f87171);
}

.peer-settings-badge {
  padding: 2px 6px;
  font-family: var(--cc-font-mono, ui-monospace, monospace);
  font-size: var(--cc-type-xs, 11px);
  color: var(--cc-text-muted, #94a3b8);
  background: var(--cc-input-bg, rgba(255, 255, 255, 0.06));
  border: 1px solid var(--cc-border, rgba(255, 255, 255, 0.12));
  border-radius: var(--cc-radius-sm, 6px);
}

.peer-settings-theme-grid,
.peer-settings-color-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(12.5rem, 1fr));
  gap: var(--cc-space-2, 8px);
}

.peer-settings-theme-card {
  display: flex;
  flex-direction: column;
  gap: var(--cc-space-2, 8px);
  padding: var(--cc-space-2, 8px);
  background: var(--cc-input-bg, rgba(255, 255, 255, 0.04));
  border: 1px solid var(--cc-border, rgba(255, 255, 255, 0.12));
  border-radius: var(--cc-radius-sm, 6px);
}

.peer-settings-theme-card[data-peer-active="true"] {
  border-color: var(--cc-accent, #38bdf8);
}

.peer-settings-swatches { display: flex; gap: 4px; }

.peer-settings-swatch {
  display: inline-block;
  width: 14px;
  height: 14px;
  flex-shrink: 0;
  border-radius: 3px;
  border: 1px solid var(--cc-border, rgba(255, 255, 255, 0.2));
}

.peer-settings-prompt-list {
  display: flex;
  flex-direction: column;
  gap: var(--cc-space-2, 8px);
}

.peer-settings-prompt-item {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--cc-space-2, 8px);
  padding: 6px 8px;
  border: 1px solid var(--cc-border, rgba(255, 255, 255, 0.08));
  border-radius: var(--cc-radius-sm, 6px);
}

.peer-settings-prompt-item[data-peer-selected="true"] {
  border-color: var(--cc-accent, #38bdf8);
}

.peer-prompt-dialog {
  display: flex;
  flex-direction: column;
  gap: var(--cc-space-3, 12px);
  width: min(46rem, calc(100vw - 3rem));
}

.peer-prompt-dialog-preview {
  min-height: 12rem;
  max-height: 55vh;
  overflow-y: auto;
  padding: var(--cc-space-3, 12px);
  background: var(--cc-input-bg, rgba(15, 23, 42, 0.6));
  border: 1px solid var(--cc-border, rgba(255, 255, 255, 0.14));
  border-radius: var(--cc-radius-sm, 6px);
}

.peer-settings-report {
  margin: 0;
  padding-left: var(--cc-space-4, 16px);
  font-size: var(--cc-type-sm, 12px);
  color: var(--cc-text-muted, #94a3b8);
}

.peer-settings-steps {
  display: flex;
  gap: var(--cc-space-2, 8px);
  padding-bottom: var(--cc-space-2, 8px);
  border-bottom: 1px solid var(--cc-border, rgba(255, 255, 255, 0.1));
}
`;

export function injectSettingsStyles(doc = globalThis.document, { nonce } = {}) {
  if (!doc?.createElement || !doc.head) return null;
  const existing = doc.getElementById(SETTINGS_STYLE_ID);
  if (existing) return existing;
  const style = doc.createElement('style');
  style.id = SETTINGS_STYLE_ID;
  if (nonce) style.setAttribute('nonce', String(nonce));
  style.textContent = SETTINGS_CSS;
  doc.head.append(style);
  return style;
}
