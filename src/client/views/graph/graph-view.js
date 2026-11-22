/**
 * Knowledge-graph surface (`[data-testid="graph-view"]`, `C2a V-Graph` + `v0.7.0`).
 * Coordinates `createGraphStage` (`peer-graph` CloudCanvas widget), `createGraphFolderFilter`,
 * node search, `createNotesImport`, error/empty states, `createNodeCard`, and `createDeleteNodeDialog`.
 */
import {
  button, createLife, createStatus, documentOf, el, injectUiStyles, input, setValue, show
} from 'cloudcanvas-lib/ui';
import { createDeleteNodeDialog } from './delete-node-dialog.js';
import { createPluginActionsBar } from '../plugin/plugin-chrome.js';
import { createGraphFolderFilter } from './graph-folder-filter.js';
import { deriveGraphStageModel, deriveHomeViewModel } from './graph-models.js';
import { createGraphStage } from './graph-stage.js';
import { injectGraphStyles } from './graph.css.js';
import { createNodeCard } from './node-card.js';
import { createNotesImport } from './notes-import.js';

function dispatchGraphIntent(send, intent) {
  if (typeof send !== 'function') return undefined;
  try {
    const res = send(intent);
    if (res && typeof res.catch === 'function') res.catch(() => {});
    return res;
  } catch {
    return undefined;
  }
}

function buildGraphChrome(doc, life, callbacks) {
  const chrome = el(doc, 'div', { className: 'peer-graph-chrome' });
  const row = el(doc, 'div', { className: 'peer-graph-chrome-row' });
  const folderSlot = el(doc, 'div');
  const folderFilter = createGraphFolderFilter(folderSlot, {
    onToggleFolder: (folderId, nextIds, checked) => callbacks.onToggleFolder(folderId, nextIds, checked),
    onClearFolders: () => callbacks.onClearFolders()
  });
  const searchInput = input(doc, {
    type: 'search',
    label: 'Search nodes',
    placeholder: 'Search nodes…',
    className: 'peer-graph-search',
    signal: life.signal,
    onInput: (query) => callbacks.onSearch(query),
    attrs: { 'data-peer-graph-search': '' }
  });
  const fitBtn = button(doc, {
    label: 'Fit',
    ariaLabel: 'Fit knowledge graph in view',
    signal: life.signal,
    onClick: () => callbacks.onFit(),
    attrs: { 'data-peer-action': 'fit-graph' }
  });
  const notesSlot = el(doc, 'div');
  const notesImport = createNotesImport(notesSlot, {
    showRenderSettings: true,
    onPickFiles: callbacks.onPickFiles,
    onImportNotes: (files) => callbacks.onImportNotes(files),
    onSaveRenderSettings: (settings) => callbacks.onSaveRenderSettings(settings)
  });
  const pluginSlot = el(doc, 'div');
  const pluginActions = createPluginActionsBar(pluginSlot, { location: 'graph', testId: 'plugin-graph-actions' });
  row.append(folderSlot, searchInput, fitBtn, notesSlot, pluginSlot);
  chrome.append(row);
  return { chrome, folderSlot, folderFilter, searchInput, notesImport, pluginActions };
}

function handleDirectNodeDelete(state, nodeId, nodeName) {
  if (!state.send) return;
  let pending;
  try {
    pending = state.send({ type: 'delete-node', nodeId });
  } catch (err) {
    state.pendingDelete = { nodes: [{ id: nodeId, name: nodeName || nodeId }], failure: err };
    state.deleteDialog.update(state.pendingDelete);
    return;
  }
  if (pending && typeof pending.catch === 'function') {
    pending.catch((err) => {
      if (state.life.dead) return;
      state.pendingDelete = { nodes: [{ id: nodeId, name: nodeName || nodeId }], failure: err };
      state.deleteDialog.update(state.pendingDelete);
    });
  }
}

function handleFolderToggle(state, folderId, nextIds, checked) {
  if (typeof state.send === 'function') {
    dispatchGraphIntent(state.send, { type: 'toggle-graph-folder', folderId, checked: Boolean(checked) });
    return;
  }
  state.fallbackFolders = nextIds;
  if (state.lastRawModel) syncGraphView(state, state.lastRawModel, true);
}

function handleFolderClear(state) {
  if (typeof state.send === 'function') {
    dispatchGraphIntent(state.send, { type: 'clear-graph-folders' });
    return;
  }
  state.fallbackFolders = [];
  if (state.lastRawModel) syncGraphView(state, state.lastRawModel, true);
}

function attachStageControl(stageSlot, state, life, send) {
  return createGraphStage(stageSlot, {
    onSelect: (nodeId) => dispatchGraphIntent(send, { type: 'select-node', nodeId }),
    onContext: (nodeId) => {
      dispatchGraphIntent(send, { type: 'select-node', nodeId });
      if (!nodeId) return;
      const found = state.lastVm?.stage?.data?.nodes?.find((n) => n.id === nodeId);
      state.pendingDelete = { nodes: [{ id: nodeId, name: found?.label || nodeId }] };
      state.deleteDialog.update(state.pendingDelete);
    },
    onStageClick: () => dispatchGraphIntent(send, { type: 'select-node', nodeId: null }),
    onCameraMove: (t) => {
      if (state.inSync || !t) return;
      state.cancelCameraTimer?.();
      const camera = { k: t.k, x: t.x, y: t.y };
      state.cancelCameraTimer = life.later(() => { state.cancelCameraTimer = null; dispatchGraphIntent(send, { type: 'set-camera', camera }); }, 180);
    },
    onCommit: (positions) => dispatchGraphIntent(send, { type: 'commit-positions', positions })
  });
}

