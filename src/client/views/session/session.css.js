/**
 * Styles for the interactive session transcript, sticky scroll, rich answered/practice
 * cards, plan dock, abort dialog, question/practice docks, composer, and stats bar.
 * Uses only `--cc-*` and `--peer-*` custom properties (`views §1.2` rule 10).
 */

export const SESSION_STYLE_ID = "peer-session-styles";

export const SESSION_CSS = `/* ------------------ PEER: SESSION VIEW ------------------ */
.peer-session {
	display: flex; flex-direction: column; flex: 1; min-width: 0; min-height: 0;
	color: var(--cc-text, #e2e8f0);
}
.peer-session [hidden] { display: none !important; }
.peer-session-header {
	display: flex; align-items: center; justify-content: space-between;
	background: var(--cc-card-bg, rgba(15, 23, 42, 0.88));
	border-bottom: 1px solid var(--cc-border, var(--cc-card-border, rgba(255, 255, 255, 0.1)));
}
.peer-session-header > .peer-shared-top-bar { flex: 1; min-width: 0; border-bottom: 0; }
.peer-session-rename-bar { display: flex; align-items: center; gap: var(--cc-space-2, 8px); padding-right: var(--cc-space-3, 12px); }
.peer-session-rename-form { display: flex; align-items: center; gap: var(--cc-space-1, 4px); }
.peer-session-status {
	display: flex; flex-direction: column; align-items: center; justify-content: center;
	gap: var(--cc-space-3, 12px); flex: 1; padding: var(--cc-space-6, 24px);
}
.peer-session-transcript-wrap { flex: 1; min-width: 0; min-height: 0; width: 100%; }
.peer-session-transcript {
	display: flex; flex-direction: column; gap: var(--cc-space-4, 16px);
	width: min(var(--peer-transcript-max-width, 52rem), 100%);
	margin: 0 auto; padding: var(--cc-space-4, 16px); box-sizing: border-box;
	font-family: var(--peer-font-prose, var(--cc-font, sans-serif));
	font-size: var(--peer-prose-size, var(--cc-type-md, 14px));
}
.peer-session-message { display: flex; flex-direction: column; gap: var(--cc-space-2, 8px); min-width: 0; }
.peer-session-message[data-peer-role="user"] {
	align-self: flex-end; max-width: min(40rem, 92%);
	padding: var(--cc-space-3, 12px) var(--cc-space-4, 16px);
	background: var(--cc-card-bg, rgba(30, 41, 59, 0.85));
	border: 1px solid var(--cc-border, rgba(255, 255, 255, 0.1));
	border-radius: var(--cc-radius-md, 10px);
}
.peer-session-message[data-peer-role="assistant"] { width: 100%; }
.peer-session-context, .peer-session-thinking {
	padding: var(--cc-space-2, 8px) var(--cc-space-3, 12px);
	background: var(--cc-input-bg, rgba(255, 255, 255, 0.04));
	border: 1px solid var(--cc-border, rgba(255, 255, 255, 0.1));
	border-radius: var(--cc-radius-sm, 6px); font-size: var(--cc-type-sm, 12px);
}
.peer-session-context > summary, .peer-session-thinking > summary,
.peer-thinking-block > summary, .peer-session-divider details > summary {
	cursor: pointer; color: var(--cc-text-muted, #94a3b8); font-weight: var(--cc-weight-medium, 500);
}
.peer-session-thinking-body, .peer-session-context-body, .peer-session-divider-body {
	margin-top: var(--cc-space-2, 8px); color: var(--cc-text-muted, #94a3b8);
}
.peer-session-context-list { margin: var(--cc-space-1, 4px) 0 0; padding-left: var(--cc-space-4, 16px); }
.peer-session-divider {
	padding: var(--cc-space-2, 8px) var(--cc-space-3, 12px); text-align: center;
	font-size: var(--cc-type-xs, 11px); color: var(--cc-text-muted, #94a3b8);
	border-top: 1px dashed var(--cc-border, rgba(255, 255, 255, 0.15));
	border-bottom: 1px dashed var(--cc-border, rgba(255, 255, 255, 0.15));
}
.peer-session-divider-body { text-align: left; white-space: pre-wrap; }
.peer-session-image, .peer-submitted-image-fig {
	display: inline-flex; flex-direction: column; gap: var(--cc-space-1, 4px); margin: 0; max-width: 100%;
}
.peer-session-image img, .peer-submitted-image {
	max-width: 100%; height: auto; border-radius: var(--cc-radius-sm, 6px);
	border: 1px solid var(--cc-border, rgba(255, 255, 255, 0.1));
}
.peer-session-image img.is-expandable, .peer-submitted-image.is-expandable { cursor: zoom-in; }
.peer-session-image figcaption { font-size: var(--cc-type-xs, 11px); color: var(--cc-text-muted, #94a3b8); }

/* ------------------ RICH TRANSCRIPT CARDS ------------------ */
.peer-answered-slot { display: flex; flex-direction: column; gap: var(--cc-space-2, 8px); }
.peer-answered-card, .peer-problem-card, .peer-conclude-card, .peer-session-card {
	display: flex; flex-direction: column; gap: var(--cc-space-2, 8px);
	padding: var(--cc-space-4, 16px); background: var(--cc-card-bg, rgba(15, 23, 42, 0.78));
	border: 1px solid var(--cc-border, rgba(255, 255, 255, 0.12));
	border-radius: var(--cc-radius-md, 12px); box-sizing: border-box;
}
.peer-answered-card.is-dismissed, .peer-conclude-card.is-dismissed {
	padding: var(--cc-space-2, 8px) var(--cc-space-3, 12px);
	font-size: var(--cc-type-sm, 12px); color: var(--cc-text-muted, #94a3b8);
}
.peer-card-eyebrow-row, .peer-session-card-head { display: flex; align-items: center; gap: var(--cc-space-2, 8px); }
.peer-session-card-head { justify-content: space-between; }
.peer-card-eyebrow {
	font-size: var(--cc-type-xs, 11px); font-weight: var(--cc-weight-medium, 500);
	text-transform: uppercase; letter-spacing: 0.05em; color: var(--cc-text-muted, #94a3b8);
}
.peer-status-badge {
	display: inline-flex; align-items: center; padding: 1px var(--cc-space-2, 8px);
	font-size: var(--cc-type-xs, 11px); font-weight: var(--cc-weight-medium, 500);
	border-radius: var(--cc-radius-pill, 9999px);
	border: 1px solid var(--cc-border, rgba(255, 255, 255, 0.15)); color: var(--cc-text-muted, #94a3b8);
}
.peer-status-badge.is-success { color: var(--cc-tone-success, #22c55e); border-color: color-mix(in oklab, var(--cc-tone-success, #22c55e) 50%, transparent); }
.peer-status-badge.is-warning { color: var(--cc-tone-warning, #eab308); border-color: color-mix(in oklab, var(--cc-tone-warning, #eab308) 50%, transparent); }
.peer-status-badge.is-danger { color: var(--cc-tone-danger, #ef4444); border-color: color-mix(in oklab, var(--cc-tone-danger, #ef4444) 50%, transparent); }
.peer-answered-grid.is-columns { display: grid; align-items: start; }
.peer-answered-grid.is-stacked { display: flex; flex-direction: column; gap: var(--cc-space-2, 8px); }
.peer-answered-options { display: flex; flex-direction: column; gap: var(--cc-space-1, 6px); font-size: var(--cc-type-sm, 13px); }
.peer-answered-option {
	display: flex; align-items: center; gap: var(--cc-space-2, 8px);
	padding: 6px var(--cc-space-3, 12px); border-radius: var(--cc-radius-sm, 8px);
	border: 1px solid var(--cc-border, rgba(255, 255, 255, 0.12));
}
.peer-answered-option.is-correct-selected { border-color: color-mix(in oklab, var(--cc-tone-success, #22c55e) 65%, transparent); background: color-mix(in oklab, var(--cc-tone-success, #22c55e) 12%, transparent); }
.peer-answered-option.is-wrong-selected { border-color: color-mix(in oklab, var(--cc-tone-danger, #ef4444) 65%, transparent); background: color-mix(in oklab, var(--cc-tone-danger, #ef4444) 12%, transparent); }
.peer-answered-option.is-ask-selected { border-color: var(--cc-accent, #38bdf8); background: color-mix(in oklab, var(--cc-accent, #38bdf8) 12%, transparent); }
.peer-answered-option.is-correct-unselected { border-color: color-mix(in oklab, var(--cc-tone-success, #22c55e) 42%, transparent); }
.peer-answered-option-letter { width: 1rem; flex-shrink: 0; text-align: center; font-size: var(--cc-type-xs, 11px); color: var(--cc-text-muted, #94a3b8); }
.peer-answered-mark.is-check { color: var(--cc-tone-success, #22c55e); }
.peer-answered-mark.is-x { color: var(--cc-tone-danger, #ef4444); }
.peer-answered-option-label.is-muted { color: var(--cc-text-muted, #94a3b8); }
.peer-answered-confidence { display: flex; align-items: center; gap: var(--cc-space-3, 12px); margin-top: var(--cc-space-2, 8px); }
.peer-confidence-rail { flex: 1; min-width: 0; height: 6px; border-radius: var(--cc-radius-pill, 9999px); border: 1px solid var(--cc-border, rgba(255, 255, 255, 0.14)); }
.peer-confidence-pct { width: 4ch; flex-shrink: 0; text-align: center; font-family: var(--cc-font-mono, ui-monospace, monospace); font-size: var(--cc-type-xs, 12px); color: var(--cc-text-muted, #94a3b8); }
.peer-answered-why-btn, .peer-metadata-toggle {
	padding: 0; background: none; border: 0; cursor: pointer;
	font-size: var(--cc-type-xs, 11px); font-weight: var(--cc-weight-medium, 500); color: var(--cc-text-muted, #94a3b8);
}
.peer-metadata-toggle { text-transform: uppercase; letter-spacing: 0.05em; }
.peer-thinking-block {
	width: 100%; padding: 4px var(--cc-space-3, 12px) 4px 14px;
	border-left: 3px solid color-mix(in oklab, var(--cc-text-muted, #94a3b8) 35%, transparent);
	background: var(--cc-card-bg, rgba(15, 23, 42, 0.65)); box-sizing: border-box; font-size: var(--cc-type-xs, 11px);
}
.peer-thinking-block.is-in-card { background: transparent; }
.peer-thinking-block-summary { text-transform: uppercase; letter-spacing: 0.05em; }
.peer-thinking-block-text { margin-top: var(--cc-space-1, 6px); white-space: pre-wrap; font-style: italic; font-size: var(--peer-prose-size, 15px); color: var(--cc-text-muted, #94a3b8); }
.peer-conclude-divider { border-top: 1px solid var(--cc-border, rgba(255, 255, 255, 0.12)); margin: var(--cc-space-2, 8px) 0; }
.peer-metadata-wrap { position: relative; margin-top: var(--cc-space-1, 4px); }
.peer-metadata-box {
	position: absolute; top: calc(100% + 6px); left: 0; z-index: var(--cc-z-ui-popover, 1300);
	width: min(20rem, calc(100vw - 2rem)); padding: var(--cc-space-3, 12px);
	background: var(--cc-ui-surface, var(--cc-card-bg, rgba(15, 23, 42, 0.98)));
	border: 1px solid var(--cc-border, rgba(255, 255, 255, 0.15)); border-radius: var(--cc-radius-md, 10px);
	box-shadow: var(--cc-shadow-2, 0 12px 32px rgba(0, 0, 0, 0.55));
}
.peer-metadata-grid { display: grid; grid-template-columns: auto 1fr; gap: 4px var(--cc-space-3, 12px); margin: 0; font-size: var(--cc-type-xs, 11px); }
.peer-metadata-dt { color: var(--cc-text-muted, #94a3b8); }
.peer-metadata-dd { margin: 0; font-family: var(--cc-font-mono, ui-monospace, monospace); }
.peer-malformed-question {
	padding: var(--cc-space-3, 12px); border: 1px dashed var(--cc-border, rgba(255, 255, 255, 0.2));
	border-radius: var(--cc-radius-md, 10px); font-size: var(--cc-type-sm, 12px); color: var(--cc-text-muted, #94a3b8);
}
.peer-session-card-error, .peer-session-turn-error { color: var(--cc-tone-danger, #f87171); font-size: var(--cc-type-sm, 12px); }

/* ------------------ PLAN DOCK, FOOTER, DOCKS & COMPOSER ------------------ */
.peer-plan-dock {
	width: min(var(--peer-transcript-max-width, 52rem), 100%); margin: var(--cc-space-2, 8px) auto 0;
	padding: var(--cc-space-2, 8px) var(--cc-space-3, 12px); box-sizing: border-box;
	background: var(--cc-card-bg, rgba(15, 23, 42, 0.72));
	border: 1px solid var(--cc-border, rgba(255, 255, 255, 0.1)); border-radius: var(--cc-radius-md, 10px);
}
.peer-plan-dock-head, .peer-plan-dock-actions, .peer-abort-dialog-actions,
.peer-session-error-bar, .peer-dock-head, .peer-dock-foot, .peer-dock-confirm {
	display: flex; align-items: center; justify-content: space-between; gap: var(--cc-space-2, 8px);
}
.peer-abort-dialog-actions { justify-content: flex-end; margin-top: var(--cc-space-3, 12px); }
.peer-plan-dock-meta { flex: 1; font-size: var(--cc-type-xs, 11px); color: var(--cc-text-muted, #94a3b8); }
.peer-plan-dock-body { margin-top: var(--cc-space-2, 8px); height: 13rem; overflow: hidden; }
.peer-plan-edge { stroke: var(--cc-border, rgba(148, 163, 184, 0.45)); stroke-width: 1.5; }
.peer-plan-arrow { fill: var(--cc-border, rgba(148, 163, 184, 0.65)); }
.peer-plan-node-box { fill: var(--cc-input-bg, rgba(30, 41, 59, 0.9)); stroke: var(--cc-border, rgba(148, 163, 184, 0.35)); stroke-width: 1.25; }
.peer-plan-node[data-status="current"] .peer-plan-node-box { stroke: var(--cc-accent, #38bdf8); stroke-width: 2; }
.peer-plan-node[data-status="visited"] .peer-plan-node-box { opacity: 0.78; }
.peer-plan-node-label { fill: var(--cc-text, #e2e8f0); font-size: var(--cc-type-xs, 11px); font-family: var(--cc-font, sans-serif); }
.peer-session-footer {
	display: flex; flex-direction: column; gap: var(--cc-space-2, 8px); width: 100%;
	padding: var(--cc-space-3, 12px) var(--cc-space-4, 16px); box-sizing: border-box;
	background: var(--cc-card-bg, rgba(15, 23, 42, 0.92)); border-top: 1px solid var(--cc-border, rgba(255, 255, 255, 0.1));
}
.peer-session-footer > * { width: min(var(--peer-transcript-max-width, 52rem), 100%); margin: 0 auto; box-sizing: border-box; }
.peer-session-error-actions, .peer-dock-head-actions, .peer-composer-actions,
.peer-composer-attach-group, .peer-stats-summary, .peer-model-picker {
	display: inline-flex; align-items: center; gap: var(--cc-space-2, 8px);
}
.peer-question-dock, .peer-practice-dock, .peer-composer {
	display: flex; flex-direction: column; gap: var(--cc-space-2, 8px); padding: var(--cc-space-3, 12px);
	background: var(--cc-input-bg, rgba(255, 255, 255, 0.04));
	border: 1px solid var(--cc-border, rgba(255, 255, 255, 0.12)); border-radius: var(--cc-radius-md, 10px);
}
.peer-dock-badge { font-size: var(--cc-type-xs, 11px); font-weight: var(--cc-weight-semibold, 600); text-transform: uppercase; letter-spacing: 0.04em; color: var(--cc-text-muted, #94a3b8); }
.peer-question-options { display: flex; flex-direction: column; gap: var(--cc-space-1, 4px); }
.peer-question-option { justify-content: flex-start; text-align: left; }
.peer-question-option.is-selected { border-color: var(--cc-accent, #38bdf8); }
.peer-question-other-row, .peer-question-confidence, .peer-composer-row { display: flex; align-items: center; gap: var(--cc-space-2, 8px); }
.peer-question-other-input, .peer-question-confidence-slider, .peer-composer-input { flex: 1; min-width: 0; }
.peer-question-answer, .peer-question-thinking, .peer-practice-thinking, .peer-composer-input { width: 100%; resize: vertical; box-sizing: border-box; }
.peer-composer-steers, .peer-composer-chips { display: flex; flex-wrap: wrap; align-items: center; gap: var(--cc-space-1, 4px); }
.peer-composer-steer-item, .peer-composer-chip {
	display: inline-flex; align-items: center; gap: var(--cc-space-1, 4px);
	padding: 2px var(--cc-space-2, 8px); font-size: var(--cc-type-xs, 11px);
	background: var(--cc-card-bg, rgba(15, 23, 42, 0.75));
	border: 1px solid var(--cc-border, rgba(255, 255, 255, 0.12)); border-radius: var(--cc-radius-pill, 9999px);
}
.peer-composer-thumb { width: 18px; height: 18px; object-fit: cover; border-radius: var(--cc-radius-xs, 4px); }
.peer-stats-bar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--cc-space-2, 8px); font-size: var(--cc-type-xs, 11px); color: var(--cc-text-muted, #94a3b8); }
.peer-session-main-row { display: flex; flex: 1; min-width: 0; min-height: 0; width: 100%; overflow: hidden; }
.peer-session-find { display: flex; align-items: center; gap: var(--cc-space-2, 8px); padding: var(--cc-space-2, 8px) var(--cc-space-4, 16px); border-bottom: 1px solid var(--cc-border, rgba(255, 255, 255, 0.1)); background: var(--cc-card-bg, rgba(15, 23, 42, 0.88)); font-size: var(--cc-type-xs, 12px); }
.peer-session-find-input { flex: 1; min-width: 0; }
.peer-session-find-count { font-variant-numeric: tabular-nums; color: var(--cc-text-muted, #94a3b8); }
.peer-selection-toolbar { position: fixed; z-index: 65; display: flex; align-items: center; gap: var(--cc-space-1, 4px); padding: 4px; background: var(--cc-ui-surface, var(--cc-card-bg, #1c1c1c)); border: 1px solid var(--cc-border, #434343); border-radius: var(--cc-radius-sm, 8px); box-shadow: var(--cc-shadow-2, 0 8px 24px rgba(0, 0, 0, 0.45)); }
.peer-citation-list { display: flex; flex-direction: column; gap: var(--cc-space-1, 4px); margin-bottom: var(--cc-space-2, 8px); }
.peer-citation-quote-card { display: flex; flex-direction: column; gap: 2px; padding: var(--cc-space-1, 4px) var(--cc-space-2, 8px); border-left: 2px solid var(--cc-accent, #38bdf8); background: var(--cc-card-bg, rgba(15, 23, 42, 0.6)); border-radius: var(--cc-radius-xs, 4px); }
.peer-citation-chip { align-self: flex-start; background: transparent; border: 0; padding: 0; color: var(--cc-text, #e2e8f0); font-size: var(--cc-type-xs, 12px); cursor: pointer; text-align: left; }
.peer-citation-comment-text { margin: 0; font-size: var(--cc-type-xs, 11px); color: var(--cc-text-muted, #94a3b8); }
.peer-citation-popover { position: fixed; right: var(--cc-space-4, 16px); bottom: 6.5rem; z-index: 70; display: flex; flex-direction: column; gap: var(--cc-space-2, 8px); width: min(24rem, calc(100vw - 2rem)); padding: var(--cc-space-3, 12px); background: var(--cc-ui-surface, var(--cc-card-bg, #1c1c1c)); border: 1px solid var(--cc-border, #434343); border-radius: var(--cc-radius-md, 10px); box-shadow: var(--cc-shadow-2, 0 12px 32px rgba(0, 0, 0, 0.5)); }
.peer-citation-popover-quote, .peer-side-quote { margin: 0; padding-left: var(--cc-space-2, 8px); border-left: 2px solid var(--cc-border, #434343); font-size: var(--cc-type-xs, 12px); font-style: italic; color: var(--cc-text-muted, #94a3b8); }
.peer-citation-popover-actions { display: flex; justify-content: flex-end; gap: var(--cc-space-2, 8px); }
.peer-side-popover { position: fixed; z-index: 60; display: flex; flex-direction: column; overflow: hidden; padding: var(--cc-space-3, 12px); background: var(--cc-ui-surface, var(--cc-card-bg, #1c1c1c)); border: 1px solid var(--cc-border, #434343); border-radius: var(--cc-radius-md, 12px); box-shadow: var(--cc-shadow-2, 0 12px 32px rgba(0, 0, 0, 0.5)); box-sizing: border-box; }
.peer-side-panel { display: flex; flex-direction: column; flex-shrink: 0; width: 22rem; max-width: 45vw; height: 100%; padding: var(--cc-space-3, 12px); border-left: 1px solid var(--cc-border, #434343); background: var(--cc-bg, #141414); box-sizing: border-box; }
.peer-side-body { display: flex; flex-direction: column; flex: 1; min-height: 0; gap: var(--cc-space-2, 8px); }
.peer-side-header { display: flex; align-items: center; gap: var(--cc-space-2, 8px); font-size: var(--cc-type-xs, 12px); color: var(--cc-text-muted, #94a3b8); }
.peer-side-header.is-draggable { cursor: grab; user-select: none; touch-action: none; }
.peer-side-title { flex: 1; font-weight: var(--cc-weight-medium, 500); }
.peer-side-scroll { display: flex; flex-direction: column; flex: 1; min-height: 0; gap: var(--cc-space-2, 8px); overflow-y: auto; }
.peer-side-messages { display: flex; flex-direction: column; gap: var(--cc-space-2, 8px); }
.peer-side-msg.is-user { align-self: flex-end; max-width: 80%; padding: var(--cc-space-2, 8px) var(--cc-space-3, 12px); background: var(--cc-ui-selected, #2a2a2a); border-radius: var(--cc-radius-md, 10px); }
.peer-side-user-text { margin: 0; white-space: pre-wrap; font-size: var(--cc-type-sm, 13px); }
.peer-side-foot { display: flex; flex-direction: column; gap: var(--cc-space-1, 4px); }
.peer-side-composer-row { display: flex; align-items: flex-end; gap: var(--cc-space-2, 8px); }
.peer-side-composer-surface { flex: 1; min-width: 0; }
.peer-side-input { width: 100%; resize: none; box-sizing: border-box; }
.peer-side-resize { position: absolute; touch-action: none; }
.peer-side-resize-n { left: 8px; right: 8px; top: 0; height: 6px; cursor: ns-resize; }
.peer-side-resize-s { left: 8px; right: 8px; bottom: 0; height: 6px; cursor: ns-resize; }
.peer-side-resize-w { top: 8px; bottom: 8px; left: 0; width: 6px; cursor: ew-resize; }
.peer-side-resize-e { top: 8px; bottom: 8px; right: 0; width: 6px; cursor: ew-resize; }
.peer-side-resize-nw { left: 0; top: 0; width: 10px; height: 10px; cursor: nwse-resize; }
.peer-side-resize-ne { right: 0; top: 0; width: 10px; height: 10px; cursor: nesw-resize; }
.peer-side-resize-sw { left: 0; bottom: 0; width: 10px; height: 10px; cursor: nesw-resize; }
.peer-side-resize-se { right: 0; bottom: 0; width: 10px; height: 10px; cursor: nwse-resize; }
.peer-message-side-btn { align-self: flex-end; opacity: 0.65; font-size: var(--cc-type-xs, 11px); padding: 2px 6px; background: transparent; border: 1px solid var(--cc-border, rgba(255, 255, 255, 0.12)); border-radius: var(--cc-radius-xs, 4px); color: var(--cc-text-muted, #94a3b8); cursor: pointer; }
.peer-message-side-btn:hover { opacity: 1; color: var(--cc-text, #e2e8f0); }
`;

export function injectSessionStyles(doc = globalThis.document, { nonce } = {}) {
	if (!doc?.createElement || !doc.head) return null;
	const existing = doc.getElementById(SESSION_STYLE_ID);
	if (existing) return existing;
	const style = doc.createElement("style");
	style.id = SESSION_STYLE_ID;
	if (nonce) style.setAttribute("nonce", String(nonce));
	style.textContent = SESSION_CSS;
	doc.head.append(style);
	return style;
}
