import type { Simulation, SimulationLinkDatum } from "d3-force";
import type { ZoomBehavior, ZoomTransform } from "d3-zoom";
import type {
	GraphRenderSettings,
	LayoutNode as SimLayoutNode,
	PhysicsTuning,
	Position,
	RegionTuning,
	RenderedMode,
} from "../../../core/index.ts";
import type { Pt } from "./cluster-geometry.ts";

export type { GraphRenderSettings };

/** One node to draw: world-space position + the short glanceable label. */
export interface CanvasNode {
	id: string;
	x: number;
	y: number;
	label: string;
}

/** One directed edge of the DERIVED view (premise -> implication node -> conclusion). */
export interface CanvasEdge {
	from: string;
	to: string;
}

/** Implication-node ids: invisible pure geometry and unpickable on canvas. */
export const isImpNodeId = (id: string): boolean => id.startsWith("arg_");

/** One cluster region: member node ids + the LLM-coined label (or null). */
export interface CanvasCluster {
	id: string;
	label: string | null;
	members: string[];
}

/** Cluster region + label lightness (HSL %), per rendered mode. */
export interface ClusterLightness {
	ring: number;
	label: number;
}

export const CLUSTER_LIGHTNESS: Record<RenderedMode, ClusterLightness> = {
	dark: { ring: 60, label: 78 },
	light: { ring: 42, label: 30 },
};

/** Theme colors, resolved to #rrggbb by the caller. */
export interface CanvasColors {
	node: string;
	edge: string;
	label: string;
	hoverText: string;
	clusterLightness: ClusterLightness;
}

export interface CanvasData {
	nodes: CanvasNode[];
	edges: CanvasEdge[];
	logicalEdges?: CanvasEdge[];
	impLinks?: ReadonlyArray<{ id: string; premises: ReadonlyArray<string>; conclusion: string }>;
	clusters: CanvasCluster[];
	colors: CanvasColors;
	fontFamily: string;
}

export interface RendererCallbacks {
	onSelect: (nodeId: string, screenPos: Pt) => void;
	onContext: (nodeId: string | null, screenPos: Pt) => void;
	onStageClick: () => void;
	onCameraMove: (transform: { k: number; x: number; y: number }) => void;
	onCommit: (positions: Record<string, Position>) => void;
}

/** One complete arrow glyph: shaft + head triangle. */
export interface ArrowGeom {
	shaftFrom: Pt;
	shaftTo: Pt;
	tip: Pt;
	left: Pt;
	right: Pt;
}

export const LABEL_SIZE = 12;
export const LABEL_WEIGHT = "500";
export const REGION_LABEL_MAX_WIDTH = 220;
export const REGION_LABEL_MAX_LINES = 3;
export const REGION_LABEL_LINE_HEIGHT = 1.3;
export const LABEL_MAX_WIDTH = 170;
export const LABEL_GAP = 2.9;
export const LABEL_LINE_HEIGHT = 1.3;
export const LABELS_FADE_RATIO = 0.5;
export const GLOW_SCALE = 1.7;
export const GLOW_ALPHA = 0.3;
export const HOVER_FADE_MS = 180;
export const ZOOM_EASE_MS = 45;
export const PICKING_PAD = 10;
export const CLICK_SLOP = 4;
export const LIVE_ALPHA_DECAY = 0.05;
export const DRAG_ALPHA_TARGET = 0.3;
export const SIM_SETTLE_ALPHA = 0.005;
export const COMMIT_DEBOUNCE_MS = 250;
export const REGION_EVERY = 3;

export interface WorldSizes {
	nodeR: number;
	glowOuter: number;
	labelSize: number;
	labelGap: number;
}

export interface RegionMeta {
	id: string;
	label: string | null;
	lines: string[] | null;
	cx: number;
	cy: number;
	hue: number;
}

export interface RendererState {
	canvas: HTMLCanvasElement;
	ctx: CanvasRenderingContext2D;
	callbacks: RendererCallbacks;
	zoomBehavior: ZoomBehavior<HTMLCanvasElement, unknown>;
	transform: ZoomTransform;
	hasFit: boolean;
	viewW: number;
	viewH: number;
	kFit: number;
	worldBBox: { minX: number; maxX: number; minY: number; maxY: number } | null;
	data: CanvasData | null;
	nodeById: Map<string, CanvasNode>;
	settings: GraphRenderSettings | null;
	visible: ReadonlySet<string> | null;
	sim: Simulation<SimLayoutNode, SimulationLinkDatum<SimLayoutNode>> | null;
	simById: Map<string, SimLayoutNode>;
	simActive: boolean;
	dragId: string | null;
	dragOrigin: Pt | null;
	simMoved: boolean;
	commitTimer: ReturnType<typeof setTimeout> | null;
	frameId: number | null;
	dirty: boolean;
	inTick: boolean;
	hoverId: string | null;
	hoverNode: CanvasNode | null;
	hoverFade: number;
	hoverFrom: number;
	hoverTarget: number;
	hoverStart: number;
	zoomTarget: { k: number; x: number; y: number } | null;
	lastTickAt: number;
	animating: boolean;
	downPos: Pt | null;
	geoVersion: number;
	builtVersion: number;
	nodesPath: Path2D | null;
	shaftsPath: Path2D;
	headsPath: Path2D;
	regionCanvas: HTMLCanvasElement | null;
	regionRect: { minX: number; minY: number; w: number; h: number } | null;
	regionMeta: RegionMeta[];
	regionTuning: RegionTuning;
	physicsTuning: PhysicsTuning;
	simCenter: Pt;
	regionBuiltVersion: number;
	frameCount: number;
	labelLines: Map<string, string[]>;
	worldLabelFont: string;
	world: WorldSizes;
	markDirty: () => void;
}
