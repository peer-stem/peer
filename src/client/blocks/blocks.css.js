/**
 * Stylesheet for peer transcript Markdown & application blocks (`src/client/blocks/`).
 * Uses only `--cc-*` and `--peer-*` design tokens and injects once per Document.
 */

export const BLOCKS_STYLE_ID = "peer-blocks-styles";

export const BLOCKS_CSS = `/* ------------------ PEER: TRANSCRIPT BLOCKS ------------------ */
.peer-blocks-markdown {
	font-family: var(--peer-font-prose, var(--cc-font, ui-sans-serif, system-ui, sans-serif));
	font-size: var(--peer-prose-size, 16px);
	line-height: var(--peer-prose-leading, 1.5);
	color: var(--cc-text, #e6e6e6);
	min-width: 0;
}
.peer-blocks-markdown > :first-child,
.peer-blocks-prose > :first-child,
.peer-blocks-callout > .peer-blocks-markdown > :first-child {
	margin-top: 0;
}
.peer-blocks-markdown > :last-child,
.peer-blocks-prose > :last-child,
.peer-blocks-callout > .peer-blocks-markdown > :last-child {
	margin-bottom: 0;
}
.peer-blocks-markdown :where(h1, h2, h3, h4, h5, h6) {
	font-weight: var(--peer-heading-weight, 900);
	color: var(--cc-text, #e6e6e6);
	margin: 1.25rem 0 0.5rem;
}
.peer-blocks-markdown :where(p, ul, ol) {
	margin: 0.75rem 0;
}
.peer-blocks-markdown :where(ul, ol) {
	padding-left: 1.5rem;
}
.peer-blocks-markdown :where(strong, b) {
	color: var(--cc-ink-strong, var(--cc-text, #e6e6e6));
	font-weight: 700;
}
.peer-blocks-markdown :where(em, i) {
	color: var(--cc-ink-em, var(--cc-text, #e6e6e6));
}
.peer-blocks-markdown :where(a) {
	color: var(--cc-text, #e6e6e6);
	text-decoration: underline;
	overflow-wrap: anywhere;
}
.peer-blocks-markdown :where(hr) {
	margin: 1.5rem 0;
	border: 0;
	border-top: 1px solid var(--cc-border, #434343);
}
.peer-blocks-markdown :where(blockquote) {
	margin: 1rem 0;
	padding-left: 1rem;
	border-left: 4px solid var(--cc-border, #434343);
	color: var(--cc-text-muted, #8d8d8d);
	font-style: italic;
}
.peer-blocks-markdown :not(pre) > code {
	padding: 0.125rem 0.375rem;
	border: 1px solid var(--cc-border, #434343);
	border-radius: var(--cc-radius-sm, 4px);
	background: var(--cc-ui-surface, var(--cc-card-bg, #1c1c1c));
	color: var(--cc-ink-code, var(--cc-text, #e6e6e6));
	font-family: var(--cc-font-mono, ui-monospace, SFMono-Regular, monospace);
	font-size: 0.875em;
	font-variant-ligatures: var(--peer-code-ligatures, none);
}

/* Corner affordances (copy / expand) */
.peer-blocks-corner {
	position: absolute;
	top: 0.25rem;
	right: 0.25rem;
	z-index: 2;
	display: inline-flex;
	align-items: center;
	gap: 0.25rem;
	opacity: 0;
	transition: opacity 120ms ease;
}
:is(.peer-blocks-code, .peer-blocks-table-wrap, .peer-blocks-math, .peer-blocks-mermaid, .peer-blocks-plugin-fence):is(:hover, :focus-within) > .peer-blocks-corner,
.peer-blocks-corner[data-peer-copied="true"] {
	opacity: 1;
}
.peer-blocks-corner-btn {
	min-height: 1.5rem;
	padding: 0.125rem 0.375rem;
	font-family: var(--cc-font-mono, ui-monospace, SFMono-Regular, monospace);
	font-size: var(--cc-type-xs, 11px);
	color: var(--cc-text-muted, #8d8d8d);
	background: var(--cc-ui-surface, var(--cc-card-bg, #1c1c1c));
	border: 1px solid var(--cc-border, #434343);
	border-radius: var(--cc-radius-sm, 4px);
	cursor: pointer;
}
.peer-blocks-corner-btn:hover {
	color: var(--cc-text, #e6e6e6);
	background: var(--cc-ui-selected, var(--cc-btn-bg-hover, #2a2a2a));
}
.peer-blocks-corner-btn:focus-visible {
	outline: var(--cc-focus-ring-width, 2px) solid var(--cc-focus-ring, var(--cc-accent, #8d8d8d));
	outline-offset: var(--cc-focus-ring-offset, 2px);
}

/* Fenced code blocks & Shiki light/dark tokens */
.peer-blocks-code {
	position: relative;
	margin: 1rem 0;
	padding: 0.375rem;
	border: 1px solid var(--cc-border, #434343);
	border-radius: var(--cc-radius-lg, 12px);
	background: var(--cc-ui-surface, var(--cc-card-bg, #1c1c1c));
}
.peer-blocks-code-body {
	overflow-x: auto;
	padding: 0.75rem 1rem;
}
.peer-blocks-code-pre {
	margin: 0;
	font-family: var(--cc-font-mono, ui-monospace, SFMono-Regular, monospace);
	font-size: var(--cc-type-base, 14px);
	line-height: 1.5;
	font-variant-ligatures: var(--peer-code-ligatures, none);
}
.peer-blocks-code-content {
	font: inherit;
	font-variant-ligatures: inherit;
}
.peer-blocks-code-line[data-peer-line]::before {
	content: attr(data-peer-line);
	display: inline-block;
	min-width: 1.75rem;
	margin-right: 1rem;
	text-align: right;
	color: var(--cc-text-muted, #8d8d8d);
	user-select: none;
}
.peer-blocks-code-token {
	color: var(--shiki-dark, inherit);
}
:root.light .peer-blocks-code-token,
.peer-blocks-code[data-peer-mode="light"] .peer-blocks-code-token {
	color: var(--shiki-light, inherit);
}

/* Sharp-bordered GitHub alert callout */
.peer-blocks-callout {
	margin: 1rem 0;
	width: fit-content;
	max-width: 100%;
	padding: 0.75rem 1rem;
	border: 1px solid var(--cc-line-strong, var(--cc-text, #e6e6e6));
	border-radius: 0;
	background: transparent;
}

/* GFM tables */
.peer-blocks-table-wrap {
	position: relative;
	margin: 1rem 0;
	width: fit-content;
	max-width: 100%;
}
.peer-blocks-table-scroll {
	overflow-x: auto;
	max-width: 100%;
}
.peer-blocks-table {
	width: fit-content;
	border-collapse: collapse;
	border: 1px solid var(--cc-border, #434343);
	font-size: inherit;
}
.peer-blocks-table :where(th, td) {
	padding: 0.5rem 1rem;
	text-align: left;
	font-size: inherit;
}
.peer-blocks-table :where(th) {
	font-weight: 600;
}
.peer-blocks-table :where(th, td):not(:first-child) {
	border-left: 1px solid var(--cc-border, #434343);
}
.peer-blocks-table > thead {
	border-bottom: 1px solid var(--cc-border, #434343);
}
.peer-blocks-table > tbody > tr:not(:last-child) {
	border-bottom: 1px solid var(--cc-border, #434343);
}

/* KaTeX display math */
.peer-blocks-math {
	position: relative;
	display: block;
	margin: 1rem 0;
}
.peer-blocks-math .katex-display {
	overflow-x: auto;
	overflow-y: hidden;
}

/* Blocked Markdown image badge */
.peer-blocks-image-blocked {
	display: inline-block;
	padding: 0.125rem 0.5rem;
	border: 1px solid var(--cc-border, #434343);
	border-radius: var(--cc-radius-sm, 4px);
	color: var(--cc-text-muted, #8d8d8d);
	font-family: var(--cc-font-mono, ui-monospace, SFMono-Regular, monospace);
	font-size: var(--cc-type-xs, 11px);
}

/* Mermaid diagrams & error fallback */
.peer-blocks-mermaid {
	position: relative;
	margin: 1rem 0;
}
.peer-blocks-mermaid[data-streamdown="mermaid"] svg {
	display: block;
	margin: 0 auto;
	max-width: 100% !important;
	height: auto !important;
}
.peer-blocks-mermaid-preview {
	margin: 0;
	padding: 0.75rem 1rem;
	overflow-x: auto;
	border: 1px solid var(--cc-border, #434343);
	border-radius: var(--cc-radius-lg, 12px);
	background: var(--cc-ui-surface, var(--cc-card-bg, #1c1c1c));
	color: var(--cc-text-muted, #8d8d8d);
	font-family: var(--cc-font-mono, ui-monospace, SFMono-Regular, monospace);
	font-size: var(--cc-type-xs, 11px);
}
.peer-blocks-mermaid-error {
	margin: 0;
	padding: 1rem;
	border: 1px solid var(--cc-tone-danger, #ef4444);
	border-radius: var(--cc-radius-lg, 12px);
	background: var(--cc-ui-surface, var(--cc-card-bg, #1c1c1c));
}
.peer-blocks-mermaid-error-title {
	margin: 0;
	font-size: var(--cc-type-base, 14px);
	font-weight: 600;
	color: var(--cc-tone-danger, #ef4444);
}
.peer-blocks-mermaid-error-detail {
	margin: 0.25rem 0 0;
	font-family: var(--cc-font-mono, ui-monospace, SFMono-Regular, monospace);
	font-size: var(--cc-type-xs, 11px);
	color: var(--cc-text-muted, #8d8d8d);
	overflow-wrap: anywhere;
}
.peer-blocks-mermaid-error-source {
	margin: 0.75rem 0 0;
	padding: 0.75rem;
	overflow-x: auto;
	border: 1px solid var(--cc-border, #434343);
	border-radius: var(--cc-radius-md, 8px);
	color: var(--cc-text, #e6e6e6);
	font-family: var(--cc-font-mono, ui-monospace, SFMono-Regular, monospace);
	font-size: var(--cc-type-xs, 11px);
}
.peer-blocks-plugin-fence {
	position: relative;
	margin: 1rem 0;
	min-width: 0;
}
`;

/**
 * Inject the transcript blocks stylesheet once into `doc`.
 * @param {Document} [doc]
 * @param {{nonce?: string}} [options]
 * @returns {HTMLStyleElement|null}
 */
export function injectBlocksStyles(doc = globalThis.document, { nonce } = {}) {
	if (!doc?.createElement || !doc.head) return null;
	const existing = doc.getElementById(BLOCKS_STYLE_ID);
	if (existing) return existing;
	const style = doc.createElement("style");
	style.id = BLOCKS_STYLE_ID;
	if (nonce) style.setAttribute("nonce", String(nonce));
	style.textContent = BLOCKS_CSS;
	doc.head.append(style);
	return style;
}
