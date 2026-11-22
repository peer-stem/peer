import { clusterHue } from "./cluster-geometry.ts";
import { boxBlurRound, wrapRegionLabel } from "./math.ts";
import {
	LABEL_WEIGHT,
	REGION_LABEL_MAX_LINES,
	REGION_LABEL_MAX_WIDTH,
	type CanvasCluster,
	type CanvasData,
	type CanvasNode,
	type RegionMeta,
	type RendererState,
} from "./types.ts";

function computeRegionBounds(
	clusters: readonly CanvasCluster[],
	nodeById: ReadonlyMap<string, CanvasNode>,
	isVisible: (id: string) => boolean,
): { minX: number; minY: number; maxX: number; maxY: number } | null {
	let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
	for (const c of clusters) {
		for (const id of c.members) {
			if (!isVisible(id)) continue;
			const n = nodeById.get(id);
			if (!n) continue;
			if (n.x < minX) minX = n.x;
			if (n.x > maxX) maxX = n.x;
			if (n.y < minY) minY = n.y;
			if (n.y > maxY) maxY = n.y;
		}
	}
	return minX > maxX ? null : { minX, minY, maxX, maxY };
}

function buildRegionMetaList(
	state: RendererState,
	data: CanvasData,
	isVisible: (id: string) => boolean,
): RegionMeta[] {
	const meta: RegionMeta[] = [];
	for (const cluster of data.clusters) {
		let members = 0, sumX = 0, sumY = 0;
		for (const id of cluster.members) {
			const n = isVisible(id) ? state.nodeById.get(id) : undefined;
			if (!n) continue;
			members++;
			sumX += n.x;
			sumY += n.y;
		}
		if (!members) continue;
		meta.push({ id: cluster.id, label: cluster.label || null, cx: sumX / members, cy: sumY / members, hue: clusterHue(cluster.id), lines: null });
	}
	if (!state.settings) return meta;
	const ctx = state.ctx;
	const prevFont = ctx.font;
	ctx.font = `${LABEL_WEIGHT} ${state.settings.clusterLabelSize}px ${data.fontFamily}`;
	const measure = (s: string) => ctx.measureText(s).width;
	for (const rm of meta) {
		rm.lines = rm.label ? wrapRegionLabel(rm.label, REGION_LABEL_MAX_WIDTH, REGION_LABEL_MAX_LINES, measure) : null;
	}
	ctx.font = prevFont;
	return meta;
}

function paintClusterSkeleton(
	rctx: CanvasRenderingContext2D,
	data: CanvasData,
	nodeById: ReadonlyMap<string, CanvasNode>,
	clusterOf: ReadonlyMap<string, number>,
	isVisible: (id: string) => boolean,
	geom: { minX: number; minY: number; cell: number; dilationW: number },
): void {
	data.clusters.forEach((cluster, ci) => {
		const hue = clusterHue(cluster.id);
		const color = `hsla(${hue}, 65%, ${data.colors.clusterLightness.ring}%, 1)`;
		rctx.strokeStyle = color;
		rctx.beginPath();
		const touched = new Set<string>();
		for (const e of data.edges) {
			if (clusterOf.get(e.from) !== ci || clusterOf.get(e.to) !== ci) continue;
			if (!isVisible(e.from) || !isVisible(e.to)) continue;
			const a = nodeById.get(e.from);
			const b = nodeById.get(e.to);
			if (!a || !b) continue;
			rctx.moveTo((a.x - geom.minX) / geom.cell, (a.y - geom.minY) / geom.cell);
			rctx.lineTo((b.x - geom.minX) / geom.cell, (b.y - geom.minY) / geom.cell);
			touched.add(e.from);
			touched.add(e.to);
		}
		rctx.stroke();
		rctx.fillStyle = color;
		const discR = geom.dilationW / geom.cell;
		for (const id of cluster.members) {
			if (touched.has(id) || !isVisible(id)) continue;
			const n = nodeById.get(id);
			if (!n) continue;
			rctx.beginPath();
			rctx.arc((n.x - geom.minX) / geom.cell, (n.y - geom.minY) / geom.cell, discR, 0, Math.PI * 2);
			rctx.fill();
		}
	});
}

