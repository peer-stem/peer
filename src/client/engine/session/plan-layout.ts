import { graphlib } from "dagre-d3-es";
import { layout as dagreLayout } from "dagre-d3-es/src/dagre/index.js";
import { edgePathD, HEAD_H, HEAD_W, STROKE_W } from "./plan-edges.ts";

export { edgePathD, HEAD_H, HEAD_W, STROKE_W };

export interface LayoutNode {
	id: string;
	title: string;
}

export interface LabelMeasure {
	lines: (title: string, maxWidth: number) => string[];
	width: (line: string) => number;
	fontSize: number;
}

export const PAD_X = 16;
const PAD_Y = 9;
export const NODE_W_MIN = 96;
const LINE_HEIGHT = 13 / 11;
export const MAX_LINE_EM = 12.75;
export const GAP_X = 24;
export const GAP_Y = 48;

const NARROW_CHARS = new Set(" ijltfr.,:;'!|()[]-\\");
const WIDE_CHARS = new Set("mwMW@");
const CAP_DIGIT = /[A-Z0-9]/;

function chartWidth(text: string): number {
	let w = 0;
	for (const ch of text) {
		if (NARROW_CHARS.has(ch)) w += 3.1;
		else if (WIDE_CHARS.has(ch)) w += 9.2;
		else if (CAP_DIGIT.test(ch)) w += 6.0;
		else w += 5.4;
	}
	return w;
}

export const chartMeasure: LabelMeasure = {
	fontSize: 11,
	width: chartWidth,
	lines(title, maxWidth) {
		const lines: string[] = [];
		for (const word of title.trim().split(/\s+/)) {
			const last = lines[lines.length - 1];
			if (last !== undefined && chartWidth(`${last} ${word}`) <= maxWidth) lines[lines.length - 1] = `${last} ${word}`;
			else lines.push(word);
		}
		return lines;
	},
};

export function topoFor(nodes: readonly LayoutNode[], edges: ReadonlyArray<{ from: string; to: string }>) {
	const index = new Map(nodes.map((n, i) => [n.id, i] as const));
	const indegree = new Map<string, number>(nodes.map((n) => [n.id, 0] as const));
	const dependents = new Map<string, string[]>();
	for (const e of edges) {
		if (!index.has(e.from) || !index.has(e.to)) continue;
		indegree.set(e.to, (indegree.get(e.to) ?? 0) + 1);
		const list = dependents.get(e.from);
		if (list) list.push(e.to);
		else dependents.set(e.from, [e.to]);
	}
	const ready = nodes.filter((n) => (indegree.get(n.id) ?? 0) === 0).map((n) => n.id);
	const order: LayoutNode[] = [];
	const depth = new Map<string, number>();
	const byId = new Map(nodes.map((n) => [n.id, n] as const));
	while (ready.length > 0) {
		ready.sort((a, b) => (index.get(a) ?? 0) - (index.get(b) ?? 0));
		const id = ready.shift()!;
		const node = byId.get(id);
		if (node) order.push(node);
		const d = depth.get(id) ?? 0;
		depth.set(id, d);
		for (const t of dependents.get(id) ?? []) {
			if ((depth.get(t) ?? -1) < d + 1) depth.set(t, d + 1);
			const left = (indegree.get(t) ?? 0) - 1;
			indegree.set(t, left);
			if (left === 0) ready.push(t);
		}
	}
	for (const n of nodes) {
		if (!depth.has(n.id)) {
			order.push(n);
			depth.set(n.id, 0);
		}
	}
	return { order, depth };
}

function buildDagreGraph(
	nodes: readonly LayoutNode[],
	edges: ReadonlyArray<{ from: string; to: string }>,
	measure: LabelMeasure,
	lineH: number,
) {
	const nodeH = new Map<string, number>();
	const nodeW = new Map<string, number>();
	const lines = new Map<string, string[]>();
	const ids = new Set(nodes.map((n) => n.id));
	const routed: Array<{ from: string; to: string }> = [];
	const g = new graphlib.Graph({ compound: false, multigraph: true });
	g.setGraph({ rankdir: "TB", nodesep: GAP_X, ranksep: GAP_Y, marginx: 0, marginy: 0 });
	const minH = 2 * lineH + 2 * PAD_Y;
	for (const n of nodes) {
		const wrapped = measure.lines(n.title, MAX_LINE_EM * measure.fontSize);
		const widest = Math.max(1, ...wrapped.map(measure.width));
		const w = Math.max(NODE_W_MIN, Math.ceil(widest) + 2 * PAD_X);
		const h = Math.max(minH, wrapped.length * lineH + 2 * PAD_Y);
		lines.set(n.id, wrapped);
		nodeW.set(n.id, w);
		nodeH.set(n.id, h);
		g.setNode(n.id, { width: w, height: h });
	}
	for (const e of edges) {
		if (ids.has(e.from) && ids.has(e.to)) {
			g.setEdge(e.from, e.to, { label: "", width: 0, height: 0 });
			routed.push(e);
		}
	}
	dagreLayout(g, undefined);
	return { g, nodeH, nodeW, lines, routed };
}

