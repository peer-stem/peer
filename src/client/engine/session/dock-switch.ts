const SCROLLER = "[data-dock-scroll-area], [data-dock-viewport]";

function view(scroller: HTMLElement) {
	const r = scroller.getBoundingClientRect();
	const top = r.top + scroller.clientTop;
	return { top, bottom: top + scroller.clientHeight };
}

export function scrollNearest(scroller: HTMLElement, el: Element, margin = 8): void {
	if (scroller.scrollHeight <= scroller.clientHeight) return;
	const v = view(scroller);
	const e = el.getBoundingClientRect();
	if (e.top < v.top + margin) scroller.scrollTop -= v.top + margin - e.top;
	else if (e.bottom > v.bottom - margin) {
		scroller.scrollTop += Math.min(e.bottom - (v.bottom - margin), e.top - (v.top + margin));
	}
}

export function visibleFocused(root: HTMLElement): Element | null {
	const doc = root.ownerDocument;
	const win = doc.defaultView;
	const el = doc.activeElement;
	if (!win || !el || el === root || !root.contains(el)) return null;
	if (win.getComputedStyle(el).visibility === "hidden") return null;
	const rect = el.getBoundingClientRect();
	let top = Math.max(rect.top, 0), bottom = Math.min(rect.bottom, win.innerHeight);
	let left = Math.max(rect.left, 0), right = Math.min(rect.right, win.innerWidth);
	for (let p = el.parentElement; p && top < bottom && left < right; p = p.parentElement) {
		const { overflowX, overflowY } = win.getComputedStyle(p);
		if (overflowY && overflowY !== "visible") {
			const clip = view(p);
			top = Math.max(top, clip.top);
			bottom = Math.min(bottom, clip.bottom);
		}
		if (overflowX && overflowX !== "visible") {
			const edge = p.getBoundingClientRect().left + p.clientLeft;
			left = Math.max(left, edge);
			right = Math.min(right, edge + p.clientWidth);
		}
	}
	return top < bottom && left < right ? el : null;
}

export function revealFocused(root: HTMLElement): void {
	const focused = root.ownerDocument.activeElement;
	if (!focused || focused === root || !root.contains(focused)) return;
	for (let p = focused.parentElement; p; p = p.parentElement) {
		if (p.matches(SCROLLER)) scrollNearest(p, focused);
		if (p.hasAttribute("data-dock-viewport")) break;
	}
}

export type ReadingAnchor = { section: HTMLElement; target: Range | Element; edge: "top" | "bottom"; inset: number };

function firstReadableCharRange(range: Range, text: Text, top: number, bottom: number): Range | null {
	let lo = 0;
	let hi = text.length - 1;
	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		range.setStart(text, mid);
		range.setEnd(text, mid + 1);
		if (range.getBoundingClientRect().top >= top - 1) hi = mid;
		else lo = mid + 1;
	}
	range.setStart(text, lo);
	range.setEnd(text, lo + 1);
	const line = range.getBoundingClientRect();
	return line.height && line.top >= top - 1 && line.top < bottom ? range : null;
}

function firstVisible(section: HTMLElement, top: number, bottom: number): Range | Element | null {
	const doc = section.ownerDocument;
	if (!doc.createTreeWalker || !doc.createRange) return null;
	const walker = doc.createTreeWalker(section, 5);
	const range = doc.createRange();
	for (let node = walker.nextNode(); node; node = walker.nextNode()) {
		if (node.nodeType === 1) {
			const el = node as Element;
			if (!el.matches("img, svg, canvas, .katex")) continue;
			const r = el.getBoundingClientRect();
			if (r.height > 0 && r.bottom > top && r.top < bottom) return el;
			continue;
		}
		const text = node as Text;
		if (!text.data.trim() || text.parentElement?.closest('[aria-hidden="true"], .katex-mathml')) continue;
		range.selectNodeContents(text);
		const box = range.getBoundingClientRect();
		if (!box.height || box.bottom <= top || box.top >= bottom) continue;
		const hit = firstReadableCharRange(range, text, top, bottom);
		if (hit) return hit;
	}
	return null;
}

function scrollingAncestor(el: HTMLElement): HTMLElement | null {
	for (let p = el.parentElement; p; p = p.parentElement) {
		if (
			p.matches(SCROLLER) &&
			p.scrollHeight > p.clientHeight &&
			p.clientHeight > 0 &&
			/^(auto|scroll)$/.test(p.ownerDocument.defaultView?.getComputedStyle?.(p).overflowY ?? "")
		) {
			return p;
		}
		if (p.hasAttribute("data-dock-viewport")) break;
	}
	return null;
}

