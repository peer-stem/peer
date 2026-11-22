export interface DockHeightMeasurements {
	columnHeight: number;
	outsideHeight: number;
	beforeShellHeight: number;
	shellBorderHeight: number;
	contentHeight: number;
	questionHeight: number | null;
	questionPaddingHeight: number;
	questionMinContentHeight?: number;
	questionNaturalHeight?: number;
}

export const MIN_VISIBLE_LINES = 3;

export function dockHeightBudget(m: DockHeightMeasurements) {
	const available = Math.max(m.columnHeight - 32, 0);
	const viewportMaxHeight = Math.max(available - m.outsideHeight, 0);
	const shellMaxHeight = Math.max(viewportMaxHeight - m.beforeShellHeight, 0);
	const naturalHeight = m.beforeShellHeight + m.shellBorderHeight + m.contentHeight;
	const questionMaxHeight = m.questionHeight === null
		? null
		: Math.max(viewportMaxHeight - (naturalHeight - m.questionHeight), 0);
	const naturalQuestion = m.questionNaturalHeight ?? m.questionHeight ?? 0;
	const minUsableQuestion = m.questionPaddingHeight + (m.questionMinContentHeight ?? 0);
	const scrollWholeContent = questionMaxHeight === null
		? naturalHeight > viewportMaxHeight
		: questionMaxHeight <= m.questionPaddingHeight
			|| (questionMaxHeight < naturalQuestion - 0.5 && questionMaxHeight < minUsableQuestion);
	return { viewportMaxHeight, shellMaxHeight, questionMaxHeight, scrollWholeContent };
}

export interface DockHeightElements {
	column: HTMLElement;
	block: HTMLElement;
	viewport: HTMLElement;
	body: HTMLElement;
	shell: HTMLElement;
	content: HTMLElement;
}

const pixels = (value: string) => Number.parseFloat(value) || 0;
const SCROLL_AREA = "[data-dock-scroll-area]";

function edges(el: Element): number {
	const cs = getComputedStyle(el);
	return pixels(cs.paddingTop) + pixels(cs.paddingBottom) + pixels(cs.borderTopWidth) + pixels(cs.borderBottomWidth);
}

export function minContentHeight(region: HTMLElement): number {
	const prose = region.querySelector(".lh-prose") ?? region;
	const cs = getComputedStyle(prose);
	const line = pixels(cs.lineHeight) || pixels(cs.fontSize) * 1.5;
	return MIN_VISIBLE_LINES * line;
}

export function naturalRegionHeight(region: HTMLElement, height: number): number {
	let hidden = 0;
	const areas = region.matches(SCROLL_AREA) ? [region] : [...region.querySelectorAll<HTMLElement>(SCROLL_AREA)];
	for (const area of areas) hidden = Math.max(hidden, area.scrollHeight - area.clientHeight);
	return height + hidden;
}

function scrollerAncestorChrome(scroller: HTMLElement, region: HTMLElement): number {
	let fixed = edges(scroller);
	for (let el: HTMLElement = scroller; el.parentElement && el.parentElement !== region; el = el.parentElement) {
		const parent = el.parentElement;
		fixed += edges(parent);
		for (const sibling of parent.children) {
			if (sibling !== el) fixed += sibling.getBoundingClientRect().height;
		}
	}
	return fixed;
}

export function regionChrome(region: HTMLElement): number {
	if (region.matches(SCROLL_AREA)) return edges(region);
	let chrome = 0;
	for (const scroller of region.querySelectorAll<HTMLElement>(SCROLL_AREA)) {
		chrome = Math.max(chrome, scrollerAncestorChrome(scroller, region));
	}
	return chrome + edges(region);
}

export const DOCK_HEIGHT_REGION = "[data-dock-height-region], [data-dock-scroll-area]";

export function syncDockHeight(elements: DockHeightElements, expanded: boolean) {
	const { column, block, viewport, body, shell, content } = elements;
	const question = expanded ? content.querySelector<HTMLElement>(DOCK_HEIGHT_REGION) : null;
	const height = (el: HTMLElement) => el.getBoundingClientRect().height;
	const shellStyle = getComputedStyle(shell);
	const budget = dockHeightBudget({
		columnHeight: column.clientHeight,
		outsideHeight: Math.max(height(block) - height(viewport), 0),
		beforeShellHeight: Math.max(height(body) - height(shell), 0),
		shellBorderHeight: pixels(shellStyle.borderTopWidth) + pixels(shellStyle.borderBottomWidth),
		contentHeight: height(content),
		questionHeight: question ? height(question) : null,
		questionPaddingHeight: question ? regionChrome(question) : 0,
		questionMinContentHeight: question ? minContentHeight(question) : 0,
		...(question ? { questionNaturalHeight: naturalRegionHeight(question, height(question)) } : {}),
	});
	if (budget.questionMaxHeight === null) block.style.removeProperty("--dock-max-h");
	else block.style.setProperty("--dock-max-h", budget.scrollWholeContent ? "none" : `${budget.questionMaxHeight}px`);
	viewport.style.maxHeight = `${budget.viewportMaxHeight}px`;
	viewport.style.overflowY = budget.scrollWholeContent ? "auto" : "visible";
	shell.style.maxHeight = budget.scrollWholeContent ? "none" : `${budget.shellMaxHeight}px`;
	return budget;
}

export function clearDockHeightStyles(elements: Pick<DockHeightElements, "block" | "viewport" | "shell">): void {
	elements.block.style.removeProperty("--dock-max-h");
	elements.viewport.style.removeProperty("max-height");
	elements.viewport.style.removeProperty("overflow-y");
	elements.shell.style.removeProperty("max-height");
}

export function forwardDockWheel(event: WheelEvent, root: HTMLElement, transcript: HTMLElement): void {
	if (event.deltaY === 0) return;
	for (let n = event.target as HTMLElement | null; n && n !== root; n = n.parentElement) {
		if (!(n instanceof HTMLElement) || !/^(auto|scroll)$/.test(getComputedStyle(n).overflowY)) continue;
		if (n.scrollHeight - n.clientHeight < 2) continue;
		if (event.deltaY < 0 ? n.scrollTop > 0 : n.scrollTop < n.scrollHeight - n.clientHeight - 0.5) return;
	}
	event.preventDefault();
	transcript.scrollTop += event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? transcript.clientHeight : 1);
}
