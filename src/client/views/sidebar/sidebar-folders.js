/**
 * Shared session-sidebar folder tree helpers, drag/drop bindings,
 * context-menu item builders, and session/folder tree row renderers
 * (`components/sidebar-folders.tsx` & `components/sidebar.tsx` parity).
 */
import { button, el } from 'cloudcanvas-lib/ui';
import { canMoveFolder, placementOf } from 'peer-engine';
import { timeAgo } from './extraction-coverage.js';

export const SIDEBAR_TREE_INDENT = 18;
export const SOURCE_DRAG_TYPE = 'application/x-learnharness-source';

const CHEVRON_INSET = 4;

export function sidebarRowPadding(depth) {
  return 12 + depth * SIDEBAR_TREE_INDENT;
}

export function sidebarRail(depth) {
  return sidebarRowPadding(depth) - CHEVRON_INSET + 7;
}

export function sidebarRuleInset(depth) {
  return depth === 0 ? 0 : sidebarRail(depth - 1);
}

export function sidebarRowBox(depth) {
  const inset = sidebarRuleInset(depth);
  return { marginLeft: inset, paddingLeft: sidebarRowPadding(depth) - inset };
}

export function sidebarFolderBox(depth) {
  const inset = sidebarRuleInset(depth);
  return { marginLeft: inset, paddingLeft: sidebarRowPadding(depth) - CHEVRON_INSET - inset };
}

export function sessionMeta(chat, now = new Date()) {
  if (chat?.compacting) return `Compacting context · ${timeAgo(chat.updatedAt, now)}`;
  if (chat?.pendingQuestion) return `Waiting for input · ${timeAgo(chat.updatedAt, now)}`;
  if ((chat?.kind ?? 'teach') === 'practice' && chat?.pendingProblem) {
    return `Problem waiting · ${timeAgo(chat.updatedAt, now)}`;
  }
  if (chat?.busy) return 'Working…';
  return timeAgo(chat?.updatedAt, now);
}

function slugifyTitle(title) {
  const slug = String(title ?? '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || 'session';
}

export function triggerMarkdownDownload(doc, { filename, markdown, chatId, title }) {
  const targetBody = doc?.body;
  if (!targetBody) return;
  const anchor = doc.createElement('a');
  const safeName = filename || `${slugifyTitle(title)}.md`;
  const urlObj = doc.defaultView?.URL ?? globalThis.URL;
  if (typeof markdown === 'string' && typeof urlObj?.createObjectURL === 'function') {
    const blobUrl = urlObj.createObjectURL(new Blob([markdown], { type: 'text/markdown;charset=utf-8' }));
    anchor.href = blobUrl;
    anchor.download = safeName;
    targetBody.append(anchor);
    anchor.click();
    anchor.remove();
    urlObj.revokeObjectURL?.(blobUrl);
    return;
  }
  anchor.href = `/api/chats/${encodeURIComponent(String(chatId ?? ''))}/markdown`;
  anchor.download = safeName;
  targetBody.append(anchor);
  anchor.click();
  anchor.remove();
}

export function buildInlineNameInput(doc, {
  initialValue = '', placeholder = '', ariaLabel = '', testId = '', onCommit, onCancel
}) {
  const attrs = {
    type: 'text',
    spellcheck: 'false',
    placeholder,
    'aria-label': ariaLabel,
    ...(testId ? { 'data-testid': testId } : {})
  };
  const inputEl = el(doc, 'input', { className: 'peer-sidebar-inline-input', attrs });
  inputEl.value = initialValue;
  let settled = false;
  const finishCommit = () => {
    if (settled) return;
    settled = true;
    const trimmed = inputEl.value.trim();
    if (!trimmed) { onCancel?.(); return; }
    onCommit?.(trimmed);
  };
  inputEl.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      settled = true;
      onCancel?.();
      return;
    }
    if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); finishCommit(); }
  });
  inputEl.addEventListener('blur', finishCommit);
  inputEl.addEventListener('dragstart', (ev) => { ev.preventDefault(); ev.stopPropagation(); });
  queueMicrotask(() => {
    if (!inputEl.isConnected) return;
    inputEl.focus();
    inputEl.select?.();
  });
  return inputEl;
}

function readDragPayload(event, fallback) {
  try {
    const raw = event.dataTransfer?.getData?.(SOURCE_DRAG_TYPE);
    const parsed = raw ? JSON.parse(raw) : null;
    if (parsed && (parsed.kind === 'source' || parsed.kind === 'folder') && typeof parsed.id === 'string') {
      return parsed;
    }
  } catch { /* ignore non-json drag payloads */ }
  return fallback ?? null;
}

