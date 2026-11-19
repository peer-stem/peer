/**
 * Shared styles for peer top-bar, pending route screen, and not-found screen.
 * Uses only `--cc-*` and `--peer-*` custom properties (`views §1.2` rule 10).
 */

export const SHARED_STYLE_ID = 'peer-shared-styles';

export const SHARED_CSS = `/* ------------------ PEER: SHARED VIEWS ------------------ */

.peer-shared-top-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--cc-space-3, 12px);
  min-height: 3rem;
  padding: var(--cc-space-2, 8px) var(--cc-space-4, 16px);
  background: var(--cc-card-bg, rgba(15, 23, 42, 0.88));
  border-bottom: 1px solid var(--cc-border, var(--cc-card-border, rgba(255, 255, 255, 0.1)));
  box-sizing: border-box;
}

.peer-shared-top-bar-start,
.peer-shared-top-bar-end {
  display: inline-flex;
  align-items: center;
  gap: var(--cc-space-2, 8px);
  flex: none;
}

.peer-shared-top-bar-heading {
  display: flex;
  align-items: baseline;
  gap: var(--cc-space-2, 8px);
  flex: 1;
  min-width: 0;
}

.peer-shared-top-bar-title {
  margin: 0;
  font-family: var(--peer-font-title, var(--cc-font, sans-serif));
  font-size: var(--cc-type-lg, 15px);
  font-weight: var(--peer-heading-weight, var(--cc-weight-semibold, 600));
  color: var(--cc-text, #e2e8f0);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.peer-shared-top-bar-kind,
.peer-shared-top-bar-badge {
  display: inline-flex;
  align-items: center;
  padding: 2px var(--cc-space-2, 8px);
  font-size: var(--cc-type-xs, 11px);
  color: var(--cc-text-muted, #94a3b8);
  background: var(--cc-input-bg, rgba(255, 255, 255, 0.06));
  border: 1px solid var(--cc-border, var(--cc-card-border, rgba(255, 255, 255, 0.1)));
  border-radius: var(--cc-radius-pill, 9999px);
  white-space: nowrap;
}

.peer-shared-top-bar-subtitle {
  font-size: var(--cc-type-sm, 12px);
  color: var(--cc-text-muted, #94a3b8);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.peer-shared-pending,
.peer-shared-not-found {
  display: grid;
  place-items: center;
  align-content: center;
  gap: var(--cc-space-3, 12px);
  flex: 1;
  min-height: 16rem;
  padding: var(--cc-space-6, 24px);
  box-sizing: border-box;
}

.peer-shared-not-found-actions {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--cc-space-2, 8px);
}
`;

export function injectSharedStyles(doc = globalThis.document, { nonce } = {}) {
  if (!doc?.createElement || !doc.head) return null;
  const existing = doc.getElementById(SHARED_STYLE_ID);
  if (existing) return existing;
  const style = doc.createElement('style');
  style.id = SHARED_STYLE_ID;
  if (nonce) style.setAttribute('nonce', String(nonce));
  style.textContent = SHARED_CSS;
  doc.head.append(style);
  return style;
}
