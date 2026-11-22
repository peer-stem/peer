/**
 * Source & folder deletion confirmation dialog (`v0.7.0` parity, `[data-testid="delete-source-dialog"]`).
 * Uses `createModal` from `'peer-kit'` and exposes optional `deleteSessions` checkbox.
 */
import { button, createLife, documentOf, el, injectUiStyles, setOff, show, textNode, writeText } from 'cloudcanvas-lib/ui';
import { createModal } from 'peer-kit';
import { injectGraphStyles } from './graph.css.js';

function formatSummaryNames(sources, folders) {
  const names = [
    ...sources.map((s) => String(s.label ?? s.id)),
    ...folders.map((f) => String(f.name ?? f.id))
  ];
  const head = names.slice(0, 8).join(', ');
  return names.length > 8 ? `${head}, and ${names.length - 8} more` : head;
}

function buildSessionsToggleRow(doc, life, onToggleSessions) {
  const sessionsLabel = el(doc, 'label', { className: 'peer-graph-prop-row', attrs: { hidden: true } });
  const sessionsBox = el(doc, 'input', { attrs: { type: 'checkbox', 'data-testid': 'delete-source-sessions' } });
  sessionsBox.addEventListener('change', () => onToggleSessions(sessionsBox.checked), { signal: life.signal });
  const sessionsCopy = el(doc, 'span');
  const sessionsTitle = el(doc, 'strong');
  const sessionsTitleText = textNode(doc, sessionsTitle, '');
  sessionsCopy.append(
    sessionsTitle,
    el(doc, 'span', { text: ' — Also permanently deletes conversation messages and background jobs.' })
  );
  sessionsLabel.append(sessionsBox, sessionsCopy);
  return { sessionsLabel, sessionsBox, sessionsTitleText };
}

function buildDeleteSourceDom(doc, life, handlers) {
  const wrap = el(doc, 'div', {
    className: 'peer-graph-confirm-dialog',
    attrs: { 'data-testid': 'delete-source-dialog' }
  });
  const namesEl = el(doc, 'p', { attrs: { 'data-testid': 'source-deletion-names' } });
  const namesText = textNode(doc, namesEl, '');
  const contribEl = el(doc, 'p', {
    className: 'peer-graph-import-notice',
    text: 'Removes these sources’ contributions to propositions and reasoning chains. Knowledge supported by other sources survives; knowledge supported only by these sources is removed.',
    attrs: { 'data-testid': 'source-deletion-contributions', hidden: true }
  });
  const noteEl = el(doc, 'p', {
    className: 'peer-graph-import-notice',
    text: 'Imported source records are removed, but original files on disk are never changed. Selected folders are removed only when empty; folders needed by kept sessions remain.'
  });
  const sessionsUi = buildSessionsToggleRow(doc, life, handlers.onToggleSessions);
  const failureEl = el(doc, 'p', {
    className: 'peer-graph-import-error',
    attrs: { role: 'alert', 'data-testid': 'source-delete-failure', hidden: true }
  });
  const failureText = textNode(doc, failureEl, '');
  const actions = el(doc, 'div', { className: 'peer-graph-confirm-actions' });
  const cancelBtn = button(doc, {
    label: 'Cancel', signal: life.signal, onClick: handlers.onCancel, attrs: { 'data-testid': 'source-delete-cancel' }
  });
  const confirmBtn = button(doc, {
    className: 'peer-graph-danger-btn', label: 'Delete', signal: life.signal,
    onClick: handlers.onConfirm, attrs: { 'data-testid': 'source-delete-confirm' }
  });
  actions.append(cancelBtn, confirmBtn);
  wrap.append(namesEl, contribEl, noteEl, sessionsUi.sessionsLabel, failureEl, actions);
  return { wrap, namesText, contribEl, ...sessionsUi, failureEl, failureText, cancelBtn, confirmBtn };
}

function syncDeleteSourceDom(state) {
  const { open, sources, folders, deleteSessions, busy, failure, dom } = state;
  if (!open || (sources.length === 0 && folders.length === 0)) {
    state.modal.update({ open: false });
    return;
  }
  const chats = sources.filter((s) => s.kind === 'chat');
  writeText(dom.namesText, formatSummaryNames(sources, folders));
  show(dom.contribEl, sources.length > 0);
  show(dom.sessionsLabel, chats.length > 0);
  dom.sessionsBox.checked = Boolean(deleteSessions);
  dom.sessionsBox.disabled = busy;
  writeText(dom.sessionsTitleText, `Also delete the ${chats.length} selected ${chats.length === 1 ? 'session' : 'sessions'}`);
  show(dom.failureEl, failure !== '');
  writeText(dom.failureText, failure);
  setOff(dom.cancelBtn, busy);
  setOff(dom.confirmBtn, busy);
  dom.confirmBtn.textContent = busy ? 'Deleting…' : (failure ? 'Try again' : 'Delete');
  state.modal.update({
    open: true,
    title: 'Delete selected sources and folders?',
    closeButton: false,
    dismissible: !busy,
    content: dom.wrap
  });
}

async function executeSourceDeletion(state, onConfirm, onClose) {
  if (state.busy) return;
  state.busy = true;
  state.failure = '';
  syncDeleteSourceDom(state);
  const chatsExist = state.sources.some((s) => s.kind === 'chat');
  const payload = {
    sourceIds: state.sources.map((s) => s.id),
    folderIds: state.folders.map((f) => f.id),
    deleteSessions: chatsExist ? Boolean(state.deleteSessions) : false
  };
  try {
    await onConfirm?.(payload);
    if (state.life.dead) return;
    state.busy = false;
    onClose?.();
  } catch (err) {
    if (state.life.dead) return;
    state.busy = false;
    state.failure = err instanceof Error ? err.message : String(err ?? 'Delete failed.');
    syncDeleteSourceDom(state);
  }
}

export function createDeleteSourceDialog(host, { onConfirm, onClose } = {}) {
  const doc = documentOf(host);
  injectUiStyles(doc);
  injectGraphStyles(doc);
  const life = createLife();
  const state = {
    life, modal: null, dom: null, open: false,
    sources: [], folders: [], deleteSessions: false, busy: false, failure: ''
  };
  const closeNow = () => { if (!state.busy) onClose?.(); };
  state.modal = createModal(host, { onClose: closeNow });
  state.dom = buildDeleteSourceDom(doc, life, {
    onToggleSessions: (checked) => { state.deleteSessions = checked; syncDeleteSourceDom(state); },
    onCancel: closeNow,
    onConfirm: () => { void executeSourceDeletion(state, onConfirm, onClose); }
  });

  const update = (model = {}) => {
    if (life.dead) return;
    const nextOpen = Boolean(model?.open);
    if (!nextOpen && state.open) {
      state.deleteSessions = false;
      state.busy = false;
      state.failure = '';
    }
    state.open = nextOpen;
    state.sources = Array.isArray(model?.sources) ? model.sources : [];
    state.folders = Array.isArray(model?.folders) ? model.folders : [];
    if (typeof model?.deleteSessions === 'boolean') state.deleteSessions = model.deleteSessions;
    syncDeleteSourceDom(state);
  };

  return { update, destroy: () => { if (life.destroy()) state.modal.destroy(); } };
}
