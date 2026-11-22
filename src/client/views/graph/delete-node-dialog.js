/**
 * Node deletion confirmation dialog (`v0.7.0` parity, `[data-testid="delete-node-dialog"]`).
 * Uses `createModal` from `'peer-kit'` and handles 409 `extraction_running` retry UI.
 */
import { button, createLife, documentOf, el, injectUiStyles, setOff, show, textNode, writeText } from 'cloudcanvas-lib/ui';
import { createModal } from 'peer-kit';
import { injectGraphStyles } from './graph.css.js';

export const EXTRACTION_RETRY_LINE = 'An extraction is running — try again when the activity dock drains.';

function formatDialogHeading(nodes, folders) {
  if (folders.length > 0) {
    return nodes.length > 0 ? 'Delete nodes and remove empty folders?' : 'Remove empty folders?';
  }
  return nodes.length === 1 ? 'Delete node?' : `Delete ${nodes.length} nodes?`;
}

function formatNodeNamesSummary(nodes) {
  if (nodes.length <= 1) return nodes[0]?.name ?? '';
  const head = nodes.slice(0, 8).map((n) => n.name).join(', ');
  return nodes.length > 8 ? `${head}, and ${nodes.length - 8} more` : head;
}

function normalizeFailure(err) {
  if (!err) return null;
  if (typeof err === 'object' && 'code' in err) {
    return { code: String(err.code ?? 'error'), error: String(err.error ?? err.message ?? 'Delete failed.') };
  }
  const msg = err instanceof Error ? err.message : String(err);
  const isExtraction = msg.includes('extraction_running') || msg.includes('409') || msg.toLowerCase().includes('extraction is running');
  return { code: isExtraction ? 'extraction_running' : 'error', error: msg };
}

function buildDeleteNodeDom(doc, life, onCancel, onConfirmClick) {
  const wrap = el(doc, 'div', {
    className: 'peer-graph-confirm-dialog',
    attrs: { 'data-testid': 'delete-node-dialog' }
  });
  const namesCode = el(doc, 'code', { attrs: { 'data-testid': 'node-name-code' } });
  const namesText = textNode(doc, namesCode, '');
  const foldersEl = el(doc, 'p', { attrs: { 'data-testid': 'folder-removal-names', hidden: true } });
  const foldersText = textNode(doc, foldersEl, '');
  const permEl = el(doc, 'p', { className: 'peer-graph-import-notice', attrs: { 'data-testid': 'node-permanence-line' } });
  const permText = textNode(doc, permEl, '');
  const explainEl = el(doc, 'p', { className: 'peer-graph-import-notice', attrs: { 'data-testid': 'folder-removal-explanation' } });
  const explainText = textNode(doc, explainEl, 'Sessions, imported source records, and non-empty folders are kept.');

  const failureBox = el(doc, 'div', { attrs: { role: 'alert', 'data-testid': 'node-delete-failure', hidden: true } });
  const failureText = textNode(doc, failureBox, '');
  const retryBtn = button(doc, {
    label: 'Try again',
    signal: life.signal,
    onClick: onConfirmClick,
    attrs: { 'data-testid': 'node-delete-retry' }
  });
  failureBox.append(retryBtn);

  const actions = el(doc, 'div', { className: 'peer-graph-confirm-actions' });
  const cancelBtn = button(doc, {
    label: 'Cancel',
    signal: life.signal,
    onClick: onCancel,
    attrs: { 'data-testid': 'node-delete-cancel' }
  });
  const confirmBtn = button(doc, {
    className: 'peer-graph-danger-btn',
    label: 'Delete',
    signal: life.signal,
    onClick: onConfirmClick,
    attrs: { 'data-testid': 'node-delete-confirm' }
  });
  actions.append(cancelBtn, confirmBtn);
  wrap.append(namesCode, foldersEl, permEl, explainEl, failureBox, actions);
  return {
    wrap, namesCode, namesText, foldersEl, foldersText, permEl, permText,
    explainText, failureBox, failureText, retryBtn, cancelBtn, confirmBtn
  };
}

function syncDeleteNodeDom(state) {
  const { nodes, folders, busy, failure, dom } = state;
  const open = nodes.length > 0 || folders.length > 0;
  if (!open) {
    state.modal.update({ open: false });
    return;
  }
  dom.namesCode.setAttribute('data-testid', nodes.length === 1 ? 'node-name-code' : 'node-names-code');
  writeText(dom.namesText, formatNodeNamesSummary(nodes));
  show(dom.foldersEl, folders.length > 0);
  writeText(dom.foldersText, folders.length > 0 ? `Empty folders: ${folders.map((f) => f.name).join(', ')}` : '');
  show(dom.permEl, nodes.length > 0);
  writeText(
    dom.permText,
    nodes.length === 1
      ? 'This permanently deletes the node — this cannot be undone.'
      : `This permanently deletes all ${nodes.length} nodes — this cannot be undone.`
  );
  writeText(
    dom.explainText,
    `${folders.length > 0 ? 'Only the named empty folders are removed. ' : ''}Sessions, imported source records, and non-empty folders are kept.`
  );
  show(dom.failureBox, Boolean(failure));
  if (failure) {
    writeText(dom.failureText, `${failure.code === 'extraction_running' ? EXTRACTION_RETRY_LINE : failure.error} `);
  }
  setOff(dom.cancelBtn, busy);
  setOff(dom.confirmBtn, busy);
  setOff(dom.retryBtn, busy);
  dom.confirmBtn.textContent = busy ? 'Deleting…' : 'Delete';
  state.modal.update({
    open: true,
    title: formatDialogHeading(nodes, folders),
    closeButton: false,
    dismissible: !busy,
    content: dom.wrap
  });
}

export function createDeleteNodeDialog(host, { onConfirm, onClose } = {}) {
  const doc = documentOf(host);
  injectUiStyles(doc);
  injectGraphStyles(doc);
  const life = createLife();
  const state = { life, modal: null, dom: null, nodes: [], folders: [], busy: false, failure: null };
  const closeNow = () => { if (!state.busy) onClose?.(); };

  const runConfirm = async () => {
    if (state.busy || (state.nodes.length === 0 && state.folders.length === 0)) return;
    state.busy = true;
    state.failure = null;
    syncDeleteNodeDom(state);
    try {
      await onConfirm?.({ nodes: state.nodes, folders: state.folders });
      if (life.dead) return;
      state.busy = false;
      onClose?.();
    } catch (err) {
      if (life.dead) return;
      state.busy = false;
      state.failure = normalizeFailure(err);
      syncDeleteNodeDom(state);
    }
  };

  state.modal = createModal(host, { onClose: closeNow });
  state.dom = buildDeleteNodeDom(doc, life, closeNow, () => { void runConfirm(); });

  const update = (model = {}) => {
    if (life.dead) return;
    state.nodes = Array.isArray(model?.nodes) ? model.nodes : [];
    state.folders = Array.isArray(model?.folders) ? model.folders : [];
    if (model?.failure !== undefined) state.failure = model.failure ? normalizeFailure(model.failure) : null;
    else if (state.nodes.length === 0 && state.folders.length === 0) state.failure = null;
    syncDeleteNodeDom(state);
  };

  const destroy = () => {
    if (!life.destroy()) return;
    state.modal.destroy();
  };

  return { update, destroy };
}