export function bindDragSource(node, kind, id, dragState, enabled = true) {
  if (!enabled || !id) return;
  node.draggable = true;
  node.setAttribute('data-source-drag-row', id);
  node.addEventListener('dragstart', (event) => {
    if (event.target?.closest?.('input,textarea')) { event.preventDefault(); return; }
    dragState.current = { kind, id };
    event.dataTransfer?.setData?.(SOURCE_DRAG_TYPE, JSON.stringify({ kind, id }));
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
  });
  node.addEventListener('dragend', () => { dragState.current = null; });
}

export function bindDropZone(node, parentId, organization, dragState, onMove) {
  if (!organization || typeof onMove !== 'function') return;
  node.setAttribute('data-drop-active', 'false');
  node.addEventListener('dragover', (event) => {
    const types = Array.from(event.dataTransfer?.types ?? []);
    if (!dragState.current && !types.includes(SOURCE_DRAG_TYPE)) return;
    const active = dragState.current;
    const valid = active?.kind !== 'folder' || canMoveFolder(organization, active.id, parentId);
    if (!valid) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    node.setAttribute('data-drop-active', 'true');
  });
  node.addEventListener('dragleave', (event) => {
    if (node.contains(event.relatedTarget)) return;
    event.stopPropagation();
    node.setAttribute('data-drop-active', 'false');
  });
  node.addEventListener('drop', (event) => {
    const item = readDragPayload(event, dragState.current);
    node.setAttribute('data-drop-active', 'false');
    dragState.current = null;
    if (!item) return;
    event.preventDefault();
    event.stopPropagation();
    if (item.kind === 'folder' && !canMoveFolder(organization, item.id, parentId)) return;
    onMove({ action: 'move', kind: item.kind, id: item.id, parentId });
  });
}

export function renderFolderRule(doc, depth, edge) {
  const rule = el(doc, 'div', {
    className: `peer-sidebar-folder-rule is-${edge}`,
    attrs: { 'aria-hidden': 'true', 'data-sidebar-folder-rule': edge }
  });
  rule.style.left = `${sidebarRuleInset(depth)}px`;
  return rule;
}

export function renderNewFolderRow(doc, { depth, compact = false, onCreate, onCancel }) {
  const box = sidebarFolderBox(depth);
  const row = el(doc, 'div', {
    className: `peer-sidebar-folder-edit${compact ? ' is-compact' : ''}`,
    attrs: { 'data-testid': 'sidebar-new-folder-row' }
  });
  row.style.marginLeft = `${box.marginLeft}px`;
  row.style.paddingLeft = `${box.paddingLeft}px`;
  const inputOpts = {
    initialValue: '',
    placeholder: 'Folder name',
    ariaLabel: 'New folder name',
    testId: 'sidebar-folder-name-input',
    onCommit: onCreate,
    onCancel
  };
  row.append(el(doc, 'span', { text: '📁', attrs: { 'aria-hidden': 'true' } }), buildInlineNameInput(doc, inputOpts));
  return row;
}

function buildFolderHeadingRow(doc, { folder, depth, open, compact, renaming, dragState, handlers }) {
  const rowBox = sidebarRowBox(depth);
  const folderBox = sidebarFolderBox(depth);
  const wrap = el(doc, 'div', {
    className: 'peer-sidebar-folder-row',
    attrs: { 'data-testid': `sidebar-folder-row-${folder.id}`, 'data-folder-id': folder.id, 'data-drop-active': 'false' }
  });
  wrap.style.marginLeft = `${rowBox.marginLeft}px`;
  bindDragSource(wrap, 'folder', folder.id, dragState, !renaming);

  if (renaming) {
    const editRow = el(doc, 'div', { className: `peer-sidebar-folder-edit${compact ? ' is-compact' : ''}` });
    editRow.style.paddingLeft = `${folderBox.paddingLeft}px`;
    const inputOpts = {
      initialValue: folder.name,
      ariaLabel: `Rename folder ${folder.name}`,
      testId: 'sidebar-folder-name-input',
      onCommit: (name) => handlers.onCommitRename(folder, name),
      onCancel: handlers.onCancelRename
    };
    editRow.append(el(doc, 'span', { text: open ? '▾' : '▸', attrs: { 'aria-hidden': 'true' } }), buildInlineNameInput(doc, inputOpts));
    wrap.append(editRow);
    return wrap;
  }

  const btnAttrs = {
    type: 'button',
    'data-testid': 'sidebar-folder',
    'data-folder-id': folder.id,
    'aria-expanded': String(Boolean(open)),
    'aria-label': `${open ? 'Collapse' : 'Expand'} folder ${folder.name}`
  };
  const btn = el(doc, 'button', { className: `peer-sidebar-folder-btn${compact ? ' is-compact' : ''}`, attrs: btnAttrs });
  btn.style.paddingLeft = `${folderBox.paddingLeft}px`;
  const nameEl = el(doc, 'span', { className: `peer-sidebar-name${compact ? ' is-compact' : ''}`, text: folder.name });
  btn.append(el(doc, 'span', { text: open ? '▾' : '▸', attrs: { 'aria-hidden': 'true' } }), nameEl);
  btn.addEventListener('click', () => handlers.onToggleFolder(folder.id));
  btn.addEventListener('contextmenu', (ev) => handlers.onFolderContextMenu(ev, folder, btn));
  wrap.append(btn);
  return wrap;
}

