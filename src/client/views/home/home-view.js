/**
 * Home screen view (`[data-peer-screen="home"]`, `views §2.3`, `C2a V-Graph`).
 * Renders Graph/Chains tabs, mounts `createGraphView` (`[data-testid="graph-view"]`)
 * or minimal/chains mode (`[data-testid="minimal-home"]` + `[data-testid="chains-table"]`
 * + `[data-peer-notes-import]`), and hosts the quick-start composer + Setup CTA.
 * Zero view-owned session mode (`R4`): reads `vm.sessionMode` and dispatches
 * `set-session-mode` via `send` (with fallback only when `send` is omitted).
 */
import {
  button, createLife, documentOf, el, injectUiStyles, input, setOff, show, textNode, writeText
} from 'cloudcanvas-lib/ui';
import { createChainsTable } from '../graph/chains-table.js';
import { deriveHomeViewModel } from '../graph/graph-models.js';
import { createGraphView } from '../graph/graph-view.js';
import { createNotesImport } from '../graph/notes-import.js';
import { createTopBar } from '../shared/top-bar.js';
import { injectHomeStyles } from './home.css.js';

function dispatchHomeIntent(send, intent) {
  if (typeof send !== 'function') return undefined;
  try {
    const res = send(intent);
    if (res && typeof res.catch === 'function') res.catch(() => {});
    return res;
  } catch {
    return undefined;
  }
}

function resolveSessionMode(state, vm) {
  if (typeof state.send === 'function') {
    return vm?.sessionMode === 'practice' ? 'practice' : 'teach';
  }
  if (state.lastModel && typeof state.lastModel.sessionMode === 'string') {
    return vm?.sessionMode === 'practice' ? 'practice' : 'teach';
  }
  return state.fallbackMode;
}

function syncChainsPane(nodes, vm) {
  if (vm.minimalHome) {
    nodes.root.className = 'peer-home-minimal';
    nodes.root.setAttribute('data-testid', 'minimal-home');
    const s = vm.summary;
    writeText(
      nodes.summaryText,
      `${s.propositions} propositions · ${s.chains} chains · ${s.sessions} sessions · ${s.importedNotes} imported notes`
    );
    show(nodes.summaryEl, true);
  } else {
    nodes.root.className = 'peer-home-chains-pane';
    nodes.root.removeAttribute('data-testid');
    show(nodes.summaryEl, false);
  }
  nodes.notesImport.update(vm.notes);
  nodes.chainsTable.update(vm.chainsTable);
}

function createChainsPane(host, { send, getComposerText, onPickFiles }) {
  const doc = documentOf(host);
  const root = el(doc, 'div', { className: 'peer-home-chains-pane' });
  const topRow = el(doc, 'div', { className: 'peer-home-minimal-top' });
  const summaryEl = el(doc, 'div', {
    className: 'peer-home-summary',
    attrs: { 'data-testid': 'knowledge-summary', hidden: true }
  });
  const summaryText = textNode(doc, summaryEl, '');
  const notesSlot = el(doc, 'div');
  const notesImport = createNotesImport(notesSlot, {
    showRenderSettings: false,
    onPickFiles,
    onImportNotes: (files) => dispatchHomeIntent(send, { type: 'import-notes', files })
  });
  topRow.append(summaryEl, notesSlot);

  const tableSlot = el(doc, 'div');
  const chainsTable = createChainsTable(tableSlot, {
    onSearch: (query) => dispatchHomeIntent(send, { type: 'set-search', query }),
    onTogglePick: (nodeId) => dispatchHomeIntent(send, { type: 'toggle-pick-node', nodeId }),
    onClearPicks: () => dispatchHomeIntent(send, { type: 'clear-picks' }),
    onSourceAction: (method, body) => send?.({ type: 'source-action', method, body }),
    onDeleteSource: (sourceId, deleteSessions = false) => dispatchHomeIntent(send, {
      type: 'source-action',
      method: 'DELETE',
      body: { sourceIds: [sourceId], folderIds: [], deleteSessions: Boolean(deleteSessions) }
    }),
    onLaunchPractice: (pickedIds, pickedNames) => {
      const typed = getComposerText().trim();
      const fallback = pickedNames.length > 0 ? `Practice: ${pickedNames.join(', ')}` : 'Practice selected propositions';
      const payload = { type: 'start-session', prompt: typed || fallback, kind: 'practice' };
      if (pickedIds.length > 0) payload.nodeIds = [...pickedIds];
      dispatchHomeIntent(send, payload);
    }
  });
  root.append(topRow, tableSlot);
  host.append(root);

  const nodes = { root, summaryEl, summaryText, notesImport, chainsTable };
  return {
    update: (vm) => syncChainsPane(nodes, vm),
    focusSearch: () => chainsTable.focusSearch(),
    destroy: () => { chainsTable.destroy(); notesImport.destroy(); root.remove(); }
  };
}

