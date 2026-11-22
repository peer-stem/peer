/**
 * Session & folder deletion confirmation modal (`components/delete-session-dialog.tsx` parity).
 * Exports `TRACES_COPY`, `SESSION_DELETE_COPY`, `folderDeleteCopy`, and
 * `createDeleteSessionDialog(host, { onClose, onConfirm })`.
 */
import { button, createLife, documentOf, el, injectUiStyles, setOff, show, textNode, writeText } from 'cloudcanvas-lib/ui';
import { injectShellStyles } from '../shell/shell.css.js';
import { injectSidebarStyles } from './sidebar.css.js';

export const TRACES_COPY = Object.freeze({
  testid: 'delete-traces',
  checkbox: 'delete-traces-checkbox',
  title: 'Also remove its graph traces',
  body: 'This session’s topics, links, and events leave the graph too. Topics other sessions or imported notes also cover survive; topics only this session created are removed entirely.'
});

export const SESSION_DELETE_COPY = Object.freeze({
  label: 'Delete session',
  testid: 'delete-session-dialog',
  heading: 'Delete session?',
  body: 'This permanently removes the session — its messages, background jobs, and extraction records. Everything it added to the graph stays unless you check below. This cannot be undone.',
  traces: TRACES_COPY
});

function countNoun(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

function setDisabled(btn, off) {
  const flag = Boolean(off);
  btn.disabled = flag;
  setOff(btn, flag);
}

export function folderDeleteCopy(input) {
  const sessions = Number(input?.sessions) || 0;
  const subfolders = Number(input?.subfolders) || 0;
  const notes = Number(input?.notes) || 0;
  const parentName = input?.parentName ?? null;
  const whatParts = [countNoun(sessions, 'session', 'sessions')];
  if (subfolders > 0) whatParts.push(countNoun(subfolders, 'subfolder', 'subfolders'));
  const dest = parentName === null ? 'the top level' : `“${parentName}”`;
  const notesClause = notes > 0
    ? ` ${countNoun(notes, 'imported notes file', 'imported notes files')} inside ${notes === 1 ? 'moves' : 'move'} to ${dest}.`
    : '';
  return {
    label: 'Delete folder',
    testid: 'delete-folder-dialog',
    heading: 'Delete folder?',
    body: `This permanently removes the folder and the ${whatParts.join(' and ')} inside — the sessions’ messages, background jobs, and extraction records. Everything they added to the graph stays unless you check below.${notesClause} This cannot be undone.`,
    traces: {
      title: 'Also remove their graph traces',
      body: 'These sessions’ topics, links, and events leave the graph too. Topics other sessions or imported notes also cover survive; topics only these sessions created are removed entirely.'
    }
  };
}

function normalizeDeleteFailure(err) {
  if (!err) return null;
  if (typeof err === 'object' && ('error' in err || 'message' in err)) {
    return {
      code: String(err.code ?? 'error'),
      error: String(err.error ?? err.message ?? 'Delete failed.')
    };
  }
  return { code: 'error', error: String(err) };
}

function buildTracesRow(doc, life, onToggleTraces) {
  const tracesLabel = el(doc, 'label', {
    className: 'peer-delete-traces-label',
    attrs: { 'data-testid': TRACES_COPY.testid }
  });
  const checkbox = el(doc, 'input', {
    attrs: { type: 'checkbox', 'data-testid': TRACES_COPY.checkbox }
  });
  life.on(checkbox, 'change', () => onToggleTraces(checkbox.checked));
  const copyWrap = el(doc, 'span', { className: 'peer-sidebar-row-body' });
  const titleEl = el(doc, 'span');
  const tracesTitleText = textNode(doc, titleEl, '');
  const bodyEl = el(doc, 'span', { className: 'peer-sidebar-meta' });
  const tracesBodyText = textNode(doc, bodyEl, '');
  copyWrap.append(titleEl, bodyEl);
  tracesLabel.append(checkbox, copyWrap);
  return { tracesLabel, checkbox, tracesTitleText, tracesBodyText };
}

function buildFailureAndActions(doc, life, handlers) {
  const failureEl = el(doc, 'div', {
    className: 'peer-delete-failure',
    attrs: { role: 'alert', 'data-testid': 'delete-failure', hidden: true }
  });
  const failureSpan = el(doc, 'span');
  const failureText = textNode(doc, failureSpan, '');
  const retryBtn = button(doc, {
    label: 'Try again',
    signal: life.signal,
    onClick: handlers.onConfirm,
    attrs: { 'data-testid': 'delete-retry' }
  });
  failureEl.append(failureSpan, retryBtn);

  const actions = el(doc, 'div', { className: 'peer-delete-actions' });
  const cancelBtn = button(doc, {
    label: 'Cancel',
    signal: life.signal,
    onClick: handlers.onCancel,
    attrs: { 'data-testid': 'delete-cancel' }
  });
  const confirmBtn = button(doc, {
    className: 'peer-delete-confirm-btn',
    label: 'Delete',
    signal: life.signal,
    onClick: handlers.onConfirm,
    attrs: { 'data-testid': 'delete-confirm' }
  });
  actions.append(cancelBtn, confirmBtn);
  return { failureEl, failureText, retryBtn, actions, cancelBtn, confirmBtn };
}

function buildDialogNodes(doc, life, handlers) {
  const backdrop = el(doc, 'div', { className: 'peer-shell-backdrop peer-delete-dialog-backdrop' });
  const dialog = el(doc, 'div', {
    className: 'peer-shell-modal peer-delete-dialog',
    attrs: { role: 'dialog', 'aria-modal': 'true', tabindex: '-1' }
  });
  const headingEl = el(doc, 'h2', { className: 'peer-delete-dialog-title' });
  const headingText = textNode(doc, headingEl, '');
  const codeWrap = el(doc, 'div');
  const nameCode = el(doc, 'code', {
    className: 'peer-delete-name-code',
    attrs: { 'data-testid': 'session-name-code' }
  });
  const nameText = textNode(doc, nameCode, '');
  codeWrap.append(nameCode);
  const bodyEl = el(doc, 'p', { className: 'peer-sidebar-meta' });
  const bodyText = textNode(doc, bodyEl, '');
  const tracesUi = buildTracesRow(doc, life, handlers.onToggleTraces);
  const footerUi = buildFailureAndActions(doc, life, handlers);
  dialog.append(headingEl, codeWrap, bodyEl, tracesUi.tracesLabel, footerUi.failureEl, footerUi.actions);
  backdrop.append(dialog);
  life.on(backdrop, 'click', (event) => {
    if (event.target === backdrop) handlers.onCancel();
  });
  return { backdrop, dialog, headingText, nameText, bodyText, ...tracesUi, ...footerUi };
}

function bindDialogEscape(state, doc, onCancel) {
  state.openLife?.destroy();
  state.openLife = null;
  const win = doc.defaultView;
  if (!win || typeof win.addEventListener !== 'function') return;
  const openLife = createLife();
  state.openLife = openLife;
  openLife.on(win, 'keydown', (event) => {
    if (event.key !== 'Escape' || event.defaultPrevented || state.busy) return;
    event.preventDefault();
    onCancel();
  });
}

function syncDeleteDialogDom(host, doc, state, onCancel) {
  const { model, dom, traces, busy, failure } = state;
  if (!model) {
    state.openLife?.destroy();
    state.openLife = null;
    dom.backdrop.remove();
    return;
  }
  const kind = model.kind === 'folder' ? 'folder' : 'session';
  const fallbackCopy = kind === 'folder'
    ? folderDeleteCopy({ sessions: 0, subfolders: 0, notes: 0, parentName: null })
    : SESSION_DELETE_COPY;
  const copy = model.copy ?? fallbackCopy;
  dom.dialog.setAttribute('aria-label', copy.label);
  dom.dialog.setAttribute('data-testid', copy.testid || (kind === 'folder' ? 'delete-folder-dialog' : 'delete-session-dialog'));
  writeText(dom.headingText, copy.heading);
  writeText(dom.nameText, String(model.title ?? ''));
  writeText(dom.bodyText, copy.body);
  writeText(dom.tracesTitleText, copy.traces.title);
  writeText(dom.tracesBodyText, copy.traces.body);
  dom.checkbox.checked = Boolean(traces);
  dom.checkbox.disabled = busy;
  show(dom.failureEl, Boolean(failure));
  writeText(dom.failureText, failure ? failure.error : '');
  setDisabled(dom.retryBtn, busy);
  setDisabled(dom.cancelBtn, busy);
  setDisabled(dom.confirmBtn, busy);
  dom.confirmBtn.textContent = busy ? 'Deleting…' : 'Delete';
  if (!dom.backdrop.isConnected) {
    host.append(dom.backdrop);
    bindDialogEscape(state, doc, onCancel);
  }
}

async function runDeleteConfirm(host, doc, state, onConfirm, handleCancel) {
  if (!state.model || state.busy) return;
  const kind = state.model.kind === 'folder' ? 'folder' : 'session';
  const mode = state.traces ? 'delete-nodes' : 'preserve-graph';
  state.busy = true;
  state.failure = null;
  syncDeleteDialogDom(host, doc, state, handleCancel);
  try {
    await onConfirm?.({ kind, id: state.model.id, mode });
    if (state.life.dead) return;
    state.busy = false;
    syncDeleteDialogDom(host, doc, state, handleCancel);
  } catch (err) {
    if (state.life.dead) return;
    state.busy = false;
    state.failure = normalizeDeleteFailure(err);
    syncDeleteDialogDom(host, doc, state, handleCancel);
  }
}

function applyDeleteDialogUpdate(host, doc, state, handleCancel, model = null) {
  if (state.life.dead) return;
  if (!model || typeof model !== 'object' || !model.id) {
    Object.assign(state, { model: null, targetKey: null, traces: false, busy: false, failure: null });
    syncDeleteDialogDom(host, doc, state, handleCancel);
    return;
  }
  const nextKey = `${model.kind ?? 'session'}:${model.id}`;
  if (nextKey !== state.targetKey) {
    state.targetKey = nextKey;
    state.traces = typeof model.traces === 'boolean' ? model.traces : false;
    state.busy = false;
    state.failure = null;
  }
  state.model = model;
  if (typeof model.traces === 'boolean') state.traces = model.traces;
  if (typeof model.busy === 'boolean') state.busy = model.busy;
  if (model.failure !== undefined) state.failure = normalizeDeleteFailure(model.failure);
  syncDeleteDialogDom(host, doc, state, handleCancel);
}

export function createDeleteSessionDialog(host, { onClose, onConfirm } = {}) {
  const doc = documentOf(host);
  injectUiStyles(doc);
  injectShellStyles(doc);
  injectSidebarStyles(doc);
  const life = createLife();
  const state = {
    life, openLife: null, dom: null, model: null, targetKey: null,
    traces: false, busy: false, failure: null
  };
  const handleCancel = () => { if (!state.busy) onClose?.(); };
  state.dom = buildDialogNodes(doc, life, {
    onToggleTraces: (checked) => { state.traces = checked; },
    onCancel: handleCancel,
    onConfirm: () => { void runDeleteConfirm(host, doc, state, onConfirm, handleCancel); }
  });
  const destroy = () => {
    if (!life.destroy()) return;
    state.openLife?.destroy();
    state.dom.backdrop.remove();
  };
  return {
    update: (model) => applyDeleteDialogUpdate(host, doc, state, handleCancel, model),
    destroy
  };
}