function computePlanInkBounds(
	nodes: readonly LayoutNode[],
	routed: ReadonlyArray<{ from: string; to: string }>,
	geom: {
		x: Map<string, number>;
		y: Map<string, number>;
		nodeW: Map<string, number>;
		nodeH: Map<string, number>;
		edgePts: Map<string, Array<{ x: number; y: number }>>;
	},
) {
	let inkMinX = Infinity, inkMinY = Infinity, inkMaxX = -Infinity, inkMaxY = -Infinity;
	const stretch = (px: number, py: number) => {
		if (px < inkMinX) inkMinX = px;
		if (py < inkMinY) inkMinY = py;
		if (px > inkMaxX) inkMaxX = px;
		if (py > inkMaxY) inkMaxY = py;
	};
	for (const n of nodes) {
		const nx = geom.x.get(n.id);
		const ny = geom.y.get(n.id);
		if (nx === undefined || ny === undefined) continue;
		stretch(nx, ny);
		stretch(nx + geom.nodeW.get(n.id)!, ny + geom.nodeH.get(n.id)!);
	}
	for (const e of routed) {
		const pts = geom.edgePts.get(`${e.from}->${e.to}`);
		const tx = geom.x.get(e.to);
		const ty = geom.y.get(e.to);
		if (!pts) continue;
		const target = tx !== undefined && ty !== undefined
			? { x: tx, y: ty, w: geom.nodeW.get(e.to)!, h: geom.nodeH.get(e.to)! }
			: undefined;
		const nums = edgePathD(pts, target).match(/-?\d+(?:\.\d+)?/g);
		if (!nums) continue;
		for (let i = 0; i + 1 < nums.length; i += 2) {
			stretch(parseFloat(nums[i]!), parseFloat(nums[i + 1]!));
		}
	}
	return { inkMinX, inkMinY, inkMaxX, inkMaxY };
}

export type PlanLayout = ReturnType<typeof blockLayout>;

export function blockLayout(
	nodes: readonly LayoutNode[],
	edges: ReadonlyArray<{ from: string; to: string }>,
	measure: LabelMeasure,
) {
	const x = new Map<string, number>();
	const y = new Map<string, number>();
	const lineH = measure.fontSize * LINE_HEIGHT;
	const edgePts = new Map<string, Array<{ x: number; y: number }>>();
	if (nodes.length === 0) {
		return {
			x, y, nodeH: new Map<string, number>(), nodeW: new Map<string, number>(),
			lines: new Map<string, string[]>(), lineH, fontSize: measure.fontSize,
			edgePts, originX: 0, originY: 0, width: 0, height: 0,
		};
	}
	const { g, nodeH, nodeW, lines, routed } = buildDagreGraph(nodes, edges, measure, lineH);
	for (const n of nodes) {
		const pos = g.node(n.id);
		if (pos) {
			x.set(n.id, pos.x - nodeW.get(n.id)! / 2);
			y.set(n.id, pos.y - nodeH.get(n.id)! / 2);
		}
	}
	for (const e of routed) {
		const pts: Array<{ x: number; y: number }> | undefined = g.edge(e.from, e.to)?.points;
		if (pts) edgePts.set(`${e.from}->${e.to}`, pts.map((pt) => ({ x: pt.x, y: pt.y })));
	}
	const { inkMinX, inkMinY, inkMaxX, inkMaxY } = computePlanInkBounds(nodes, routed, { x, y, nodeW, nodeH, edgePts });
	const originX = Math.min(0, inkMinX === Infinity ? 0 : inkMinX);
	const originY = Math.min(0, inkMinY === Infinity ? 0 : inkMinY);
	return {
		x, y, nodeH, nodeW, lines, lineH, fontSize: measure.fontSize, edgePts, originX, originY,
		width: Math.max((g.graph().width ?? 0) - originX, inkMaxX === -Infinity ? 0 : inkMaxX - originX, 1),
		height: Math.max((g.graph().height ?? 0) - originY, inkMaxY === -Infinity ? 0 : inkMaxY - originY, 1),
	};
}
