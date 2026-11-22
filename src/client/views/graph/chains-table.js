/**
 * Reasoning chains & source management table (`[data-testid="chains-table"]`).
 * Supports `v0.7.0` source folders (`New folder`, expand/collapse, inline rename,
 * drag-and-drop move, `DeleteSourceDialog` with `deleteSessions` checkbox) while
 * keeping `[data-peer-action="delete-source"]` and proposition practice-picks working.
 */
import {
  button, createLife, documentOf, el, injectUiStyles, input,
  setOff, setValue, show, textNode, writeText
} from 'cloudcanvas-lib/ui';
import { toggleSourceEntries } from 'peer-engine';
import { createDeleteSourceDialog } from './delete-source-dialog.js';
import { injectGraphStyles } from './graph.css.js';
import { createSourceFolderTree } from './source-folder-tree.js';

function renderMemberRow(doc, member) {
  const row = el(doc, 'label', {
    className: 'peer-graph-prop-row',
    attrs: { 'data-peer-prop-row': member.id }
  });
  const checkbox = el(doc, 'input', {
    attrs: { type: 'checkbox', 'data-peer-pick-node': member.id, 'aria-label': `Pick ${member.name}` }
  });
  checkbox.checked = Boolean(member.picked);
  const body = el(doc, 'span');
  body.append(el(doc, 'strong', { text: `${member.name}: ` }), el(doc, 'span', { text: member.statement }));
  row.append(checkbox, body);
  return row;
}

function renderChainRow(doc, chain) {
  const block = el(doc, 'div', {
    className: 'peer-graph-chain-row',
    attrs: { 'data-peer-chain-row': chain.id }
  });
  block.append(el(doc, 'div', { className: 'peer-graph-chain-line', text: chain.line }));
  for (const member of chain.members) block.append(renderMemberRow(doc, member));
  return block;
}

function buildSourceDeleteActions(doc, group) {
  const right = el(doc, 'span', { className: 'peer-graph-chains-actions' });
  const confirmAttrs = {
    'data-peer-action': 'confirm-delete-source',
    'data-peer-source-id': group.sourceId,
    'data-testid': `confirm-delete-source-${group.sourceId}`
  };
  const delAttrs = { 'data-peer-action': 'delete-source', 'data-peer-source-id': group.sourceId };
  right.append(
    button(doc, { label: 'Delete…', ariaLabel: `Confirm delete source ${group.label}`, attrs: confirmAttrs }),
    button(doc, { className: 'peer-graph-danger-btn', label: 'Delete source', ariaLabel: `Delete source ${group.label}`, attrs: delAttrs })
  );
  return right;
}

function renderSourceGroup(doc, group, depth, selectedSources) {
  const details = el(doc, 'details', {
    className: 'peer-graph-source-group',
    attrs: { 'data-peer-source-row': group.sourceId ?? group.key }
  });
  details.open = true;
  if (depth > 0) details.style.marginLeft = `${depth * 20}px`;
  const summary = el(doc, 'summary', { className: 'peer-graph-source-summary' });
  const left = el(doc, 'span', { className: 'peer-graph-chains-actions' });
  if (group.deletable && group.sourceId) {
    const checkAttrs = {
      type: 'checkbox', 'data-peer-select-source': group.sourceId,
      'data-testid': `source-checkbox-${group.sourceId}`, 'aria-label': `Select source ${group.label}`
    };
    const srcCheck = el(doc, 'input', { attrs: checkAttrs });
    srcCheck.checked = selectedSources.has(group.sourceId);
    left.append(srcCheck);
  }
  left.append(el(doc, 'span', { text: `${group.label} (${group.propositionCount} propositions)` }));
  summary.append(left);
  if (group.deletable && group.sourceId) summary.append(buildSourceDeleteActions(doc, group));
  details.append(summary);
  for (const chain of group.chains) details.append(renderChainRow(doc, chain));
  return details;
}

