/**
 * Prompt segment modal (`v0.7.0` parity, `[data-testid="prompt-segment-dialog"]`).
 * Uses `createModal` + `createKitMarkdown` from `'peer-kit'`, supports `"View default"`,
 * `"Add override"`, and `"Edit override"` modes, Markdown vs Preview toggle, dirty-close
 * discard guard, Save & activate, and Delete override.
 */
import { button, createLife, documentOf, el, setOff, show, textNode, writeText } from 'cloudcanvas-lib/ui';
import { createKitMarkdown, createModal } from 'peer-kit';

function resolveModalTitle(mode, savedText) {
  if (mode !== 'edit') return 'View default';
  return savedText === null || savedText === undefined ? 'Add override' : 'Edit override';
}

function buildDiscardAndFooterBars(doc, life, handlers) {
  const discardBar = el(doc, 'div', {
    className: 'peer-settings-row',
    attrs: { 'data-testid': 'prompt-discard-guard', hidden: true }
  });
  const discardActions = el(doc, 'div', { className: 'peer-settings-controls' });
  discardActions.append(
    button(doc, { label: 'Keep editing', signal: life.signal, onClick: handlers.onKeepEditing, attrs: { 'data-testid': 'prompt-keep-editing' } }),
    button(doc, { className: 'peer-graph-danger-btn', label: 'Discard changes', signal: life.signal, onClick: handlers.onForceClose, attrs: { 'data-testid': 'prompt-discard-confirm' } })
  );
  discardBar.append(el(doc, 'span', { role: 'status', text: 'Discard unsaved changes?' }), discardActions);
  const footer = el(doc, 'div', { className: 'peer-settings-row' });
  const deleteBtn = button(doc, {
    className: 'peer-graph-danger-btn', label: 'Delete override', signal: life.signal,
    onClick: handlers.onDelete, attrs: { 'data-testid': 'prompt-dialog-delete', hidden: true }
  });
  const rightActions = el(doc, 'div', { className: 'peer-settings-controls' });
  const closeBtn = button(doc, { label: 'Close', signal: life.signal, onClick: handlers.onRequestClose, attrs: { 'data-testid': 'prompt-dialog-close' } });
  const saveBtn = button(doc, {
    className: 'is-primary', label: 'Save and activate', signal: life.signal,
    onClick: handlers.onSave, attrs: { 'data-testid': 'prompt-dialog-save', hidden: true }
  });
  rightActions.append(closeBtn, saveBtn);
  footer.append(deleteBtn, rightActions);
  return { discardBar, footer, deleteBtn, closeBtn, saveBtn };
}

function buildDialogContent(doc, life, handlers) {
  const wrap = el(doc, 'div', { className: 'peer-prompt-dialog', attrs: { 'data-testid': 'prompt-segment-dialog' } });
  const topRow = el(doc, 'div', { className: 'peer-settings-row' });
  const nameEl = el(doc, 'p', { className: 'peer-settings-hint', attrs: { 'data-testid': 'prompt-segment-name' } });
  const nameText = textNode(doc, nameEl, '');
  const seg = el(doc, 'div', { className: 'peer-settings-segmented', attrs: { role: 'group', 'aria-label': 'Prompt display' } });
  const mdBtn = button(doc, { label: 'Markdown', signal: life.signal, onClick: () => handlers.onSetPreview(false), attrs: { 'data-testid': 'prompt-display-markdown', 'aria-pressed': 'false' } });
  const previewBtn = button(doc, { label: 'Preview', signal: life.signal, onClick: () => handlers.onSetPreview(true), attrs: { 'data-testid': 'prompt-display-preview', 'aria-pressed': 'true' } });
  seg.append(mdBtn, previewBtn);
  topRow.append(nameEl, seg);
  const area = el(doc, 'textarea', { className: 'peer-settings-textarea', attrs: { rows: '12', 'data-testid': 'prompt-segment-textarea', 'aria-label': 'Default Markdown' } });
  life.on(area, 'input', () => handlers.onInput(area.value));
  const previewHost = el(doc, 'div', {
    className: 'peer-prompt-dialog-preview',
    attrs: { tabindex: '0', 'aria-label': 'Rendered Markdown', 'data-testid': 'prompt-segment-preview', hidden: true }
  });
  const mdControl = createKitMarkdown(previewHost);
  const errEl = el(doc, 'p', { className: 'peer-settings-error', attrs: { role: 'alert', 'data-testid': 'prompt-segment-error', hidden: true } });
  const errText = textNode(doc, errEl, '');
  const bars = buildDiscardAndFooterBars(doc, life, handlers);
  wrap.append(topRow, area, previewHost, errEl, bars.discardBar, bars.footer);
  return { wrap, nameText, mdBtn, previewBtn, area, previewHost, mdControl, errEl, errText, ...bars };
}

function isDraftDirty(state) {
  if (state.mode !== 'edit') return false;
  const baseline = state.savedText ?? state.sourceText;
  return state.draftText !== baseline;
}