function buildHomeTabs(doc, life, send) {
  const subbar = el(doc, 'div', { className: 'peer-home-subbar', attrs: { 'data-peer-home-tabs': '' } });
  const tablist = el(doc, 'div', { className: 'peer-home-tabs', attrs: { role: 'tablist', 'aria-label': 'Home view' } });
  const graphTab = button(doc, {
    className: 'peer-home-tab',
    label: 'Graph',
    signal: life.signal,
    onClick: () => dispatchHomeIntent(send, { type: 'set-view-tab', tab: 'graph' }),
    attrs: { role: 'tab', 'data-peer-tab': 'graph', 'aria-selected': 'true' }
  });
  const chainsTab = button(doc, {
    className: 'peer-home-tab',
    label: 'Chains',
    signal: life.signal,
    onClick: () => dispatchHomeIntent(send, { type: 'set-view-tab', tab: 'chains' }),
    attrs: { role: 'tab', 'data-peer-tab': 'chains', 'aria-selected': 'false' }
  });
  tablist.append(graphTab, chainsTab);
  subbar.append(tablist);
  return { subbar, graphTab, chainsTab };
}

function buildDockMetaRow(doc, life, callbacks) {
  const metaRow = el(doc, 'div', { className: 'peer-home-dock-meta' });
  const modesWrap = el(doc, 'div', { className: 'peer-home-modes' });
  const teachBtn = button(doc, {
    className: 'peer-home-mode',
    label: 'Teach',
    signal: life.signal,
    onClick: () => callbacks.onSetMode('teach'),
    attrs: { 'data-peer-home-mode': 'teach', 'aria-pressed': 'true' }
  });
  const practiceBtn = button(doc, {
    className: 'peer-home-mode',
    label: 'Practice',
    signal: life.signal,
    onClick: () => callbacks.onSetMode('practice'),
    attrs: { 'data-peer-home-mode': 'practice', 'aria-pressed': 'false' }
  });
  modesWrap.append(teachBtn, practiceBtn);

  const pickedBar = el(doc, 'div', { className: 'peer-home-picked-bar', attrs: { 'data-peer-picked-bar': '', hidden: true } });
  const pickedText = textNode(doc, pickedBar, '0 picked');
  pickedBar.append(button(doc, {
    label: 'Clear',
    signal: life.signal,
    onClick: () => callbacks.onClearPicks(),
    attrs: { 'data-peer-action': 'clear-home-picks' }
  }));
  const setupSlot = el(doc, 'div', { attrs: { 'data-peer-setup-slot': '' } });
  metaRow.append(modesWrap, pickedBar, setupSlot);
  return { metaRow, teachBtn, practiceBtn, pickedBar, pickedText, setupSlot };
}