function buildChainsToolbar(doc, life, handlers) {
  const bar = el(doc, 'div', { className: 'peer-graph-chains-toolbar' });
  const countsEl = el(doc, 'span', { className: 'peer-graph-section-label', attrs: { 'data-peer-chains-counts': '' } });
  const countsText = textNode(doc, countsEl, '0 chains · 0 propositions');
  const actions = el(doc, 'div', { className: 'peer-graph-chains-actions' });
  const newFolderBtn = button(doc, {
    label: 'New folder', ariaLabel: 'Add folder', signal: life.signal, onClick: handlers.onNewFolder,
    attrs: { 'data-testid': 'add-source-folder', 'data-peer-action': 'new-source-folder' }
  });
  const searchInput = input(doc, {
    type: 'search', label: 'Search chains and propositions', placeholder: 'Search chains…',
    className: 'peer-graph-search', signal: life.signal, onInput: (val) => handlers.onSearch(val),
    attrs: { 'data-peer-chains-search': '', 'data-testid': 'chain-table-search' }
  });
  const pickedEl = el(doc, 'span', { className: 'peer-graph-section-label', attrs: { 'data-peer-picked-count': '' } });
  const pickedText = textNode(doc, pickedEl, '0 picked');
  const clearBtn = button(doc, {
    label: 'Clear', signal: life.signal, onClick: handlers.onClearPicks, attrs: { 'data-peer-action': 'clear-picks' }
  });
  const practiceBtn = button(doc, {
    label: 'Practice', ariaLabel: 'Launch practice session with selected propositions',
    signal: life.signal, onClick: handlers.onPractice,
    attrs: { 'data-peer-action': 'launch-practice', 'data-testid': 'practice-picked' }
  });
  const deleteSelectedBtn = button(doc, {
    className: 'peer-graph-danger-btn', label: 'Delete selected', ariaLabel: 'Delete selected sources and folders',
    signal: life.signal, onClick: handlers.onOpenDeleteSelected,
    attrs: { 'data-testid': 'chain-delete', 'data-peer-action': 'confirm-delete-sources', hidden: true }
  });
  actions.append(newFolderBtn, searchInput, pickedEl, clearBtn, practiceBtn, deleteSelectedBtn);
  bar.append(countsEl, actions);
  return { bar, countsText, searchInput, pickedEl, pickedText, clearBtn, practiceBtn, deleteSelectedBtn };
}

function resolveSourcesForDialog(model, sourceIds, folderIds) {
  const groupsById = new Map((model?.groups ?? []).filter((g) => g.sourceId).map((g) => [g.sourceId, g]));
  const dirById = new Map((model?.directory?.sources ?? []).map((s) => [s.id, s]));
  const sources = [...sourceIds].map((id) => {
    const g = groupsById.get(id);
    const d = dirById.get(id);
    return {
      id,
      kind: d?.kind ?? g?.kind ?? 'chat',
      label: d?.label ?? g?.label ?? id,
      createdAt: d?.createdAt ?? null
    };
  });
  const folderById = new Map((model?.organization?.folders ?? []).map((f) => [f.id, f]));
  const folders = [...folderIds].map((id) => folderById.get(id)).filter(Boolean);
  return { sources, folders };
}

function applyEntryToggle(state, kind, id, checked) {
  const dir = state.lastModel?.directory;
  if (dir) {
    const next = toggleSourceEntries(
      dir,
      { sources: state.selectedSources, folders: state.selectedFolders },
      kind,
      id,
      checked
    );
    state.selectedSources = next.sources;
    state.selectedFolders = next.folders;
  } else if (kind === 'source') {
    if (checked) state.selectedSources.add(id);
    else state.selectedSources.delete(id);
  } else {
    if (checked) state.selectedFolders.add(id);
    else state.selectedFolders.delete(id);
  }
  state.refresh();
}

function bindDelegatedTableEvents(life, treeHost, state, callbacks, openDialogFor) {
  life.on(treeHost, 'change', (event) => {
    const pickId = event.target?.getAttribute?.('data-peer-pick-node');
    if (pickId) { callbacks.onTogglePick?.(pickId); return; }
    const srcId = event.target?.getAttribute?.('data-peer-select-source');
    if (srcId) applyEntryToggle(state, 'source', srcId, Boolean(event.target.checked));
  });
  life.on(treeHost, 'click', (event) => {
    const confirmBtn = event.target?.closest?.('[data-peer-action="confirm-delete-source"]');
    if (confirmBtn) {
      event.preventDefault();
      event.stopPropagation();
      const sourceId = confirmBtn.getAttribute('data-peer-source-id');
      if (sourceId) openDialogFor([sourceId], []);
      return;
    }
    const delBtn = event.target?.closest?.('[data-peer-action="delete-source"]');
    if (!delBtn) return;
    event.preventDefault();
    event.stopPropagation();
    const sourceId = delBtn.getAttribute('data-peer-source-id');
    if (sourceId) callbacks.onDeleteSource?.(sourceId);
  });
}