function mountGraphParts(host, doc, life, send, navigate, onPickFiles) {
  const root = el(doc, 'div', { className: 'peer-graph-view', attrs: { 'data-testid': 'graph-view' } });
  const stageSlot = el(doc, 'div', { className: 'peer-graph-stage-slot' });
  const emptyEl = el(doc, 'div', {
    className: 'peer-graph-empty',
    text: 'Start a session or extract files to build your knowledge graph.',
    attrs: { 'data-peer-graph-empty': '', hidden: true }
  });
  const statusSlot = el(doc, 'div', { className: 'peer-graph-status', attrs: { 'data-peer-graph-status': '', hidden: true } });
  const statusControl = createStatus(statusSlot);
  const cardSlot = el(doc, 'div', { attrs: { 'data-peer-node-card-slot': '' } });
  const dialogSlot = el(doc, 'div');
  const state = {
    life, send, root, emptyEl, statusSlot, statusControl, inSync: false,
    cancelCameraTimer: null, lastModel: null, lastRawModel: null,
    fallbackFolders: null, pendingDelete: null
  };
  state.runSync = (fn) => { state.inSync = true; try { fn(); } finally { state.inSync = false; } };
  state.chrome = buildGraphChrome(doc, life, {
    onPickFiles,
    onToggleFolder: (id, nextIds, checked) => handleFolderToggle(state, id, nextIds, checked),
    onClearFolders: () => handleFolderClear(state),
    onSearch: (query) => dispatchGraphIntent(send, { type: 'set-search', query }),
    onFit: () => state.runSync(() => state.stage.fit()),
    onImportNotes: (files) => dispatchGraphIntent(send, { type: 'import-notes', files }),
    onSaveRenderSettings: (settings) => dispatchGraphIntent(send, { type: 'save-render-settings', settings })
  });
  state.nodeCard = createNodeCard(cardSlot, {
    onClose: () => dispatchGraphIntent(send, { type: 'select-node', nodeId: null }),
    onDeleteNode: (nodeId, nodeName) => handleDirectNodeDelete(state, nodeId, nodeName),
    onNavigate: (href) => navigate?.(href)
  });
  state.deleteDialog = createDeleteNodeDialog(dialogSlot, {
    onClose: () => { state.pendingDelete = null; state.deleteDialog.update({ nodes: [] }); },
    onConfirm: async ({ nodes }) => {
      for (const n of nodes) await send?.({ type: 'delete-node', nodeId: n.id });
      state.pendingDelete = null;
    }
  });
  root.append(stageSlot, emptyEl, statusSlot, state.chrome.chrome, cardSlot, dialogSlot);
  host.append(root);
  state.stage = attachStageControl(stageSlot, state, life, send);
  return state;
}

function resolveVmWithFolders(state, model) {
  const baseVm = model?.stage && model?.notes ? model : deriveHomeViewModel(model);
  if (baseVm.hasModelFolderFilter || !state.fallbackFolders) return baseVm;
  const org = baseVm.folderFilter?.organization;
  if (!org) return baseVm;
  const patchedRaw = {
    ...model,
    organization: org,
    selectedFolderIds: state.fallbackFolders
  };
  return {
    ...baseVm,
    folderFilter: { ...baseVm.folderFilter, selectedIds: state.fallbackFolders },
    stage: deriveGraphStageModel(patchedRaw)
  };
}

function syncGraphView(state, model = {}, force = false) {
  if (state.life.dead || (!force && model === state.lastModel)) return;
  state.lastModel = model;
  state.lastRawModel = model;
  const vm = resolveVmWithFolders(state, model);
  state.lastVm = vm;
  setValue(state.chrome.searchInput, vm.searchQuery ?? '');
  const hasFolders = (vm.folderFilter?.organization?.folders?.length ?? 0) > 0;
  show(state.chrome.folderSlot, hasFolders);
  state.chrome.folderFilter.update(vm.folderFilter ?? {});
  state.chrome.notesImport.update(vm.notes);
  state.chrome.pluginActions.update({
    plugins: model?.plugins ?? vm?.plugins ?? null,
    manager: model?.pluginManager ?? vm?.pluginManager ?? null,
    context: { surface: 'home', pathname: '/' }
  });

  const isError = vm.graphLoad === 'error';
  show(state.statusSlot, isError);
  if (isError) {
    state.statusControl.update({
      status: 'error',
      message: vm.graphError || 'Could not load knowledge graph.',
      retry: () => dispatchGraphIntent(state.send, { type: 'reload' })
    });
  }
  show(state.emptyEl, !isError && Boolean(vm.stage.isEmpty));
  state.runSync(() => state.stage.update(vm.stage));
  state.nodeCard.update(vm.nodeCard);
}

export function createGraphView(host, { send, navigate, onPickFiles } = {}) {
  const doc = documentOf(host);
  injectUiStyles(doc);
  injectGraphStyles(doc);
  const life = createLife();
  const state = mountGraphParts(host, doc, life, send, navigate, onPickFiles);

  const destroy = () => {
    if (!life.destroy()) return;
    state.cancelCameraTimer = null;
    state.lastModel = null;
    state.lastRawModel = null;
    state.deleteDialog.destroy();
    state.nodeCard.destroy();
    state.chrome.folderFilter.destroy();
    state.chrome.notesImport.destroy();
    state.chrome.pluginActions.destroy();
    state.statusControl.destroy();
    state.stage.destroy();
    state.root.remove();
  };

  return {
    update: (model) => syncGraphView(state, model),
    fit: () => { if (!life.dead) state.runSync(() => state.stage.fit()); },
    focusSearch: () => { if (!life.dead) state.chrome.searchInput.focus(); },
    destroy
  };
}
