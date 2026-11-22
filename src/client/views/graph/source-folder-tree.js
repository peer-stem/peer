/**
 * Hierarchical source & folder tree (`v0.7.0` parity, `views/graph/source-folder-tree.js`).
 * Supports folder creation, expand/collapse, inline rename (`rename-folder`),
 * folder/source selection (`folderEntryCheck`), and drag-and-drop move (`move`).
 */
import { button, createLife, documentOf, el, placeChildren } from 'cloudcanvas-lib/ui';
import { canMoveFolder, folderEntryCheck, folderIsEmpty, fuzzyScore, placementOf } from 'peer-engine';

export const SOURCE_DRAG_TYPE = 'application/x-learnharness-source';

const COLLATOR = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

export function sourceNameMatches(directory, id, label, query) {
  if (!String(query ?? '').trim()) return true;
  if (fuzzyScore(query, label ?? '') !== null) return true;
  if (!directory?.organization) return false;
  let parent = placementOf(directory.organization, id)?.folderId ?? null;
  const seen = new Set();
  while (parent !== null && !seen.has(parent)) {
    seen.add(parent);
    const folder = directory.organization.folders.find((f) => f.id === parent);
    if (!folder) break;
    if (fuzzyScore(query, folder.name) !== null) return true;
    parent = folder.parentId;
  }
  return false;
}

function buildNameEditor(doc, initialName, onSave, onCancel) {
  const inputEl = el(doc, 'input', {
    className: 'cloudcanvas-ui-field',
    attrs: {
      type: 'text',
      placeholder: 'Folder name',
      'aria-label': 'Source or folder name',
      'data-testid': 'source-name-input'
    }
  });
  inputEl.value = initialName;
  let settled = false;
  const commit = async () => {
    if (settled) return;
    const trimmed = inputEl.value.trim();
    if (!trimmed) { settled = true; onCancel?.(); return; }
    if (trimmed === initialName && initialName !== '') { settled = true; onCancel?.(); return; }
    settled = true;
    await onSave(trimmed);
  };
  inputEl.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); settled = true; onCancel?.(); }
    if (ev.key === 'Enter') { ev.preventDefault(); ev.stopPropagation(); void commit(); }
  });
  inputEl.addEventListener('blur', () => { void commit(); });
  inputEl.addEventListener('dragstart', (ev) => { ev.preventDefault(); ev.stopPropagation(); });
  queueMicrotask(() => { inputEl.focus(); inputEl.select?.(); });
  return inputEl;
}

function readDraggedPayload(event, fallbackDragged) {
  let parsed = null;
  try {
    const raw = event.dataTransfer?.getData?.(SOURCE_DRAG_TYPE);
    parsed = raw ? JSON.parse(raw) : null;
  } catch { /* ignore non-json drag */ }
  const isValid = parsed && (parsed.kind === 'source' || parsed.kind === 'folder') && typeof parsed.id === 'string';
  return isValid ? parsed : (fallbackDragged ?? null);
}

function bindDropSurface(node, parentId, state, renderNow) {
  const org = state.organization;
  if (!org || typeof state.callbacks.onOrganizationAction !== 'function') return;
  node.addEventListener('dragover', (ev) => {
    const types = Array.from(ev.dataTransfer?.types ?? []);
    if (!state.dragged && !types.includes(SOURCE_DRAG_TYPE)) return;
    const valid = state.dragged?.kind !== 'folder' || canMoveFolder(org, state.dragged.id, parentId);
    if (!valid) return;
    ev.preventDefault();
    ev.stopPropagation();
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move';
    node.setAttribute('data-drop-active', 'true');
  });
  node.addEventListener('dragleave', (ev) => {
    if (node.contains(ev.relatedTarget)) return;
    node.setAttribute('data-drop-active', 'false');
  });
  node.addEventListener('drop', (ev) => {
    const item = readDraggedPayload(ev, state.dragged);
    node.setAttribute('data-drop-active', 'false');
    if (!item) return;
    ev.preventDefault();
    ev.stopPropagation();
    state.dragged = null;
    if (item.kind === 'folder' && !canMoveFolder(org, item.id, parentId)) return;
    void Promise.resolve(state.callbacks.onOrganizationAction({
      action: 'move', kind: item.kind, id: item.id, parentId
    })).catch(() => {});
    renderNow();
  });
}

