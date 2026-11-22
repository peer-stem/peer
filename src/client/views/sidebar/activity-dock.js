/**
 * Sidebar Background Agents strip (`components/activity-dock.tsx` parity).
 * Renders `[data-testid="activity-section"]`, keyed `job` / `plugin-worker` /
 * `extraction` blobs, a 1s live elapsed ticker while populated, inline detail
 * expansion, and `[data-testid="activity-abort"]`.
 */
import { button, createLife, documentOf, el, injectUiStyles, setOff, show, textNode, writeText } from 'cloudcanvas-lib/ui';
import { formatTokens, isModelsRefusal, isProviderKeyRefusal, planCostLabel } from 'peer-engine';
import { createViewList } from '../shared/view-list.js';
import { injectSidebarStyles } from './sidebar.css.js';

const SUBSCRIPTION_PREFIXES = Object.freeze([
  ['chatgpt:', 'ChatGPT'],
  ['github-copilot-subscription:', 'GitHub Copilot'],
  ['xai-subscription:', 'Grok']
]);

function modelSubLabel(model) {
  if (typeof model !== 'string' || !model) return undefined;
  for (const [prefix, label] of SUBSCRIPTION_PREFIXES) {
    if (model.startsWith(prefix)) return label;
  }
  return undefined;
}

function modelSubLabels(models) {
  const labels = [];
  for (const model of models) {
    const label = modelSubLabel(model);
    if (label && !labels.includes(label)) labels.push(label);
  }
  return labels;
}

