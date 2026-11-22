/**
 * Styles for persistent peer overlays (`cheat-sheet`, `pan-zoom-viewer`, and
 * `startup-message-dialog`). Uses only `--cc-*` and `--peer-*` custom properties.
 */

export const OVERLAYS_STYLE_ID = "peer-overlays-styles";

export const OVERLAYS_CSS = `/* ------------------ PEER: OVERLAYS ------------------ */

.peer-overlays-cheat-dialog .cloudcanvas-ui-dialog-panel {
	width: min(36rem, calc(100vw - 2rem));
}

.peer-overlays-cheat-body {
	display: flex;
	flex-direction: column;
	gap: var(--cc-space-3, 12px);
}

.peer-overlays-cheat-group {
	display: flex;
	flex-direction: column;
	gap: var(--cc-space-1, 4px);
}

.peer-overlays-cheat-heading {
	font-size: var(--cc-type-xs, 11px);
	text-transform: uppercase;
	letter-spacing: 0.06em;
	color: var(--cc-text-muted, #94a3b8);
}

.peer-overlays-cheat-row {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: var(--cc-space-3, 12px);
	font-size: var(--cc-type-sm, 12px);
}

.peer-overlays-kbd {
	padding: 2px 6px;
	font-family: var(--cc-font-mono, ui-monospace, monospace);
	font-size: var(--cc-type-xs, 11px);
	background: var(--cc-input-bg, rgba(255, 255, 255, 0.06));
	border: 1px solid var(--cc-border, var(--cc-card-border, rgba(255, 255, 255, 0.14)));
	border-radius: var(--cc-radius-sm, 6px);
}

.peer-overlays-viewer-dialog .cloudcanvas-ui-dialog-panel {
	width: min(72rem, calc(100vw - 2rem));
	height: min(48rem, calc(100dvh - 2rem));
	padding: 0;
	overflow: hidden;
}

.peer-overlays-viewer-dialog .cloudcanvas-ui-dialog-body {
	display: flex;
	flex: 1;
	min-height: 0;
	padding: 0;
}

.peer-overlays-viewer-frame {
	display: flex;
	flex-direction: column;
	flex: 1;
	width: 100%;
	height: 100%;
	min-height: 20rem;
	box-sizing: border-box;
}

.peer-overlays-viewer-bar {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: var(--cc-space-3, 12px);
	padding: var(--cc-space-3, 12px) var(--cc-space-4, 16px);
	border-bottom: 1px solid var(--cc-border, var(--cc-card-border, rgba(255, 255, 255, 0.1)));
}

.peer-overlays-viewer-title {
	margin: 0;
	font-family: var(--peer-font-title, var(--cc-font, sans-serif));
	font-size: var(--cc-type-md, 14px);
	font-weight: var(--cc-weight-semibold, 600);
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

.peer-overlays-viewer-controls {
	display: flex;
	align-items: center;
	gap: var(--cc-space-2, 8px);
}

.peer-overlays-viewer-scale {
	min-width: 3.25rem;
	text-align: center;
	font-family: var(--cc-font-mono, ui-monospace, monospace);
	font-size: var(--cc-type-xs, 11px);
	color: var(--cc-text-muted, #94a3b8);
}

.peer-overlays-viewer-stage {
	position: relative;
	flex: 1;
	min-height: 18rem;
	display: flex;
	overflow: hidden;
	background: var(--cc-bg, #0b1120);
}

.peer-overlays-viewer-stage > .cloudcanvas-ui-pan-zoom {
	flex: 1;
	width: 100%;
	height: 100%;
}

.peer-overlays-viewer-img {
	display: block;
	max-width: 82vw;
	max-height: 72dvh;
	object-fit: contain;
}

.peer-overlays-viewer-code {
	margin: 0;
	padding: var(--cc-space-4, 16px);
	max-width: 80vw;
	max-height: 70dvh;
	overflow: auto;
	font-family: var(--cc-font-mono, ui-monospace, monospace);
	font-size: var(--cc-type-sm, 12px);
	color: var(--cc-text, #e2e8f0);
	background: var(--cc-card-bg, rgba(15, 23, 42, 0.9));
	border: 1px solid var(--cc-border, rgba(255, 255, 255, 0.1));
	border-radius: var(--cc-radius-sm, 6px);
}

.peer-overlays-startup-dialog .cloudcanvas-ui-dialog-panel {
	width: min(36rem, calc(100vw - 2rem));
	max-height: 85dvh;
}

.peer-overlays-startup-content {
	display: flex;
	flex-direction: column;
	gap: var(--cc-space-3, 12px);
}

.peer-overlays-startup-date {
	font-size: var(--cc-type-xs, 11px);
	color: var(--cc-text-muted, #94a3b8);
}

.peer-overlays-startup-body {
	overflow-y: auto;
	font-family: var(--peer-font-prose, var(--cc-font, sans-serif));
	font-size: var(--peer-prose-size, var(--cc-type-md, 14px));
}

.peer-overlays-startup-link {
	color: var(--cc-accent, #38bdf8);
	text-decoration: underline;
}

.peer-overlays-startup-footer {
	display: flex;
	justify-content: flex-end;
	padding-top: var(--cc-space-2, 8px);
	border-top: 1px solid var(--cc-border, rgba(255, 255, 255, 0.1));
}
`;

export function injectOverlaysStyles(doc = globalThis.document, { nonce } = {}) {
	if (!doc?.createElement || !doc.head) return null;
	const existing = doc.getElementById(OVERLAYS_STYLE_ID);
	if (existing) return existing;
	const style = doc.createElement("style");
	style.id = OVERLAYS_STYLE_ID;
	if (nonce) style.setAttribute("nonce", String(nonce));
	style.textContent = OVERLAYS_CSS;
	doc.head.append(style);
	return style;
}