function attachDragSource(row, kind, id, state) {
  if (!id || typeof state.callbacks.onOrganizationAction !== 'function') return;
  row.draggable = true;
  row.setAttribute('data-source-drag-row', id);
  row.addEventListener('dragstart', (ev) => {
    if (ev.target?.closest?.('input:not([type="checkbox"]),textarea')) { ev.preventDefault(); return; }
    state.dragged = { kind, id };
    ev.dataTransfer?.setData?.(SOURCE_DRAG_TYPE, JSON.stringify({ kind, id }));
    if (ev.dataTransfer) ev.dataTransfer.effectAllowed = 'move';
  });
  row.addEventListener('dragend', () => { state.dragged = null; });
}

function parentFolderOfGroup(org, group) {
  if (!org || !group.sourceId) return null;
  return placementOf(org, group.sourceId)?.folderId ?? null;
}

function isGroupInSubtree(org, group, folderId) {
  let cur = parentFolderOfGroup(org, group);
  const seen = new Set();
  while (cur !== null && !seen.has(cur)) {
    if (cur === folderId) return true;
    seen.add(cur);
    cur = org.folders.find((f) => f.id === cur)?.parentId ?? null;
  }
  return false;
}

function isFolderVisible(org, groups, query, folderId) {
  if (!query.trim()) return true;
  if (groups.some((g) => isGroupInSubtree(org, g, folderId))) return true;
  const self = org.folders.find((f) => f.id === folderId);
  if (self && fuzzyScore(query, self.name) !== null) return true;
  return org.folders.some((f) => f.parentId === folderId && isFolderVisible(org, groups, query, f.id));
}

function appendFolderNameControl(doc, row, folder, state, renderNow) {
  if (state.renamingId === folder.id) {
    row.draggable = false;
    const onCommit = async (name) => {
      state.renamingId = null;
      await state.callbacks.onOrganizationAction?.({ action: 'rename-folder', id: folder.id, name });
      renderNow();
    };
    row.append(buildNameEditor(doc, folder.name, onCommit, () => { state.renamingId = null; renderNow(); }));
    return;
  }
  row.append(button(doc, {
    label: folder.name,
    onClick: () => { state.renamingId = folder.id; renderNow(); },
    attrs: { title: 'Rename', 'data-testid': `folder-name-${folder.id}`, 'data-peer-action': 'rename-folder-trigger' }
  }));
}

function buildFolderRowNode(doc, folder, depth, open, state, renderNow) {
  const { organization, directory, groups, selectedSources, selectedFolders } = state;
  const row = el(doc, 'div', {
    className: 'peer-graph-folder-row',
    attrs: { 'data-testid': `folder-row-${folder.id}`, 'data-drop-active': 'false' }
  });
  row.style.marginLeft = `${depth * 20}px`;
  attachDragSource(row, 'folder', folder.id, state);

  const checkState = directory
    ? folderEntryCheck(directory, folder.id, { sources: selectedSources, folders: selectedFolders })
    : { checked: selectedFolders.has(folder.id), indeterminate: false };
  const sourceIds = new Set((directory?.sources ?? []).map((s) => s.id));
  const empty = folderIsEmpty(organization, folder.id, sourceIds);
  const box = el(doc, 'input', {
    attrs: { type: 'checkbox', 'data-testid': `folder-checkbox-${folder.id}`, 'aria-label': `Select folder ${folder.name}` }
  });
  box.checked = checkState.checked || (empty && selectedFolders.has(folder.id));
  box.indeterminate = checkState.indeterminate;
  box.addEventListener('change', () => state.callbacks.onToggleFolder?.(folder.id, box.checked));

  const toggleBtn = button(doc, {
    label: open ? '▾' : '▸',
    ariaLabel: `Expand folder ${folder.name}`,
    onClick: () => {
      if (state.expanded.has(folder.id)) state.expanded.delete(folder.id);
      else state.expanded.add(folder.id);
      renderNow();
    },
    attrs: { 'data-testid': `folder-toggle-${folder.id}`, 'aria-expanded': String(open) }
  });
  const propIds = new Set(groups.filter((g) => isGroupInSubtree(organization, g, folder.id)).flatMap((g) => g.nodeIds ?? []));
  row.append(box, toggleBtn);
  appendFolderNameControl(doc, row, folder, state, renderNow);
  row.append(el(doc, 'span', { className: 'peer-graph-section-label', text: `${propIds.size} propositions` }));
  return row;
}

