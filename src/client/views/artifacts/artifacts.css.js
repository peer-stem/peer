/**
 * Styles for session artifact & tool cards (`dispatch-card`, `demo-card`, `visual-card`,
 * `job-card`, `steer-card`, `probe-done-card`, `live-tool-card`, `tool-call-card`).
 * Strictly uses `--cc-*` and `--peer-*` custom properties.
 */

export const ARTIFACTS_STYLE_ID = "peer-artifacts-styles";

export const ARTIFACTS_CSS = `/* ------------------ PEER: ARTIFACT & TOOL CARDS ------------------ */
.peer-dispatch-card, .peer-demo-card, .peer-brief-card, .peer-probe-done-box,
.peer-job-delivery-failure, .peer-artifact-fallback {
	display: flex; flex-direction: column; gap: var(--cc-space-2, 8px);
	padding: var(--cc-space-4, 16px); box-sizing: border-box;
	background: var(--cc-card-bg, rgba(15, 23, 42, 0.78));
	border: 1px solid var(--cc-border, rgba(255, 255, 255, 0.12));
	border-radius: var(--cc-radius-md, 12px); color: var(--cc-text, #e2e8f0);
}
.peer-dispatch-head, .peer-dispatch-settled, .peer-dispatch-refused,
.peer-job-aborted, .peer-brief-head, .peer-demo-title-group, .peer-demo-actions {
	display: flex; align-items: center; gap: var(--cc-space-2, 8px);
}
.peer-dispatch-head, .peer-dispatch-settled, .peer-dispatch-refused,
.peer-job-aborted, .peer-brief-head, .peer-demo-eyebrow, .peer-visual-eyebrow {
	font-size: var(--cc-type-xs, 11px); color: var(--cc-text-muted, #94a3b8);
}
.peer-dispatch-label, .peer-demo-eyebrow, .peer-visual-eyebrow, .peer-brief-eyebrow,
.peer-tool-label {
	font-weight: var(--cc-weight-medium, 500); text-transform: uppercase; letter-spacing: 0.05em;
}
.peer-dispatch-activity, .peer-dispatch-pending, .peer-artifact-note {
	font-size: var(--cc-type-sm, 13px); color: var(--cc-text-muted, #94a3b8); margin: 0;
}
.peer-dispatch-activity { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.peer-dispatch-glyph.is-error, .peer-tool-label.is-error, .peer-artifact-badge-error {
	color: var(--cc-tone-danger, #ef4444);
}
.peer-artifact-badge-error {
	padding: 1px 6px; border-radius: var(--cc-radius-xs, 4px);
	background: color-mix(in oklab, var(--cc-tone-danger, #ef4444) 15%, transparent);
	font-size: var(--cc-type-xs, 11px); text-transform: lowercase;
}
.peer-dispatch-setup-btn {
	padding: 2px var(--cc-space-2, 8px); font-size: var(--cc-type-xs, 11px); cursor: pointer;
	background: var(--cc-card-bg, rgba(15, 23, 42, 0.9)); color: var(--cc-text, #e2e8f0);
	border: 1px solid var(--cc-border, rgba(255, 255, 255, 0.16)); border-radius: var(--cc-radius-xs, 4px);
}

/* Demo & Visual cards */
.peer-demo-header, .peer-visual-caption-row {
	display: flex; align-items: center; justify-content: space-between; gap: var(--cc-space-2, 8px);
}
.peer-demo-title {
	min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
	font-size: var(--cc-type-xs, 12px); font-weight: var(--cc-weight-medium, 500); color: var(--cc-text, #e2e8f0);
}
.peer-artifact-icon-btn {
	display: inline-flex; align-items: center; justify-content: center; gap: 4px;
	padding: 4px var(--cc-space-2, 8px); font-size: var(--cc-type-xs, 11px); cursor: pointer;
	background: var(--cc-input-bg, rgba(255, 255, 255, 0.04)); color: var(--cc-text-muted, #94a3b8);
	border: 1px solid var(--cc-border, rgba(255, 255, 255, 0.12)); border-radius: var(--cc-radius-sm, 6px);
}
.peer-artifact-icon-btn[aria-pressed="true"] {
	color: var(--cc-accent, #38bdf8); border-color: var(--cc-accent, #38bdf8);
}
.peer-demo-iframe {
	width: 100%; border-radius: var(--cc-radius-sm, 8px);
	border: 1px solid var(--cc-border, rgba(255, 255, 255, 0.14));
	background: var(--peer-artifact-canvas-bg, #ffffff); box-sizing: content-box;
}
.peer-demo-error-chip {
	display: flex; flex-wrap: wrap; align-items: center; gap: var(--cc-space-2, 8px);
	padding: var(--cc-space-2, 8px) var(--cc-space-3, 12px); border-radius: var(--cc-radius-sm, 8px);
	background: color-mix(in oklab, var(--cc-tone-danger, #ef4444) 12%, transparent);
	color: var(--cc-tone-danger, #ef4444); font-size: var(--cc-type-sm, 13px);
}
.peer-demo-error-msg {
	flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
	font-family: var(--cc-font-mono, ui-monospace, monospace); font-size: var(--cc-type-xs, 11px);
}
.peer-demo-error-send {
	padding: 3px var(--cc-space-2, 8px); font-size: var(--cc-type-xs, 11px); cursor: pointer;
	background: transparent; color: var(--cc-tone-danger, #ef4444);
	border: 1px solid color-mix(in oklab, var(--cc-tone-danger, #ef4444) 45%, transparent);
	border-radius: var(--cc-radius-xs, 6px);
}
.peer-visual-card { display: flex; flex-direction: column; gap: var(--cc-space-2, 8px); width: 100%; margin: var(--cc-space-2, 8px) 0; }
.peer-visual-card.is-natural { width: fit-content; max-width: 100%; margin-left: auto; margin-right: auto; }
.peer-visual-svg {
	width: 100%; overflow: hidden; border-radius: var(--cc-radius-sm, 8px);
	background: var(--peer-artifact-canvas-bg, #ffffff);
}
.peer-visual-svg.is-natural { width: fit-content; max-width: 100%; }
.peer-visual-svg img { display: block; height: auto; width: 100%; }
.peer-visual-svg.is-natural img { width: auto; max-width: 100%; }
.peer-visual-svg.is-annotated img { width: auto; max-height: 60vh; max-width: 100%; }

/* Worker details, Briefs, Probe done, Tool cards */
.peer-worker-details, .peer-live-tool-card, .peer-tool-call-card {
	width: 100%; font-size: var(--cc-type-xs, 12px); color: var(--cc-text-muted, #94a3b8);
}
.peer-worker-summary, .peer-tool-summary {
	display: flex; align-items: center; gap: var(--cc-space-2, 8px);
	cursor: pointer; list-style: none; user-select: none;
}
.peer-worker-summary::-webkit-details-marker, .peer-tool-summary::-webkit-details-marker,
.peer-probe-done > summary::-webkit-details-marker { display: none; }
.peer-worker-details[open] .peer-worker-view-label { display: none; }
.peer-worker-details:not([open]) .peer-worker-hide-label { display: none; }
.peer-worker-body { margin-top: var(--cc-space-2, 8px); }
.peer-brief-meta, .peer-brief-sources {
	margin-top: var(--cc-space-2, 8px); padding-top: var(--cc-space-2, 8px);
	border-top: 1px solid var(--cc-border, rgba(255, 255, 255, 0.1));
	font-size: var(--cc-type-xs, 11px); color: var(--cc-text-muted, #94a3b8);
}
.peer-brief-source-list { margin: 4px 0 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 2px; }
.peer-brief-source-link { color: var(--cc-accent, #38bdf8); text-decoration: none; }
.peer-brief-source-link:hover { text-decoration: underline; }
.peer-probe-done {
	overflow: hidden; border-radius: var(--cc-radius-md, 12px);
	border: 1px solid var(--cc-border, rgba(255, 255, 255, 0.12));
	background: var(--cc-card-bg, rgba(15, 23, 42, 0.65));
}
.peer-probe-done > summary {
	display: flex; align-items: center; gap: var(--cc-space-2, 8px); cursor: pointer; list-style: none;
	padding: var(--cc-space-3, 12px); font-size: var(--cc-type-xs, 11px);
	font-weight: var(--cc-weight-medium, 500); text-transform: uppercase; letter-spacing: 0.05em;
	color: var(--cc-text-muted, #94a3b8);
}
.peer-probe-done[open] > summary { border-bottom: 1px solid var(--cc-border, rgba(255, 255, 255, 0.1)); }
.peer-probe-done-count { margin-left: auto; text-transform: none; letter-spacing: normal; font-weight: normal; }
.peer-probe-done-strand {
	padding: var(--cc-space-2, 8px) var(--cc-space-3, 12px);
	border-top: 1px solid var(--cc-border, rgba(255, 255, 255, 0.08));
}
.peer-probe-done-strand:first-child { border-top: 0; }
.peer-probe-done-strand-title { font-size: var(--cc-type-sm, 13px); font-weight: var(--cc-weight-medium, 500); color: var(--cc-text, #e2e8f0); }
.peer-probe-done-strand-body { margin-top: 2px; font-size: var(--cc-type-sm, 13px); color: var(--cc-text-muted, #94a3b8); }
.peer-tool-arg { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.peer-tool-body {
	display: flex; flex-direction: column; gap: var(--cc-space-2, 8px); margin-top: var(--cc-space-2, 8px);
	padding: var(--cc-space-3, 12px); border-radius: var(--cc-radius-md, 10px);
	border: 1px solid var(--cc-border, rgba(255, 255, 255, 0.12));
	background: var(--cc-card-bg, rgba(15, 23, 42, 0.78));
}
.peer-tool-pre {
	margin: 4px 0 0; max-height: 14rem; overflow: auto; white-space: pre-wrap; word-break: break-all;
	font-family: var(--cc-font-mono, ui-monospace, monospace); font-size: var(--cc-type-xs, 11px);
	color: var(--cc-text, #e2e8f0);
}
.peer-tool-pre.is-error { color: var(--cc-tone-danger, #ef4444); }
.peer-plugin-worker { display: flex; flex-direction: column; gap: var(--cc-space-2, 8px); }
.peer-plugin-worker-fallback { display: flex; flex-direction: column; gap: var(--cc-space-2, 8px); font-size: var(--cc-type-sm, 13px); }
`;

export function injectArtifactsStyles(doc = globalThis.document, { nonce } = {}) {
	if (!doc?.createElement || !doc.head) return null;
	const existing = doc.getElementById(ARTIFACTS_STYLE_ID);
	if (existing) return existing;
	const style = doc.createElement("style");
	style.id = ARTIFACTS_STYLE_ID;
	if (nonce) style.setAttribute("nonce", String(nonce));
	style.textContent = ARTIFACTS_CSS;
	doc.head.append(style);
	return style;
}
