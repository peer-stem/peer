/**
 * Tutor citation chips, quote cards, and optional comment popover (`citation-popover.js`).
 * Uses `CITATION_MAX_COMMENT_LENGTH`, `citationLabel`, `collectCitations`,
 * `revealCitationSource`, and `withCitationComment` from `'peer-engine'`.
 */
import { button, createLife, documentOf, el, textNode, writeText } from "cloudcanvas-lib/ui";
import {
	CITATION_MAX_COMMENT_LENGTH,
	citationLabel,
	collectCitations,
	revealCitationSource,
	withCitationComment,
} from "peer-engine";

export function commentDismissalOutcome({ reason, draft, saved }) {
	if (reason === "escape" || draft === null) return "close";
	if (draft.trim() === String(saved ?? "").trim()) return "close";
	if (draft.length > CITATION_MAX_COMMENT_LENGTH) return "keep-open";
	return "commit";
}

export function commentKeyAction(event) {
	if (event.isComposing) return null;
	if (event.key === "Escape") return "cancel";
	if (event.key !== "Enter" || event.shiftKey) return null;
	return event.metaKey || event.ctrlKey ? "save-send" : "save";
}

export function renderUserCitationsStrip(doc, rawText, options = {}) {
	const occurrences = collectCitations(String(rawText ?? ""));
	if (occurrences.length === 0) return null;
	const wrap = el(doc, "div", { className: "peer-citation-list" });
	for (const occ of occurrences) {
		const cit = occ.citation;
		const card = el(doc, "div", {
			className: "peer-citation-quote-card",
			attrs: { "data-testid": "citation-quote-card" },
		});
		const chip = el(doc, "button", {
			className: "peer-citation-chip",
			text: citationLabel(cit),
			attrs: {
				type: "button",
				"data-testid": "citation-chip",
				title: cit.text,
			},
		});
		chip.addEventListener("click", () => {
			revealCitationSource({
				transcript: options.getTranscript?.() ?? null,
				scroll: options.getScrollContext?.() ?? null,
				citation: cit,
				currentChatId: String(options.currentChatId ?? cit.chatId),
				navigate: (href) => options.onNavigate?.(href),
			});
		});
		card.append(chip);
		if (cit.comment) {
			card.append(el(doc, "p", { className: "peer-citation-comment-text", text: cit.comment }));
		}
		wrap.append(card);
	}
	return wrap;
}

export function stripCitationLinksFromDisplay(rawText) {
	const text = String(rawText ?? "");
	const occurrences = collectCitations(text);
	if (occurrences.length === 0) return text;
	let out = "";
	let cursor = 0;
	for (const occ of occurrences) {
		out += text.slice(cursor, occ.start);
		cursor = occ.end;
	}
	out += text.slice(cursor);
	return out.trim();
}

function buildPopoverDom(doc, life, handlers) {
	const root = el(doc, "div", {
		className: "peer-citation-popover",
		attrs: {
			role: "dialog",
			"aria-label": "Citation comment",
			"data-testid": "citation-comment-popover",
			hidden: true,
		},
	});
	const quoteEl = el(doc, "blockquote", { className: "peer-citation-popover-quote" });
	const quoteText = textNode(doc, quoteEl, "");
	const textarea = el(doc, "textarea", {
		className: "cloudcanvas-ui-input peer-citation-textarea",
		attrs: {
			rows: "2",
			"aria-label": "Comment on selected text",
			placeholder: "Add an optional comment...",
		},
	});
	const errEl = el(doc, "p", {
		className: "peer-session-card-error",
		text: "Comments can contain up to 8,000 characters.",
		attrs: { role: "status", hidden: true },
	});
	const actions = el(doc, "div", { className: "peer-citation-popover-actions" });
	const cancelBtn = button(doc, {
		label: "Cancel",
		signal: life.signal,
		onClick: () => handlers.cancel(),
		attrs: { "data-peer-action": "cancel-citation-comment" },
	});
	const saveBtn = button(doc, {
		className: "is-primary",
		label: "Save",
		signal: life.signal,
		onClick: () => handlers.commit(false),
		attrs: { "data-peer-action": "save-citation-comment" },
	});
	actions.append(cancelBtn, saveBtn);
	root.append(quoteEl, textarea, errEl, actions);
	return { root, quoteText, textarea, errEl, saveBtn };
}

function bindPopoverInteractions(doc, life, st, nodes, helpers) {
	life.on(nodes.textarea, "input", () => {
		st.touchedDraft = nodes.textarea.value;
		helpers.syncValidation();
	});
	life.on(nodes.textarea, "keydown", (ev) => {
		const action = commentKeyAction({
			key: ev.key,
			shiftKey: ev.shiftKey,
			metaKey: ev.metaKey,
			ctrlKey: ev.ctrlKey,
			isComposing: Boolean(ev.isComposing || ev.keyCode === 229),
		});
		if (!action) return;
		ev.preventDefault();
		ev.stopPropagation();
		if (action === "cancel") helpers.close();
		else helpers.commit(action === "save-send");
	});
	life.on(doc, "pointerdown", (ev) => {
		if (nodes.root.hidden || !st.target || nodes.root.contains(ev.target)) return;
		const outcome = commentDismissalOutcome({
			reason: "outside",
			draft: st.touchedDraft,
			saved: st.target.citation?.comment,
		});
		if (outcome === "commit") helpers.commit(false);
		else if (outcome === "close") helpers.close();
	});
}

export function createCitationCommentPopover(host, { onSave, onClose } = {}) {
	const doc = documentOf(host);
	const life = createLife();
	const st = { target: null, touchedDraft: null };
	let nodes = null;
	const close = () => {
		st.target = null;
		st.touchedDraft = null;
		nodes.root.hidden = true;
		onClose?.();
	};
	const commit = (andSend) => {
		if (!st.target) return;
		const draft = nodes.textarea.value;
		if (draft.length > CITATION_MAX_COMMENT_LENGTH) return;
		const nextCitation = withCitationComment(st.target.citation, draft);
		onSave?.({ target: st.target, citation: nextCitation, comment: draft, andSend: Boolean(andSend) });
		close();
	};
	nodes = buildPopoverDom(doc, life, { cancel: close, commit });
	host.append(nodes.root);
	const syncValidation = () => {
		const tooLong = nodes.textarea.value.length > CITATION_MAX_COMMENT_LENGTH;
		nodes.errEl.hidden = !tooLong;
		nodes.saveBtn.disabled = tooLong;
		nodes.saveBtn.textContent = tooLong ? "Shorten comment" : "Save";
	};
	bindPopoverInteractions(doc, life, st, nodes, { syncValidation, close, commit });
	return {
		open(nextTarget) {
			if (life.dead || !nextTarget) return;
			st.target = nextTarget;
			st.touchedDraft = null;
			writeText(nodes.quoteText, String(nextTarget.citation?.text ?? ""));
			nodes.textarea.value = String(nextTarget.citation?.comment ?? "");
			syncValidation();
			nodes.root.hidden = false;
			nodes.textarea.focus?.({ preventScroll: true });
		},
		close,
		isOpen: () => !nodes.root.hidden,
		destroy: () => { if (life.destroy()) nodes.root.remove(); },
	};
}
