/**
 * Pure projection from `GraphSnapshot` (+ optional client position overrides)
 * into `CanvasData` for `GraphCanvasRenderer.setData`, plus render-settings ladders.
 */

import type { GraphNode, GraphSnapshot } from "../../../core/contracts/graph.ts";
import { incrementalLayout } from "../../../core/layout.ts";
import type {
	CanvasCluster,
	CanvasColors,
	CanvasData,
	CanvasEdge,
	CanvasNode,
} from "./types.ts";

export {
	ARROW_LENGTH_LADDER,
	CHARGE_RANGE,
	CLUSTER_LABEL_SIZE_LADDER,
	CLUSTER_PULL_RANGE,
	DEFAULT_PHYSICS_TUNING,
	DEFAULT_REGION_TUNING,
	DEFAULT_RENDER_SETTINGS,
	DEPTH_BASE_RADIUS_RANGE,
	DEPTH_SPACING_RANGE,
	DEPTH_STRENGTH_RANGE,
	EDGE_WIDTH_LADDER,
	GRAVITY_RANGE,
	LABEL_SIZE_LADDER,
	LABEL_ZOOM_LADDER,
	LINK_DISTANCE_RANGE,
	LINK_STRENGTH_RANGE,
	NODE_SIZE_LADDER,
	REGION_BITMAP_OPTIONS,
	REGION_BLUR_LADDER,
	REGION_DILATION_LADDER,
	REGION_EDGE_ALPHA_LADDER,
	VELOCITY_DECAY_RANGE,
	fromLadderPosition,
	fromOffSliderPosition,
	fromSliderPosition,
	labelZoomDisplay,
	ladderIndex,
	sanitizePhysicsTuning,
	sanitizeRegionTuning,
	sanitizeRenderSettings,
	snapToLadder,
	toLadderPosition,
	toOffSliderPosition,
	toSliderPosition,
	type PhysicsTuning,
	type RegionTuning,
} from "../../../core/render-settings.ts";

type ImpLinkEntry = { id: string; premises: string[]; conclusion: string };
type XY = { x: number; y: number };

export function isNodeVisible(node: Pick<GraphNode, "name" | "statement">, query: string): boolean {
	const q = query.trim().toLowerCase();
	if (!q) return true;
	return node.name.toLowerCase().includes(q) || node.statement.toLowerCase().includes(q);
}

function hashNodeAngle(id: string, index: number): number {
	let h = 0x811c9dc5;
	for (let c = 0; c < id.length; c++) {
		h ^= id.charCodeAt(c);
		h = (h * 0x01000193) >>> 0;
	}
	return ((h / 0xffffffff) * 2 * Math.PI + index * 2.39996323) % (2 * Math.PI);
}

function seedMissingPositions(nodes: readonly { id: string }[], positions: Map<string, XY>): Map<string, XY> {
	if (positions.size === 0 || nodes.every((n) => positions.has(n.id))) return positions;
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	for (const p of positions.values()) {
		if (p.x < minX) minX = p.x;
		if (p.y < minY) minY = p.y;
		if (p.x > maxX) maxX = p.x;
		if (p.y > maxY) maxY = p.y;
	}
	const cx = (minX + maxX) / 2;
	const cy = (minY + maxY) / 2;
	const radius = Math.max(maxX - minX, maxY - minY, 40) * 0.7 + 20;
	const missing = nodes.filter((n) => !positions.has(n.id));
	for (let i = 0; i < missing.length; i++) {
		const node = missing[i];
		if (!node) continue;
		const angle = hashNodeAngle(node.id, i);
		positions.set(node.id, { x: cx + Math.cos(angle) * radius, y: cy + Math.sin(angle) * radius });
	}
	return positions;
}

function resolveImpLinks(snapshot: GraphSnapshot): ImpLinkEntry[] {
	if (Array.isArray(snapshot.impLinks) && snapshot.impLinks.length > 0) {
		return snapshot.impLinks.map((l) => ({
			id: l.id,
			premises: [...l.premises],
			conclusion: l.conclusion,
		}));
	}
	const chains = Array.isArray(snapshot.chains) ? snapshot.chains : [];
	return chains
		.filter((c) => Array.isArray(c.premises) && c.premises.length > 1)
		.map((c) => ({ id: c.id, premises: [...c.premises], conclusion: c.conclusion }));
}

function resolveAllNodes(
	snapshot: GraphSnapshot,
	impLinks: readonly ImpLinkEntry[],
): Array<{ id: string; name: string }> {
	const base = (snapshot.nodes ?? []).map((n) => ({ id: n.id, name: n.name }));
	const seen = new Set(base.map((n) => n.id));
	for (const link of impLinks) {
		if (seen.has(link.id)) continue;
		seen.add(link.id);
		base.push({ id: link.id, name: "⟹" });
	}
	return base;
}

function collectKnownPositions(
	nodes: readonly { id: string }[],
	ledger: Readonly<Record<string, XY>> | undefined,
	saved: Readonly<Record<string, XY>> | undefined,
): Map<string, XY> {
	const out = new Map<string, XY>();
	for (const node of nodes) {
		const candidate = saved?.[node.id] ?? ledger?.[node.id];
		if (!candidate) continue;
		if (Number.isFinite(candidate.x) && Number.isFinite(candidate.y)) {
			out.set(node.id, { x: candidate.x, y: candidate.y });
		}
	}
	return out;
}

export function deriveCanvasData(
	snapshot: GraphSnapshot,
	colors: CanvasColors,
	fontFamily: string,
	savedPositions?: Readonly<Record<string, { x: number; y: number }>>,
): CanvasData {
	const impLinks = resolveImpLinks(snapshot);
	const rawNodes = resolveAllNodes(snapshot, impLinks);
	if (rawNodes.length === 0) {
		return { nodes: [], edges: [], logicalEdges: [], impLinks: [], clusters: [], colors, fontFamily };
	}
	const edges: CanvasEdge[] = (snapshot.edges ?? []).map((e) => ({ from: e.from, to: e.to }));
	const rawLogical = snapshot.logicalEdges ?? snapshot.edges ?? [];
	const logicalEdges: CanvasEdge[] = rawLogical.map((e) => ({ from: e.from, to: e.to }));
	const clusters: CanvasCluster[] = (snapshot.clusters ?? []).map((c) => ({
		id: c.id,
		label: c.label,
		members: [...c.members],
	}));
	const known = collectKnownPositions(rawNodes, snapshot.positions, savedPositions);
	const positions =
		known.size > 0
			? seedMissingPositions(rawNodes, known)
			: incrementalLayout(rawNodes, edges, new Map(), { logicalEdges, impLinks, clusters });
	const nodes: CanvasNode[] = rawNodes.map((n) => ({
		id: n.id,
		x: positions.get(n.id)?.x ?? 0,
		y: positions.get(n.id)?.y ?? 0,
		label: n.name,
	}));
	return { nodes, edges, logicalEdges, impLinks, clusters, colors, fontFamily };
}
