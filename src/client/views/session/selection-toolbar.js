/**
 * Floating transcript text-selection toolbar (`selection-toolbar.js`).
 * Uses `captureSelection`, `observeSelectionActions`, `isSelectionRectVisible`,
 * `resolveSelectionActionPosition`, `createCiteAction`, and `SIDE_QUOTE_MAX_CHARS`
 * from `'peer-engine'` to offer `Cite` and `Ask` actions over tutor prose.
 */
import { createLife, documentOf, el } from "cloudcanvas-lib/ui";
import {
	SIDE_QUOTE_MAX_CHARS,
	captureSelection,
	createCiteAction,
	isSelectionRectVisible,
	observeSelectionActions,
	resolveSelectionActionPosition,
} from "peer-engine";

export function runSelectionAction(action, capture) {
	if (!action || action.disabledLabel?.(capture)) return false;
	return Boolean(action.onSelect(capture));
}

function computeClipRects(node, viewport, win) {
	const clips = [viewport.getBoundingClientRect()];
	for (let cur = node.parentElement; cur && cur !== viewport; cur = cur.parentElement) {
		const style = typeof win?.getComputedStyle === "function" ? win.getComputedStyle(cur) : null;
		const clipX = style ? style.overflowX !== "visible" : false;
		const clipY = style ? style.overflowY !== "visible" : false;
		if (!clipX && !clipY) continue;
		const b = cur.getBoundingClientRect();
		const left = b.left + cur.clientLeft;
		const top = b.top + cur.clientTop;
		clips.push({
			left: clipX ? left : -Infinity,
			right: clipX ? left + cur.clientWidth : Infinity,
			top: clipY ? top : -Infinity,
			bottom: clipY ? top + cur.clientHeight : Infinity,
		});
	}
	return clips;
}

function isRangeLineVisible(doc, win, range, viewport) {
	const root = range.commonAncestorContainer;
	if (!root) return false;
	const rect = range.getBoundingClientRect?.();
	if (rect && rect.width === 0 && rect.height === 0) return true;
	const walker = doc.createTreeWalker(root, 4);
	let node = root.nodeType === 3 ? root : walker.nextNode();
	for (; node; node = walker.nextNode()) {
		if (typeof range.intersectsNode === "function" && !range.intersectsNode(node)) continue;
		const slice = doc.createRange();
		slice.selectNodeContents(node);
		if (node === range.startContainer) slice.setStart(node, range.startOffset);
		if (node === range.endContainer) slice.setEnd(node, range.endOffset);
		if (!slice.toString().trim()) continue;
		const clips = computeClipRects(node, viewport, win);
		const rects = Array.from(slice.getClientRects?.() ?? []);
		if (rects.length === 0 || rects.some((line) => isSelectionRectVisible(line, clips))) return true;
	}
	return true;
}

function buildDefaultActions(getChatId, getComposer, onOpenCitationEditor, onOpenSideThread) {
	const cite = {
		id: "cite",
		label: "Cite",
		ariaLabel: "Cite selection in your input",
		disabledLabel: (cap) => createCiteAction({
			chatId: getChatId(),
			composer: getComposer,
			openEditor: (t) => onOpenCitationEditor?.(t),
		}).disabledLabel?.(cap) ?? null,
		visible: () => getComposer() !== null,
		onSelect: (cap) => createCiteAction({
			chatId: getChatId(),
			composer: getComposer,
			openEditor: (t) => onOpenCitationEditor?.(t),
		}).onSelect(cap),
	};
	const ask = {
		id: "side-ask",
		label: "Ask",
		ariaLabel: "Ask a side question about this selection",
		disabledLabel: (cap) => (cap.selector.text.length > SIDE_QUOTE_MAX_CHARS ? "Shorten selection" : null),
		visible: () => typeof onOpenSideThread === "function",
		onSelect: (cap) => {
			const { text, start, end, prefix, suffix } = cap.selector;
			onOpenSideThread({
				anchor: { kind: "range", range: cap.range.cloneRange() },
				passage: { text, sourceMessageId: cap.messageId, selector: { start, end, prefix, suffix } },
			});
			return true;
		},
	};
	return [cite, ask];
}

