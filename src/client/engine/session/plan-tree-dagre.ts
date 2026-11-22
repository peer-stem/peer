/**
 * Deterministic DOM-free `PlanTree` DAG layout (`dagre-d3-es`) plus model/thinking
 * display helpers for browser views (`peer-engine`).
 */

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { graphlib } from "dagre-d3-es";
import { layout as dagreLayout } from "dagre-d3-es/src/dagre/index.js";
import {
	derivedNodeStatus,
	type DerivedPlanStatuses,
	type PlanEdge,
	type PlanNode,
	type PlanTree,
} from "../../../core/contracts/plan.ts";
import { FIT_PAD, FIT_ZOOM_MAX, ZOOM_MAX, type Viewport } from "../dom/pan-zoom.ts";
import { THINKING_LABEL, defaultOrderLevel } from "./thinking-default.ts";
import { prettyModel } from "./usage-format.ts";

export interface PlanLayoutNode {
	id: string;
	label: string;
	status: string;
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface PlanLayoutEdge {
	from: string;
	to: string;
	points: Array<{ x: number; y: number }>;
}

export interface PlanLayoutResult {
	width: number;
	height: number;
	nodes: PlanLayoutNode[];
	edges: PlanLayoutEdge[];
}

export interface FitPlanBoxResult extends Viewport {
	k: number;
}

type BoxLike = { width?: number; height?: number; w?: number; h?: number };

const PAD_X = 16;
const NODE_W_MIN = 96;
const NODE_H = 44;
const LINE_H = 13;
const GAP_X = 24;
const GAP_Y = 48;
const LAYOUT_PAD = 8;

const NARROW_CHARS = new Set(" ijltfr.,:;'!|()[]-\\");
const WIDE_CHARS = new Set("mwMW@");
const CAP_DIGIT = /[A-Z0-9]/;

export function estimateLineWidth(line: string): number {
	let w = 0;
	for (const ch of line) {
		if (NARROW_CHARS.has(ch)) w += 3.1;
		else if (WIDE_CHARS.has(ch)) w += 9.2;
		else if (CAP_DIGIT.test(ch)) w += 6.0;
		else w += 5.4;
	}
	return w;
}

export function wrapPlanTitle(title: string, maxChars = 28): string[] {
	const words = title.trim().split(/\s+/).filter(Boolean);
	if (words.length === 0) return [""];
	const atoms: string[] = [];
	for (const word of words) {
		for (let i = 0; i < word.length; i += maxChars) atoms.push(word.slice(i, i + maxChars));
	}
	const lines: string[] = [];
	for (const atom of atoms) {
		const last = lines[lines.length - 1];
		if (last !== undefined && last.length + 1 + atom.length <= maxChars) {
			lines[lines.length - 1] = `${last} ${atom}`;
		} else {
			lines.push(atom);
		}
	}
	return lines;
}

function measurePlanNode(title: string): { width: number; height: number } {
	const lines = wrapPlanTitle(title);
	const widest = Math.max(1, ...lines.map(estimateLineWidth));
	const width = Math.max(NODE_W_MIN, Math.ceil(widest) + 2 * PAD_X);
	const height = NODE_H + Math.max(0, lines.length - 2) * LINE_H;
	return { width, height };
}

function resolveStatus(node: PlanNode, statuses?: DerivedPlanStatuses | null): string {
	if (statuses) return derivedNodeStatus(statuses, node.id);
	const inline = (node as { status?: unknown }).status;
	return typeof inline === "string" && inline.length > 0 ? inline : "upcoming";
}

function shiftLayoutOrigin(
	nodes: PlanLayoutNode[],
	edges: PlanLayoutEdge[],
	graphWidth: number,
	graphHeight: number,
): PlanLayoutResult {
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	for (const n of nodes) {
		minX = Math.min(minX, n.x);
		minY = Math.min(minY, n.y);
		maxX = Math.max(maxX, n.x + n.width);
		maxY = Math.max(maxY, n.y + n.height);
	}
	for (const e of edges) {
		for (const pt of e.points) {
			minX = Math.min(minX, pt.x);
			minY = Math.min(minY, pt.y);
			maxX = Math.max(maxX, pt.x);
			maxY = Math.max(maxY, pt.y);
		}
	}
	const ox = (minX < 0 ? -minX : 0) + LAYOUT_PAD;
	const oy = (minY < 0 ? -minY : 0) + LAYOUT_PAD;
	const shiftedNodes = nodes.map((n) => ({ ...n, x: n.x + ox, y: n.y + oy }));
	const shiftedEdges = edges.map((e) => ({
		from: e.from,
		to: e.to,
		points: e.points.map((pt) => ({ x: pt.x + ox, y: pt.y + oy })),
	}));
	const rawMaxX = maxX === -Infinity ? 0 : maxX + ox;
	const rawMaxY = maxY === -Infinity ? 0 : maxY + oy;
	return {
		width: Math.max(graphWidth + ox, rawMaxX) + LAYOUT_PAD,
		height: Math.max(graphHeight + oy, rawMaxY) + LAYOUT_PAD,
		nodes: shiftedNodes,
		edges: shiftedEdges,
	};
}

export function layoutPlanTree(
	tree: PlanTree | null | undefined,
	statuses?: DerivedPlanStatuses | null,
): PlanLayoutResult {
	if (!tree || !Array.isArray(tree.nodes) || tree.nodes.length === 0) {
		return { width: 0, height: 0, nodes: [], edges: [] };
	}
	const g = new graphlib.Graph({ compound: false, multigraph: true });
	g.setGraph({ rankdir: "TB", nodesep: GAP_X, ranksep: GAP_Y, marginx: 0, marginy: 0 });
	const sizes = new Map<string, { width: number; height: number }>();
	for (const node of tree.nodes) {
		const size = measurePlanNode(node.title ?? node.id);
		sizes.set(node.id, size);
		g.setNode(node.id, { width: size.width, height: size.height });
	}
	const routed: PlanEdge[] = [];
	for (const edge of tree.edges ?? []) {
		if (!sizes.has(edge.from) || !sizes.has(edge.to)) continue;
		g.setEdge(edge.from, edge.to, { label: "", width: 0, height: 0 });
		routed.push({ from: edge.from, to: edge.to });
	}
	dagreLayout(g, undefined);
	const nodes: PlanLayoutNode[] = tree.nodes.map((node) => {
		const size = sizes.get(node.id) ?? { width: NODE_W_MIN, height: NODE_H };
		const pos = g.node(node.id);
		return {
			id: node.id,
			label: node.title ?? node.id,
			status: resolveStatus(node, statuses),
			x: (pos?.x ?? size.width / 2) - size.width / 2,
			y: (pos?.y ?? size.height / 2) - size.height / 2,
			width: size.width,
			height: size.height,
		};
	});
	const edges: PlanLayoutEdge[] = routed.map((edge) => {
		const pts: Array<{ x: number; y: number }> = g.edge(edge.from, edge.to)?.points ?? [];
		return {
			from: edge.from,
			to: edge.to,
			points: pts.map((pt: { x: number; y: number }) => ({ x: pt.x, y: pt.y })),
		};
	});
	return shiftLayoutOrigin(nodes, edges, g.graph().width ?? 0, g.graph().height ?? 0);
}

export function clampZoom(zoom: number, min = 0.02, max = ZOOM_MAX): number {
	if (!Number.isFinite(zoom)) return 1;
	return Math.min(Math.max(zoom, min), max);
}

export function fitPlanBoxTransform(
	content: BoxLike,
	viewport: BoxLike,
	pad = FIT_PAD,
): FitPlanBoxResult {
	const cw = content.width ?? content.w ?? 0;
	const ch = content.height ?? content.h ?? 0;
	const vw = viewport.width ?? viewport.w ?? 0;
	const vh = viewport.height ?? viewport.h ?? 0;
	if (vw <= 0 || vh <= 0 || cw <= 0 || ch <= 0) return { zoom: 1, k: 1, x: 0, y: 0 };
	const raw = Math.min((vw - pad) / cw, (vh - pad) / ch, FIT_ZOOM_MAX);
	const zoom = clampZoom(raw, 0.02, ZOOM_MAX);
	return { zoom, k: zoom, x: (vw - cw * zoom) / 2, y: (vh - ch * zoom) / 2 };
}

export function shortModelName(id: string, qualified = false): string {
	return id ? prettyModel(id, qualified) : "";
}

export function thinkingLevelLabel(level: string | null | undefined): string {
	return level ? (THINKING_LABEL[level] ?? level) : "off";
}

export function defaultThinkingLevel(supported?: readonly string[]): string {
	return defaultOrderLevel((supported ?? []) as readonly ThinkingLevel[]);
}
