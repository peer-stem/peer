import { select } from "d3-selection";
import { zoomIdentity } from "d3-zoom";
import {
	createGraphSimulation,
	type LayoutNode as SimLayoutNode,
	type Position,
} from "../../../core/index.ts";
import type { Pt } from "./cluster-geometry.ts";
import { drawRendererFrame } from "./geometry.ts";
import { pickNearest } from "./math.ts";
import {
	CLICK_SLOP,
	COMMIT_DEBOUNCE_MS,
	DRAG_ALPHA_TARGET,
	HOVER_FADE_MS,
	isImpNodeId,
	LIVE_ALPHA_DECAY,
	PICKING_PAD,
	SIM_SETTLE_ALPHA,
	ZOOM_EASE_MS,
	type CanvasNode,
	type RendererState,
} from "./types.ts";

export function eventPos(canvas: HTMLCanvasElement, e: { clientX: number; clientY: number }): Pt {
	const rect = canvas.getBoundingClientRect();
	return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

export function pickNodeAt(state: RendererState, px: number, py: number): CanvasNode | null {
	if (!state.data || !state.settings) return null;
	const { x: tx, y: ty, k } = state.transform;
	const maxDist = state.settings.nodeSize * k + PICKING_PAD;
	const projected: { id: string; x: number; y: number }[] = [];
	for (const n of state.data.nodes) {
		if (state.visible && !state.visible.has(n.id)) continue;
		if (isImpNodeId(n.id)) continue;
		projected.push({ id: n.id, x: n.x * k + tx, y: n.y * k + ty });
	}
	const hit = pickNearest(projected, px, py, maxDist);
	return hit ? (state.nodeById.get(hit.id) ?? null) : null;
}

export function setRendererHover(state: RendererState, nodeId: string | null): void {
	if (nodeId === state.hoverId && state.hoverTarget === (nodeId ? 1 : 0)) return;
	state.hoverId = nodeId;
	if (nodeId) state.hoverNode = state.nodeById.get(nodeId) ?? null;
	state.hoverFrom = state.hoverFade;
	state.hoverTarget = nodeId ? 1 : 0;
	state.hoverStart = performance.now();
	state.animating = true;
	state.markDirty();
}

export function buildRendererSim(state: RendererState): void {
	const data = state.data;
	if (!data || data.nodes.length === 0) {
		state.sim = null;
		state.simById = new Map();
		return;
	}
	const t = state.physicsTuning;
	state.sim = createGraphSimulation(data.nodes, data.edges, {
		logicalEdges: data.logicalEdges,
		impLinks: data.impLinks,
		gravity: { x: state.simCenter.x, y: state.simCenter.y, strength: t.gravity },
		alphaDecay: LIVE_ALPHA_DECAY,
		velocityDecay: t.velocityDecay,
		chargeStrength: t.chargeStrength,
		linkStrength: t.linkStrength,
		linkDistance: t.linkDistance,
		clusterPull: data.clusters.length > 0 ? { clusters: data.clusters, strength: t.clusterPull } : undefined,
		depthAnchor: t.depthMode === "off" ? undefined : {
			mode: t.depthMode,
			strength: t.depthStrength,
			spacing: t.depthSpacing,
			baseRadius: t.depthBaseRadius,
			center: state.simCenter,
		},
	});
	state.simById = new Map(data.nodes.map((n) => [n.id, n as SimLayoutNode]));
	state.sim.alpha(SIM_SETTLE_ALPHA);
}

function schedulePositionCommit(state: RendererState): void {
	if (state.commitTimer) clearTimeout(state.commitTimer);
	state.commitTimer = setTimeout(() => {
		state.commitTimer = null;
		if (!state.data || !state.simMoved) return;
		state.simMoved = false;
		const positions: Record<string, Position> = {};
		for (const n of state.data.nodes) positions[n.id] = { x: n.x, y: n.y };
		state.callbacks.onCommit(positions);
	}, COMMIT_DEBOUNCE_MS);
}

function advanceSim(state: RendererState): boolean {
	if (!state.sim || !state.simActive) return false;
	state.sim.tick();
	for (const n of state.sim.nodes()) {
		if (n.vx || n.vy) {
			state.simMoved = true;
			break;
		}
	}
	state.geoVersion++;
	if (!state.dragId && state.sim.alpha() < SIM_SETTLE_ALPHA) {
		state.simActive = false;
		schedulePositionCommit(state);
		return false;
	}
	return true;
}

function advanceHover(state: RendererState): boolean {
	if (state.hoverFade === state.hoverTarget) return false;
	const t = Math.min((performance.now() - state.hoverStart) / HOVER_FADE_MS, 1);
	state.hoverFade = state.hoverFrom + (state.hoverTarget - state.hoverFrom) * t;
	if (state.hoverTarget === 0 && state.hoverFade === 0) state.hoverNode = null;
	return t < 1;
}

function advanceZoom(state: RendererState, dt: number): boolean {
	const target = state.zoomTarget;
	if (!target) return false;
	const t = state.transform;
	const blend = 1 - Math.exp(-dt / ZOOM_EASE_MS);
	let k = t.k + (target.k - t.k) * blend;
	let done = false;
	if (Math.abs(target.k - k) / target.k < 0.002) {
		k = target.k;
		done = true;
	}
	const scale = k / t.k;
	const x = target.x - (target.x - t.x) * scale;
	const y = target.y - (target.y - t.y) * scale;
	if (done) state.zoomTarget = null;
	select(state.canvas).call(state.zoomBehavior.transform, zoomIdentity.translate(x, y).scale(k));
	return !done;
}

export function runRendererTick(state: RendererState): void {
	state.inTick = true;
	try {
		const now = performance.now();
		const dt = Math.min(Math.max(now - state.lastTickAt, 8), 100);
		state.lastTickAt = now;
		const hoverAnim = advanceHover(state);
		const zoomAnim = advanceZoom(state, dt);
		const simAnim = advanceSim(state);
		drawRendererFrame(state);
		state.animating = hoverAnim || zoomAnim || simAnim;
	} finally {
		state.inTick = false;
	}
	if (state.animating) {
		state.frameId = requestAnimationFrame(() => {
			state.frameId = null;
			runRendererTick(state);
		});
	}
}

export function handleCanvasWheel(state: RendererState, e: WheelEvent): void {
	e.preventDefault();
	const delta = -e.deltaY * (e.deltaMode === 1 ? 0.05 : e.deltaMode ? 1 : 0.002);
	const { x, y } = eventPos(state.canvas, e);
	const current = state.zoomTarget?.k ?? state.transform.k;
	const k = Math.min(Math.max(current * Math.exp(delta), 0.02), 40);
	state.zoomTarget = { k, x, y };
	state.lastTickAt = performance.now();
	state.markDirty();
}

export function handlePointerMove(state: RendererState, e: PointerEvent): void {
	const pos = eventPos(state.canvas, e);
	if (state.dragId) {
		const n = state.simById.get(state.dragId);
		if (!n) return;
		const moved = state.dragOrigin !== null && Math.hypot(pos.x - state.dragOrigin.x, pos.y - state.dragOrigin.y) > CLICK_SLOP;
		if (moved) {
			if (state.commitTimer) { clearTimeout(state.commitTimer); state.commitTimer = null; }
			state.sim?.alphaTarget(DRAG_ALPHA_TARGET);
			state.simActive = true;
			state.markDirty();
		}
		n.fx = (pos.x - state.transform.x) / state.transform.k;
		n.fy = (pos.y - state.transform.y) / state.transform.k;
		return;
	}
	const node = pickNodeAt(state, pos.x, pos.y);
	if ((node?.id ?? null) !== state.hoverId) setRendererHover(state, node?.id ?? null);
	state.canvas.style.cursor = node ? "pointer" : "";
}

export function handlePointerDown(state: RendererState, e: PointerEvent): void {
	if (e.button !== 0) return;
	const pos = eventPos(state.canvas, e);
	const node = pickNodeAt(state, pos.x, pos.y);
	if (node && state.sim) {
		e.preventDefault();
		try { state.canvas.setPointerCapture(e.pointerId); } catch { /* best-effort */ }
		state.dragId = node.id;
		state.dragOrigin = pos;
		const n = state.simById.get(node.id);
		if (n) {
			n.fx = n.x;
			n.fy = n.y;
		}
		state.canvas.style.cursor = "grabbing";
		state.markDirty();
		return;
	}
	state.downPos = pos;
	state.zoomTarget = null;
}

export function handlePointerUp(state: RendererState, e: PointerEvent): void {
	if (e.button !== 0) return;
	if (state.dragId) {
		const id = state.dragId;
		state.dragId = null;
		state.dragOrigin = null;
		try { state.canvas.releasePointerCapture(e.pointerId); } catch { /* already released */ }
		state.canvas.style.cursor = "";
		const n = state.simById.get(id);
		if (n) {
			n.fx = null;
			n.fy = null;
		}
		if (state.simActive) {
			state.sim?.alphaTarget(0);
			state.markDirty();
		} else {
			state.callbacks.onSelect(id, eventPos(state.canvas, e));
		}
		return;
	}
	if (!state.downPos) return;
	const pos = eventPos(state.canvas, e);
	const moved = Math.hypot(pos.x - state.downPos.x, pos.y - state.downPos.y);
	state.downPos = null;
	if (moved > CLICK_SLOP) return;
	const node = pickNodeAt(state, pos.x, pos.y);
	if (node) state.callbacks.onSelect(node.id, pos);
	else state.callbacks.onStageClick();
}

export function handleContextMenu(state: RendererState, e: MouseEvent): void {
	e.preventDefault();
	const pos = eventPos(state.canvas, e);
	state.callbacks.onContext(pickNodeAt(state, pos.x, pos.y)?.id ?? null, pos);
}

export function handlePointerLeave(state: RendererState): void {
	if (state.dragId) return;
	state.downPos = null;
	setRendererHover(state, null);
}