export function renderFolderBranch(doc, {
  folder, childrenNodes, prevIsFolder, depth, compact, open,
  creatingFolder, renamingFolderId, organization, dragState, handlers, renderChildren
}) {
  const branch = el(doc, 'div', {
    className: 'peer-sidebar-folder-branch',
    attrs: { 'data-testid': `sidebar-folder-branch-${folder.id}`, 'data-folder-id': folder.id }
  });
  bindDropZone(branch, folder.id, organization, dragState, handlers.onMove);
  if (!prevIsFolder) branch.append(renderFolderRule(doc, depth, 'top'));
  const creatingHere = creatingFolder?.parentId === folder.id;
  if (open && (childrenNodes.length > 0 || creatingHere)) {
    const thread = el(doc, 'div', {
      className: 'peer-sidebar-folder-thread',
      attrs: { 'aria-hidden': 'true', 'data-testid': `sidebar-folder-thread-${folder.id}` }
    });
    thread.style.left = `${sidebarRail(depth)}px`;
    branch.append(thread);
  }
  branch.append(buildFolderHeadingRow(doc, {
    folder, depth, open, compact, renaming: renamingFolderId === folder.id, dragState, handlers
  }));
  if (open && creatingHere) {
    branch.append(renderNewFolderRow(doc, {
      depth: depth + 1, compact, onCreate: (name) => handlers.onCreateFolder(name, folder.id), onCancel: handlers.onCancelCreateFolder
    }));
  }
  if (open) branch.append(...renderChildren(childrenNodes, depth + 1));
  branch.append(renderFolderRule(doc, depth, 'bottom'));
  return branch;
}

function buildSessionRenameRow(doc, chat, rowBox, compact, state) {
  const editRow = el(doc, 'div', {
    className: `peer-sidebar-rename-row${compact ? ' is-compact' : ''}`,
    attrs: { 'data-testid': 'session-rename-row' }
  });
  editRow.style.paddingLeft = `${rowBox.paddingLeft}px`;
  const col = el(doc, 'span', { className: 'peer-sidebar-row-body' });
  const inputOpts = {
    initialValue: chat.title,
    ariaLabel: 'Rename session',
    testId: 'session-rename-input',
    onCommit: (nextTitle) => state.commitSessionRename(chat.id, nextTitle),
    onCancel: () => { state.renamingSessionId = null; state.renderNow(); }
  };
  col.append(buildInlineNameInput(doc, inputOpts));
  if (!compact) col.append(el(doc, 'span', { className: 'peer-sidebar-meta', text: sessionMeta(chat) }));
  editRow.append(col);
  return editRow;
}

export function renderSessionItemRow(doc, { chat, depth, compact, serif, active, kbdSelected, renaming, placedIn, state }) {
  const rowBox = sidebarRowBox(depth);
  const wrap = el(doc, 'div', { className: 'peer-sidebar-drag-row' });
  wrap.style.marginLeft = `${rowBox.marginLeft}px`;
  bindDragSource(wrap, 'source', chat.id, state.dragState, !renaming);
  bindDropZone(wrap, placedIn, state.organization, state.dragState, state.treeHandlers.onMove);
  if (renaming) {
    wrap.append(buildSessionRenameRow(doc, chat, rowBox, compact, state));
    return wrap;
  }
  const attrs = {
    type: 'button',
    'data-testid': 'session-row',
    'data-chat-id': chat.id,
    'data-session-id': chat.id,
    'data-peer-active': String(Boolean(active)),
    ...(active ? { 'aria-current': 'page' } : {}),
    ...(kbdSelected ? { 'data-kbd-selected': 'true' } : {})
  };
  const rowBtn = el(doc, 'button', { className: `peer-sidebar-session-row${compact ? ' is-compact' : ''}`, attrs });
  rowBtn.style.paddingLeft = `${rowBox.paddingLeft}px`;
  if (chat.busy || chat.compacting) {
    rowBtn.append(el(doc, 'span', { text: '⠋', attrs: { 'aria-hidden': 'true', 'data-peer-busy-spinner': '' } }));
  }
  const bodyCol = el(doc, 'span', { className: 'peer-sidebar-row-body' });
  const nameCls = `peer-sidebar-name${compact ? ' is-compact' : ''}${serif && !compact ? ' is-serif' : ''}`;
  bodyCol.append(el(doc, 'span', { className: nameCls, text: chat.title ?? '' }));
  if (!compact) bodyCol.append(el(doc, 'span', { className: 'peer-sidebar-meta', text: sessionMeta(chat) }));
  rowBtn.append(bodyCol);
  if ((chat.kind ?? 'teach') === 'practice') {
    rowBtn.append(el(doc, 'span', { className: 'peer-sidebar-meta', text: 'Practice', attrs: { 'aria-label': 'Practice session' } }));
  }
  rowBtn.addEventListener('click', () => { state.kbdIndex = null; state.callbacks.onNavigate?.({ name: 'session', id: chat.id }); });
  rowBtn.addEventListener('contextmenu', (ev) => state.openSessionMenu(ev, chat, rowBtn));
  wrap.append(rowBtn);
  return wrap;
}

