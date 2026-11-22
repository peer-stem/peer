/**
 * Voice & speech styles (`f4-c2c`), scoped to `--cc-*` tokens.
 */

export const VOICE_STYLE_ID = "peer-voice-styles";

export const VOICE_CSS = `
.peer-dictation-wrap {
	display: inline-flex;
	align-items: center;
	gap: var(--cc-space-1, 4px);
	flex-wrap: wrap;
}
.peer-dictation-toggle {
	display: inline-flex;
	align-items: center;
	gap: 4px;
	padding: 4px 8px;
	border-radius: var(--cc-radius-sm, 6px);
	border: 1px solid var(--cc-border, rgba(128,128,128,0.28));
	background: var(--cc-surface-2, transparent);
	color: var(--cc-fg, inherit);
	font-size: 0.8125rem;
	cursor: pointer;
}
.peer-dictation-toggle.is-recording {
	border-color: var(--cc-danger, #ef4444);
	color: var(--cc-danger, #ef4444);
}
.peer-dictation-bar {
	display: inline-flex;
	align-items: center;
	gap: 6px;
	padding: 2px 8px;
	border-radius: var(--cc-radius-sm, 6px);
	background: var(--cc-surface-2, rgba(128,128,128,0.12));
	font-size: 0.75rem;
}
.peer-dictation-meter {
	display: inline-block;
	width: 48px;
	height: 6px;
	border-radius: 999px;
	background: var(--cc-border, rgba(128,128,128,0.25));
	overflow: hidden;
	position: relative;
}
.peer-dictation-meter-fill {
	display: block;
	height: 100%;
	background: var(--cc-accent, #3b82f6);
	transition: width 80ms linear;
}
.peer-dictation-error {
	font-size: 0.75rem;
	color: var(--cc-danger, #ef4444);
	background: none;
	border: none;
	padding: 2px 4px;
	cursor: pointer;
}
.peer-speak-btn {
	display: inline-flex;
	align-items: center;
	gap: 4px;
	padding: 2px 6px;
	border-radius: var(--cc-radius-sm, 6px);
	border: 1px solid transparent;
	background: transparent;
	color: var(--cc-fg-muted, inherit);
	font-size: 0.75rem;
	cursor: pointer;
}
.peer-speak-btn:hover,
.peer-speak-btn.is-speaking {
	color: var(--cc-fg, inherit);
	border-color: var(--cc-border, rgba(128,128,128,0.28));
}
.peer-speech-settings {
	display: flex;
	flex-direction: column;
	gap: var(--cc-space-2, 8px);
}
`;

export function injectVoiceStyles(doc = globalThis.document, { nonce } = {}) {
	if (!doc?.createElement || !doc.head) return null;
	const existing = doc.getElementById(VOICE_STYLE_ID);
	if (existing) return existing;
	const style = doc.createElement("style");
	style.id = VOICE_STYLE_ID;
	if (nonce) style.setAttribute("nonce", String(nonce));
	style.textContent = VOICE_CSS;
	doc.head.append(style);
	return style;
}