function buildToolbarButton(doc, action, capture, onDone) {
	const disabledReason = action.disabledLabel?.(capture) ?? null;
	const label = disabledReason ?? action.label;
	const ariaLabel = disabledReason ?? action.ariaLabel;
	const btn = el(doc, "button", {
		className: "cloudcanvas-ui-button peer-selection-btn",
		text: label,
		attrs: { type: "button", "data-peer-selection-action": action.id, "aria-label": ariaLabel },
	});
	btn.disabled = disabledReason !== null;
	btn.addEventListener("pointerdown", (ev) => ev.preventDefault());
	btn.addEventListener("click", () => {
		if (runSelectionAction(action, capture)) onDone();
	});
	return btn;
}

function renderActionButtons(doc, toolbar, capture, actions, onDone) {
	const buttons = actions
		.filter((action) => action.visible(capture))
		.map((action) => buildToolbarButton(doc, action, capture, onDone));
	toolbar.replaceChildren(...buttons);
	return buttons.length > 0;
}

function evaluateToolbarSelection(env, viewport, pointer) {
	const { doc, win, toolbar, actions, hide, finishSelection } = env;
	const capture = captureSelection(viewport, win?.getSelection?.() ?? null);
	if (!capture || !actions.some((a) => a.visible(capture))) { hide(); return; }
	const vpRect = viewport.getBoundingClientRect();
	const rangeRect = capture.range.getBoundingClientRect?.() ?? vpRect;
	const hasArea = vpRect.width > 0 && vpRect.height > 0;
	if (hasArea && (!isSelectionRectVisible(rangeRect, [vpRect]) || !isRangeLineVisible(doc, win, capture.range, viewport))) {
		hide();
		return;
	}
	const lines = Array.from(capture.range.getClientRects?.() ?? []);
	const pos = resolveSelectionActionPosition({
		bounds: hasArea ? vpRect : { left: 0, top: 0, right: 800, bottom: 600 },
		selectionRect: lines.at(-1) ?? rangeRect,
		pointer,
		viewport: { width: win?.innerWidth || 1280, height: win?.innerHeight || 800 },
	});
	if (!renderActionButtons(doc, toolbar, capture, actions, finishSelection)) { hide(); return; }
	toolbar.style.left = `${pos.x}px`;
	toolbar.style.top = `${pos.y}px`;
	toolbar.hidden = false;
}

export function createSelectionToolbar(host, options = {}) {
	const doc = documentOf(host);
	const win = doc.defaultView ?? globalThis.window;
	const life = createLife();
	let chatId = String(options.chatId ?? "");
	let observer = null;
	const getComposer = options.getComposer ?? (() => null);
	const actions = options.actions ?? buildDefaultActions(
		() => chatId, getComposer, options.onOpenCitationEditor, options.onOpenSideThread,
	);
	const toolbar = el(doc, "div", {
		className: "peer-selection-toolbar",
		attrs: { role: "toolbar", "aria-label": "Selection actions", "data-testid": "selection-toolbar", hidden: true },
	});
	host.append(toolbar);
	const hide = () => { toolbar.hidden = true; toolbar.replaceChildren(); };
	const finishSelection = () => { win?.getSelection?.()?.removeAllRanges?.(); observer?.cancel?.(); hide(); };
	const env = { doc, win, toolbar, actions, hide, finishSelection };

	life.on(toolbar, "keydown", (ev) => {
		ev.stopPropagation();
		if (ev.key === "Escape" && !ev.isComposing) { ev.preventDefault(); observer?.cancel?.(); hide(); }
	});
	const viewport = options.viewport ?? null;
	if (viewport && win) {
		observer = observeSelectionActions({
			element: viewport,
			getActionElement: () => (toolbar.hidden ? null : toolbar),
			restoreAfterScroll: true,
			onSelection: (pointer) => evaluateToolbarSelection(env, viewport, pointer),
			onDismiss: hide,
		});
		life.on(doc, "selectionchange", () => observer.selectionChanged());
	}
	return {
		update: (next = {}) => { if (next.chatId !== undefined) chatId = String(next.chatId ?? ""); },
		evaluateNow: (pointer = null) => { if (viewport) evaluateToolbarSelection(env, viewport, pointer); },
		destroy: () => { if (!life.destroy()) return; observer?.dispose?.(); observer = null; toolbar.remove(); },
	};
}
