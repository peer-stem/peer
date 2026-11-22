import type { Pt } from "./cluster-geometry.ts";
import { LABELS_FADE_RATIO, type ArrowGeom } from "./types.ts";

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** The user-perceived characters of `s` (emoji, flags and accented letters stay whole). */
export function graphemes(s: string): string[] {
	return Array.from(graphemeSegmenter.segment(s), (g) => g.segment);
}

function splitOverlongWord(
	pending: string[],
	lines: string[],
	maxWidth: number,
	measure: (s: string) => number,
): void {
	const word = pending[0]!;
	const chars = graphemes(word);
	let chunk = "";
	let used = 0;
	while (used < chars.length && measure(chunk + chars[used]) <= maxWidth) chunk += chars[used++];
	const rest = chars.slice(used).join("");
	if (chunk) {
		lines.push(chunk);
		pending[0] = rest;
	} else {
		lines.push(rest);
		pending.shift();
	}
}

function fillRegionLine(
	pending: string[],
	lines: string[],
	maxWidth: number,
	measure: (s: string) => number,
): boolean {
	let line = "";
	while (pending.length > 0) {
		const word = pending[0]!;
		const candidate = line ? `${line} ${word}` : word;
		if (measure(candidate) <= maxWidth) {
			line = candidate;
			pending.shift();
			continue;
		}
		if (!line) splitOverlongWord(pending, lines, maxWidth, measure);
		break;
	}
	if (line) lines.push(line);
	return Boolean(line) || (lines.length > 0 && pending.length > 0);
}

/** Wrap one region label: word-wise first, then char-wise, capped at maxLines with ellipsis. */
export function wrapRegionLabel(
	text: string,
	maxWidth: number,
	maxLines: number,
	measure: (s: string) => number,
): string[] {
	if (maxLines < 1 || measure(text) <= maxWidth) return [text];
	const lines: string[] = [];
	const pending: string[] = text.split(/\s+/).filter(Boolean);
	while (pending.length > 0 && lines.length < maxLines - 1) {
		if (!fillRegionLine(pending, lines, maxWidth, measure)) break;
	}
	const rest = pending.join(" ");
	if (!rest) return lines;
	if (measure(rest) <= maxWidth) {
		lines.push(rest);
		return lines;
	}
	const tail = graphemes(rest);
	while (tail.length > 1 && measure(`${tail.join("")}…`) > maxWidth) tail.pop();
	lines.push(`${tail.join("")}…`);
	return lines;
}

/** Label-only cluster patch: apply live label updates to cluster records and region meta. */
export function applyClusterLabels(
	clusters: { id: string; label: string | null }[],
	regionMeta: { id: string; label: string | null; lines: string[] | null }[],
	labels: ReadonlyMap<string, string | null>,
	maxWidth: number,
	maxLines: number,
	measure: (s: string) => number,
): boolean {
	let changed = false;
	for (const cluster of clusters) {
		if (!labels.has(cluster.id) || cluster.label == null) continue;
		const label = labels.get(cluster.id) ?? null;
		if (label === cluster.label) continue;
		cluster.label = label;
		changed = true;
	}
	if (!changed) return false;
	for (const rm of regionMeta) {
		if (!labels.has(rm.id) || rm.label == null) continue;
		const label = labels.get(rm.id) ?? null;
		rm.label = label;
		rm.lines = label ? wrapRegionLabel(label, maxWidth, maxLines, measure) : null;
	}
	return true;
}

function blurHorizontal(src: Float32Array, tmp: Float32Array, w: number, h: number, radius: number): void {
	const div = radius * 2 + 1;
	for (let y = 0; y < h; y++) {
		const row = y * w * 4;
		let sum0 = 0, sum1 = 0, sum2 = 0, sum3 = 0;
		for (let x = -radius; x <= radius; x++) {
			const i = row + Math.min(Math.max(x, 0), w - 1) * 4;
			sum0 += src[i]!;
			sum1 += src[i + 1]!;
			sum2 += src[i + 2]!;
			sum3 += src[i + 3]!;
		}
		for (let x = 0; x < w; x++) {
			const o = row + x * 4;
			tmp[o] = sum0 / div;
			tmp[o + 1] = sum1 / div;
			tmp[o + 2] = sum2 / div;
			tmp[o + 3] = sum3 / div;
			const addI = row + Math.min(x + radius + 1, w - 1) * 4;
			const subI = row + Math.max(x - radius, 0) * 4;
			sum0 += src[addI]! - src[subI]!;
			sum1 += src[addI + 1]! - src[subI + 1]!;
			sum2 += src[addI + 2]! - src[subI + 2]!;
			sum3 += src[addI + 3]! - src[subI + 3]!;
		}
	}
}

