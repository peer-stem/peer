import { select } from "d3-selection";
import { zoom, zoomIdentity } from "d3-zoom";
import {
	DEFAULT_PHYSICS_TUNING,
	DEFAULT_REGION_TUNING,
	sanitizePhysicsTuning,
	sanitizeRegionTuning,
	type GraphRenderSettings,
	type PhysicsTuning,
	type RegionTuning,
} from "../../../core/index.ts";
import { drawRendererFrame } from "./geometry.ts";
import { applyClusterLabels, fitTransform } from "./math.ts";
import {
	buildRendererSim,
	handleCanvasWheel,
	handleContextMenu,
	handlePointerDown,
	handlePointerLeave,
	handlePointerMove,
	handlePointerUp,
	runRendererTick,
} from "./sim-events.ts";
import {
	LABEL_WEIGHT,
	REGION_LABEL_MAX_LINES,
	REGION_LABEL_MAX_WIDTH,
	type CanvasData,
	type RendererCallbacks,
	type RendererState,
} from "./types.ts";

function syncCanvasSize(state: RendererState): void {
	const w = state.canvas.clientWidth;
	const h = state.canvas.clientHeight;
	const dpr = window.devicePixelRatio || 1;
	const bw = Math.max(1, Math.round(w * dpr));
	const bh = Math.max(1, Math.round(h * dpr));
	if (state.canvas.width !== bw || state.canvas.height !== bh) {
		state.canvas.width = bw;
		state.canvas.height = bh;
	}
	state.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
	state.viewW = w;
	state.viewH = h;
}

function refreshFitZoom(state: RendererState): void {
	if (!state.worldBBox) return;
	const w = state.canvas.clientWidth;
	const h = state.canvas.clientHeight;
	if (w >= 10 && h >= 10) state.kFit = fitTransform(state.worldBBox, w, h, 40).k;
}

function handleCanvasResize(state: RendererState, fitFn: () => void): void {
	const prevW = state.viewW;
	const prevH = state.viewH;
	const { x: tx, y: ty, k } = state.transform;
	const wx = (prevW / 2 - tx) / k;
	const wy = (prevH / 2 - ty) / k;
	syncCanvasSize(state);
	if (!state.hasFit) {
		fitFn();
	} else {
		refreshFitZoom(state);
		if (prevW > 0 && prevH > 0 && state.viewW > 0 && state.viewH > 0) {
			const nextT = zoomIdentity.translate(state.viewW / 2 - wx * k, state.viewH / 2 - wy * k).scale(k);
			select(state.canvas).call(state.zoomBehavior.transform, nextT);
		}
	}
	drawRendererFrame(state);
}

function validCamera(cam?: { k: number; x: number; y: number } | null): cam is { k: number; x: number; y: number } {
	return Boolean(
		cam &&
		typeof cam.k === "number" && Number.isFinite(cam.k) && cam.k > 0 &&
		typeof cam.x === "number" && Number.isFinite(cam.x) &&
		typeof cam.y === "number" && Number.isFinite(cam.y),
	);
}

function scheduleDirtyFrame(state: RendererState): void {
	state.dirty = true;
	if (state.frameId !== null || state.inTick) return;
	state.frameId = requestAnimationFrame(() => {
		state.frameId = null;
		runRendererTick(state);
	});
}

function createRendererState(canvas: HTMLCanvasElement, callbacks: RendererCallbacks): RendererState {
	const ctx = canvas.getContext("2d");
	if (!ctx) throw new Error("2d context unavailable");
	const state: RendererState = {
		canvas, ctx, callbacks,
		zoomBehavior: zoom<HTMLCanvasElement, unknown>().scaleExtent([0.02, 40]),
		transform: zoomIdentity, hasFit: false, viewW: 0, viewH: 0, kFit: 1, worldBBox: null,
		data: null, nodeById: new Map(), settings: null, visible: null,
		sim: null, simById: new Map(), simActive: false, dragId: null, dragOrigin: null,
		simMoved: false, commitTimer: null, frameId: null, dirty: true, inTick: false,
		hoverId: null, hoverNode: null, hoverFade: 0, hoverFrom: 0, hoverTarget: 0, hoverStart: 0,
		zoomTarget: null, lastTickAt: 0, animating: false, downPos: null,
		geoVersion: 0, builtVersion: -1, nodesPath: null, shaftsPath: new Path2D(), headsPath: new Path2D(),
		regionCanvas: null, regionRect: null, regionMeta: [],
		regionTuning: DEFAULT_REGION_TUNING, physicsTuning: DEFAULT_PHYSICS_TUNING,
		simCenter: { x: 0, y: 0 }, regionBuiltVersion: -1, frameCount: 0,
		labelLines: new Map(), worldLabelFont: "", world: { nodeR: 0, glowOuter: 0, labelSize: 0, labelGap: 0 },
		markDirty: () => scheduleDirtyFrame(state),
	};
	state.zoomBehavior.on("zoom", ({ transform }) => {
		state.transform = transform;
		state.markDirty();
		state.callbacks.onCameraMove(transform);
	});
	select(canvas).call(state.zoomBehavior).on("dblclick.zoom", null).on("wheel.zoom", null);
	return state;
}

