/**
 * CloudCanvas `peer-graph` stage control (`views §3.2`, `C-03`).
 * Mounts `blit(stageDiv)` -> `root.blit({ type: 'peer-graph' })`, constructs
 * `GraphCanvasRenderer` ONLY when `clonedData && clonedData.nodes.length > 0`
 * (eliminating the empty-mount simulation race), drives it with shallow-cloned
 * `nodes` so `d3-force` never mutates store models, and degrades cleanly with
 * `[data-peer-canvas-fallback]` when `canvas.getContext('2d')` is unavailable.
 */
import { blit } from 'cloudcanvas';
import { createLife, documentOf, el, injectUiStyles, placeChildren, textNode, writeText } from 'cloudcanvas-lib/ui';
import { GraphCanvasRenderer, isImpNodeId } from 'peer-engine';
import { deriveGraphStageModel, FALLBACK_RENDER_SETTINGS } from './graph-models.js';
import { ensureGraphWidgetRegistered } from './graph-widget.js';
import { injectGraphStyles } from './graph.css.js';

export function cloneCanvasData(data) {
  if (!data || typeof data !== 'object') return null;
  return {
    ...data,
    nodes: Array.isArray(data.nodes) ? data.nodes.map((node) => ({ ...node })) : [],
    edges: Array.isArray(data.edges) ? data.edges.map((edge) => ({ ...edge })) : [],
    logicalEdges: Array.isArray(data.logicalEdges) ? data.logicalEdges.map((edge) => ({ ...edge })) : undefined,
    impLinks: Array.isArray(data.impLinks)
      ? data.impLinks.map((link) => ({ ...link, premises: [...(link.premises ?? [])] }))
      : undefined,
    clusters: Array.isArray(data.clusters)
      ? data.clusters.map((cluster) => ({ ...cluster, members: [...(cluster.members ?? [])] }))
      : []
  };
}

function probeCanvas2d(canvas) {
  if (!canvas || typeof canvas.getContext !== 'function') return false;
  try {
    return Boolean(canvas.getContext('2d'));
  } catch {
    return false;
  }
}

function makeRendererCallbacks(callbacks) {
  return {
    onSelect: (nodeId, pos) => callbacks.onSelect?.(nodeId, pos),
    onContext: (nodeId, pos) => callbacks.onContext?.(nodeId, pos),
    onStageClick: () => callbacks.onStageClick?.(),
    onCameraMove: (transform) => callbacks.onCameraMove?.(transform),
    onCommit: (positions) => callbacks.onCommit?.(positions)
  };
}

function mountFallbackSurface(doc, stageDiv, life, callbacks, getNodeById) {
  const root = el(doc, 'div', {
    className: 'peer-graph-canvas-fallback',
    attrs: { 'data-peer-canvas-fallback': '' }
  });
  const summaryEl = el(doc, 'div', { className: 'peer-graph-fallback-summary' });
  const summaryText = textNode(doc, summaryEl, 'Knowledge graph stage');
  const nodesWrap = el(doc, 'div', { className: 'peer-graph-fallback-nodes' });
  root.append(summaryEl, nodesWrap);
  stageDiv.append(root);

  life.on(root, 'click', (event) => {
    const btn = event.target?.closest?.('[data-peer-fallback-node]');
    if (!btn) { callbacks.onStageClick?.(); return; }
    const node = getNodeById(btn.getAttribute('data-peer-fallback-node'));
    if (node) callbacks.onSelect?.(node.id, { x: node.x ?? 0, y: node.y ?? 0 });
  });

  life.on(root, 'contextmenu', (event) => {
    event.preventDefault();
    const btn = event.target?.closest?.('[data-peer-fallback-node]');
    const node = btn ? getNodeById(btn.getAttribute('data-peer-fallback-node')) : null;
    callbacks.onContext?.(node ? node.id : null, { x: node?.x ?? 0, y: node?.y ?? 0 });
  });

  return { root, summaryText, nodesWrap };
}

function buildFallbackNodeBtn(doc, node) {
  const btn = el(doc, 'button', {
    className: 'cloudcanvas-ui-button peer-graph-fallback-node',
    text: node.label || node.id,
    attrs: { 'data-peer-fallback-node': node.id }
  });
  btn.type = 'button';
  return btn;
}

function syncFallbackSurface(doc, fallback, clonedData, visible) {
  const allNodes = clonedData?.nodes ?? [];
  const pickable = allNodes.filter((n) => !isImpNodeId(n.id) && (!visible || visible.has(n.id)));
  writeText(fallback.summaryText, `Knowledge graph (${pickable.length} propositions)`);
  placeChildren(fallback.nodesWrap, pickable.map((node) => buildFallbackNodeBtn(doc, node)));
}

