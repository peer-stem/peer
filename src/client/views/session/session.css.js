/**
 * Styles for the read-only session transcript view (`views §1.2` rule 10, `§2.5`).
 * Uses only `--cc-*` and `--peer-*` tokens.
 */

export const SESSION_STYLE_ID = 'peer-session-styles';

export const SESSION_CSS = `/* ------------------ PEER: SESSION VIEW ------------------ */

.peer-session {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
  min-height: 0;
  color: var(--cc-text, #e2e8f0);
}

.peer-session-status {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--cc-space-3, 12px);
  flex: 1;
  padding: var(--cc-space-6, 24px);
}

.peer-session-transcript {
  display: flex;
  flex-direction: column;
  gap: var(--cc-space-4, 16px);
  flex: 1;
  width: min(52rem, 100%);
  margin: 0 auto;
  padding: var(--cc-space-4, 16px);
  box-sizing: border-box;
  font-family: var(--peer-font-prose, var(--cc-font, sans-serif));
  font-size: var(--peer-prose-size, var(--cc-type-md, 14px));
}

.peer-session-status[hidden],
.peer-session-transcript[hidden],
.peer-session-footer[hidden],
.peer-session-turn-error[hidden] {
  display: none;
}

.peer-session-message {
  display: flex;
  flex-direction: column;
  gap: var(--cc-space-2, 8px);
  min-width: 0;
}

.peer-session-message[data-peer-role="user"] {
  align-self: flex-end;
  max-width: min(40rem, 92%);
  padding: var(--cc-space-3, 12px) var(--cc-space-4, 16px);
  background: var(--cc-card-bg, rgba(30, 41, 59, 0.85));
  border: 1px solid var(--cc-border, var(--cc-card-border, rgba(255, 255, 255, 0.1)));
  border-radius: var(--cc-radius-md, 10px);
}

.peer-session-message[data-peer-role="assistant"] {
  width: 100%;
}

.peer-session-context,
.peer-session-thinking {
  padding: var(--cc-space-2, 8px) var(--cc-space-3, 12px);
  background: var(--cc-input-bg, rgba(255, 255, 255, 0.04));
  border: 1px solid var(--cc-border, var(--cc-card-border, rgba(255, 255, 255, 0.1)));
  border-radius: var(--cc-radius-sm, 6px);
  font-size: var(--cc-type-sm, 12px);
}

.peer-session-context > summary,
.peer-session-thinking > summary,
.peer-session-divider details > summary {
  cursor: pointer;
  color: var(--cc-text-muted, #94a3b8);
  font-weight: var(--cc-weight-medium, 500);
}

.peer-session-context > summary:focus-visible,
.peer-session-thinking > summary:focus-visible,
.peer-session-divider details > summary:focus-visible {
  outline: var(--cc-focus-ring-width, 2px) solid var(--cc-focus-ring, var(--cc-accent, #38bdf8));
  outline-offset: var(--cc-focus-ring-offset, 2px);
}

.peer-session-thinking-body,
.peer-session-context-body,
.peer-session-divider-body {
  margin-top: var(--cc-space-2, 8px);
  white-space: pre-wrap;
  color: var(--cc-text-muted, #94a3b8);
}

.peer-session-context-list,
.peer-session-card-list {
  margin: var(--cc-space-1, 4px) 0 0;
  padding-left: var(--cc-space-4, 16px);
}

.peer-session-divider {
  padding: var(--cc-space-2, 8px) var(--cc-space-3, 12px);
  text-align: center;
  font-size: var(--cc-type-xs, 11px);
  color: var(--cc-text-muted, #94a3b8);
  border-top: 1px dashed var(--cc-border, var(--cc-card-border, rgba(255, 255, 255, 0.15)));
  border-bottom: 1px dashed var(--cc-border, var(--cc-card-border, rgba(255, 255, 255, 0.15)));
}

.peer-session-divider-body {
  text-align: left;
}

.peer-session-image {
  display: inline-flex;
  flex-direction: column;
  gap: var(--cc-space-1, 4px);
  margin: 0;
  max-width: 100%;
}

.peer-session-image img {
  max-width: 100%;
  height: auto;
  border-radius: var(--cc-radius-sm, 6px);
  border: 1px solid var(--cc-border, var(--cc-card-border, rgba(255, 255, 255, 0.1)));
}

.peer-session-image figcaption {
  font-size: var(--cc-type-xs, 11px);
  color: var(--cc-text-muted, #94a3b8);
}

.peer-session-card {
  display: flex;
  flex-direction: column;
  gap: var(--cc-space-1, 4px);
  padding: var(--cc-space-2, 8px) var(--cc-space-3, 12px);
  background: var(--cc-input-bg, rgba(255, 255, 255, 0.05));
  border: 1px solid var(--cc-border, var(--cc-card-border, rgba(255, 255, 255, 0.1)));
  border-radius: var(--cc-radius-sm, 6px);
  font-size: var(--cc-type-sm, 12px);
}

.peer-session-card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--cc-space-2, 8px);
}

.peer-session-card-title {
  font-weight: var(--cc-weight-semibold, 600);
  color: var(--cc-text, #e2e8f0);
}

.peer-session-card-meta {
  font-size: var(--cc-type-xs, 11px);
  color: var(--cc-text-muted, #94a3b8);
}

.peer-session-card-error,
.peer-session-turn-error {
  color: var(--cc-tone-danger, #f87171);
  font-size: var(--cc-type-sm, 12px);
}

.peer-session-footer {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--cc-space-2, 8px);
  padding: var(--cc-space-2, 8px) var(--cc-space-4, 16px);
  font-size: var(--cc-type-xs, 11px);
  color: var(--cc-text-muted, #94a3b8);
  background: var(--cc-card-bg, rgba(15, 23, 42, 0.88));
  border-top: 1px solid var(--cc-border, var(--cc-card-border, rgba(255, 255, 255, 0.1)));
}
`;

export function injectSessionStyles(doc = globalThis.document, { nonce } = {}) {
  if (!doc?.createElement || !doc.head) return null;
  const existing = doc.getElementById(SESSION_STYLE_ID);
  if (existing) return existing;
  const style = doc.createElement('style');
  style.id = SESSION_STYLE_ID;
  if (nonce) style.setAttribute('nonce', String(nonce));
  style.textContent = SESSION_CSS;
  doc.head.append(style);
  return style;
}
