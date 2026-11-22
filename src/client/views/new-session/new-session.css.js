/**
 * Styles for `/chat/new` draft screen (`views §1.2` rule 10, `C2a §4.2`).
 * Uses only `--cc-*` and `--peer-*` custom properties.
 */

export const NEW_SESSION_STYLE_ID = "peer-new-session-styles";

export const NEW_SESSION_CSS = `/* ------------------ PEER: NEW SESSION VIEW ------------------ */

.peer-new-session {
	display: flex;
	flex-direction: column;
	flex: 1;
	min-width: 0;
	min-height: 0;
	color: var(--cc-text, #e2e8f0);
}

.peer-new-session [hidden] {
	display: none !important;
}

.peer-new-session-body {
	display: flex;
	flex-direction: column;
	gap: var(--cc-space-4, 16px);
	flex: 1;
	width: min(46rem, 100%);
	margin: 0 auto;
	padding: var(--cc-space-6, 24px) var(--cc-space-4, 16px);
	box-sizing: border-box;
	overflow-y: auto;
}

.peer-new-session-toolbar {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	justify-content: space-between;
	gap: var(--cc-space-3, 12px);
}

.peer-new-session-modes,
.peer-new-session-model-pill,
.peer-new-session-attach-group {
	display: inline-flex;
	align-items: center;
	gap: var(--cc-space-2, 8px);
}

.peer-new-session-mode.is-active {
	border-color: var(--cc-accent, #38bdf8);
	color: var(--cc-text, #e2e8f0);
}

.peer-new-session-model-badge {
	padding: 2px var(--cc-space-2, 8px);
	font-size: var(--cc-type-xs, 11px);
	color: var(--cc-text-muted, #94a3b8);
	background: var(--cc-input-bg, rgba(255, 255, 255, 0.05));
	border: 1px solid var(--cc-border, var(--cc-card-border, rgba(255, 255, 255, 0.12)));
	border-radius: var(--cc-radius-pill, 9999px);
}

.peer-new-session-picker,
.peer-new-session-card {
	display: flex;
	flex-direction: column;
	gap: var(--cc-space-2, 8px);
	padding: var(--cc-space-3, 12px);
	background: var(--cc-card-bg, rgba(15, 23, 42, 0.78));
	border: 1px solid var(--cc-border, var(--cc-card-border, rgba(255, 255, 255, 0.12)));
	border-radius: var(--cc-radius-md, 10px);
}

.peer-new-session-picker-head,
.peer-new-session-actions {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: var(--cc-space-2, 8px);
}

.peer-new-session-picker-list {
	display: flex;
	flex-direction: column;
	gap: var(--cc-space-1, 4px);
	max-height: 15rem;
	overflow-y: auto;
}

.peer-new-session-prop {
	display: flex;
	flex-direction: column;
	align-items: flex-start;
	gap: 2px;
	width: 100%;
	text-align: left;
}

.peer-new-session-prop.is-picked {
	border-color: var(--cc-accent, #38bdf8);
}

.peer-new-session-prop-statement,
.peer-new-session-hint {
	font-size: var(--cc-type-xs, 11px);
	color: var(--cc-text-muted, #94a3b8);
}

.peer-new-session-draft {
	width: 100%;
	min-height: 5rem;
	resize: vertical;
	box-sizing: border-box;
}

.peer-new-session-chips {
	display: flex;
	flex-wrap: wrap;
	gap: var(--cc-space-1, 4px);
}

.peer-new-session-chip {
	display: inline-flex;
	align-items: center;
	gap: var(--cc-space-1, 4px);
	padding: 2px var(--cc-space-2, 8px);
	font-size: var(--cc-type-xs, 11px);
	background: var(--cc-input-bg, rgba(255, 255, 255, 0.06));
	border: 1px solid var(--cc-border, var(--cc-card-border, rgba(255, 255, 255, 0.12)));
	border-radius: var(--cc-radius-pill, 9999px);
}

.peer-new-session-error {
	color: var(--cc-tone-danger, #f87171);
	font-size: var(--cc-type-sm, 12px);
}
`;

export function injectNewSessionStyles(doc = globalThis.document, { nonce } = {}) {
	if (!doc?.createElement || !doc.head) return null;
	const existing = doc.getElementById(NEW_SESSION_STYLE_ID);
	if (existing) return existing;
	const style = doc.createElement("style");
	style.id = NEW_SESSION_STYLE_ID;
	if (nonce) style.setAttribute("nonce", String(nonce));
	style.textContent = NEW_SESSION_CSS;
	doc.head.append(style);
	return style;
}
