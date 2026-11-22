export type SelectionActionPoint = { x: number; y: number };
export type RectLike = { left: number; top: number; right: number; bottom: number };
export type SelectionDismissReason = "interaction" | "cancel";

const EDGE = 8;
const MULTI_CLICK_SETTLE_MS = 500;
const SCROLL_SETTLE_MS = 150;

export function resolveSelectionActionPosition({
	bounds,
	selectionRect,
	pointer,
	viewport,
}: {
	bounds: RectLike;
	selectionRect: RectLike | null;
	pointer: SelectionActionPoint | null;
	viewport: { width: number; height: number };
}): SelectionActionPoint {
	const preferred = pointer
		?? (selectionRect ? { x: selectionRect.right, y: selectionRect.bottom + 4 } : { x: bounds.right - 140, y: bounds.top + 12 });
	const minX = Math.max(bounds.left, 0) + EDGE;
	const maxX = Math.min(bounds.right, viewport.width) - EDGE;
	const minY = Math.max(bounds.top, 0) + EDGE;
	const maxY = Math.min(bounds.bottom, viewport.height) - EDGE;
	return {
		x: Math.min(Math.max(preferred.x, minX), Math.max(minX, maxX)),
		y: Math.min(Math.max(preferred.y, minY), Math.max(minY, maxY)),
	};
}

export function isSelectionRectVisible(rect: RectLike, clips: readonly RectLike[]): boolean {
	let { left, top, right, bottom } = rect;
	for (const clip of clips) {
		left = Math.max(left, clip.left);
		top = Math.max(top, clip.top);
		right = Math.min(right, clip.right);
		bottom = Math.min(bottom, clip.bottom);
	}
	return right > left && bottom > top;
}

interface ObserverOptions {
	element: HTMLElement;
	getActionElement: () => HTMLElement | null;
	restoreAfterScroll: boolean;
	onSelection: (pointer: SelectionActionPoint | null) => void;
	onDismiss: (reason: SelectionDismissReason) => void;
}

interface SelectionRuntimeState {
	pointerDown: boolean;
	gesture: boolean;
	shown: boolean;
	timer: number | undefined;
	frame: number | undefined;
	scrollTimer: number | undefined;
	clearPending(): void;
	schedule(delay: number, pointer: SelectionActionPoint | null): void;
	dismiss(reason: SelectionDismissReason): void;
	onAction(target: EventTarget | null): boolean;
}

function scheduleSelectionFrame(
	s: SelectionRuntimeState,
	view: Window & typeof globalThis,
	opts: ObserverOptions,
	delay: number,
	pointer: SelectionActionPoint | null,
): void {
	s.clearPending();
	const onTimer = () => {
		s.timer = undefined;
		s.frame = view.requestAnimationFrame(() => { s.frame = undefined; s.shown = true; opts.onSelection(pointer); });
	};
	s.timer = view.setTimeout(onTimer, delay);
}

function createSelectionState(view: Window & typeof globalThis, opts: ObserverOptions): SelectionRuntimeState {
	const s: SelectionRuntimeState = {
		pointerDown: false, gesture: false, shown: false,
		timer: undefined, frame: undefined, scrollTimer: undefined,
		clearPending() {
			if (s.timer !== undefined) view.clearTimeout(s.timer);
			if (s.frame !== undefined) view.cancelAnimationFrame(s.frame);
			s.timer = s.frame = undefined;
		},
		schedule: (delay, pointer) => scheduleSelectionFrame(s, view, opts, delay, pointer),
		dismiss(reason) { s.clearPending(); s.shown = false; opts.onDismiss(reason); },
		onAction(target) {
			const action = opts.getActionElement();
			return Boolean(action && target instanceof view.Node && action.contains(target));
		},
	};
	return s;
}

function createSelectionHandlers(s: SelectionRuntimeState, view: Window & typeof globalThis, opts: ObserverOptions) {
	const { element, restoreAfterScroll } = opts;
	return {
		pointerDownCapture(event: PointerEvent) {
			if (s.onAction(event.target)) { s.clearPending(); return; }
			if (s.shown || s.timer !== undefined) s.dismiss("interaction");
			s.pointerDown = true;
			const target = event.target as Element | null;
			s.gesture = event.button === 0 && !event.defaultPrevented && element.contains(target) && !target?.closest("button, [role=button]");
		},
		mouseUp(event: MouseEvent) {
			s.pointerDown = false;
			if (!s.gesture || event.button !== 0) return;
			s.gesture = false;
			s.schedule(event.detail >= 2 ? MULTI_CLICK_SETTLE_MS : 0, { x: event.clientX, y: event.clientY });
		},
		keyDown(event: KeyboardEvent) {
			if (event.key === "Escape") { if (s.shown || s.timer !== undefined) s.dismiss("cancel"); return; }
			s.pointerDown = false;
		},
		cancel() { if (s.shown || s.timer !== undefined) s.dismiss("cancel"); },
		contextMenu() { s.dismiss("interaction"); },
		focusIn(event: FocusEvent) { if (s.shown && !s.onAction(event.target)) s.dismiss("interaction"); },
		scroll() {
			if (s.pointerDown) return;
			const wasShown = s.shown;
			if (s.shown || s.timer !== undefined) s.dismiss("cancel");
			if (!restoreAfterScroll || !wasShown) return;
			if (s.scrollTimer !== undefined) view.clearTimeout(s.scrollTimer);
			s.scrollTimer = view.setTimeout(() => { s.scrollTimer = undefined; s.schedule(0, null); }, SCROLL_SETTLE_MS);
		},
	};
}

export function observeSelectionActions(
	opts: ObserverOptions,
): { selectionChanged: () => void; cancel: () => void; dispose: () => void } {
	const { element } = opts;
	const view = element.ownerDocument.defaultView!;
	const doc = element.ownerDocument;
	const s = createSelectionState(view, opts);
	const h = createSelectionHandlers(s, view, opts);

	doc.addEventListener("pointerdown", h.pointerDownCapture, true);
	doc.addEventListener("mouseup", h.mouseUp, true);
	doc.addEventListener("keydown", h.keyDown, true);
	doc.addEventListener("focusin", h.focusIn, true);
	element.addEventListener("contextmenu", h.contextMenu);
	element.addEventListener("scroll", h.scroll, true);
	view.addEventListener("pointercancel", h.cancel);
	view.addEventListener("blur", h.cancel);
	view.addEventListener("resize", h.cancel);

	return {
		selectionChanged() {
			if (s.pointerDown) { if (s.shown) s.dismiss("cancel"); return; }
			if (s.timer === undefined && s.frame === undefined) s.schedule(0, null);
		},
		cancel() { s.clearPending(); s.shown = false; },
		dispose() {
			s.clearPending();
			if (s.scrollTimer !== undefined) view.clearTimeout(s.scrollTimer);
			doc.removeEventListener("pointerdown", h.pointerDownCapture, true);
			doc.removeEventListener("mouseup", h.mouseUp, true);
			doc.removeEventListener("keydown", h.keyDown, true);
			doc.removeEventListener("focusin", h.focusIn, true);
			element.removeEventListener("contextmenu", h.contextMenu);
			element.removeEventListener("scroll", h.scroll, true);
			view.removeEventListener("pointercancel", h.cancel);
			view.removeEventListener("blur", h.cancel);
			view.removeEventListener("resize", h.cancel);
		},
	};
}
