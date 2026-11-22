/**
 * Modal wrapper (`L-10`) over `cloudcanvas-lib/ui` `createDialog`:
 * adds reference-counted document scroll lock and a two-ended backdrop guard
 * (`pointerdown` + `click` must both hit the `<dialog>` backdrop, preventing
 * text-selection drags from inside the panel from closing the modal).
 */
import { createDialog, createLife, documentOf } from "cloudcanvas-lib/ui";
import { injectKitStyles } from "./styles.js";

const lockCounts = new WeakMap();

function acquireScrollLock(doc) {
	const entry = lockCounts.get(doc) ?? { count: 0, priorOverflow: "" };
	if (entry.count === 0 && doc.body) {
		entry.priorOverflow = doc.body.style.overflow;
		doc.body.style.overflow = "hidden";
	}
	entry.count += 1;
	lockCounts.set(doc, entry);
}

function releaseScrollLock(doc) {
	const entry = lockCounts.get(doc);
	if (!entry) return;
	entry.count = Math.max(0, entry.count - 1);
	if (entry.count === 0) {
		if (doc.body) doc.body.style.overflow = entry.priorOverflow;
		lockCounts.delete(doc);
	}
}

/**
 * @param {HTMLElement} host
 * @param {{onClose?: (reason: "escape"|"backdrop"|"button") => void}} [callbacks]
 */
export function createModal(host, { onClose } = {}) {
	const doc = documentOf(host);
	injectKitStyles(doc);
	const life = createLife();
	let open = false;
	let downOnBackdrop = true;
	const dialog = createDialog(host, {
		onClose: (reason) => {
			if (reason === "backdrop" && !downOnBackdrop) return;
			onClose?.(reason);
		},
	});
	const bindBackdropGuard = () => {
		const dialogEl = dialog.body.closest("dialog");
		if (!dialogEl || dialogEl.dataset.kitBackdropBound === "1") return;
		dialogEl.dataset.kitBackdropBound = "1";
		life.on(dialogEl, "pointerdown", (event) => {
			downOnBackdrop = event.target === dialogEl;
		}, { capture: true });
	};
	return {
		body: dialog.body,
		update(model = {}) {
			if (life.dead) return;
			const nextOpen = Boolean(model.open);
			dialog.update(model);
			if (nextOpen) bindBackdropGuard();
			if (nextOpen && !open) acquireScrollLock(doc);
			else if (!nextOpen && open) releaseScrollLock(doc);
			open = nextOpen;
		},
		destroy() {
			if (!life.destroy()) return;
			if (open) releaseScrollLock(doc);
			open = false;
			dialog.destroy();
		},
	};
}
