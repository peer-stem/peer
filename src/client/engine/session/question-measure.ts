import { createQuestionProbe, DRAFT_FIELD, MEDIA_SVG, type QuestionParts } from "./question-probe.ts";
import {
	HEIGHT_TOLERANCE,
	solveQuestionLayout,
	twoColumnTriggered,
	widthGrid,
	type ColumnSpec,
	type QuestionLayout,
} from "./question-solver.ts";

export interface MeasureOptions {
	available: number;
	base: number;
	floor: number;
}

export interface MeasuredColumn {
	min: number;
	preferredMin: number;
	max: number;
	widths: number[];
	heights: number[];
}

export interface QuestionMeasure {
	stackedNeed: number;
	columns?: { triggered: boolean; question: MeasuredColumn; answer: MeasuredColumn };
}

type Probe = ReturnType<typeof createQuestionProbe>;

export function heightCurve(widths: number[], height: (w: number) => number): number[] {
	const out = new Array<number>(widths.length);
	const fill = (lo: number, hi: number) => {
		if (hi - lo < 2) return;
		if (Math.abs(out[lo]! - out[hi]!) < HEIGHT_TOLERANCE) {
			for (let i = lo + 1; i < hi; i++) out[i] = out[lo]!;
			return;
		}
		const mid = (lo + hi) >> 1;
		out[mid] = height(widths[mid]!);
		fill(lo, mid);
		fill(mid, hi);
	};
	out[0] = height(widths[0]!);
	if (widths.length > 1) out[widths.length - 1] = height(widths[widths.length - 1]!);
	fill(0, widths.length - 1);
	return out;
}

export function curveWidths(min: number, preferredMin: number, max: number): number[] {
	const widths = widthGrid(min, max);
	const p = Math.ceil(preferredMin);
	if (!widths.includes(p) && p > widths[0]! && p < widths.at(-1)!) {
		widths.splice(widths.findIndex((w) => w > p), 0, p);
	}
	return widths;
}

export function curveHeight(c: MeasuredColumn, width: number): number {
	let lo = 0;
	let hi = c.widths.length - 1;
	while (lo < hi) {
		const mid = (lo + hi + 1) >> 1;
		if (c.widths[mid]! <= width + 0.5) lo = mid;
		else hi = mid - 1;
	}
	return c.heights[lo]!;
}

export function measureQuestionContent(probe: Probe, options: Pick<MeasureOptions, "base" | "floor">): QuestionMeasure {
	const { base, floor } = options;
	const stackedNeed = probe.unbreakable(probe.stacked, base);
	if (!probe.answer) return { stackedNeed };
	const [qh, ah] = probe.stackedHeights(base);
	const triggered = twoColumnTriggered(qh, ah);
	probe.toColumns();
	const column = (box: HTMLElement): MeasuredColumn => {
		const spec = probe.column(box, floor);
		const widths = triggered ? curveWidths(spec.min, spec.preferredMin, spec.max) : [spec.min];
		const heights = triggered ? heightCurve(widths, (w) => probe.height(box, w)) : [0];
		return { min: spec.min, preferredMin: spec.preferredMin, max: spec.max, widths, heights };
	};
	return { stackedNeed, columns: { triggered, question: column(probe.question), answer: column(probe.answer) } };
}

export function solveMeasured(m: QuestionMeasure, input: Pick<MeasureOptions, "available" | "base">): QuestionLayout {
	const spec = (c: MeasuredColumn): ColumnSpec => ({
		min: c.min,
		preferredMin: c.preferredMin,
		max: c.max,
		widths: c.widths,
		height: (w) => curveHeight(c, w),
	});
	return solveQuestionLayout({
		available: input.available,
		base: input.base,
		stackedNeed: m.stackedNeed,
		...(m.columns ? { columns: { triggered: m.columns.triggered, question: spec(m.columns.question), answer: spec(m.columns.answer) } } : {}),
	});
}

export function measureQuestionLayout(
	parts: QuestionParts,
	options: MeasureOptions,
	host?: HTMLElement,
): { layout: QuestionLayout; measure: QuestionMeasure } {
	const probe = createQuestionProbe(parts, host);
	try {
		const measure = measureQuestionContent(probe, options);
		return { layout: solveMeasured(measure, options), measure };
	} finally {
		probe.dispose();
	}
}

