import type { ColumnSpec } from "./question-solver.ts";

export const QUESTION_COLUMN_PAD = "pl-4 pr-3 pt-3 pb-2";
export const STACKED_AREA_PAD = "px-4 pt-3";
export const CONFIDENCE_ROW_PAD = "pt-1.5 pb-3.5";
export const ANSWER_COLUMN_FRAME = "flex flex-col justify-center";
export const ANSWER_OPTIONS_PAD = "pl-3 pr-4 pt-3";
export const ANSWER_COLUMN_INSET_CSS = "1.75rem";
export const COLUMN_GAP_CSS = "1.5rem";

export const MEDIA_SVG = '[data-testid="md-mermaid"][data-streamdown="mermaid"] > div > svg';
export const DRAFT_FIELD = '[role="textbox"], [contenteditable]:not([contenteditable="false"])';
const MEASURE_CH = 70;

export function rootRem(doc: Document | undefined = typeof document === "undefined" ? undefined : document): number {
	const px = doc ? parseFloat(getComputedStyle(doc.documentElement).fontSize) : NaN;
	return px > 0 ? px : 16;
}

export function questionCardGeometry(rem = 16) {
	const chrome = 2 * rem + 2;
	return { container: 46 * rem, chrome, base: 46 * rem - chrome, floor: 23 * rem };
}

export function dockContainerMax(blockWidth: number, rem: number, transcriptMaxWidth: number | null): number {
	const cap = transcriptMaxWidth === null ? Infinity : transcriptMaxWidth * rem;
	return Math.min(cap, blockWidth - rem);
}

export function layoutFontKey(appearance: {
	fontFamily?: string | null;
	proseFontSize: number;
	codeLigatures?: boolean;
	mdRendering?: { headingWeight?: number };
}): string {
	return `${appearance.fontFamily ?? ""}|${appearance.proseFontSize}|${appearance.codeLigatures ? 1 : 0}|${appearance.mdRendering?.headingWeight ?? ""}`;
}

export interface QuestionParts {
	root: HTMLElement;
	question: HTMLElement;
	options: HTMLElement | null;
	confidence: HTMLElement | null;
	media?: { question: HTMLElement; options: HTMLElement | null };
}

export function cloneWithImageSizes(live: HTMLElement): Node {
	const clone = live.cloneNode(true) as HTMLElement;
	const liveImgs = live.querySelectorAll("img");
	clone.querySelectorAll("img").forEach((img, i) => {
		const source = liveImgs[i];
		if (!source?.naturalWidth || img.hasAttribute("width")) return;
		img.setAttribute("width", String(source.naturalWidth));
		img.setAttribute("height", String(source.naturalHeight));
	});
	return clone;
}

function withoutDrafts(clone: HTMLElement): HTMLElement {
	for (const field of clone.querySelectorAll<HTMLElement>(DRAFT_FIELD)) {
		field.replaceChildren();
		field.dataset.empty = "true";
	}
	return clone;
}

function overflowAtWidth(box: HTMLElement, width: number): number {
	box.style.width = `${width}px`;
	let over = Math.max(0, box.scrollWidth - box.clientWidth);
	for (const el of box.querySelectorAll<HTMLElement>("*")) {
		const d = el.scrollWidth - el.clientWidth;
		if (el.clientWidth <= 0 || d <= over) continue;
		if (/^(auto|scroll)$/.test(getComputedStyle(el).overflowX)) over = d;
	}
	return over;
}

function measureUnbreakable(box: HTMLElement, start: number): number {
	const o1 = overflowAtWidth(box, start);
	if (o1 <= 0) return start;
	const w2 = Math.ceil(start + o1) + 1;
	const o2 = overflowAtWidth(box, w2);
	if (o2 <= 0) return w2;
	return o2 < o1 ? Math.ceil(w2 + o2) + 1 : start;
}

function measureMediaNatural(parts: QuestionParts, qBox: HTMLElement, box: HTMLElement): number {
	const source = parts.media ?? parts;
	const live = box === qBox ? source.question : source.options;
	if (!live) return 0;
	let widest = 0;
	for (const svg of live.querySelectorAll<SVGSVGElement>(MEDIA_SVG)) {
		const holder = svg.parentElement?.style.maxWidth ?? "";
		const capped = holder.endsWith("px") ? parseFloat(holder) : 0;
		const inline = svg.style.maxWidth.endsWith("px") ? parseFloat(svg.style.maxWidth) : 0;
		const natural = capped > 0 ? capped : inline > 0 ? inline : svg.viewBox?.baseVal?.width ?? 0;
		if (natural > widest) widest = natural;
	}
	for (const img of live.querySelectorAll("img")) {
		if (img.naturalWidth > widest) widest = img.naturalWidth;
	}
	if (!widest) return 0;
	const cs = getComputedStyle(box);
	return Math.ceil(
		widest + parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight) + parseFloat(cs.borderLeftWidth) + parseFloat(cs.borderRightWidth),
	);
}