function blurAndScaleRegionImage(
	rctx: CanvasRenderingContext2D,
	bw: number,
	bh: number,
	blurPx: number,
	edgeAlpha: number,
): void {
	const img = rctx.getImageData(0, 0, bw, bh);
	const n = bw * bh * 4;
	const a = new Float32Array(n);
	for (let i = 0; i < n; i += 4) {
		const alpha = img.data[i + 3]! / 255;
		a[i] = img.data[i]! * alpha;
		a[i + 1] = img.data[i + 1]! * alpha;
		a[i + 2] = img.data[i + 2]! * alpha;
		a[i + 3] = img.data[i + 3]!;
	}
	const b = new Float32Array(n);
	const tmp = new Float32Array(n);
	boxBlurRound(a, tmp, b, bw, bh, blurPx);
	boxBlurRound(b, tmp, a, bw, bh, blurPx);
	boxBlurRound(a, tmp, b, bw, bh, blurPx);
	for (let i = 0; i < n; i += 4) {
		const alpha = b[i + 3]!;
		if (alpha <= 0) {
			img.data.fill(0, i, i + 4);
		} else {
			img.data[i] = Math.round((b[i]! / alpha) * 255);
			img.data[i + 1] = Math.round((b[i + 1]! / alpha) * 255);
			img.data[i + 2] = Math.round((b[i + 2]! / alpha) * 255);
			img.data[i + 3] = Math.round(alpha * edgeAlpha);
		}
	}
	rctx.putImageData(img, 0, 0);
}

/** Rasterize cluster regions into the low-res world-space bitmap. */
export function buildRendererRegions(state: RendererState): void {
	const data = state.data;
	const isVisible = (id: string): boolean => !state.visible || state.visible.has(id);
	const bounds = data && data.clusters.length > 0 ? computeRegionBounds(data.clusters, state.nodeById, isVisible) : null;
	if (!data || !bounds) {
		state.regionCanvas = null;
		state.regionRect = null;
		state.regionMeta = [];
		return;
	}
	state.regionMeta = buildRegionMetaList(state, data, isVisible);
	const tuning = state.regionTuning;
	if (!tuning.enabled) {
		state.regionCanvas = null;
		state.regionRect = null;
		return;
	}
	const clusterOf = new Map<string, number>();
	data.clusters.forEach((c, i) => { for (const id of c.members) clusterOf.set(id, i); });
	const padWorld = tuning.dilation + tuning.blur * 2;
	const cell = Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY, padWorld * 2) / tuning.bitmap;
	const minX = bounds.minX - padWorld, minY = bounds.minY - padWorld;
	const spanX = bounds.maxX + padWorld - minX, spanY = bounds.maxY + padWorld - minY;
	const bw = Math.max(1, Math.ceil(spanX / cell)), bh = Math.max(1, Math.ceil(spanY / cell));
	const rc = state.regionCanvas ?? (state.regionCanvas = document.createElement("canvas"));
	if (rc.width !== bw || rc.height !== bh) { rc.width = bw; rc.height = bh; }
	const rctx = rc.getContext("2d", { willReadFrequently: true });
	if (!rctx) return;
	rctx.clearRect(0, 0, bw, bh);
	rctx.lineCap = "round";
	rctx.lineWidth = (tuning.dilation * 2) / cell;
	paintClusterSkeleton(rctx, data, state.nodeById, clusterOf, isVisible, { minX, minY, cell, dilationW: tuning.dilation });
	blurAndScaleRegionImage(rctx, bw, bh, tuning.blur > 0 ? Math.max(1, Math.round(tuning.blur / cell)) : 0, tuning.edgeAlpha);
	state.regionRect = { minX, minY, w: spanX, h: spanY };
}