export function createProbeHost(root: HTMLElement): HTMLElement {
	const host = root.ownerDocument.createElement("div");
	host.setAttribute("aria-hidden", "true");
	host.setAttribute("inert", "");
	host.setAttribute("data-question-layout-host", "");
	Object.assign(host.style, {
		position: "absolute", left: "0", top: "0", width: "0", height: "0",
		overflow: "hidden", visibility: "hidden", pointerEvents: "none", contain: "strict",
	});
	root.prepend(host);
	return host;
}

type FontTracker = { epoch: number; loaded: number; listeners: Set<() => void> };
const fontTrackers = new WeakMap<object, FontTracker>();

function loadedFaces(set: FontFaceSet): number {
	let n = 0;
	const faces = set as FontFaceSet & Iterable<FontFace>;
	if (typeof faces[Symbol.iterator] === "function") {
		for (const face of faces) {
			if (face.status === "loaded") n++;
		}
	}
	return n;
}

function fontTracker(set: FontFaceSet | undefined): FontTracker | null {
	if (!set?.addEventListener) return null;
	let t = fontTrackers.get(set);
	if (!t) {
		const tracker: FontTracker = { epoch: 0, loaded: loadedFaces(set), listeners: new Set() };
		fontTrackers.set(set, (t = tracker));
		set.addEventListener("loadingdone", () => {
			const loaded = loadedFaces(set);
			if (loaded === tracker.loaded) return;
			tracker.loaded = loaded;
			tracker.epoch++;
			for (const listener of tracker.listeners) listener();
		});
	}
	return t;
}

export function onFontsLoaded(set: FontFaceSet | undefined, listener: () => void): () => void {
	const t = fontTracker(set);
	if (!t) return () => {};
	t.listeners.add(listener);
	return () => { t.listeners.delete(listener); };
}

export function questionContentFingerprint(parts: Pick<QuestionParts, "question" | "options">): string {
	const options = parts.options;
	let rich = 0;
	let text = options?.textContent?.length ?? 0;
	if (options) {
		for (const el of options.querySelectorAll(".katex, svg, img, code, table")) {
			if (!el.closest(DRAFT_FIELD)) rich++;
		}
		for (const field of options.querySelectorAll(DRAFT_FIELD)) {
			if (!field.parentElement?.closest(DRAFT_FIELD)) text -= field.textContent?.length ?? 0;
		}
	}
	const epoch = fontTracker(parts.question.ownerDocument?.fonts)?.epoch ?? 0;
	return `${parts.question.querySelectorAll("*").length}|${rich}|${text}|${epoch}`;
}

export function questionContentReady(parts: Pick<QuestionParts, "question" | "options">): boolean {
	for (const part of [parts.question, parts.options]) {
		if (!part) continue;
		if (part.querySelector('[data-testid="md-mermaid"][aria-busy="true"]')) return false;
		for (const svg of part.querySelectorAll<SVGSVGElement>(MEDIA_SVG)) {
			if (!svg.parentElement?.style.maxWidth) return false;
		}
		for (const img of part.querySelectorAll("img")) {
			if (!img.complete) return false;
		}
	}
	return parts.question.ownerDocument?.fonts?.status !== "loading";
}

export interface QuestionLayoutRequest {
	available: number;
	base: number;
	floor: number;
	key: string;
}

export function sameLayout(a: QuestionLayout | null, b: QuestionLayout | null): boolean {
	if (a === null || b === null) return a === b;
	if (a.kind === "stacked" || b.kind === "stacked") return a.kind === b.kind && a.width === b.width;
	return a.question === b.question && a.answer === b.answer;
}

export interface LiveQuestion {
	root: HTMLElement;
	question: HTMLElement;
	options: HTMLElement | null;
	observe: (HTMLElement | null)[];
}

export interface UseQuestionLayout {
	cacheId: string;
	request: QuestionLayoutRequest | null;
	identity: unknown;
	live: () => LiveQuestion | null;
	parts: (live: LiveQuestion) => QuestionParts;
	onLayout?: (layout: QuestionLayout | null) => void;
	onSwitch?: (from: QuestionLayout | null, to: QuestionLayout | null) => void;
}

type CachedMeasure = { measure: QuestionMeasure; content: string };
const measuredCache = new Map<string, CachedMeasure>();
const MEASURED_MAX = 256;

export function getCachedQuestionMeasure(key: string): CachedMeasure | undefined {
	return measuredCache.get(key);
}

export function rememberQuestionMeasure(key: string, entry: CachedMeasure): void {
	measuredCache.delete(key);
	measuredCache.set(key, entry);
	if (measuredCache.size > MEASURED_MAX) measuredCache.delete(measuredCache.keys().next().value!);
}