function syncPromptDialog(state) {
  const { dom, open, mode, name, draftText, savedText, preview, busy, error, confirmDiscard } = state;
  if (!open) {
    state.modal.update({ open: false });
    return;
  }
  const editing = mode === 'edit';
  const dirty = isDraftDirty(state);
  writeText(dom.nameText, name);
  dom.mdBtn.setAttribute('aria-pressed', String(!preview));
  dom.previewBtn.setAttribute('aria-pressed', String(preview));
  setOff(dom.mdBtn, confirmDiscard);
  setOff(dom.previewBtn, confirmDiscard);

  show(dom.area, !preview);
  show(dom.previewHost, preview);
  dom.area.readOnly = !editing || Boolean(busy) || confirmDiscard;
  dom.area.setAttribute('aria-label', editing ? 'Override Markdown' : 'Default Markdown');
  if (dom.area.value !== draftText) dom.area.value = draftText;
  if (preview) dom.mdControl.update({ source: draftText, displayOnly: true });

  show(dom.errEl, error !== '');
  writeText(dom.errText, error);
  show(dom.discardBar, confirmDiscard);
  show(dom.footer, !confirmDiscard);

  const hasSaved = savedText !== null && savedText !== undefined;
  show(dom.deleteBtn, editing && hasSaved);
  setOff(dom.deleteBtn, Boolean(busy) || dirty);
  dom.deleteBtn.textContent = busy === 'delete' ? 'Deleting…' : 'Delete override';

  show(dom.saveBtn, editing);
  setOff(dom.saveBtn, Boolean(busy) || !dirty);
  dom.saveBtn.textContent = busy === 'save' ? 'Saving…' : 'Save and activate';
  setOff(dom.closeBtn, Boolean(busy));

  state.modal.update({
    open: true,
    title: resolveModalTitle(mode, savedText),
    closeButton: false,
    dismissible: !busy,
    content: dom.wrap
  });
}

async function executeDialogMutation(state, kind, fn, fallbackMsg, onClose) {
  state.busy = kind;
  state.error = '';
  syncPromptDialog(state);
  try {
    await fn();
    if (state.life.dead) return;
    state.busy = null;
    if (kind === 'save') state.savedText = state.draftText;
    onClose?.();
  } catch (err) {
    if (state.life.dead) return;
    state.busy = null;
    state.error = err instanceof Error ? err.message : fallbackMsg;
    syncPromptDialog(state);
  }
}

function applyPromptDialogModel(state, model) {
  if (state.life.dead) return;
  if (!model || !model.open) {
    state.open = false;
    state.confirmDiscard = false;
    syncPromptDialog(state);
    return;
  }
  const sessionKey = `${model.path ?? ''}:${model.mode ?? 'view'}`;
  if (!state.open || sessionKey !== state.sessionKey) {
    state.sessionKey = sessionKey;
    state.path = String(model.path ?? '');
    state.name = String(model.name ?? state.path);
    state.mode = model.mode === 'edit' ? 'edit' : 'view';
    state.sourceText = String(model.sourceText ?? '');
    state.savedText = model.overrideText ?? null;
    state.draftText = state.mode === 'edit' ? (state.savedText ?? state.sourceText) : state.sourceText;
    state.preview = state.mode !== 'edit';
    state.busy = null;
    state.error = '';
    state.confirmDiscard = false;
  }
  state.open = true;
  syncPromptDialog(state);
}

export function createPromptSegmentDialog(host, { onSave, onDelete, onClose } = {}) {
  const doc = documentOf(host);
  const life = createLife();
  const state = {
    life, modal: null, dom: null, open: false, sessionKey: '', path: '', name: '',
    mode: 'view', sourceText: '', savedText: null, draftText: '',
    preview: true, busy: null, error: '', confirmDiscard: false
  };
  const requestClose = () => {
    if (state.busy) return;
    if (state.confirmDiscard) { state.confirmDiscard = false; syncPromptDialog(state); return; }
    if (isDraftDirty(state)) { state.confirmDiscard = true; syncPromptDialog(state); return; }
    onClose?.();
  };
  state.modal = createModal(host, { onClose: requestClose });
  state.dom = buildDialogContent(doc, life, {
    onSetPreview: (val) => { state.preview = val; syncPromptDialog(state); },
    onInput: (val) => { state.draftText = val; syncPromptDialog(state); },
    onKeepEditing: () => { state.confirmDiscard = false; syncPromptDialog(state); },
    onForceClose: () => { state.confirmDiscard = false; onClose?.(); },
    onRequestClose: requestClose,
    onSave: () => {
      if (!state.busy && isDraftDirty(state)) {
        void executeDialogMutation(state, 'save', () => onSave?.(state.path, state.draftText), "Couldn't save the override. Your edits are still here.", onClose);
      }
    },
    onDelete: () => {
      if (!state.busy && state.savedText !== null && !isDraftDirty(state)) {
        void executeDialogMutation(state, 'delete', () => onDelete?.(state.path), "Couldn't delete the override.", onClose);
      }
    }
  });
  return {
    update: (model = null) => applyPromptDialogModel(state, model),
    destroy: () => { if (life.destroy()) { state.dom.mdControl.destroy(); state.modal.destroy(); } }
  };
}