function blurVertical(tmp: Float32Array, dst: Float32Array, w: number, h: number, radius: number): void {
	const div = radius * 2 + 1;
	for (let x = 0; x < w; x++) {
		const col = x * 4;
		let sum0 = 0, sum1 = 0, sum2 = 0, sum3 = 0;
		for (let y = -radius; y <= radius; y++) {
			const i = col + Math.min(Math.max(y, 0), h - 1) * w * 4;
			sum0 += tmp[i]!;
			sum1 += tmp[i + 1]!;
			sum2 += tmp[i + 2]!;
			sum3 += tmp[i + 3]!;
		}
		for (let y = 0; y < h; y++) {
			const o = col + y * w * 4;
			dst[o] = sum0 / div;
			dst[o + 1] = sum1 / div;
			dst[o + 2] = sum2 / div;
			dst[o + 3] = sum3 / div;
			const addI = col + Math.min(y + radius + 1, h - 1) * w * 4;
			const subI = col + Math.max(y - radius, 0) * w * 4;
			sum0 += tmp[addI]! - tmp[subI]!;
			sum1 += tmp[addI + 1]! - tmp[subI + 1]!;
			sum2 += tmp[addI + 2]! - tmp[subI + 2]!;
			sum3 += tmp[addI + 3]! - tmp[subI + 3]!;
		}
	}
}

/** One horizontal+vertical box-blur round over PREMULTIPLIED RGBA. */
export function boxBlurRound(
	src: Float32Array,
	tmp: Float32Array,
	dst: Float32Array,
	w: number,
	h: number,
	radius: number,
): void {
	if (radius <= 0) {
		dst.set(src);
		return;
	}
	blurHorizontal(src, tmp, w, h, radius);
	blurVertical(tmp, dst, w, h, radius);
}

const clamp01 = (v: number) => Math.min(Math.max(v, 0), 1);

/** The sigma-compatible "camera ratio": 1 at fit zoom, SMALLER when zoomed in (kFit / k). */
export function zoomRatioOf(kFit: number, k: number): number {
	return kFit / k;
}

/** Node-label opacity at a given camera ratio. */
export function labelAlpha(
	ratio: number,
	labelZoom: number,
	span = labelZoom * LABELS_FADE_RATIO,
): number {
	return clamp01(1 - (ratio - labelZoom) / span);
}

/** The camera transform that frames `bbox` in a w×h viewport with padding. */
export function fitTransform(
	bbox: { minX: number; maxX: number; minY: number; maxY: number },
	w: number,
	h: number,
	padding: number,
): { x: number; y: number; k: number } {
	const bw = Math.max(bbox.maxX - bbox.minX, 1e-6);
	const bh = Math.max(bbox.maxY - bbox.minY, 1e-6);
	const k = Math.min((w - 2 * padding) / bw, (h - 2 * padding) / bh);
	const cx = (bbox.minX + bbox.maxX) / 2;
	const cy = (bbox.minY + bbox.maxY) / 2;
	return { x: w / 2 - cx * k, y: h / 2 - cy * k, k };
}

/** The arrowhead geometry for a directed edge a→b. */
export function arrowGeometry(
	a: Pt,
	b: Pt,
	fromRadius: number,
	toRadius: number,
	headLength: number,
): ArrowGeom | null {
	const dx = b.x - a.x;
	const dy = b.y - a.y;
	const len = Math.hypot(dx, dy);
	if (len < 1e-6) return null;
	const ux = dx / len;
	const uy = dy / len;
	const tip = { x: b.x - ux * toRadius, y: b.y - uy * toRadius };
	const base = { x: tip.x - ux * headLength, y: tip.y - uy * headLength };
	const halfW = 0.4 * headLength;
	return {
		shaftFrom: { x: a.x + ux * fromRadius, y: a.y + uy * fromRadius },
		shaftTo: base,
		tip,
		left: { x: base.x - uy * halfW, y: base.y + ux * halfW },
		right: { x: base.x + uy * halfW, y: base.y - ux * halfW },
	};
}

/** Nearest node within maxDist of a screen point. */
export function pickNearest<T extends { id: string; x: number; y: number }>(
	nodes: T[],
	px: number,
	py: number,
	maxDist: number,
): T | null {
	let best: T | null = null;
	let bestD = maxDist * maxDist;
	for (const n of nodes) {
		const d = (n.x - px) ** 2 + (n.y - py) ** 2;
		if (d < bestD) {
			bestD = d;
			best = n;
		}
	}
	return best;
}

/** "#rrggbb" + alpha → "rgba(...)". */
export function rgbaFromHex(hex: string, alpha: number): string {
	const r = Number.parseInt(hex.slice(1, 3), 16);
	const g = Number.parseInt(hex.slice(3, 5), 16);
	const b = Number.parseInt(hex.slice(5, 7), 16);
	return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
