/**
 * Keyboard shortcuts settings section (`views/settings/keyboard-section.js`).
 * Lists `KEYBOARD_ACTIONS`, captures live keybinds (`set-keybinding`), and resets (`reset-keybindings`).
 */
import { button, createLife, documentOf, el } from 'cloudcanvas-lib/ui';
import { KEYBOARD_ACTIONS, eventBinding, formatBinding } from 'peer-keyboard';

const KEY_SCOPES = Object.freeze([
  ['global', 'Global'],
  ['chat', 'Chat'],
  ['graph', 'Graph']
]);

const MODIFIER_ONLY_KEYS = /* @__PURE__ */ new Set(['Control', 'Meta', 'Alt', 'Shift']);

function appendRebindButtons(doc, controls, def, overrides, isRebinding, state) {
  if (def.displayOnly) return;
  const signal = state.life.signal;
  if (isRebinding) {
    controls.append(button(doc, {
      label: 'Cancel',
      signal,
      attrs: { 'data-peer-action': 'cancel-rebind' },
      onClick: () => state.stopCapture()
    }));
    return;
  }
  controls.append(button(doc, {
    label: 'Rebind',
    signal,
    attrs: {
      'data-peer-action': 'rebind-key',
      'data-peer-action-id': def.id,
      'data-testid': `kbd-rebind-${def.id}`
    },
    onClick: () => state.startCapture(def.id)
  }));
  if (overrides[def.id] === undefined) return;
  controls.append(button(doc, {
    label: 'Reset',
    signal,
    attrs: {
      'data-peer-action': 'reset-key',
      'data-peer-action-id': def.id,
      'data-testid': `kbd-reset-${def.id}`
    },
    onClick: () => state.onPrefsIntent?.({ type: 'set-keybinding', actionId: def.id, binding: def.binding })
  }));
}

function renderShortcutRow(doc, def, state) {
  const overrides = state.prefs?.keymapOverrides ?? {};
  const effective = overrides[def.id] ?? def.binding;
  const isRebinding = state.rebindingId === def.id;
  const row = el(doc, 'div', {
    className: 'peer-settings-row',
    attrs: { 'data-peer-kbd-row': def.id, 'data-testid': `kbd-row-${def.id}` }
  });
  const meta = el(doc, 'div', { className: 'peer-settings-row-meta' });
  meta.append(el(doc, 'span', { className: 'peer-settings-row-label', text: def.label }));
  if (def.displayOnly) {
    meta.append(el(doc, 'p', { className: 'peer-settings-hint', text: 'Fixed contextual shortcut' }));
  }
  const controls = el(doc, 'div', { className: 'peer-settings-controls' });
  controls.append(el(doc, 'kbd', {
    className: 'peer-settings-badge',
    text: isRebinding ? 'Press keys…' : formatBinding(effective),
    attrs: { 'data-peer-kbd': def.id }
  }));
  appendRebindButtons(doc, controls, def, overrides, isRebinding, state);
  row.append(meta, controls);
  return row;
}

function renderScopeSection(doc, scope, heading, state) {
  const actions = KEYBOARD_ACTIONS.filter((item) => item.scope === scope);
  if (actions.length === 0) return null;
  const group = el(doc, 'div', { className: 'peer-settings-group', attrs: { 'data-peer-kbd-scope': scope } });
  group.append(el(doc, 'h3', { className: 'peer-settings-group-title', text: heading }));
  for (const def of actions) group.append(renderShortcutRow(doc, def, state));
  return group;
}

function syncKeyboardRows(state) {
  const groups = [];
  for (const [scope, heading] of KEY_SCOPES) {
    const group = renderScopeSection(state.doc, scope, heading, state);
    if (group) groups.push(group);
  }
  state.listHost.replaceChildren(...groups);
}

function attachCaptureListener(state, actionId) {
  state.abortCapture();
  state.rebindingId = actionId;
  syncKeyboardRows(state);
  const win = state.doc.defaultView;
  if (!win || typeof win.addEventListener !== 'function') return;
  const controller = new AbortController();
  state.captureController = controller;
  win.addEventListener('keydown', (event) => {
    if (state.life.dead || event.isComposing || MODIFIER_ONLY_KEYS.has(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === 'Escape') {
      state.stopCapture();
      return;
    }
    const binding = eventBinding(event);
    if (!binding) return;
    state.stopCapture();
    state.onPrefsIntent?.({ type: 'set-keybinding', actionId, binding });
  }, { capture: true, signal: controller.signal });
}

export function createKeyboardSection(host, { onPrefsIntent } = {}) {
  const doc = documentOf(host);
  const life = createLife();
  const root = el(doc, 'div', { className: 'peer-settings-panel', attrs: { 'data-peer-settings-section': 'keyboard' } });
  const listHost = el(doc, 'div', { className: 'peer-settings-panel', attrs: { 'data-peer-kbd-list': '' } });
  const footer = el(doc, 'div', { className: 'peer-settings-row' });
  footer.append(
    el(doc, 'p', { className: 'peer-settings-hint', text: 'Custom shortcuts are stored locally on this device.' }),
    button(doc, {
      label: 'Reset all to defaults',
      signal: life.signal,
      attrs: { 'data-peer-action': 'reset-keybindings', 'data-testid': 'kbd-reset-all' },
      onClick: () => onPrefsIntent?.({ type: 'reset-keybindings' })
    })
  );
  root.append(listHost, footer);
  host.append(root);

  const state = {
    doc, life, listHost, onPrefsIntent, prefs: null, rebindingId: null, captureController: null,
    abortCapture: () => {
      if (state.captureController) { state.captureController.abort(); state.captureController = null; }
    },
    stopCapture: () => { state.abortCapture(); state.rebindingId = null; syncKeyboardRows(state); },
    startCapture: (actionId) => attachCaptureListener(state, actionId)
  };
  life.add(() => state.abortCapture());

  const update = ({ prefs = null } = {}) => {
    if (life.dead) return;
    state.prefs = prefs;
    syncKeyboardRows(state);
  };
  update({});

  return { update, destroy: () => { if (life.destroy()) root.remove(); } };
}
