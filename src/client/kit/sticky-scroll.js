/**
 * Sticky bottom-following scroll container (`L-5`) for transcripts and logs.
 * Sticks to the bottom while content grows unless the user scrolls up past
 * `thresholdPx`, and optionally renders a floating "Jump to bottom" button.
 */
import { button, createLife, documentOf, el } from "cloudcanvas-lib/ui";
import { injectKitStyles } from "./styles.js";

const DEFAULT_THRESHOLD = 48;

function computeAtBottom(viewport, threshold) {
	const remaining = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
	return remaining <= threshold;
}

function applyStickyModel(state, jumpBtn, model = {}) {
	if (model.autoStick !== undefined) state.autoStick = Boolean(model.autoStick);
	if (model.showJumpButton !== undefined) state.showJump = Boolean(model.showJumpButton);
	if (model.jumpLabel) {
		const label = String(model.jumpLabel);
		jumpBtn.textContent = label;
		jumpBtn.setAttribute("aria-label", label);
	}
	jumpBtn.hidden = !state.showJump || state.stuck;
}

function bindStickyViewport(life, state, viewport, content, jumpBtn, threshold, onStickChange) {
	const syncJump = () => { jumpBtn.hidden = !state.showJump || state.stuck; };
	const setStuck = (next) => {
		if (state.stuck === next) return;
		state.stuck = next;
		syncJump();
		onStickChange?.(state.stuck);
	};
	const stickToBottom = () => {
		state.programmatic = true;
		viewport.scrollTop = viewport.scrollHeight;
		state.programmatic = false;
		setStuck(true);
	};
	const notifyGrowth = () => {
		if (state.autoStick && state.stuck) stickToBottom();
		else syncJump();
	};
	life.on(viewport, "scroll", () => {
		if (!state.programmatic) setStuck(computeAtBottom(viewport, threshold));
	}, { passive: true });
	if (typeof ResizeObserver === "function") {
		const ro = new ResizeObserver(() => notifyGrowth());
		ro.observe(content);
		life.add(() => ro.disconnect());
	}
	return { stickToBottom, notifyGrowth };
}

/**
 * @param {HTMLElement} host
 * @param {{onStickChange?: (stuck: boolean) => void, thresholdPx?: number}} [callbacks]
 */
export function createStickyScroll(host, callbacks = {}) {
	const doc = documentOf(host);
	injectKitStyles(doc);
	const life = createLife();
	const threshold = callbacks.thresholdPx ?? DEFAULT_THRESHOLD;
	const root = el(doc, "div", { className: "cloudcanvas-ui-sticky-scroll" });
	const viewport = el(doc, "div", { className: "cloudcanvas-ui-sticky-viewport" });
	const content = el(doc, "div", { className: "cloudcanvas-ui-sticky-content" });
	const state = { stuck: true, autoStick: true, showJump: true, programmatic: false };
	let actions = null;
	const jumpBtn = button(doc, {
		label: "Jump to bottom",
		className: "cloudcanvas-ui-sticky-jump",
		signal: life.signal,
		onClick: () => actions.stickToBottom(),
	});
	jumpBtn.hidden = true;
	viewport.append(content);
	root.append(viewport, jumpBtn);
	host.append(root);
	actions = bindStickyViewport(life, state, viewport, content, jumpBtn, threshold, callbacks.onStickChange);

	return {
		root,
		viewport,
		content,
		isAtBottom: () => state.stuck,
		stickToBottom: () => actions.stickToBottom(),
		notifyGrowth: () => actions.notifyGrowth(),
		update(model = {}) {
			if (!life.dead) applyStickyModel(state, jumpBtn, model);
		},
		destroy() {
			if (life.destroy()) root.remove();
		},
	};
}
