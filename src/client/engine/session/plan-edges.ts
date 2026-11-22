import { curveBasis, line } from "d3-shape";

export const STROKE_W = 1;
export const HEAD_H = 16 * (STROKE_W / 1.5);
const HEAD_SCALE = HEAD_H / 104;
export const HEAD_W = 50.2 * HEAD_SCALE;
const HEAD_TIP_OVERHANG = (50.2 - 27.2) * HEAD_SCALE;
const DOCK_GAP = 4 * (STROKE_W / 1.5);
const STRAIGHT_RUN = 12;
const ENTRY_ANGLE_LIMIT = (40 * Math.PI) / 180;

const edgeLine = line<{ x: number; y: number }>()
	.x((p) => p.x)
	.y((p) => p.y)
	.curve(curveBasis);

function faceNormal(
	border: { x: number; y: number },
	box: { x: number; y: number; w: number; h: number },
): { x: number; y: number } {
	const d = {
		top: border.y - box.y,
		bottom: box.y + box.h - border.y,
		left: border.x - box.x,
		right: box.x + box.w - border.x,
	};
	const face = (Object.keys(d) as Array<keyof typeof d>).reduce((a, b) => (d[a] <= d[b] ? a : b));
	switch (face) {
		case "top": return { x: 0, y: -1 };
		case "bottom": return { x: 0, y: 1 };
		case "left": return { x: -1, y: 0 };
		default: return { x: 1, y: 0 };
	}
}

function resolveTargetApproach(
	last: { x: number; y: number },
	ux: number,
	uy: number,
	target?: { x: number; y: number; w: number; h: number },
): { tipx: number; tipy: number; ux: number; uy: number } {
	if (!target) {
		return { tipx: last.x - ux * DOCK_GAP, tipy: last.y - uy * DOCK_GAP, ux, uy };
	}
	const n = faceNormal(last, target);
	const tipx = last.x + n.x * DOCK_GAP;
	const tipy = last.y + n.y * DOCK_GAP;
	const v = { x: -ux, y: -uy };
	const vn = v.x * n.x + v.y * n.y;
	if (vn < Math.cos(ENTRY_ANGLE_LIMIT)) {
		const t = { x: v.x - vn * n.x, y: v.y - vn * n.y };
		const tl = Math.hypot(t.x, t.y);
		const that = tl > 0 ? { x: t.x / tl, y: t.y / tl } : { x: -n.y, y: n.x };
		const c = Math.cos(ENTRY_ANGLE_LIMIT);
		const s = Math.sin(ENTRY_ANGLE_LIMIT);
		return { tipx, tipy, ux: -(c * n.x + s * that.x), uy: -(c * n.y + s * that.y) };
	}
	return { tipx, tipy, ux, uy };
}

export function edgePathD(
	points: Array<{ x: number; y: number }>,
	target?: { x: number; y: number; w: number; h: number },
): string {
	const pts = points.map((p) => ({ ...p }));
	if (pts.length >= 2) {
		const last = pts[pts.length - 1]!;
		const prev = pts[pts.length - 2]!;
		const dx = last.x - prev.x;
		const dy = last.y - prev.y;
		const len = Math.hypot(dx, dy) || 1;
		const resolved = resolveTargetApproach(last, dx / len, dy / len, target);
		const M = {
			x: resolved.tipx - resolved.ux * HEAD_TIP_OVERHANG,
			y: resolved.tipy - resolved.uy * HEAD_TIP_OVERHANG,
		};
		const Q = {
			x: M.x - resolved.ux * STRAIGHT_RUN,
			y: M.y - resolved.uy * STRAIGHT_RUN,
		};
		pts.splice(pts.length - 1, 1, Q, M);
	}
	return edgeLine(pts) ?? "";
}