function renderTreeLevel(doc, parentId, depth, state, renderNow) {
  const { organization, groups, query } = state;
  const searching = query.trim() !== '';
  const folderItems = (organization?.folders ?? [])
    .filter((f) => f.parentId === parentId && isFolderVisible(organization, groups, query, f.id))
    .sort((a, b) => COLLATOR.compare(a.name, b.name) || a.id.localeCompare(b.id));
  const sourceItems = groups.filter((g) => parentFolderOfGroup(organization, g) === parentId);
  const out = [];

  for (const folder of folderItems) {
    const open = searching || state.expanded.has(folder.id);
    const branch = el(doc, 'div', {
      className: 'peer-graph-folder-branch',
      attrs: { 'data-testid': `source-folder-${folder.id}` }
    });
    bindDropSurface(branch, folder.id, state, renderNow);
    branch.append(buildFolderRowNode(doc, folder, depth, open, state, renderNow));
    if (open) branch.append(...renderTreeLevel(doc, folder.id, depth + 1, state, renderNow));
    out.push(branch);
  }
  for (const group of sourceItems) {
    const node = state.callbacks.renderSourceGroup(group, depth);
    if (group.sourceId) attachDragSource(node, 'source', group.sourceId, state);
    bindDropSurface(node, parentId, state, renderNow);
    out.push(node);
  }
  return out;
}

function renderFolderTreeRoot(doc, root, state, renderNow) {
  if (state.life.dead) return;
  const children = [];
  if (state.creatingFolder) {
    const createRow = el(doc, 'div', { className: 'peer-graph-folder-row', attrs: { 'data-testid': 'new-folder-row' } });
    const saveNewFolder = async (name) => {
      state.creatingFolder = false;
      const createdId = await state.callbacks.onOrganizationAction?.({ action: 'create-folder', name, parentId: null });
      if (typeof createdId === 'string' && createdId) state.expanded.add(createdId);
      renderNow();
    };
    createRow.append(buildNameEditor(doc, '', saveNewFolder, () => { state.creatingFolder = false; renderNow(); }));
    children.push(createRow);
  }
  if (!state.organization) {
    for (const group of state.groups) children.push(state.callbacks.renderSourceGroup(group, 0));
    placeChildren(root, children);
    return;
  }
  children.push(...renderTreeLevel(doc, null, 0, state, renderNow));
  if (typeof state.callbacks.onOrganizationAction === 'function') {
    const dropAttrs = { 'data-testid': 'source-root-drop', 'aria-label': 'Move outside folders', 'data-drop-active': 'false' };
    const rootDrop = el(doc, 'div', { className: 'peer-graph-root-drop', attrs: dropAttrs });
    bindDropSurface(rootDrop, null, state, renderNow);
    children.push(rootDrop);
  }
  placeChildren(root, children);
}

export function createSourceFolderTree(host, callbacks = {}) {
  const doc = documentOf(host);
  const life = createLife();
  const root = el(doc, 'div', { className: 'peer-graph-chains-groups' });
  host.append(root);
  const state = {
    life, callbacks, organization: null, directory: null, groups: [], query: '',
    creatingFolder: false, renamingId: null, dragged: null,
    expanded: new Set(), selectedSources: new Set(), selectedFolders: new Set()
  };
  const renderNow = () => renderFolderTreeRoot(doc, root, state, renderNow);

  const update = (model = {}) => {
    if (life.dead) return;
    state.organization = model.organization ?? model.directory?.organization ?? null;
    state.directory = model.directory ?? (state.organization ? { organization: state.organization, sources: [] } : null);
    state.groups = Array.isArray(model.groups) ? model.groups : [];
    state.query = String(model.searchQuery ?? '');
    state.selectedSources = model.selectedSources instanceof Set ? model.selectedSources : new Set(model.selectedSources ?? []);
    state.selectedFolders = model.selectedFolders instanceof Set ? model.selectedFolders : new Set(model.selectedFolders ?? []);
    for (const f of state.organization?.folders ?? []) {
      if (!state.seenFolders?.has(f.id)) state.expanded.add(f.id);
    }
    state.seenFolders = new Set((state.organization?.folders ?? []).map((f) => f.id));
    renderNow();
  };

  return {
    update,
    startCreateFolder: () => { state.creatingFolder = true; renderNow(); },
    destroy: () => { if (life.destroy()) root.remove(); }
  };
}
