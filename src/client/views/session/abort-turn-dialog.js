/**
 * Esc-abort confirmation modal (`[data-testid="abort-turn-dialog"]`) built on
 * `createModal` from `'peer-kit'` for `"turn" | "question" | "problem" | null`.
 */
import { button, createLife, documentOf, el, textNode, writeText } from "cloudcanvas-lib/ui";
import { createModal } from "peer-kit";

export const ABORT_COPY = Object.freeze({
	turn: Object.freeze({
		title: "Abort this turn?",
		line: "The partial answer stays in the transcript.",
		action: "Abort",
	}),
	question: Object.freeze({
		title: "Dismiss this question?",
		line: "Skipped — the teacher moves on without it.",
		action: "Dismiss",
	}),
	problem: Object.freeze({
		title: "Discard this problem?",
		line: "The problem is dropped — no solution is revealed.",
		action: "Discard",
	}),
});

function buildAbortDialogContent(doc, life, handlers) {
	const content = el(doc, "div", { className: "peer-abort-dialog-body" });
	const lineEl = el(doc, "p", {
		className: "peer-abort-dialog-line",
		attrs: { "data-testid": "abort-turn-line" },
	});
	const lineText = textNode(doc, lineEl, "");
	const actions = el(doc, "div", { className: "peer-abort-dialog-actions" });
	const cancelBtn = button(doc, {
		className: "peer-abort-dialog-cancel",
		label: "Cancel",
		signal: life.signal,
		onClick: () => handlers.onClose(),
		attrs: { "data-testid": "abort-turn-cancel", "data-peer-action": "abort-cancel" },
	});
	const confirmBtn = button(doc, {
		className: "peer-abort-dialog-confirm is-danger",
		label: "Abort",
		signal: life.signal,
		onClick: () => handlers.onConfirm(),
		attrs: { "data-testid": "abort-turn-confirm", "data-peer-action": "abort-confirm" },
	});
	const confirmText = confirmBtn.firstChild;
	actions.append(cancelBtn, confirmBtn);
	content.append(lineEl, actions);
	return { content, lineText, confirmText };
}

function syncDialogAttributes(dialogEl, mode, open) {
	if (!dialogEl) return;
	dialogEl.classList.add("peer-abort-dialog");
	const titleEl = dialogEl.querySelector(".cloudcanvas-ui-dialog-title");
	if (open && mode) {
		dialogEl.setAttribute("data-testid", "abort-turn-dialog");
		dialogEl.setAttribute("data-abort-mode", mode);
		titleEl?.setAttribute("data-testid", "abort-turn-title");
	} else {
		dialogEl.removeAttribute("data-testid");
		dialogEl.removeAttribute("data-abort-mode");
		titleEl?.removeAttribute("data-testid");
	}
}

function applyAbortUpdate(state, nodes, modal, dialogEl, input = null) {
	if (state.life.dead) return;
	const rawMode = typeof input === "string" ? input : input?.mode ?? null;
	const busy = Boolean(typeof input === "object" && input !== null && input.busy);
	const copy = rawMode && Object.hasOwn(ABORT_COPY, rawMode) ? ABORT_COPY[rawMode] : null;
	if (!copy) {
		state.activeMode = null;
		modal.update({ open: false, closeButton: false, content: nodes.content });
		syncDialogAttributes(dialogEl, null, false);
		return;
	}
	state.activeMode = rawMode;
	const suffix = busy && rawMode !== "turn" ? " The working turn stops too." : "";
	writeText(nodes.lineText, `${copy.line}${suffix}`);
	writeText(nodes.confirmText, copy.action);
	modal.update({ open: true, title: copy.title, closeButton: false, content: nodes.content });
	syncDialogAttributes(dialogEl, rawMode, true);
}

export function createAbortTurnDialog(host, { onConfirm, onClose } = {}) {
	const doc = documentOf(host);
	const life = createLife();
	const state = { life, activeMode: null };
	const modal = createModal(host, { onClose: () => { if (state.activeMode) onClose?.(); } });
	const dialogEl = modal.body.closest("dialog");
	const nodes = buildAbortDialogContent(doc, life, {
		onClose: () => onClose?.(),
		onConfirm: () => { if (state.activeMode) onConfirm?.(state.activeMode); },
	});
	const destroy = () => {
		if (!life.destroy()) return;
		state.activeMode = null;
		modal.destroy();
	};
	return {
		node: dialogEl,
		isOpen: () => state.activeMode !== null,
		getMode: () => state.activeMode,
		update: (input) => applyAbortUpdate(state, nodes, modal, dialogEl, input),
		destroy,
	};
}