export function formatElapsed(ms) {
  const sec = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ${String(sec % 60).padStart(2, '0')}s`;
  return `${Math.floor(min / 60)}h ${String(min % 60).padStart(2, '0')}m`;
}

function computeStepContext(lastStep, contextLimit) {
  if (!lastStep || contextLimit === null || contextLimit === undefined || lastStep.inputTokens === undefined) {
    return null;
  }
  const used = lastStep.inputTokens
    + (lastStep.outputTokens ?? 0)
    + (lastStep.cacheReadTokens ?? 0)
    + (lastStep.cacheWriteTokens ?? 0);
  return { used, limit: contextLimit };
}

function mapJobToBlob(job) {
  const usage = job.usage;
  const activity = isModelsRefusal(job.error)
    ? 'needs model setup'
    : isProviderKeyRefusal(job.error)
      ? 'needs a provider key'
      : (job.activity ?? '');
  const pluginTitle = job.plugin?.label || job.plugin?.toolName || 'Plugin worker';
  return {
    id: job.id,
    process: 'job',
    jobKind: job.kind,
    title: job.kind === 'plugin' ? pluginTitle : (job.title ?? ''),
    chatId: job.chatId,
    startedAt: Date.parse(job.createdAt) || 0,
    cost: job.costUsd ?? null,
    context: usage ? computeStepContext(usage.lastStep, job.contextLimit) : null,
    activity,
    model: usage?.model,
    steps: usage?.steps
  };
}

function mapPluginWorkerToBlob(task) {
  const fallbackModel = task.model ? `${task.model.provider}:${task.model.id}` : undefined;
  return {
    id: task.id,
    process: 'plugin-worker',
    jobKind: 'plugin',
    title: task.title ?? '',
    startedAt: Date.parse(task.createdAt) || 0,
    cost: task.costUsd ?? null,
    context: computeStepContext(task.usage?.lastStep, task.contextLimit ?? null),
    activity: task.activity ?? task.status ?? '',
    model: task.usage?.model ?? fallbackModel,
    steps: task.usage?.steps
  };
}

export function toBlobs(feed = {}) {
  const blobs = [];
  for (const job of feed.jobs ?? []) blobs.push(mapJobToBlob(job));
  for (const worker of feed.pluginWorkers ?? []) blobs.push(mapPluginWorkerToBlob(worker));
  for (const run of feed.extractions ?? []) {
    blobs.push({
      id: run.id,
      process: 'extraction',
      phase: run.phase,
      title: run.title ?? '',
      chatId: run.chatId,
      startedAt: Number(run.startedAt) || 0,
      cost: null,
      context: null,
      activity: ''
    });
  }
  blobs.sort((a, b) => a.startedAt - b.startedAt);
  return blobs;
}

function blobKindLabel(blob) {
  if (blob.process === 'extraction') return `Extraction — ${blob.phase ?? 'running'}`;
  const table = {
    research: 'Researcher',
    demo: 'Demo builder',
    visual: 'Figure maker',
    pdf: 'PDF reader',
    plugin: 'Plugin worker'
  };
  return table[blob.jobKind] ?? 'Sub-agent';
}

function normalizeBlobs(activityModel) {
  if (!activityModel || typeof activityModel !== 'object') return [];
  if (Array.isArray(activityModel.blobs)) return activityModel.blobs;
  const source = activityModel.feed && typeof activityModel.feed === 'object' ? activityModel.feed : activityModel;
  return toBlobs(source);
}

function buildDetailKv(doc, labelText, valTestId, hidden = false) {
  const row = el(doc, 'div', { className: 'peer-activity-kv', attrs: hidden ? { hidden: true } : undefined });
  const valSpan = el(doc, 'span', {
    className: 'peer-coverage-val',
    attrs: valTestId ? { 'data-testid': valTestId } : undefined
  });
  const valText = textNode(doc, valSpan, '');
  row.append(el(doc, 'span', { text: labelText }), valSpan);
  return { row, valText };
}

function buildBlobDetailDom(doc, life, onOpenSession) {
  const detail = el(doc, 'div', {
    className: 'peer-activity-detail',
    attrs: { 'data-testid': 'activity-blob-detail', hidden: true }
  });
  const headRow = el(doc, 'div', { className: 'peer-activity-kv' });
  const kindSpan = el(doc, 'span');
  const kindText = textNode(doc, kindSpan, '');
  const detailElapsedSpan = el(doc, 'span', { className: 'peer-coverage-val' });
  const detailElapsedText = textNode(doc, detailElapsedSpan, '');
  headRow.append(kindSpan, detailElapsedSpan);

  const actEl = el(doc, 'div', { className: 'peer-sidebar-meta', attrs: { hidden: true } });
  const actText = textNode(doc, actEl, '');
  const cost = buildDetailKv(doc, 'Cost');
  const ctx = buildDetailKv(doc, 'Context', 'activity-blob-context');
  const model = buildDetailKv(doc, 'Model', undefined, true);
  const steps = buildDetailKv(doc, 'Steps', undefined, true);
  const sessionLink = el(doc, 'a', { text: 'Open session →', attrs: { href: '#', hidden: true } });
  life.on(sessionLink, 'click', (ev) => { ev.preventDefault(); onOpenSession(); });
  const statusEl = el(doc, 'div', { className: 'peer-sidebar-meta', attrs: { hidden: true } });
  const statusText = textNode(doc, statusEl, '');
  detail.append(headRow, actEl, cost.row, ctx.row, model.row, steps.row, sessionLink, statusEl);
  return { detail, kindText, detailElapsedText, actEl, actText, cost, ctx, model, steps, sessionLink, statusEl, statusText };
}

function buildBlobFaceDom(doc, rowLife, onToggle, onAbortClick) {
  const faceWrap = el(doc, 'div', { className: 'peer-activity-face-wrap' });
  const faceBtn = el(doc, 'button', {
    className: 'peer-activity-face',
    attrs: { type: 'button', 'aria-expanded': 'false' }
  });
  const textCol = el(doc, 'span', { className: 'peer-sidebar-row-body' });
  const titleSpan = el(doc, 'span', { className: 'peer-coverage-val' });
  const titleText = textNode(doc, titleSpan, '');
  const subSpan = el(doc, 'span', { className: 'peer-sidebar-meta' });
  const subText = textNode(doc, subSpan, '');
  textCol.append(titleSpan, subSpan);

  const rightCol = el(doc, 'span', { className: 'peer-activity-kv' });
  const faceCostSpan = el(doc, 'span', { attrs: { 'data-testid': 'activity-blob-cost' } });
  const faceCostText = textNode(doc, faceCostSpan, '—');
  const elapsedSpan = el(doc, 'span', { attrs: { 'data-testid': 'activity-blob-elapsed' } });
  const elapsedText = textNode(doc, elapsedSpan, '0s');
  rightCol.append(faceCostSpan, elapsedSpan);
  faceBtn.append(textCol, rightCol);
  rowLife.on(faceBtn, 'click', onToggle);

  const abortBtn = button(doc, {
    className: 'peer-activity-abort',
    label: '■',
    signal: rowLife.signal,
    onClick: onAbortClick,
    attrs: { 'data-testid': 'activity-abort' }
  });
  faceWrap.append(faceBtn, abortBtn);
  return { faceWrap, faceBtn, titleSpan, titleText, subSpan, subText, faceCostText, elapsedText, abortBtn };
}

function applyBlobRowUpdate(slot, face, det, vm) {
  const { blob, now, detailOpen, abortState } = vm;
  slot.setAttribute('data-testid', `activity-blob-${blob.process}`);
  slot.setAttribute('data-activity-id', String(blob.id));
  const kindLabel = blobKindLabel(blob);
  const costLabel = planCostLabel(blob.cost ?? null, modelSubLabel(blob.model));
  const elapsed = formatElapsed(now - (Number(blob.startedAt) || 0));
  face.faceBtn.setAttribute('aria-expanded', String(Boolean(detailOpen)));
  face.titleSpan.title = String(blob.title ?? '');
  writeText(face.titleText, blob.title ?? '');
  face.subSpan.title = blob.activity ? String(blob.activity) : '';
  writeText(face.subText, blob.activity || kindLabel);
  writeText(face.faceCostText, costLabel);
  writeText(face.elapsedText, elapsed);
  face.abortBtn.setAttribute('aria-label', `End ${kindLabel} in ${blob.title ?? ''}`);
  face.abortBtn.title = abortState === 'failed' ? 'Abort failed — try again' : 'End this background process';
  face.abortBtn.disabled = Boolean(abortState);
  setOff(face.abortBtn, Boolean(abortState));

  show(det.detail, Boolean(detailOpen));
  if (!detailOpen) return;
  writeText(det.kindText, kindLabel);
  writeText(det.detailElapsedText, elapsed);
  show(det.actEl, Boolean(blob.activity));
  writeText(det.actText, blob.activity ?? '');
  writeText(det.cost.valText, costLabel);
  const ctxStr = blob.context ? `${formatTokens(blob.context.used)} / ${formatTokens(blob.context.limit)}` : '—';
  writeText(det.ctx.valText, ctxStr);
  show(det.model.row, Boolean(blob.model));
  writeText(det.model.valText, blob.model ?? '');
  show(det.steps.row, blob.steps !== undefined && blob.steps !== null);
  writeText(det.steps.valText, blob.steps !== undefined && blob.steps !== null ? String(blob.steps) : '');
  show(det.sessionLink, Boolean(blob.chatId));
  if (blob.chatId) det.sessionLink.setAttribute('href', `/chat/${encodeURIComponent(blob.chatId)}`);
  const abortMsg = abortState === 'failed' ? 'Abort failed — try again' : (abortState === 'pending' ? 'Stopping…' : '');
  show(det.statusEl, abortMsg !== '');
  writeText(det.statusText, abortMsg);
}

function createBlobRowView(slot, dockState) {
  const doc = documentOf(slot);
  const rowLife = createLife();
  slot.classList.add('peer-activity-blob');
  let currentBlob = null;
  const face = buildBlobFaceDom(
    doc,
    rowLife,
    () => { if (currentBlob) dockState.toggleOpen(currentBlob.id); },
    () => { if (currentBlob) dockState.triggerAbort(currentBlob); }
  );
  const det = buildBlobDetailDom(doc, rowLife, () => {
    if (currentBlob?.chatId) dockState.onNavigateSession?.(currentBlob.chatId);
  });
  slot.append(face.faceWrap, det.detail);
  return {
    node: slot,
    update: (vm) => { currentBlob = vm.blob; applyBlobRowUpdate(slot, face, det, vm); },
    destroy: () => { rowLife.destroy(); }
  };
}

function syncTicker(dockState, renderNow) {
  const shouldTick = dockState.blobs.length > 0 && !dockState.life.dead;
  if (shouldTick && dockState.timer === null) {
    dockState.timer = setInterval(() => { dockState.now = Date.now(); renderNow(); }, 1000);
  } else if (!shouldTick && dockState.timer !== null) {
    clearInterval(dockState.timer);
    dockState.timer = null;
  }
}

function renderActivityDock(dockState, nodes, viewList) {
  if (dockState.life.dead) return;
  const { blobs } = dockState;
  show(nodes.totalCostEl, blobs.length > 0);
  show(nodes.listEl, blobs.length > 0);
  if (blobs.length > 0) {
    const priced = blobs.map((b) => b.cost).filter((c) => typeof c === 'number' && Number.isFinite(c));
    const sum = priced.length === 0 ? null : priced.reduce((acc, c) => acc + c, 0);
    writeText(nodes.totalCostText, planCostLabel(sum, modelSubLabels(blobs.map((b) => b.model))));
  }
  viewList.update(blobs.map((blob) => ({
    id: blob.id,
    blob,
    now: dockState.now,
    detailOpen: dockState.openId === blob.id,
    abortState: dockState.externalAborts[blob.id] ?? dockState.localAborts.get(blob.id)
  })));
}

function buildDockDom(doc) {
  const root = el(doc, 'section', { className: 'peer-activity-section', attrs: { 'data-testid': 'activity-section' } });
  const header = el(doc, 'div', { className: 'peer-activity-header' });
  header.append(el(doc, 'span', { text: 'Background agents' }));
  const totalCostEl = el(doc, 'span', {
    className: 'peer-activity-cost-total',
    attrs: { 'data-testid': 'activity-total-cost', title: 'Total running cost (inferred)', hidden: true }
  });
  const totalCostText = textNode(doc, totalCostEl, '');
  header.append(totalCostEl);
  const listEl = el(doc, 'div', { className: 'peer-activity-list', attrs: { hidden: true } });
  root.append(header, listEl);
  return { root, totalCostEl, totalCostText, listEl };
}

export function createActivityDock(host, { onAbort, onNavigateSession } = {}) {
  const doc = documentOf(host);
  injectUiStyles(doc);
  injectSidebarStyles(doc);
  const life = createLife();
  const nodes = buildDockDom(doc);
  host.append(nodes.root);

  const dockState = {
    life, onNavigateSession, blobs: [], externalAborts: {}, localAborts: new Map(),
    openId: null, now: Date.now(), timer: null, toggleOpen: null, triggerAbort: null
  };
  const viewList = createViewList(nodes.listEl, {
    key: (item) => item.id,
    model: (item) => item,
    create: (slot) => createBlobRowView(slot, dockState)
  });
  const renderNow = () => renderActivityDock(dockState, nodes, viewList);
  dockState.toggleOpen = (id) => { dockState.openId = dockState.openId === id ? null : id; renderNow(); };
  dockState.triggerAbort = async (blob) => {
    const targetId = blob.process === 'extraction' ? (blob.chatId ?? blob.id) : blob.id;
    dockState.localAborts.set(blob.id, 'pending');
    renderNow();
    try {
      await onAbort?.({ kind: blob.process, id: targetId });
    } catch {
      if (!life.dead) { dockState.localAborts.set(blob.id, 'failed'); renderNow(); }
    }
  };

  const update = (activityModel = {}) => {
    if (life.dead) return;
    dockState.blobs = normalizeBlobs(activityModel);
    dockState.externalAborts = activityModel?.abortStates ?? {};
    const activeIds = new Set(dockState.blobs.map((b) => b.id));
    for (const id of [...dockState.localAborts.keys()]) {
      if (!activeIds.has(id)) dockState.localAborts.delete(id);
    }
    dockState.now = Date.now();
    syncTicker(dockState, renderNow);
    renderNow();
  };

  const destroy = () => {
    if (!life.destroy()) return;
    if (dockState.timer !== null) clearInterval(dockState.timer);
    dockState.timer = null;
    viewList.destroy();
    nodes.root.remove();
  };
  return { update, destroy };
}