function buildHomeDock(doc, life, callbacks) {
  const dock = el(doc, 'footer', { className: 'peer-home-dock', attrs: { 'data-peer-home-dock': '' } });
  const meta = buildDockMetaRow(doc, life, callbacks);
  const startErrorEl = el(doc, 'p', {
    className: 'peer-home-start-error',
    attrs: { role: 'alert', 'data-peer-start-error': '', hidden: true }
  });
  const startErrorText = textNode(doc, startErrorEl, '');

  const form = el(doc, 'form', { className: 'peer-home-composer' });
  const composerInput = input(doc, {
    type: 'textarea',
    label: 'What do you want to learn?',
    placeholder: 'What do you want to learn?',
    className: 'peer-home-input',
    attrs: { 'data-peer-home-input': '', rows: '2' }
  });
  const startBtn = button(doc, {
    label: 'Start',
    ariaLabel: 'Start session',
    signal: life.signal,
    onClick: () => callbacks.onSubmit(),
    attrs: { 'data-peer-action': 'home-start' }
  });
  life.on(form, 'submit', (ev) => { ev.preventDefault(); callbacks.onSubmit(); });
  life.on(composerInput, 'keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); callbacks.onSubmit(); }
  });
  form.append(composerInput, startBtn);
  dock.append(meta.metaRow, startErrorEl, form);
  return { ...meta, dock, startErrorEl, startErrorText, composerInput, startBtn };
}

function syncHomeDock(doc, life, state, vm) {
  const dock = state.dock;
  const isPractice = resolveSessionMode(state, vm) === 'practice';
  dock.teachBtn.setAttribute('aria-pressed', String(!isPractice));
  dock.practiceBtn.setAttribute('aria-pressed', String(isPractice));
  dock.composerInput.placeholder = isPractice ? 'What do you want to practice?' : 'What do you want to learn?';

  const count = vm.pickedIds.length;
  show(dock.pickedBar, count > 0);
  if (count > 0) writeText(dock.pickedText, `${count} picked`);
  writeText(dock.startErrorText, vm.startError);
  show(dock.startErrorEl, vm.startError !== '');
  setOff(dock.startBtn, vm.starting);

  if (!vm.configured && !state.setupCtaBtn) {
    state.setupCtaBtn = button(doc, {
      label: 'Set up your models',
      signal: life.signal,
      onClick: () => dispatchHomeIntent(state.send, { type: 'open-setup' }),
      attrs: { 'data-peer-setup-cta': '', 'data-testid': 'setup-cta', 'data-peer-action': 'open-setup' }
    });
    dock.setupSlot.append(state.setupCtaBtn);
  } else if (vm.configured && state.setupCtaBtn) {
    state.setupCtaBtn.remove();
    state.setupCtaBtn = null;
  }
}

function syncHomeBody(state, vm) {
  if (vm.showGraph) {
    if (state.chainsPane) { state.chainsPane.destroy(); state.chainsPane = null; }
    if (!state.graphView) {
      const opts = { send: state.send, navigate: state.navigate, onPickFiles: state.onPickFiles };
      state.graphView = createGraphView(state.bodyHost, opts);
    }
    state.graphView.update(vm);
    return;
  }
  if (state.graphView) { state.graphView.destroy(); state.graphView = null; }
  if (!state.chainsPane) {
    const getComposerText = () => state.dock.composerInput.value;
    state.chainsPane = createChainsPane(state.bodyHost, { send: state.send, onPickFiles: state.onPickFiles, getComposerText });
  }
  state.chainsPane.update(vm);
}

function submitHomePrompt(state) {
  const vm = state.lastVm;
  if (vm?.starting) return;
  const isPractice = resolveSessionMode(state, vm) === 'practice';
  const pickedIds = vm?.pickedIds ?? [];
  const typed = state.dock.composerInput.value.trim();
  const pickedNames = vm?.chainsTable?.pickedNames ?? [];
  const fallback = isPractice && pickedIds.length > 0
    ? (pickedNames.length > 0 ? `Practice: ${pickedNames.join(', ')}` : 'Practice selected propositions')
    : '';
  const prompt = typed || fallback;
  if (!prompt) return;
  if (vm && !vm.configured) { dispatchHomeIntent(state.send, { type: 'open-setup' }); return; }
  const intent = { type: 'start-session', prompt };
  if (isPractice) intent.kind = 'practice';
  if (pickedIds.length > 0) intent.nodeIds = [...pickedIds];
  dispatchHomeIntent(state.send, intent);
}

