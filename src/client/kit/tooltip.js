/**
 * Accessible hover/focus/`Escape`-dismissible tooltip (`L-7`, `role="tooltip"`).
 */
import { clamp, createLife, documentOf, el, textNode, uniqueId, writeText } from "cloudcanvas-lib/ui";
import { injectKitStyles } from "./styles.js";

const CLASS = "cloudcanvas-ui-tooltip";

function positionBubble(target, bubble, doc) {
	const win = doc.defaultView;
	if (!win || typeof target.getBoundingClientRect !== "function") return;
	const rect = target.getBoundingClientRect();
	const vw = win.innerWidth || 1024;
	const vh = win.innerHeight || 768;
	const bw = bubble.offsetWidth || 160;
	const bh = bubble.offsetHeight || 28;
	const left = clamp(rect.left + rect.width / 2 - bw / 2, 8, Math.max(8, vw - bw - 8));
	const above = rect.top - bh - 6;
	const top = above >= 8 ? above : clamp(rect.bottom + 6, 8, Math.max(8, vh - bh - 8));
	bubble.style.left = `${Math.round(left)}px`;
	bubble.style.top = `${Math.round(top)}px`;
}

function bindTooltipEvents(life, doc, target, bubble, showNow, scheduleShow, hide) {
	life.on(target, "pointerenter", scheduleShow);
	life.on(target, "pointerleave", hide);
	life.on(target, "focus", showNow);
	life.on(target, "blur", hide);
	life.on(doc, "keydown", (event) => {
		if (event.key === "Escape" && !bubble.hidden) hide();
	}, { capture: true });
}

/**
 * Attach a tooltip bound to `target` (mounted into `host` or `doc.body`).
 * @param {HTMLElement} target
 * @param {{host?: HTMLElement, delayMs?: number}} [options]
 */
export function createTooltip(target, options = {}) {
	const doc = documentOf(target);
	injectKitStyles(doc);
	const mountHost = options.host ?? doc.body;
	const life = createLife();
	const tipId = uniqueId(CLASS);
	const bubble = el(doc, "div", { className: CLASS, attrs: { id: tipId, role: "tooltip", hidden: true } });
	const labelNode = textNode(doc, bubble, "");
	let text = "";
	let cancelTimer = () => {};

	const hide = () => {
		cancelTimer();
		bubble.hidden = true;
		if (target.getAttribute("aria-describedby") === tipId) target.removeAttribute("aria-describedby");
	};
	const showNow = () => {
		if (life.dead || !text) return;
		if (!bubble.isConnected) mountHost.append(bubble);
		bubble.hidden = false;
		target.setAttribute("aria-describedby", tipId);
		positionBubble(target, bubble, doc);
	};
	const scheduleShow = () => {
		cancelTimer();
		if (!text) return;
		const delay = options.delayMs ?? 180;
		if (delay <= 0) showNow(); else cancelTimer = life.later(showNow, delay);
	};
	bindTooltipEvents(life, doc, target, bubble, showNow, scheduleShow, hide);

	return {
		bubble,
		update(model = {}) {
			if (life.dead) return;
			text = String(model.text ?? "").trim();
			writeText(labelNode, text);
			if (!text) hide();
		},
		destroy() {
			if (!life.destroy()) return;
			hide();
			bubble.remove();
		},
	};
}