function ensureRenderer(state, initialCamera) {
  if (state.renderer || state.fallback) return state.renderer;
  try {
    state.renderer = new GraphCanvasRenderer(
      state.canvas,
      makeRendererCallbacks(state.callbacks),
      initialCamera ?? null
    );
  } catch {
    state.fallback = mountFallbackSurface(
      state.doc, state.stageDiv, state.life, state.callbacks, (id) => state.nodeMap.get(id)
    );
  }
  return state.renderer;
}

function applyRendererSettings(state, settings) {
  const renderer = state.renderer;
  const resolved = settings ?? FALLBACK_RENDER_SETTINGS;
  const physicsKey = JSON.stringify(resolved.physics ?? null);
  const regionKey = JSON.stringify(resolved.regions ?? null);

  if (!state.initializedSettings) {
    state.initializedSettings = true;
    state.lastPhysicsKey = physicsKey;
    state.lastRegionKey = regionKey;
    if (resolved.regions) renderer.setRegionTuning(resolved.regions);
    if (resolved.physics) renderer.setPhysicsTuning(resolved.physics);
    renderer.setSettings(resolved);
    state.lastSettings = settings;
    return;
  }
  if (settings !== state.lastSettings) renderer.setSettings(resolved);
  if (regionKey !== state.lastRegionKey && resolved.regions) {
    state.lastRegionKey = regionKey;
    renderer.setRegionTuning(resolved.regions);
  }
  if (physicsKey !== state.lastPhysicsKey && resolved.physics) {
    state.lastPhysicsKey = physicsKey;
    renderer.setPhysicsTuning(resolved.physics);
  }
  state.lastSettings = settings;
}

function clearStageCanvas(state) {
  if (!state.renderer || !state.hadNodes) return;
  state.hadNodes = false;
  const ctx = state.canvas?.getContext?.('2d');
  if (ctx && state.canvas) ctx.clearRect(0, 0, state.canvas.width, state.canvas.height);
}

function syncGraphStage(state, model = {}) {
  if (state.life.dead || model === state.lastModel) return;
  state.lastModel = model;
  const normalized = model && 'data' in model ? model : deriveGraphStageModel(model);
  if (normalized.data !== state.lastDataSource) {
    state.lastDataSource = normalized.data;
    state.lastClonedData = cloneCanvasData(normalized.data);
    state.nodeMap = new Map((state.lastClonedData?.nodes ?? []).map((n) => [n.id, n]));
  }
  if (state.fallback) {
    syncFallbackSurface(state.doc, state.fallback, state.lastClonedData, normalized.visible);
    return;
  }
  const hasNodes = Boolean(state.lastClonedData && state.lastClonedData.nodes.length > 0);
  if (!hasNodes) {
    clearStageCanvas(state);
    return;
  }
  const renderer = ensureRenderer(state, normalized.camera);
  if (state.fallback || !renderer) {
    if (state.fallback) syncFallbackSurface(state.doc, state.fallback, state.lastClonedData, normalized.visible);
    return;
  }
  applyRendererSettings(state, normalized.settings);
  renderer.setVisible(normalized.visible ?? null);
  state.hadNodes = true;
  renderer.setData(state.lastClonedData);
}

function teardownGraphStage(state) {
  if (!state.life.destroy()) return;
  state.renderer?.destroy();
  state.renderer = null;
  state.nodeMap.clear();
  state.widgetBlit?.remove?.();
  state.root?.destroy?.();
  state.root?.remove?.();
  state.stageDiv.remove();
}

export function createGraphStage(host, callbacks = {}) {
  const doc = documentOf(host);
  injectUiStyles(doc);
  injectGraphStyles(doc);
  ensureGraphWidgetRegistered();
  const life = createLife();
  const stageDiv = el(doc, 'div', {
    className: 'peer-graph-stage-host',
    attrs: { 'data-peer-graph-stage': '' }
  });
  host.append(stageDiv);

  const root = blit(stageDiv);
  const widgetBlit = root.blit({ type: 'peer-graph' });
  const canvas = widgetBlit.el.querySelector('canvas');
  const state = {
    doc, life, stageDiv, root, widgetBlit, canvas, callbacks,
    renderer: null, fallback: null, lastModel: null, lastDataSource: undefined,
    lastClonedData: null, lastSettings: null, lastPhysicsKey: '', lastRegionKey: '',
    initializedSettings: false, hadNodes: false, nodeMap: new Map()
  };
  if (!probeCanvas2d(canvas)) {
    state.fallback = mountFallbackSurface(doc, stageDiv, life, callbacks, (id) => state.nodeMap.get(id));
  }

  return {
    update: (model) => syncGraphStage(state, model),
    fit: () => { if (!life.dead) state.renderer?.fit(); },
    destroy: () => teardownGraphStage(state)
  };
}
