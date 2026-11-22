/**
 * Styles for the peer Home screen, Graph/Chains tab bar, minimal-home summary,
 * and floating quick-start session composer dock.
 * Uses only `--cc-*` and `--peer-*` custom properties (`views §1.2` rule 10).
 */

export const HOME_STYLE_ID = 'peer-home-styles';

export const HOME_CSS = `/* ------------------ PEER: HOME VIEW ------------------ */

.peer-home {
  position: relative;
  display: flex;
  flex-direction: column;
  flex: 1 1 0%;
  width: 100%;
  height: 100%;
  min-height: 0;
  background: var(--cc-bg, #141414);
  color: var(--cc-text, #e6e6e6);
  box-sizing: border-box;
}

.peer-home-subbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--cc-space-2, 8px);
  padding: var(--cc-space-2, 8px) var(--cc-space-4, 16px);
  border-bottom: 1px solid var(--cc-border, #434343);
  background: var(--cc-card-bg, #1c1c1c);
}

.peer-home-tabs {
  display: inline-flex;
  align-items: center;
  gap: var(--cc-space-1, 4px);
}

.peer-home-tab[aria-selected="true"] {
  background: var(--cc-ui-selected, #2a2a2a);
  color: var(--cc-text, #e6e6e6);
}

.peer-home-body {
  position: relative;
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  overflow: auto;
}

.peer-home-minimal,
.peer-home-chains-pane {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  gap: var(--cc-space-3, 12px);
}

.peer-home-minimal-top {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--cc-space-3, 12px);
  padding: var(--cc-space-3, 12px) var(--cc-space-4, 16px) 0;
}

.peer-home-summary {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--cc-space-3, 12px);
  font-size: var(--cc-type-xs, 12px);
  color: var(--cc-text-muted, #8d8d8d);
}

.peer-home-dock {
  display: flex;
  flex-direction: column;
  gap: var(--cc-space-2, 8px);
  width: min(46rem, 100%);
  margin: 0 auto;
  padding: var(--cc-space-3, 12px) var(--cc-space-4, 16px);
  box-sizing: border-box;
}

.peer-home-dock-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--cc-space-2, 8px);
}

.peer-home-picked-bar {
  display: inline-flex;
  align-items: center;
  gap: var(--cc-space-2, 8px);
  font-size: var(--cc-type-xs, 12px);
  color: var(--cc-text-muted, #8d8d8d);
}

.peer-home-start-error {
  margin: 0;
  font-size: var(--cc-type-xs, 12px);
  color: var(--cc-tone-danger, #ef4444);
}

.peer-home-composer {
  display: flex;
  align-items: flex-end;
  gap: var(--cc-space-2, 8px);
  padding: var(--cc-space-2, 8px);
  background: var(--cc-ui-surface, var(--cc-card-bg, #1c1c1c));
  border: 1px solid var(--cc-border, #434343);
  border-radius: var(--cc-radius-md, 10px);
}

.peer-home-input {
  flex: 1;
  min-height: 2.5rem;
  max-height: 9rem;
  resize: vertical;
}

.peer-home-modes {
  display: inline-flex;
  align-items: center;
  gap: var(--cc-space-1, 4px);
}

.peer-home-mode[aria-pressed="true"] {
  background: var(--cc-ui-selected, #2a2a2a);
  color: var(--cc-text, #e6e6e6);
}
`;

export function injectHomeStyles(doc = globalThis.document, { nonce } = {}) {
  if (!doc?.createElement || !doc.head) return null;
  const existing = doc.getElementById(HOME_STYLE_ID);
  if (existing) return existing;
  const style = doc.createElement('style');
  style.id = HOME_STYLE_ID;
  if (nonce) style.setAttribute('nonce', String(nonce));
  style.textContent = HOME_CSS;
  doc.head.append(style);
  return style;
}