export function renderSidebarTreeNodes(doc, nodes, depth, state) {
  const out = [];
  for (let i = 0; i < nodes.length; i += 1) {
    const node = nodes[i];
    if (node.type === 'session') {
      const chat = state.withLocalTitle(node.session);
      const placedIn = placementOf(state.organization, chat.id)?.folderId ?? null;
      const active = chat.id === state.activeChatId;
      const kbdSelected = state.kbdSessionId === chat.id;
      const renaming = state.renamingSessionId === chat.id;
      out.push(renderSessionItemRow(doc, {
        chat, depth, compact: state.compact, serif: state.serif, active, kbdSelected, renaming, placedIn, state
      }));
      continue;
    }
    out.push(renderFolderBranch(doc, {
      folder: node.folder,
      childrenNodes: node.children,
      prevIsFolder: nodes[i - 1]?.type === 'folder',
      depth,
      compact: state.compact,
      open: state.isFolderOpen(node.folder.id),
      creatingFolder: state.creatingFolder,
      renamingFolderId: state.renamingFolderId,
      organization: state.organization,
      dragState: state.dragState,
      handlers: state.treeHandlers,
      renderChildren: (children, nextDepth) => renderSidebarTreeNodes(doc, children, nextDepth, state)
    }));
  }
  return out;
}

function menuButton(doc, label, testId, onClick) {
  return button(doc, {
    className: 'peer-sidebar-menu-item',
    label,
    onClick,
    attrs: { 'data-testid': testId }
  });
}

export function buildSessionMenuItems(doc, state, chat) {
  const moveTo = (parentId) => {
    state.treeHandlers.onMove({ action: 'move', kind: 'source', id: chat.id, parentId });
    state.closeMenus();
  };
  const items = [
    menuButton(doc, 'Rename', 'ctx-rename', () => { state.renamingSessionId = chat.id; state.closeMenus(); state.renderNow(); }),
    menuButton(doc, 'Export as Markdown…', 'ctx-export-md', () => { state.handleExportMarkdown(chat); state.closeMenus(); })
  ];
  const currentFolder = placementOf(state.organization, chat.id)?.folderId ?? null;
  for (const folder of state.organization?.folders ?? []) {
    if (folder.id === currentFolder) continue;
    items.push(menuButton(doc, `Move to ${folder.name}`, `ctx-move-folder-${folder.id}`, () => moveTo(folder.id)));
  }
  if (currentFolder !== null) items.push(menuButton(doc, 'Move to top level', 'ctx-move-root', () => moveTo(null)));
  items.push(menuButton(doc, 'Delete…', 'ctx-delete', () => { state.closeMenus(); state.openDeleteSession(chat); }));
  return items;
}

export function buildFolderMenuItems(doc, state, folder) {
  const moveFolder = (parentId) => {
    state.treeHandlers.onMove({ action: 'move', kind: 'folder', id: folder.id, parentId });
    state.closeMenus();
  };
  const startSubfolder = () => {
    state.collapsedFolders.delete(folder.id);
    state.creatingFolder = { parentId: folder.id };
    state.closeMenus();
    state.renderNow();
  };
  const items = [
    menuButton(doc, 'Rename', 'folder-ctx-rename', () => { state.renamingFolderId = folder.id; state.closeMenus(); state.renderNow(); }),
    menuButton(doc, 'New subfolder', 'folder-ctx-new-subfolder', startSubfolder)
  ];
  for (const target of state.organization?.folders ?? []) {
    if (target.id === folder.id || target.id === folder.parentId) continue;
    if (!canMoveFolder(state.organization, folder.id, target.id)) continue;
    items.push(menuButton(doc, `Move to ${target.name}`, `folder-ctx-move-${target.id}`, () => moveFolder(target.id)));
  }
  if (folder.parentId !== null) items.push(menuButton(doc, 'Move to top level', 'folder-ctx-move-root', () => moveFolder(null)));
  items.push(menuButton(doc, 'Delete', 'folder-ctx-delete', () => { state.closeMenus(); state.requestDeleteFolder(folder.id); }));
  return items;
}