function createProbeWrapper(doc: Document): HTMLElement {
	const wrapper = doc.createElement("div");
	wrapper.setAttribute("aria-hidden", "true");
	wrapper.setAttribute("data-question-layout-probe", "");
	wrapper.setAttribute("inert", "");
	Object.assign(wrapper.style, {
		position: "absolute", left: "0", top: "0", width: "0", height: "0",
		overflow: "hidden", visibility: "hidden", pointerEvents: "none", contain: "strict",
	});
	return wrapper;
}

function buildProbeDom(parts: QuestionParts, host: HTMLElement) {
	const doc = parts.root.ownerDocument;
	const wrapper = createProbeWrapper(doc);
	const div = (cls: string) => { const el = doc.createElement("div"); el.className = cls; return el; };
	const place = (el: HTMLElement) => {
		Object.assign(el.style, { position: "absolute", left: "0", top: "0", boxSizing: "border-box" });
		wrapper.append(el);
		return el;
	};
	const question = cloneWithImageSizes(parts.question) as HTMLElement;
	const options = parts.options ? withoutDrafts(cloneWithImageSizes(parts.options) as HTMLElement) : null;
	const confidence = options && parts.confidence ? (parts.confidence.cloneNode(true) as HTMLElement) : null;
	if (confidence) confidence.className = CONFIDENCE_ROW_PAD;
	const sBox = place(div(STACKED_AREA_PAD)), sQuestion = div("flow-root"), sAnswer = div("flow-root");
	sBox.append(sQuestion, sAnswer);
	const qBox = place(div(QUESTION_COLUMN_PAD));
	const aBox = options ? place(div(ANSWER_COLUMN_FRAME)) : null;
	const pad = options ? div(ANSWER_OPTIONS_PAD) : null;
	if (aBox && pad) aBox.append(pad);
	const arrange = (mode: "stacked" | "columns") => {
		const qTarget = mode === "stacked" ? sQuestion : qBox;
		const aTarget = mode === "stacked" ? sAnswer : pad;
		qTarget.append(question);
		if (options && aTarget) aTarget.append(options);
		if (confidence && aTarget) aTarget.append(confidence);
	};
	arrange("stacked");
	const ch = div("lh-prose");
	Object.assign(ch.style, { position: "absolute", width: `${MEASURE_CH}ch`, height: "0" });
	wrapper.append(ch);
	host.append(wrapper);
	return { wrapper, sBox, sQuestion, sAnswer, qBox, aBox, chPx: ch.getBoundingClientRect().width, arrange };
}

function buildColumnSpec(
	box: HTMLElement,
	floor: number,
	chPx: number,
	mediaNatural: (box: HTMLElement) => number,
	height: (box: HTMLElement, width: number) => number,
): ColumnSpec {
	const cs = getComputedStyle(box);
	const chrome = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight) + parseFloat(cs.borderLeftWidth) + parseFloat(cs.borderRightWidth);
	const min = Math.max(floor, measureUnbreakable(box, floor));
	const preferredMin = Math.max(min, mediaNatural(box));
	const max = Math.max(preferredMin, Math.ceil(chPx + chrome));
	return { min, preferredMin, max, height: (w) => height(box, Math.round(w)) };
}

export function createQuestionProbe(parts: QuestionParts, host: HTMLElement = parts.root) {
	const dom = buildProbeDom(parts, host);
	const cache = new WeakMap<HTMLElement, Map<number, number>>();
	const height = (box: HTMLElement, width: number) => {
		let byWidth = cache.get(box);
		if (!byWidth) cache.set(box, (byWidth = new Map()));
		const hit = byWidth.get(width);
		if (hit !== undefined) return hit;
		box.style.width = `${width}px`;
		const h = box.getBoundingClientRect().height;
		byWidth.set(width, h);
		return h;
	};
	const mediaNatural = (box: HTMLElement) => measureMediaNatural(parts, dom.qBox, box);
	return {
		stacked: dom.sBox,
		stackedHeights(width: number): [number, number] {
			dom.sBox.style.width = `${width}px`;
			return [dom.sQuestion.getBoundingClientRect().height, dom.sAnswer.getBoundingClientRect().height];
		},
		toColumns() { dom.arrange("columns"); },
		question: dom.qBox,
		answer: dom.aBox,
		chPx: dom.chPx,
		height,
		unbreakable: measureUnbreakable,
		mediaNatural,
		column: (box: HTMLElement, floor: number) => buildColumnSpec(box, floor, dom.chPx, mediaNatural, height),
		dispose() { dom.wrapper.remove(); },
	};
}
