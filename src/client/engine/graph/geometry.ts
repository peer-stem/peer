import { arrowGeometry, graphemes, labelAlpha, rgbaFromHex, zoomRatioOf } from "./math.ts";
import { buildRendererRegions } from "./regions.ts";
import {
	GLOW_ALPHA,
	GLOW_SCALE,
	isImpNodeId,
	LABEL_GAP,
	LABEL_LINE_HEIGHT,
	LABEL_MAX_WIDTH,
	LABEL_SIZE,
	LABEL_WEIGHT,
	REGION_EVERY,
	REGION_LABEL_LINE_HEIGHT,
	type CanvasData,
	type GraphRenderSettings,
	type RendererState,
	type WorldSizes,
} from "./types.ts";

function breakOverlongWord(context: CanvasRenderingContext2D, word: string, maxWidth: number, lines: string[]): void {
	let chunk = "";
	for (const char of graphemes(word)) {
		if (chunk && context.measureText(`${chunk}${char}`).width > maxWidth) {
			lines.push(chunk);
			chunk = char;
		} else {
			chunk += char;
		}
	}
	if (chunk) lines.push(chunk);
}

function wrapLabel(context: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
	const lines: string[] = [];
	for (const word of text.split(/\s+/).filter(Boolean)) {
		const last = lines.length > 0 ? lines[lines.length - 1]! : null;
		if (last !== null && context.measureText(`${last} ${word}`).width <= maxWidth) {
			lines[lines.length - 1] = `${last} ${word}`;
			continue;
		}
		breakOverlongWord(context, word, maxWidth, lines);
	}
	return lines;
}

function drawNameLines(
	context: CanvasRenderingContext2D,
	x: number,
	y: number,
	lines: string[],
	world: WorldSizes,
	color: string,
): void {
	context.fillStyle = color;
	context.textAlign = "center";
	context.textBaseline = "top";
	const firstTop = y + world.nodeR + world.labelGap;
	for (let i = 0; i < lines.length; i++) {
		context.fillText(lines[i]!, x, firstTop + i * world.labelSize * LABEL_LINE_HEIGHT);
	}
}

function buildEdgePaths(
	state: RendererState,
	data: CanvasData,
	settings: GraphRenderSettings,
	isVisible: (id: string) => boolean,
): void {
	const nodeR = settings.nodeSize;
	const arrowLen = settings.arrowLength;
	const shafts = new Path2D();
	const heads = new Path2D();
	for (const e of data.edges) {
		if (!isVisible(e.from) || !isVisible(e.to)) continue;
		const a = state.nodeById.get(e.from);
		const b = state.nodeById.get(e.to);
		if (!a || !b) continue;
		const intoImp = isImpNodeId(e.to);
		const outOfImp = isImpNodeId(e.from);
		const g = arrowGeometry(a, b, outOfImp ? 0 : nodeR, intoImp ? 0 : nodeR, arrowLen);
		if (!g) continue;
		shafts.moveTo(g.shaftFrom.x, g.shaftFrom.y);
		if (intoImp) {
			shafts.lineTo(g.tip.x, g.tip.y);
		} else {
			shafts.lineTo(g.shaftTo.x, g.shaftTo.y);
			heads.moveTo(g.tip.x, g.tip.y);
			heads.lineTo(g.left.x, g.left.y);
			heads.lineTo(g.right.x, g.right.y);
			heads.closePath();
		}
	}
	state.shaftsPath = shafts;
	state.headsPath = heads;
}

/** Derive ALL world geometry from data + visibility + settings. */
export function buildRendererGeometry(state: RendererState): void {
	state.builtVersion = state.geoVersion;
	const data = state.data;
	const settings = state.settings;
	if (!data || !settings) return;
	const nodeR = settings.nodeSize;
	state.worldLabelFont = `${LABEL_WEIGHT} ${settings.labelSize}px ${data.fontFamily}`;
	state.world = { nodeR, glowOuter: nodeR * GLOW_SCALE, labelSize: settings.labelSize, labelGap: LABEL_GAP };
	const isVisible = (id: string) => !state.visible || state.visible.has(id);
	const nodesPath = new Path2D();
	for (const n of data.nodes) {
		if (!isVisible(n.id) || isImpNodeId(n.id)) continue;
		nodesPath.moveTo(n.x + nodeR, n.y);
		nodesPath.arc(n.x, n.y, nodeR, 0, Math.PI * 2);
	}
	state.nodesPath = nodesPath;
	buildEdgePaths(state, data, settings, isVisible);
	state.labelLines = new Map();
	const prevFont = state.ctx.font;
	state.ctx.font = state.worldLabelFont;
	const maxW = LABEL_MAX_WIDTH * (settings.labelSize / LABEL_SIZE);
	for (const n of data.nodes) {
		if (isVisible(n.id) && !isImpNodeId(n.id)) state.labelLines.set(n.id, wrapLabel(state.ctx, n.label, maxW));
	}
	state.ctx.font = prevFont;
}

