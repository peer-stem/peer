/**
 * Styles for the peer application shell, sidebar rail, and persistent layer overlays.
 * Uses only `--cc-*` and `--peer-*` custom properties (`views §1.2` rule 10, `§2.1`).
 */

export const SHELL_STYLE_ID = 'peer-shell-styles';

export const SHELL_CSS = `/* ------------------ PEER: SHELL ------------------ */

.peer-shell {
  display: flex;
  flex-direction: row;
  height: 100dvh;
  min-height: 100dvh;
  width: 100%;
  overflow: hidden;
  background: var(--cc-bg, #0b1120);
  color: var(--cc-text, #e2e8f0);
  font-family: var(--cc-font, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif);
  box-sizing: border-box;
}

.peer-shell-side {
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  width: 18rem;
  height: 100%;
  min-height: 0;
  overflow: hidden;
  background: var(--cc-card-bg, rgba(15, 23, 42, 0.92));
  border-right: 1px solid var(--cc-border, var(--cc-card-border, rgba(255, 255, 255, 0.1)));
  box-sizing: border-box;
}

.peer-shell-side[data-peer-narrow="true"] {
  width: 14rem;
}

.peer-shell-side[hidden],
.peer-shell-update[hidden],
.peer-shell-backdrop[hidden],
.peer-shell-modal[hidden] {
  display: none;
}

.peer-shell-nav {
  display: flex;
  flex-direction: column;
  gap: var(--cc-space-1, 4px);
}

.peer-shell-nav .cloudcanvas-ui-button {
  width: 100%;
  text-align: left;
}

.peer-shell-content {
  flex: 1 1 0%;
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  height: 100%;
  overflow: auto;
}

.peer-shell-layer {
  position: fixed;
  inset: 0;
  z-index: var(--cc-z-ui-dialog, 1350);
  pointer-events: none;
}

.peer-shell-update {
  position: fixed;
  top: var(--cc-space-3, 12px);
  right: var(--cc-space-3, 12px);
  padding: var(--cc-space-2, 8px) var(--cc-space-3, 12px);
  font-size: var(--cc-type-xs, 11px);
  color: var(--cc-text, #e2e8f0);
  background: var(--cc-ui-surface, var(--cc-card-bg, rgba(30, 41, 59, 0.92)));
  border: 1px solid var(--cc-border, var(--cc-card-border, rgba(255, 255, 255, 0.1)));
  border-radius: var(--cc-radius-sm, 6px);
  pointer-events: auto;
}

.peer-shell-backdrop {
  position: fixed;
  inset: 0;
  display: grid;
  place-items: center;
  padding: var(--cc-space-4, 16px);
  background: var(--cc-ui-backdrop, rgba(2, 6, 23, 0.6));
  pointer-events: auto;
  box-sizing: border-box;
}

.peer-shell-modal {
  display: flex;
  flex-direction: column;
  gap: var(--cc-space-3, 12px);
  width: min(36rem, calc(100vw - 2rem));
  max-height: calc(100dvh - 2rem);
  overflow: auto;
  padding: var(--cc-space-4, 16px);
  background: var(--cc-ui-surface, var(--cc-card-bg, rgba(30, 41, 59, 0.96)));
  border: 1px solid var(--cc-border, var(--cc-card-border, rgba(255, 255, 255, 0.12)));
  border-radius: var(--cc-radius-md, 10px);
  box-shadow: var(--cc-shadow-2, 0 12px 32px rgba(0, 0, 0, 0.55));
  box-sizing: border-box;
}

.peer-shell-modal:focus-visible {
  outline: var(--cc-focus-ring-width, 2px) solid var(--cc-focus-ring, var(--cc-accent, #38bdf8));
  outline-offset: var(--cc-focus-ring-offset, 2px);
}

.peer-shell-modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--cc-space-2, 8px);
}

.peer-shell-modal-title {
  margin: 0;
  font-family: var(--peer-font-title, var(--cc-font, sans-serif));
  font-size: var(--cc-type-lg, 15px);
  font-weight: var(--peer-heading-weight, 600);
}
`;

export function injectShellStyles(doc = globalThis.document, { nonce } = {}) {
  if (!doc?.createElement || !doc.head) return null;
  const existing = doc.getElementById(SHELL_STYLE_ID);
  if (existing) return existing;
  const style = doc.createElement('style');
  style.id = SHELL_STYLE_ID;
  if (nonce) style.setAttribute('nonce', String(nonce));
  style.textContent = SHELL_CSS;
  doc.head.append(style);
  return style;
}
