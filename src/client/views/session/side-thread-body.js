/**
 * Shared body for the side-question companion (`side-thread-body.js`).
 * Renders `[data-testid="side-thread"]`, header drag/pin/close controls,
 * durable `[data-testid="side-learner-message"]` & `[data-testid="side-helper-message"]`
 * items, `[data-testid="side-streaming-answer"]`, and `[data-testid="side-thread-input"]`.
 */
import { createLife, documentOf, el, textNode, writeText } from "cloudcanvas-lib/ui";
import { SIDE_QUESTION_MAX_CHARS, collectCitations } from "peer-engine";
import { createSpinner } from "peer-kit";
import { createMarkdown } from "../../blocks/markdown.js";

export function sideThreadPlaceholder(state) {
	if (state?.pendingPassage) return "Ask about this passage…";
	if (Array.isArray(state?.messages) && state.messages.length > 0) return "Ask a follow-up…";
	return "Ask a side question…";
}

function buildPassageQuoteNode(doc, text, citation, onRevealCitation) {
	const quote = el(doc, "blockquote", { className: "peer-side-quote", text: String(text ?? "") });
	if (!citation || typeof onRevealCitation !== "function") return quote;
	const btn = el(doc, "button", {
		className: "peer-side-passage-btn",
		attrs: {
			type: "button",
			"data-testid": "side-passage-link",
			"aria-label": "Show the quoted tutor text",
			title: "Show in the lesson",
		},
	});
	btn.append(quote);
	btn.addEventListener("click", () => onRevealCitation(citation));
	return btn;
}

function buildMessageRow(doc, msg, mode, blocks, onExpand, onRevealCitation) {
	const isUser = msg.role === "user";
	const row = el(doc, "div", {
		className: isUser ? "peer-side-msg is-user" : "peer-side-msg is-helper",
		attrs: { "data-testid": isUser ? "side-learner-message" : "side-helper-message" },
	});
	const quotes = Array.isArray(msg.quotes) ? msg.quotes : [];
	for (let i = 0; i < quotes.length; i += 1) {
		const parsed = collectCitations(String(msg.quoteCitations?.[i] ?? ""))[0]?.citation ?? null;
		row.append(buildPassageQuoteNode(doc, quotes[i], parsed, onRevealCitation));
	}
	let md = null;
	if (isUser) {
		row.append(el(doc, "p", { className: "peer-side-user-text", text: String(msg.text ?? "") }));
	} else {
		const mdSlot = el(doc, "div", { className: "peer-side-md" });
		const fenceFor = blocks ? (lang) => blocks.fenceFor(lang) : undefined;
		md = createMarkdown(mdSlot, { fenceFor, onExpand });
		md.update({ source: String(msg.text ?? ""), streaming: false, mode, displayOnly: true });
		row.append(mdSlot);
	}
	if (msg.stopped) row.append(el(doc, "span", { className: "peer-side-meta", text: "Stopped" }));
	if (msg.error) row.append(el(doc, "span", { className: "peer-session-card-error", text: String(msg.error), attrs: { role: "alert" } }));
	return { row, destroy: () => md?.destroy() };
}

function buildHeaderDom(doc, life, callbacks) {
	const header = el(doc, "div", {
		className: callbacks.draggable ? "peer-side-header is-draggable" : "peer-side-header",
		attrs: { "data-testid": "side-thread-header" },
	});
	if (callbacks.onDragStart) life.on(header, "pointerdown", callbacks.onDragStart);
	const title = el(doc, "span", { className: "peer-side-title", text: "Side question" });
	const modeBtn = el(doc, "button", {
		className: "peer-artifact-icon-btn",
		text: "📌",
		attrs: { type: "button", "aria-label": "Dock side conversation", title: "Pin to side" },
	});
	const closeBtn = el(doc, "button", {
		className: "peer-artifact-icon-btn",
		text: "✕",
		attrs: { type: "button", "aria-label": "Close side conversation", title: "Close" },
	});
	life.on(modeBtn, "click", () => callbacks.onToggleMode());
	life.on(closeBtn, "click", () => callbacks.onClose());
	header.append(title, modeBtn, closeBtn);
	return { header, modeBtn };
}