function drawHoverLayer(state: RendererState, data: CanvasData): void {
	if (!state.hoverNode || state.hoverFade <= 0.02) return;
	if (state.visible && !state.visible.has(state.hoverNode.id)) return;
	const n = state.hoverNode;
	const ctx = state.ctx;
	const { nodeR, glowOuter } = state.world;
	const glow = ctx.createRadialGradient(n.x, n.y, nodeR, n.x, n.y, glowOuter);
	glow.addColorStop(0, rgbaFromHex(data.colors.node, GLOW_ALPHA * state.hoverFade));
	glow.addColorStop(1, rgbaFromHex(data.colors.node, 0));
	ctx.fillStyle = glow;
	ctx.beginPath();
	ctx.arc(n.x, n.y, glowOuter, 0, Math.PI * 2);
	ctx.arc(n.x, n.y, nodeR, 0, Math.PI * 2, true);
	ctx.fill("evenodd");
	ctx.save();
	ctx.globalAlpha = state.hoverFade;
	ctx.font = state.worldLabelFont;
	drawNameLines(ctx, n.x, n.y, state.labelLines.get(n.id) ?? [], state.world, data.colors.hoverText);
	ctx.restore();
}

function drawRegionLabelsLayer(
	state: RendererState,
	data: CanvasData,
	settings: GraphRenderSettings,
	regionAlpha: number,
	k: number,
): void {
	if (!settings.clusterLabels || regionAlpha <= 0.01) return;
	const ctx = state.ctx;
	ctx.save();
	ctx.globalAlpha = regionAlpha;
	ctx.font = `${LABEL_WEIGHT} ${settings.clusterLabelSize / k}px ${data.fontFamily}`;
	ctx.textAlign = "center";
	ctx.textBaseline = "middle";
	const lineH = (settings.clusterLabelSize * REGION_LABEL_LINE_HEIGHT) / k;
	for (const rm of state.regionMeta) {
		if (!rm.lines) continue;
		ctx.fillStyle = `hsla(${rm.hue}, 55%, ${data.colors.clusterLightness.label}%, 0.85)`;
		const firstOffset = (-(rm.lines.length - 1) / 2) * lineH;
		for (let i = 0; i < rm.lines.length; i++) {
			ctx.fillText(rm.lines[i]!, rm.cx, rm.cy + firstOffset + i * lineH);
		}
	}
	ctx.restore();
}

/** Draw every layer in one frame under one camera transform. */
export function drawRendererFrame(state: RendererState): void {
	state.dirty = false;
	const data = state.data;
	const settings = state.settings;
	if (!data || !settings) return;
	const dpr = window.devicePixelRatio || 1;
	const ctx = state.ctx;
	ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
	ctx.clearRect(0, 0, state.canvas.clientWidth, state.canvas.clientHeight);
	state.frameCount++;
	if (state.regionBuiltVersion !== state.geoVersion && (!state.simActive || state.frameCount % REGION_EVERY === 0)) {
		buildRendererRegions(state);
		state.regionBuiltVersion = state.geoVersion;
	}
	if (state.builtVersion !== state.geoVersion) buildRendererGeometry(state);
	if (!state.nodesPath) return;
	const { x: tx, y: ty, k } = state.transform;
	ctx.setTransform(dpr * k, 0, 0, dpr * k, dpr * tx, dpr * ty);
	const nodeAlpha = labelAlpha(zoomRatioOf(state.kFit, k), settings.labelZoom);
	if (state.regionCanvas && state.regionRect) {
		ctx.imageSmoothingEnabled = true;
		ctx.drawImage(state.regionCanvas, state.regionRect.minX, state.regionRect.minY, state.regionRect.w, state.regionRect.h);
	}
	if (settings.edgeWidth > 0) {
		ctx.strokeStyle = data.colors.edge;
		ctx.fillStyle = data.colors.edge;
		ctx.lineWidth = settings.edgeWidth / k;
		ctx.lineCap = "round";
		ctx.stroke(state.shaftsPath);
		ctx.fill(state.headsPath);
	}
	ctx.fillStyle = data.colors.node;
	ctx.fill(state.nodesPath);
	if (nodeAlpha > 0.01) {
		ctx.save();
		ctx.globalAlpha = nodeAlpha;
		ctx.font = state.worldLabelFont;
		for (const [id, lines] of state.labelLines) {
			const n = state.nodeById.get(id);
			if (n) drawNameLines(ctx, n.x, n.y, lines, state.world, data.colors.label);
		}
		ctx.restore();
	}
	drawHoverLayer(state, data);
	drawRegionLabelsLayer(state, data, settings, 1 - nodeAlpha, k);
}