function updateRendererData(state: RendererState, data: CanvasData, fitFn: () => void): void {
	state.data = data;
	state.nodeById = new Map(data.nodes.map((n) => [n.id, n]));
	let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
	for (const n of data.nodes) {
		if (n.x < minX) minX = n.x;
		if (n.y < minY) minY = n.y;
		if (n.x > maxX) maxX = n.x;
		if (n.y > maxY) maxY = n.y;
	}
	state.worldBBox = { minX, maxX, minY, maxY };
	if (!state.hasFit && data.nodes.length > 0) fitFn();
	else refreshFitZoom(state);
	if (state.commitTimer) { clearTimeout(state.commitTimer); state.commitTimer = null; }
	state.simActive = false;
	state.dragId = null;
	state.simMoved = false;
	state.simCenter = { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
	buildRendererSim(state);
	state.geoVersion++;
	state.markDirty();
}

export class GraphCanvasRenderer {
	private readonly state: RendererState;
	private readonly resizeObserver: ResizeObserver;
	private readonly onWheel: (e: WheelEvent) => void;
	private readonly onPointerMove: (e: PointerEvent) => void;
	private readonly onPointerDown: (e: PointerEvent) => void;
	private readonly onPointerUp: (e: PointerEvent) => void;
	private readonly onPointerLeave: () => void;
	private readonly onContextMenu: (e: MouseEvent) => void;

	constructor(
		canvas: HTMLCanvasElement,
		callbacks: RendererCallbacks,
		initialCamera?: { k: number; x: number; y: number } | null,
	) {
		const state = createRendererState(canvas, callbacks);
		this.state = state;
		this.onWheel = (e) => handleCanvasWheel(state, e);
		this.onPointerMove = (e) => handlePointerMove(state, e);
		this.onPointerDown = (e) => handlePointerDown(state, e);
		this.onPointerUp = (e) => handlePointerUp(state, e);
		this.onPointerLeave = () => handlePointerLeave(state);
		this.onContextMenu = (e) => handleContextMenu(state, e);
		canvas.addEventListener("wheel", this.onWheel, { passive: false });
		canvas.addEventListener("pointermove", this.onPointerMove);
		canvas.addEventListener("pointerdown", this.onPointerDown);
		canvas.addEventListener("pointerup", this.onPointerUp);
		canvas.addEventListener("pointerleave", this.onPointerLeave);
		canvas.addEventListener("contextmenu", this.onContextMenu);
		if (validCamera(initialCamera)) {
			state.hasFit = true;
			const camT = zoomIdentity.translate(initialCamera.x, initialCamera.y).scale(initialCamera.k);
			select(canvas).call(state.zoomBehavior.transform, camT);
		}
		this.resizeObserver = new ResizeObserver(() => handleCanvasResize(state, () => this.fit()));
		this.resizeObserver.observe(canvas);
		syncCanvasSize(state);
	}

	setData(data: CanvasData): void {
		updateRendererData(this.state, data, () => this.fit());
	}

	setSettings(settings: GraphRenderSettings): void {
		this.state.settings = settings;
		this.state.geoVersion++;
		this.state.markDirty();
	}

	setRegionTuning(input: Partial<RegionTuning>): void {
		this.state.regionTuning = sanitizeRegionTuning(input);
		this.state.regionBuiltVersion = -2;
		if (!this.state.regionTuning.enabled) {
			this.state.regionCanvas = null;
			this.state.regionRect = null;
		}
		this.state.markDirty();
	}

	setPhysicsTuning(input: Partial<PhysicsTuning>): void {
		this.state.physicsTuning = sanitizePhysicsTuning(input);
		buildRendererSim(this.state);
		if (this.state.sim) {
			this.state.sim.alpha(1);
			this.state.simActive = true;
		}
		this.state.markDirty();
	}

	setClusterLabels(labels: ReadonlyMap<string, string | null>): void {
		const { data, settings, ctx } = this.state;
		if (!data) return;
		if (!settings) {
			applyClusterLabels(data.clusters, [], labels, REGION_LABEL_MAX_WIDTH, REGION_LABEL_MAX_LINES, () => 0);
			return;
		}
		const prevFont = ctx.font;
		ctx.font = `${LABEL_WEIGHT} ${settings.clusterLabelSize}px ${data.fontFamily}`;
		const changed = applyClusterLabels(
			data.clusters, this.state.regionMeta, labels,
			REGION_LABEL_MAX_WIDTH, REGION_LABEL_MAX_LINES, (s) => ctx.measureText(s).width,
		);
		ctx.font = prevFont;
		if (changed) this.state.markDirty();
	}

	setVisible(visible: ReadonlySet<string> | null): void {
		this.state.visible = visible;
		this.state.geoVersion++;
		this.state.markDirty();
	}

	fit(): void {
		const { data, worldBBox, canvas, zoomBehavior } = this.state;
		if (!data || data.nodes.length === 0 || !worldBBox) return;
		const w = canvas.clientWidth;
		const h = canvas.clientHeight;
		if (w < 10 || h < 10) return;
		const t = fitTransform(worldBBox, w, h, 40);
		this.state.kFit = t.k;
		this.state.hasFit = true;
		select(canvas).call(zoomBehavior.transform, zoomIdentity.translate(t.x, t.y).scale(t.k));
	}

	destroy(): void {
		if (this.state.frameId !== null) cancelAnimationFrame(this.state.frameId);
		if (this.state.commitTimer) clearTimeout(this.state.commitTimer);
		this.state.sim = null;
		this.state.simActive = false;
		this.state.dragId = null;
		this.resizeObserver.disconnect();
		select(this.state.canvas).on(".zoom", null);
		this.state.canvas.removeEventListener("wheel", this.onWheel);
		this.state.canvas.removeEventListener("pointermove", this.onPointerMove);
		this.state.canvas.removeEventListener("pointerdown", this.onPointerDown);
		this.state.canvas.removeEventListener("pointerup", this.onPointerUp);
		this.state.canvas.removeEventListener("pointerleave", this.onPointerLeave);
		this.state.canvas.removeEventListener("contextmenu", this.onContextMenu);
		this.state.canvas.style.cursor = "";
	}
}