function handleHomeCommand(state, action) {
  if (state.life.dead) return false;
  if (action === 'focus-composer' || action === 'cycle-field') {
    state.dock.composerInput.focus();
    return true;
  }
  if (action === 'find') {
    if (state.graphView) state.graphView.focusSearch();
    else state.chainsPane?.focusSearch();
    return true;
  }
  if ((action === 'escape-session' || action === 'escape') && state.lastVm?.nodeCard) {
    dispatchHomeIntent(state.send, { type: 'select-node', nodeId: null });
    return true;
  }
  return false;
}

function applyHomeUpdate(doc, state, model = {}) {
  if (state.life.dead || model === state.lastModel) return;
  state.lastModel = model;
  const vm = deriveHomeViewModel(model);
  state.lastVm = vm;
  const badge = vm.summary.propositions > 0 ? `${vm.summary.propositions} props · ${vm.summary.chains} chains` : '';
  state.topBar.update({ title: vm.title, badge });
  show(state.tabs.subbar, vm.graphEnabled);
  state.tabs.graphTab.setAttribute('aria-selected', String(vm.viewTab !== 'chains'));
  state.tabs.chainsTab.setAttribute('aria-selected', String(vm.viewTab === 'chains'));
  syncHomeBody(state, vm);
  syncHomeDock(doc, state.life, state, vm);
}

function handleHomeModePick(doc, state, mode) {
  const clean = mode === 'practice' ? 'practice' : 'teach';
  if (typeof state.send === 'function') {
    dispatchHomeIntent(state.send, { type: 'set-session-mode', mode: clean });
    return;
  }
  state.fallbackMode = clean;
  if (state.lastVm) syncHomeDock(doc, state.life, state, state.lastVm);
}

function teardownHomeView(state, root) {
  if (!state.life.destroy()) return;
  state.graphView?.destroy();
  state.chainsPane?.destroy();
  state.graphView = null;
  state.chainsPane = null;
  state.setupCtaBtn?.remove();
  state.setupCtaBtn = null;
  state.lastModel = null;
  state.lastVm = null;
  state.topBar.destroy();
  root.remove();
}

export function createHomeView(host, { send, navigate, onToggleSidebar, onPickFiles } = {}) {
  const doc = documentOf(host);
  injectUiStyles(doc);
  injectHomeStyles(doc);
  const life = createLife();
  const root = el(doc, 'section', { className: 'peer-home', attrs: { 'data-peer-screen': 'home' } });
  const topBarHost = el(doc, 'div');
  const topBar = createTopBar(topBarHost, {
    onToggleSidebar,
    onOpenSettings: () => dispatchHomeIntent(send, { type: 'open-settings' })
  });
  const tabs = buildHomeTabs(doc, life, send);
  const bodyHost = el(doc, 'div', { className: 'peer-home-body' });
  const state = {
    life, send, navigate, onPickFiles, topBar, tabs, bodyHost, dock: null, setupCtaBtn: null,
    graphView: null, chainsPane: null, fallbackMode: 'teach', lastModel: null, lastVm: null
  };
  state.dock = buildHomeDock(doc, life, {
    onSetMode: (mode) => handleHomeModePick(doc, state, mode),
    onClearPicks: () => dispatchHomeIntent(send, { type: 'clear-picks' }),
    onSubmit: () => submitHomePrompt(state)
  });
  root.append(topBarHost, tabs.subbar, bodyHost, state.dock.dock);
  host.append(root);

  return {
    update: (model) => applyHomeUpdate(doc, state, model),
    command: (action) => handleHomeCommand(state, action),
    destroy: () => teardownHomeView(state, root)
  };
}