function syncChainsTableView(state, toolbar, emptyEl, tree, deleteDialog) {
  if (state.life.dead) return;
  const model = state.lastModel ?? {};
  writeText(toolbar.countsText, `${Number(model.totalChains ?? 0)} chains · ${Number(model.totalPropositions ?? 0)} propositions`);
  setValue(toolbar.searchInput, model.searchQuery ?? '');
  const pickedCount = Array.isArray(model.pickedIds) ? model.pickedIds.length : 0;
  writeText(toolbar.pickedText, `${pickedCount} picked`);
  show(toolbar.pickedEl, pickedCount > 0);
  setOff(toolbar.clearBtn, pickedCount === 0);
  show(toolbar.deleteSelectedBtn, state.selectedSources.size > 0 || state.selectedFolders.size > 0);

  const groups = Array.isArray(model.groups) ? model.groups : [];
  const folderCount = model.organization?.folders?.length ?? 0;
  show(emptyEl, groups.length === 0 && folderCount === 0);
  tree.update({ ...model, selectedSources: state.selectedSources, selectedFolders: state.selectedFolders });
  const resolved = resolveSourcesForDialog(model, state.dialogTarget.sourceIds, state.dialogTarget.folderIds);
  deleteDialog.update({ open: state.dialogOpen, sources: resolved.sources, folders: resolved.folders });
}

async function confirmSourceDeletion(state, callbacks, { sourceIds, folderIds, deleteSessions }) {
  if (callbacks.onSourceAction) {
    await callbacks.onSourceAction('DELETE', { sourceIds, folderIds, deleteSessions });
  } else {
    for (const id of sourceIds) await callbacks.onDeleteSource?.(id, deleteSessions);
  }
  for (const id of sourceIds) state.selectedSources.delete(id);
  for (const id of folderIds) state.selectedFolders.delete(id);
}

function mountChainsControls(doc, life, treeSlot, dialogSlot, state, callbacks, openDialogFor) {
  const tree = createSourceFolderTree(treeSlot, {
    renderSourceGroup: (group, depth) => renderSourceGroup(doc, group, depth, state.selectedSources),
    onToggleFolder: (folderId, checked) => applyEntryToggle(state, 'folder', folderId, checked),
    onOrganizationAction: (action) => callbacks.onSourceAction?.('POST', action)
  });
  const toolbar = buildChainsToolbar(doc, life, {
    onNewFolder: () => tree.startCreateFolder(),
    onSearch: (val) => callbacks.onSearch?.(val),
    onClearPicks: () => callbacks.onClearPicks?.(),
    onPractice: () => callbacks.onLaunchPractice?.(state.lastModel?.pickedIds ?? [], state.lastModel?.pickedNames ?? []),
    onOpenDeleteSelected: () => openDialogFor(state.selectedSources, state.selectedFolders)
  });
  const deleteDialog = createDeleteSourceDialog(dialogSlot, {
    onClose: () => { state.dialogOpen = false; state.refresh(); },
    onConfirm: (payload) => confirmSourceDeletion(state, callbacks, payload)
  });
  return { tree, toolbar, deleteDialog };
}

export function createChainsTable(host, callbacks = {}) {
  const doc = documentOf(host);
  injectUiStyles(doc);
  injectGraphStyles(doc);
  const life = createLife();
  const root = el(doc, 'section', { className: 'peer-graph-chains-table', attrs: { 'data-testid': 'chains-table' } });
  const emptyEl = el(doc, 'p', {
    className: 'peer-graph-import-notice',
    text: 'No reasoning chains match the current filter.',
    attrs: { 'data-peer-chains-empty': '', hidden: true }
  });
  const treeSlot = el(doc, 'div');
  const dialogSlot = el(doc, 'div');
  const state = {
    life, lastModel: null, selectedSources: new Set(), selectedFolders: new Set(),
    dialogOpen: false, dialogTarget: { sourceIds: [], folderIds: [] }, refresh: null
  };
  const openDialogFor = (sourceIds, folderIds) => {
    state.dialogOpen = true;
    state.dialogTarget = { sourceIds: [...sourceIds], folderIds: [...folderIds] };
    state.refresh();
  };
  const { tree, toolbar, deleteDialog } = mountChainsControls(doc, life, treeSlot, dialogSlot, state, callbacks, openDialogFor);
  state.refresh = () => syncChainsTableView(state, toolbar, emptyEl, tree, deleteDialog);
  root.append(toolbar.bar, emptyEl, treeSlot, dialogSlot);
  host.append(root);
  bindDelegatedTableEvents(life, treeSlot, state, callbacks, openDialogFor);
  const update = (model = {}) => { if (!life.dead && model !== state.lastModel) { state.lastModel = model; state.refresh(); } };
  const destroy = () => { if (life.destroy()) { state.lastModel = null; deleteDialog.destroy(); tree.destroy(); root.remove(); } };
  return { update, focusSearch: () => { if (!life.dead) toolbar.searchInput.focus(); }, destroy };
}