function buildScrollAreaDom(doc, life, onRetry) {
	const scrollEl = el(doc, "div", { className: "peer-side-scroll", attrs: { "data-side-scroll": "" } });
	const listWrap = el(doc, "div", { className: "peer-side-messages" });
	const streamWrap = el(doc, "div", { className: "peer-side-streaming", attrs: { "data-testid": "side-streaming-answer", hidden: true } });
	const streamSpinnerHost = el(doc, "span");
	const streamSpinner = createSpinner(streamSpinnerHost);
	streamSpinner.update({ label: "Answering", size: 14 });
	const streamMdSlot = el(doc, "div");
	const streamMd = createMarkdown(streamMdSlot, { displayOnly: true });
	streamWrap.append(streamSpinnerHost, streamMdSlot);
	const errEl = el(doc, "p", { className: "peer-session-card-error", attrs: { role: "alert", hidden: true } });
	const errText = textNode(doc, errEl, "");
	const retryBtn = el(doc, "button", { className: "peer-side-retry-btn", text: "Retry answer", attrs: { type: "button", hidden: true } });
	life.on(retryBtn, "click", onRetry);
	scrollEl.append(listWrap, streamWrap, errEl, retryBtn);
	return { scrollEl, listWrap, streamWrap, streamSpinnerHost, streamSpinner, streamMdSlot, streamMd, errEl, errText, retryBtn };
}

function buildComposerDom(doc, life, actions) {
	const foot = el(doc, "div", { className: "peer-side-foot" });
	const stepBtn = el(doc, "button", {
		className: "peer-side-step-btn",
		text: "Go to current step →",
		attrs: { type: "button", "data-testid": "side-current-step", hidden: true },
	});
	life.on(stepBtn, "click", () => actions.onCurrentStep?.());
	const passageSlot = el(doc, "div", { className: "peer-side-pending-passage", attrs: { hidden: true } });
	const row = el(doc, "div", { className: "peer-side-composer-row" });
	const surface = el(doc, "div", { className: "peer-side-composer-surface", attrs: { "data-testid": "side-composer-surface" } });
	const textarea = el(doc, "textarea", {
		className: "cloudcanvas-ui-input peer-side-input",
		attrs: {
			rows: "1",
			"aria-label": "Side question",
			"data-testid": "side-thread-input",
			maxlength: String(SIDE_QUESTION_MAX_CHARS),
			placeholder: "Ask a side question…",
		},
	});
	surface.append(textarea);
	const sendBtn = el(doc, "button", {
		className: "cloudcanvas-ui-button is-primary peer-side-send",
		text: "↵",
		attrs: { type: "button", "aria-label": "Send side question" },
	});
	life.on(sendBtn, "click", () => actions.onSendOrStop());
	row.append(surface, sendBtn);
	foot.append(stepBtn, passageSlot, row);
	return { foot, stepBtn, passageSlot, textarea, sendBtn };
}

function buildPendingPassageCitation(chatId, passage) {
	if (!chatId || !passage?.sourceMessageId) return null;
	const sel = passage.selector ?? { start: 0, end: passage.text.length, prefix: "", suffix: "" };
	return { version: 1, chatId, messageId: passage.sourceMessageId, text: passage.text, ...sel };
}

function syncSideBodyScroll(doc, st, scrollDom, callbacks) {
	const { activeState, mode } = st;
	const msgs = Array.isArray(activeState.messages) ? activeState.messages : [];
	const nextSig = JSON.stringify(msgs.map((m) => [m.id, m.role, m.text, m.stopped, m.error, m.quotes]));
	if (nextSig !== st.msgSig) {
		st.msgSig = nextSig;
		for (const item of st.mountedRows) item.destroy();
		st.mountedRows = msgs.map((m) => buildMessageRow(doc, m, mode, callbacks.blocks, callbacks.onExpand, callbacks.onRevealCitation));
		scrollDom.listWrap.replaceChildren(...st.mountedRows.map((r) => r.row));
	}
	const answering = Boolean(activeState.answering);
	scrollDom.streamWrap.hidden = !answering;
	if (answering) {
		const hasStream = Boolean(activeState.streamText);
		scrollDom.streamSpinnerHost.hidden = hasStream;
		scrollDom.streamMdSlot.hidden = !hasStream;
		if (hasStream) scrollDom.streamMd.update({ source: String(activeState.streamText), streaming: true, mode, displayOnly: true });
	}
	const errStr = String(activeState.error ?? "");
	scrollDom.errEl.hidden = errStr === "";
	writeText(scrollDom.errText, errStr);
	const last = msgs.at(-1);
	scrollDom.retryBtn.hidden = answering || !(last?.role === "user" || (last?.role === "assistant" && last.error !== undefined));
}