export function captureReadingPosition(
	question: HTMLElement,
	options: HTMLElement | null,
	toColumns: boolean,
): ReadingAnchor[] {
	const scroller = scrollingAncestor(question);
	if (!scroller?.scrollTop) return [];
	const { top, bottom } = view(scroller);
	if (question.getBoundingClientRect().bottom <= top) {
		if (!toColumns) return [];
		const row = options && [...options.querySelectorAll("[data-kbdrow]")].find((el) => {
			const r = el.getBoundingClientRect();
			return r.bottom > top && r.top < bottom;
		});
		return [
			{ section: question, target: question, edge: "bottom", inset: 8 },
			...(options && row ? [{ section: options, target: row, edge: "top" as const, inset: 0 }] : []),
		];
	}
	const target = firstVisible(question, top, bottom);
	if (!target) return [];
	return [{ section: question, target, edge: "top", inset: target.getBoundingClientRect().top - top }];
}

export function restoreReadingPosition(anchors: ReadingAnchor[]): void {
	let lastScroller: HTMLElement | null = null;
	for (const { section, target, edge, inset } of anchors) {
		const scroller = scrollingAncestor(section);
		if (!scroller || scroller === lastScroller) continue;
		const desired = view(scroller)[edge] + (edge === "top" ? inset : -inset);
		scroller.scrollTop += target.getBoundingClientRect()[edge] - desired;
		lastScroller = scroller;
	}
}

export function trackReadingPosition(
	question: HTMLElement,
	options: () => HTMLElement | null,
	save: (anchors: ReadingAnchor[]) => void,
): () => void {
	const viewport = question.closest<HTMLElement>("[data-dock-viewport]");
	if (!viewport) return () => {};
	const doc = question.ownerDocument;
	const width = () => `${doc.documentElement.clientWidth}:${question.clientWidth}`;
	let lastWidth = width();
	const observer = new ResizeObserver(() => { lastWidth = width(); });
	observer.observe(question);
	const onScroll = (event: Event) => {
		if (event.target !== viewport && event.target !== question.closest(SCROLLER)) return;
		if (width() !== lastWidth) return;
		save(captureReadingPosition(question, options(), true));
	};
	viewport.addEventListener("scroll", onScroll, { capture: true, passive: true });
	return () => {
		observer.disconnect();
		viewport.removeEventListener("scroll", onScroll, true);
	};
}

const INPUT_EVENTS = ["wheel", "touchstart", "pointerdown", "keydown"] as const;

function scrollerSignature(root: HTMLElement): string {
	let sig = `${root.getBoundingClientRect().width}`;
	const areas = [...root.querySelectorAll<HTMLElement>("[data-dock-scroll-area]")];
	const viewport = root.closest<HTMLElement>("[data-dock-viewport]");
	if (viewport) areas.push(viewport);
	for (const a of areas) sig += `|${a.clientWidth}x${a.clientHeight}:${a.scrollHeight}`;
	return sig;
}

export function holdAcrossSwitch(
	root: HTMLElement,
	apply: () => void,
	{ maxMs = 600, stableFrames = 3, onStop }: { maxMs?: number; stableFrames?: number; onStop?: () => void } = {},
): () => void {
	const doc = root.ownerDocument;
	const win = doc.defaultView;
	let frame = 0, stable = 0, done = false;
	const start = Date.now();
	const stop = () => {
		if (done) return;
		done = true;
		if (frame) win?.cancelAnimationFrame?.(frame);
		for (const type of INPUT_EVENTS) doc.removeEventListener(type, stop, true);
		onStop?.();
	};
	for (const type of INPUT_EVENTS) doc.addEventListener(type, stop, true);
	apply();
	let last = scrollerSignature(root);
	const tick = () => {
		frame = 0;
		if (done) return;
		apply();
		const sig = scrollerSignature(root);
		stable = sig === last ? stable + 1 : 0;
		last = sig;
		if (stable >= stableFrames || Date.now() - start > maxMs) return stop();
		frame = win?.requestAnimationFrame?.(tick) ?? 0;
	};
	frame = win?.requestAnimationFrame?.(tick) ?? 0;
	if (!frame) stop();
	return stop;
}
