/**
 * Extraction-coverage controls (`components/extraction-coverage.tsx` parity):
 * - `ringFill(uncoveredTokens, chunkTokens)` pure clamped ratio `[0..1]`
 * - `createCoverageRing(host, { onExtract })` top-bar donut + detail popover
 * - `createCoverageMenuBlock(host, { onExtract })` session context-menu block
 */
import { button, createLife, documentOf, el, injectUiStyles, setOff, show, textNode, writeText } from 'cloudcanvas-lib/ui';
import { formatTokens } from 'peer-engine';
import { createRingProgress } from 'peer-kit';
import { injectSidebarStyles } from './sidebar.css.js';

function setDisabled(btn, off) {
  const flag = Boolean(off);
  btn.disabled = flag;
  setOff(btn, flag);
}

export function timeAgo(iso, now = new Date()) {
  if (!iso) return '—';
  const parsed = new Date(iso).getTime();
  if (!Number.isFinite(parsed)) return '—';
  const ms = now.getTime() - parsed;
  if (ms < 60_000) return 'just now';
  const min = Math.floor(ms / 60_000);
  if (min < 60) return `${min}m ago`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  const date = new Date(parsed);
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${mm}-${dd}`;
}

export function ringFill(uncoveredTokens, chunkTokens) {
  return chunkTokens > 0 ? Math.min(1, Math.max(0, uncoveredTokens / chunkTokens)) : 0;
}

function buildKvRow(doc, labelText, rowTestId) {
  const row = el(doc, 'div', {
    className: 'peer-coverage-row',
    attrs: rowTestId ? { 'data-testid': rowTestId } : undefined
  });
  row.append(el(doc, 'span', { text: labelText }));
  const valSpan = el(doc, 'span', { className: 'peer-coverage-val' });
  const valText = textNode(doc, valSpan, '');
  row.append(valSpan);
  return { row, valText };
}

function buildPopoverDom(doc, life, onExtractClick) {
  const popover = el(doc, 'div', {
    className: 'peer-coverage-popover',
    attrs: { 'data-testid': 'coverage-popover', role: 'dialog', 'aria-label': 'Extraction coverage', hidden: true }
  });
  const title = el(doc, 'div', { className: 'peer-sidebar-section-label', text: 'Extraction coverage' });
  const uncovered = buildKvRow(doc, 'Uncovered');
  const covered = buildKvRow(doc, 'Covered');
  const messages = buildKvRow(doc, 'Messages');
  const threshold = buildKvRow(doc, 'Chunk threshold');
  const lastFold = buildKvRow(doc, 'Last extraction');
  const runningRow = buildKvRow(doc, 'Status', 'coverage-ring-running');
  writeText(runningRow.valText, 'extracting…');
  runningRow.row.hidden = true;
  const extractBtn = button(doc, {
    className: 'peer-ctx-extract-btn',
    label: 'Extract',
    signal: life.signal,
    onClick: onExtractClick,
    attrs: { 'data-testid': 'coverage-extract' }
  });
  popover.append(
    title, uncovered.row, covered.row, messages.row, threshold.row, lastFold.row, runningRow.row, extractBtn
  );
  return { popover, uncovered, covered, messages, threshold, lastFold, runningRow, extractBtn };
}

function syncCoveragePopover(popDom, coverage, chunkTokens) {
  writeText(popDom.uncovered.valText, `${formatTokens(Number(coverage.uncoveredTokens) || 0)} tokens`);
  writeText(popDom.covered.valText, `${formatTokens(Number(coverage.coveredTokens) || 0)} tokens`);
  writeText(popDom.messages.valText, `${Number(coverage.coveredCount) || 0} / ${Number(coverage.totalMessages) || 0}`);
  writeText(popDom.threshold.valText, `${formatTokens(chunkTokens)} tokens`);
  writeText(popDom.lastFold.valText, coverage.lastFoldedAt ? timeAgo(coverage.lastFoldedAt) : '—');
  const isRunning = Boolean(coverage.running);
  const complete = (Number(coverage.uncoveredTokens) || 0) === 0 && (Number(coverage.uncoveredCount) || 0) === 0;
  show(popDom.runningRow.row, isRunning);
  setDisabled(popDom.extractBtn, isRunning || complete);
  popDom.extractBtn.textContent = isRunning ? 'Running' : 'Extract';
}

function syncOpenFlag(state) {
  state.popDom.popover.hidden = !state.open;
  state.ring.root.setAttribute('aria-expanded', String(state.open));
  if (!state.open) {
    state.openLife?.destroy();
    state.openLife = null;
  }
}

function bindPopoverDismiss(state, doc, root) {
  state.openLife?.destroy();
  state.openLife = null;
  if (!state.open) return;
  const openLife = createLife();
  state.openLife = openLife;
  openLife.on(doc, 'pointerdown', (event) => {
    if (root.contains(event.target)) return;
    state.open = false;
    syncOpenFlag(state);
  });
  const win = doc.defaultView;
  if (!win || typeof win.addEventListener !== 'function') return;
  openLife.on(win, 'keydown', (event) => {
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    event.preventDefault();
    event.stopPropagation();
    state.open = false;
    syncOpenFlag(state);
  });
}

function applyCoverageRingUpdate(state, root, model = {}) {
  if (state.life.dead) return;
  const graphEnabled = Boolean(model?.graphEnabled ?? model?.enabled);
  const coverage = model?.coverage ?? null;
  state.chatId = model?.chatId ?? null;
  if (!graphEnabled || !coverage) {
    state.open = false;
    syncOpenFlag(state);
    state.ring.root.removeAttribute('data-peer-running');
    state.ring.update({ hidden: true, value: 0 });
    root.hidden = true;
    return;
  }
  const chunkTokens = Number(model.chunkTokens) > 0 ? Number(model.chunkTokens) : 4096;
  const fill = ringFill(Number(coverage.uncoveredTokens) || 0, chunkTokens);
  const hint = "How much of this session isn't mapped yet";
  root.hidden = false;
  if (coverage.running) state.ring.root.setAttribute('data-peer-running', 'true');
  else state.ring.root.removeAttribute('data-peer-running');
  state.ring.update({ hidden: false, value: fill, label: hint, title: hint });
  state.ring.root.setAttribute('aria-expanded', String(state.open));
  syncCoveragePopover(state.popDom, coverage, chunkTokens);
}

export function createCoverageRing(host, { onExtract } = {}) {
  const doc = documentOf(host);
  injectUiStyles(doc);
  injectSidebarStyles(doc);
  const life = createLife();
  const root = el(doc, 'div', { className: 'peer-coverage-root', attrs: { hidden: true } });
  const state = { life, open: false, openLife: null, chatId: null, ring: null, popDom: null };
  const togglePopover = () => {
    state.open = !state.open;
    syncOpenFlag(state);
    bindPopoverDismiss(state, doc, root);
  };
  state.ring = createRingProgress(root, { onClick: togglePopover, size: 18, strokeWidth: 2.5 });
  state.ring.root.setAttribute('data-testid', 'coverage-ring');
  state.ring.root.setAttribute('aria-expanded', 'false');
  state.popDom = buildPopoverDom(doc, life, () => {
    if (state.chatId) onExtract?.(state.chatId);
  });
  root.append(state.popDom.popover);
  host.append(root);
  const destroy = () => {
    if (!life.destroy()) return;
    state.openLife?.destroy();
    state.ring.destroy();
    root.remove();
  };
  return { update: (model) => applyCoverageRingUpdate(state, root, model), destroy };
}

function buildMenuBlockDom(doc, life, onExtract) {
  const root = el(doc, 'div', { className: 'peer-ctx-coverage', attrs: { hidden: true } });
  const runningEl = el(doc, 'span', { attrs: { 'data-testid': 'ctx-coverage-running', hidden: true } });
  textNode(doc, runningEl, 'extracting…');
  const completeEl = el(doc, 'span', { text: 'fully extracted', attrs: { hidden: true } });
  const statsWrap = el(doc, 'span', { className: 'peer-sidebar-row-body', attrs: { hidden: true } });
  const tokLine = el(doc, 'span', { className: 'peer-coverage-val' });
  const tokText = textNode(doc, tokLine, '');
  const msgLine = el(doc, 'span', { className: 'peer-sidebar-meta' });
  const msgText = textNode(doc, msgLine, '');
  statsWrap.append(tokLine, msgLine);
  const extractBtn = button(doc, {
    className: 'peer-ctx-extract-btn',
    label: 'Extract',
    signal: life.signal,
    onClick: () => onExtract?.(),
    attrs: { 'data-testid': 'ctx-extract' }
  });
  root.append(runningEl, completeEl, statsWrap, extractBtn);
  return { root, runningEl, completeEl, statsWrap, tokText, msgText, extractBtn };
}

export function createCoverageMenuBlock(host, { onExtract } = {}) {
  const doc = documentOf(host);
  injectUiStyles(doc);
  injectSidebarStyles(doc);
  const life = createLife();
  const dom = buildMenuBlockDom(doc, life, onExtract);
  host.append(dom.root);

  const update = (model = {}) => {
    if (life.dead) return;
    const coverage = model?.coverage ?? null;
    if (!coverage) {
      dom.root.hidden = true;
      dom.root.removeAttribute('data-testid');
      return;
    }
    dom.root.hidden = false;
    dom.root.setAttribute('data-testid', 'ctx-coverage');
    const busy = Boolean(coverage.running || model?.extracting);
    const uncoveredTokens = Number(coverage.uncoveredTokens) || 0;
    const uncoveredCount = Number(coverage.uncoveredCount) || 0;
    const complete = uncoveredTokens === 0 && uncoveredCount === 0;
    show(dom.runningEl, busy);
    show(dom.completeEl, !busy && complete);
    show(dom.statsWrap, !busy && !complete);
    if (!busy && !complete) {
      writeText(dom.tokText, `${formatTokens(uncoveredTokens)} tok uncovered`);
      writeText(dom.msgText, `${uncoveredCount} message${uncoveredCount === 1 ? '' : 's'} unextracted`);
    }
    setDisabled(dom.extractBtn, busy || complete);
    dom.extractBtn.textContent = busy ? 'Running' : 'Extract';
  };

  return { update, destroy: () => { if (life.destroy()) dom.root.remove(); } };
}
