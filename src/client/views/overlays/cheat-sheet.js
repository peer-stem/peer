/**
 * Keyboard shortcut cheat-sheet modal (`[data-testid="cheat-sheet"][data-peer-layer="cheat-sheet"]`).
 * Built on `createModal` from `'peer-kit'`, rendering `KEYBOARD_ACTIONS` grouped by scope
 * with optional `keymapOverrides`.
 */
import { createLife, documentOf, el, injectUiStyles } from "cloudcanvas-lib/ui";
import { KEYBOARD_ACTIONS, formatBinding } from "peer-keyboard";
import { createModal } from "peer-kit";
import { injectOverlaysStyles } from "./overlays.css.js";

const CHEAT_SCOPES = Object.freeze([
	["global", "Global"],
	["chat", "Chat"],
	["graph", "Graph view"],
]);

function renderScopeGroup(doc, scope, heading, overrides) {
	const actions = KEYBOARD_ACTIONS.filter((item) => item.scope === scope);
	if (actions.length === 0) return null;
	const group = el(doc, "div", {
		className: "peer-overlays-cheat-group",
		attrs: { "data-peer-cheat-scope": scope },
	});
	group.append(el(doc, "div", { className: "peer-overlays-cheat-heading", text: heading }));
	for (const item of actions) {
		const row = el(doc, "div", {
			className: "peer-overlays-cheat-row",
			attrs: { "data-peer-cheat-action": item.id },
		});
		const rawBinding = overrides?.[item.id] || item.binding;
		const kbd = el(doc, "kbd", { className: "peer-overlays-kbd", text: formatBinding(rawBinding) });
		row.append(el(doc, "span", { text: item.label }), kbd);
		group.append(row);
	}
	return group;
}

function syncCheatGroups(doc, body, overrides) {
	const groups = [];
	for (const [scope, heading] of CHEAT_SCOPES) {
		const group = renderScopeGroup(doc, scope, heading, overrides);
		if (group) groups.push(group);
	}
	body.replaceChildren(...groups);
}

function syncDialogDecorations(dialogEl, isOpen) {
	if (!dialogEl) return;
	dialogEl.classList.add("peer-overlays-cheat-dialog");
	const closeBtn = dialogEl.querySelector(".cloudcanvas-ui-dialog-close");
	closeBtn?.setAttribute("data-testid", "cheat-sheet-close");
	closeBtn?.setAttribute("data-peer-action", "close-cheat-sheet");
	if (isOpen) {
		dialogEl.setAttribute("data-testid", "cheat-sheet");
		dialogEl.setAttribute("data-peer-layer", "cheat-sheet");
	} else {
		dialogEl.removeAttribute("data-testid");
		dialogEl.removeAttribute("data-peer-layer");
	}
}

function bindWindowEscape(life, win, isOpenFn, onClose) {
	if (!win || typeof win.addEventListener !== "function") return;
	life.on(win, "keydown", (event) => {
		if (!isOpenFn() || event.key !== "Escape" || event.defaultPrevented) return;
		event.preventDefault();
		onClose?.();
	});
}

export function createCheatSheet(host, { onClose } = {}) {
	const doc = documentOf(host);
	injectUiStyles(doc);
	injectOverlaysStyles(doc);
	const life = createLife();
	const modal = createModal(host, { onClose: () => onClose?.() });
	const dialogEl = modal.body.closest("dialog");
	const body = el(doc, "div", { className: "peer-overlays-cheat-body" });

	let isOpen = false;
	let prevOverrides = undefined;
	bindWindowEscape(life, doc.defaultView, () => isOpen, onClose);

	const update = (model = {}) => {
		if (life.dead) return;
		const nextOpen = model?.open !== undefined ? Boolean(model.open) : true;
		const overrides = model?.keymapOverrides ?? null;
		if (overrides !== prevOverrides) {
			prevOverrides = overrides;
			syncCheatGroups(doc, body, overrides);
		}
		isOpen = nextOpen;
		modal.update({ open: nextOpen, title: "Keyboard shortcuts", closeButton: true, content: body });
		syncDialogDecorations(dialogEl, nextOpen);
	};
	update({});

	const destroy = () => {
		if (!life.destroy()) return;
		isOpen = false;
		modal.destroy();
	};

	return { node: dialogEl, update, destroy };
}