function syncSideBodyComposer(doc, st, compDom, model, callbacks, syncActionBtn) {
	const { activeState, chatId } = st;
	compDom.stepBtn.hidden = !model.canJumpCurrentStep;
	const passage = activeState.pendingPassage;
	compDom.passageSlot.hidden = !passage;
	if (passage) {
		const cit = buildPendingPassageCitation(chatId, passage);
		compDom.passageSlot.replaceChildren(buildPassageQuoteNode(doc, passage.text, cit, callbacks.onRevealCitation));
	} else {
		compDom.passageSlot.replaceChildren();
	}
	compDom.textarea.placeholder = sideThreadPlaceholder(activeState);
	if (typeof model.draft === "string" && compDom.textarea !== doc.activeElement && compDom.textarea.value !== model.draft) {
		compDom.textarea.value = model.draft;
	} else if (activeState.failedQuestion && !compDom.textarea.value.trim()) {
		compDom.textarea.value = activeState.failedQuestion;
	}
	syncActionBtn();
}

function bindSideBodyKeyboard(life, root, textarea, callbacks, onSubmit, syncActionBtn) {
	life.on(root, "keydown", (ev) => {
		if (ev.key === "Enter") ev.stopPropagation();
	});
	life.on(textarea, "input", () => {
		callbacks.onDraftChange?.(textarea.value);
		syncActionBtn();
	});
	life.on(textarea, "keydown", (ev) => {
		if (ev.isComposing) return;
		if (ev.key === "Enter" && (!ev.shiftKey || ev.metaKey || ev.ctrlKey)) {
			ev.preventDefault();
			ev.stopPropagation();
			void onSubmit();
		} else if (ev.key === "Escape") {
			ev.preventDefault();
			ev.stopPropagation();
			callbacks.onClose?.();
		}
	});
}

function applySideBodyUpdate(doc, st, headDom, scrollDom, compDom, callbacks, syncActionBtn, model = {}) {
	st.activeState = model.state ?? null;
	st.chatId = String(model.chatId ?? "");
	st.mode = model.mode === "light" ? "light" : "dark";
	if (!st.activeState) return;
	const isPop = st.activeState.mode !== "panel";
	headDom.modeBtn.setAttribute("aria-label", isPop ? "Dock side conversation" : "Float side conversation");
	headDom.modeBtn.setAttribute("title", isPop ? "Pin to side" : "Unpin to float");
	syncSideBodyScroll(doc, st, scrollDom, callbacks);
	syncSideBodyComposer(doc, st, compDom, model, callbacks, syncActionBtn);
}

export function createSideThreadBody(host, callbacks = {}) {
	const doc = documentOf(host);
	const life = createLife();
	const st = { activeState: null, chatId: "", mode: "dark", msgSig: "", mountedRows: [] };
	const root = el(doc, "div", { className: "peer-side-body", attrs: { "data-testid": "side-thread" } });
	const headDom = buildHeaderDom(doc, life, {
		draggable: Boolean(callbacks.onDragStart),
		onDragStart: callbacks.onDragStart,
		onToggleMode: () => callbacks.onSetMode?.(st.activeState?.mode === "panel" ? "popover" : "panel"),
		onClose: () => callbacks.onClose?.(),
	});
	const scrollDom = buildScrollAreaDom(doc, life, () => callbacks.onAsk?.("", true));
	let compDom = null;
	const syncActionBtn = () => {
		const answering = Boolean(st.activeState?.answering);
		compDom.sendBtn.setAttribute("aria-label", answering ? "Stop side answer" : "Send side question");
		compDom.sendBtn.textContent = answering ? "■" : "↵";
		compDom.sendBtn.disabled = !answering && compDom.textarea.value.trim() === "";
	};
	const submitQuestion = async () => {
		if (!st.activeState || st.activeState.answering || !compDom.textarea.value.trim()) return;
		const ok = await Promise.resolve(callbacks.onAsk?.(compDom.textarea.value, false));
		if (ok !== false) { compDom.textarea.value = ""; callbacks.onDraftChange?.(""); syncActionBtn(); }
	};
	compDom = buildComposerDom(doc, life, {
		onCurrentStep: () => callbacks.onCurrentStep?.(),
		onSendOrStop: () => (st.activeState?.answering ? callbacks.onStop?.() : void submitQuestion()),
	});
	root.append(headDom.header, scrollDom.scrollEl, compDom.foot);
	host.append(root);
	bindSideBodyKeyboard(life, root, compDom.textarea, callbacks, submitQuestion, syncActionBtn);
	return {
		update: (m) => { if (!life.dead) applySideBodyUpdate(doc, st, headDom, scrollDom, compDom, callbacks, syncActionBtn, m); },
		focusInput: () => compDom.textarea.focus?.({ preventScroll: true }),
		destroy: () => {
			if (!life.destroy()) return;
			for (const item of st.mountedRows) item.destroy();
			st.mountedRows = [];
			scrollDom.streamMd.destroy(); scrollDom.streamSpinner.destroy(); root.remove();
		},
	};
}
