/**
 * Workspace sidebar view (`components/sidebar.tsx` parity + legacy `data-peer-nav` compatibility).
 * Composes New/Practice/Graph navigation, `Mod+K` session search (`focusSearch()`),
 * kind filter, shared session folder tree, inline rename, Markdown export,
 * `CoverageMenuBlock`, `DeleteSessionDialog`, `ActivityDock`, and Settings trigger.
 */
import { button, createLife, documentOf, el, injectUiStyles, placeChildren, show, textNode, writeText } from 'cloudcanvas-lib/ui';
import { buildSessionTree, emptySourceOrganization, flattenSessionTree, folderDeletionScope } from 'peer-engine';
import { createActivityDock } from './activity-dock.js';
import { SESSION_DELETE_COPY, createDeleteSessionDialog, folderDeleteCopy } from './delete-session-dialog.js';
import { createCoverageMenuBlock, timeAgo } from './extraction-coverage.js';
import {
  bindDropZone, buildFolderMenuItems, buildSessionMenuItems,
  renderNewFolderRow, renderSidebarTreeNodes, sessionMeta, triggerMarkdownDownload
} from './sidebar-folders.js';
import { injectSidebarStyles } from './sidebar.css.js';

export { sessionMeta, timeAgo, triggerMarkdownDownload };

function resolveDirectory(model, chats) {
  const rawDir = model?.directory ?? (model?.sources?.organization ? model.sources : null);
  const org = model?.organization ?? rawDir?.organization ?? emptySourceOrganization();
  if (rawDir) return { directory: rawDir, organization: org };
  const sources = (chats ?? []).map((c) => ({ id: c.id, kind: 'chat', label: c.title, createdAt: c.updatedAt ?? '' }));
  return { directory: { organization: org, sources }, organization: org };
}

function resolveChatCoverage(model, chatId, chat) {
  if (!chatId) return null;
  if (chat?.coverage) return chat.coverage;
  const map = model?.coverageByChatId ?? model?.coverages ?? null;
  if (map && typeof map === 'object' && chatId in map) return map[chatId];
  if (model?.coverage && (!model.coverageChatId || model.coverageChatId === chatId)) return model.coverage;
  return null;
}

function positionContextMenu(menuEl, anchorEl, point) {
  const rect = anchorEl?.getBoundingClientRect?.();
  const x = Number.isFinite(point?.x) && point.x > 0 ? point.x : (rect?.left ?? 12);
  const y = Number.isFinite(point?.y) && point.y > 0 ? point.y : (rect?.bottom ?? 48);
  menuEl.style.left = `${Math.max(8, x)}px`;
  menuEl.style.top = `${Math.max(8, y)}px`;
}

function bindMenuDismiss(state, doc, menuEl, anchorEl) {
  state.menuLife?.destroy();
  state.menuLife = null;
  if (!state.ctxChatId && !state.ctxFolderId) return;
  const menuLife = createLife();
  state.menuLife = menuLife;
  menuLife.on(doc, 'pointerdown', (ev) => {
    if (!menuEl.contains(ev.target) && !anchorEl?.contains?.(ev.target)) state.closeMenus();
  });
  const win = doc.defaultView;
  if (!win || typeof win.addEventListener !== 'function') return;
  menuLife.on(win, 'keydown', (ev) => {
    if (ev.key !== 'Escape' || ev.defaultPrevented) return;
    ev.preventDefault();
    ev.stopPropagation();
    state.closeMenus();
  });
}

function buildTopNavSection(doc, life, callbacks) {
  const top = el(doc, 'div', { className: 'peer-sidebar-top' });
  const nav = el(doc, 'nav', { className: 'peer-shell-nav peer-sidebar-actions' });
  const brandRow = el(doc, 'div', { className: 'peer-sidebar-brand-row' });
  brandRow.append(
    button(doc, {
      className: 'peer-sidebar-action-btn', label: 'Graph', signal: life.signal,
      onClick: () => callbacks.onNavigate?.({ name: 'home' }),
      attrs: { 'data-peer-nav': 'home', 'data-testid': 'sidebar-home' }
    }),
    button(doc, {
      className: 'peer-sidebar-icon-btn', label: '×', ariaLabel: 'Close sidebar', signal: life.signal,
      onClick: () => callbacks.onToggleSidebar?.(),
      attrs: { 'data-testid': 'sidebar-close', hidden: typeof callbacks.onToggleSidebar !== 'function' }
    })
  );
  nav.append(
    brandRow,
    button(doc, {
      className: 'peer-sidebar-action-btn', label: 'New', signal: life.signal,
      onClick: () => callbacks.onNavigate?.({ name: 'new-session', mode: 'teach' }),
      attrs: { 'data-peer-nav': 'new-session', 'data-testid': 'new-session', title: 'Teaching' }
    }),
    button(doc, {
      className: 'peer-sidebar-action-btn', label: 'Practice', signal: life.signal,
      onClick: () => callbacks.onNavigate?.({ name: 'new-session', mode: 'practice' }),
      attrs: { 'data-peer-nav': 'new-session-practice', 'data-testid': 'new-session-practice', title: 'Practice' }
    })
  );
  top.append(nav);
  return top;
}

function buildSidebarChrome(doc, life, callbacks, state) {
  const root = el(doc, 'div', { className: 'peer-sidebar-root' });
  const top = buildTopNavSection(doc, life, callbacks);
  const searchBar = el(doc, 'div', { className: 'peer-sidebar-search-bar' });
  const searchInput = el(doc, 'input', {
    className: 'peer-sidebar-search-input',
    attrs: { type: 'search', placeholder: 'Search…', 'aria-label': 'Search sessions', 'data-testid': 'sidebar-search' }
  });
  life.on(searchInput, 'input', () => state.onSearchInput(searchInput.value));
  life.on(searchInput, 'keydown', (ev) => handleSearchKeyDown(ev, searchInput, state, callbacks));
  const newFolderBtn = button(doc, {
    className: 'peer-sidebar-icon-btn', label: '+', ariaLabel: 'Add folder', signal: life.signal,
    onClick: () => { state.creatingFolder = { parentId: null }; state.renderNow(); },
    attrs: { 'data-testid': 'new-folder-button', title: 'Add folder' }
  });
  searchBar.append(el(doc, 'span', { className: 'peer-sidebar-section-label', text: 'Sessions' }), searchInput, newFolderBtn);

  const filterBand = el(doc, 'div', { className: 'peer-sidebar-filter-band', attrs: { 'data-testid': 'session-kind-filter-band' } });
  const filterGroup = el(doc, 'div', { className: 'peer-sidebar-filter-group', attrs: { 'data-testid': 'session-kind-filter' } });
  const filterBtns = new Map();
  for (const [id, label] of [['teach', 'Teaching'], ['practice', 'Practice'], ['all', 'All']]) {
    const fBtn = button(doc, {
      className: 'peer-sidebar-filter-btn', label, signal: life.signal,
      onClick: () => { state.kindFilter = id; callbacks.onSetKindFilter?.(id); state.renderNow(); },
      attrs: { 'data-testid': `kind-filter-${id}`, 'aria-pressed': String(id === 'all') }
    });
    filterBtns.set(id, fBtn);
    filterGroup.append(fBtn);
  }
  filterBand.append(filterGroup);

  const errEl = el(doc, 'div', { className: 'peer-sidebar-error', attrs: { role: 'alert', 'data-testid': 'sidebar-folder-error', hidden: true } });
  const errSpan = el(doc, 'span');
  const errText = textNode(doc, errSpan, '');
  errEl.append(errSpan, button(doc, { label: 'Dismiss', signal: life.signal, onClick: () => { state.folderError = ''; state.renderNow(); } }));

  const listEl = el(doc, 'div', { className: 'peer-sidebar-list', attrs: { 'data-testid': 'session-list' } });
  const activityHost = el(doc, 'div');
  const footer = el(doc, 'div', { className: 'peer-sidebar-footer' });
  footer.append(button(doc, {
    className: 'peer-sidebar-settings-btn', label: 'Settings', signal: life.signal,
    onClick: () => callbacks.onOpenSettings?.(),
    attrs: { 'data-peer-nav': 'settings', 'data-testid': 'settings-entry' }
  }));
  root.append(top, searchBar, filterBand, errEl, listEl, activityHost, footer);
  return { root, searchInput, filterBtns, errEl, errText, listEl, activityHost };
}

function handleSearchKeyDown(ev, inputEl, state, callbacks) {
  if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); inputEl.blur(); return; }
  if (ev.metaKey || ev.ctrlKey || ev.altKey || ev.shiftKey) return;
  const count = state.shownSessions.length;
  if (count === 0) return;
  if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
    ev.preventDefault();
    const dir = ev.key === 'ArrowDown' ? 1 : -1;
    const resetIdx = dir === 1 ? 0 : count - 1;
    state.kbdIndex = state.kbdIndex === null || state.kbdIndex >= count ? resetIdx : (state.kbdIndex + dir + count) % count;
    state.renderNow();
    return;
  }
  if (ev.key === 'Enter') {
    const idx = state.kbdIndex !== null && state.kbdIndex < count ? state.kbdIndex : 0;
    const target = state.shownSessions[idx];
    if (!target) return;
    ev.preventDefault();
    state.kbdIndex = null;
    inputEl.blur();
    callbacks.onNavigate?.({ name: 'session', id: target.id });
  }
}

function syncContextMenuDom(doc, state) {
  const { menuEl, menuItemsHost, menuSep, coverageBlock } = state.overlay;
  if (!state.ctxChatId && !state.ctxFolderId) {
    menuEl.hidden = true;
    menuEl.removeAttribute('data-testid');
    coverageBlock.update({ coverage: null, extracting: false });
    return;
  }
  if (state.ctxChatId) {
    const chat = state.chats.find((c) => c.id === state.ctxChatId);
    if (!chat) { state.closeMenus(); return; }
    menuEl.hidden = false;
    menuEl.setAttribute('data-testid', 'session-context-menu');
    placeChildren(menuItemsHost, buildSessionMenuItems(doc, state, state.withLocalTitle(chat)));
    const cov = resolveChatCoverage(state.rawModel, chat.id, chat);
    const extracting = Boolean(state.extractingIds.has(chat.id) || state.rawModel?.extractingByChatId?.[chat.id]);
    show(menuSep, Boolean(cov));
    coverageBlock.update({ coverage: cov, extracting });
    return;
  }
  const folder = state.organization?.folders?.find((f) => f.id === state.ctxFolderId);
  if (!folder) { state.closeMenus(); return; }
  menuEl.hidden = false;
  menuEl.setAttribute('data-testid', 'folder-context-menu');
  placeChildren(menuItemsHost, buildFolderMenuItems(doc, state, folder));
  show(menuSep, false);
  coverageBlock.update({ coverage: null, extracting: false });
}

function syncSidebarDom(doc, dom, state) {
  if (state.life.dead) return;
  for (const [id, btn] of dom.filterBtns) btn.setAttribute('aria-pressed', String(id === state.kindFilter));
  const errMsg = state.folderError || String(state.rawModel?.folderError ?? state.rawModel?.error ?? '');
  show(dom.errEl, errMsg !== '');
  writeText(dom.errText, errMsg);

  const include = state.kindFilter === 'all' ? undefined : (c) => (c.kind ?? 'teach') === state.kindFilter;
  const decorated = state.chats.map((c) => state.withLocalTitle(c));
  const tree = state.loadingChats ? null : buildSessionTree(decorated, state.organization, { query: state.query, include });
  const flatRows = tree ? flattenSessionTree(tree, (id) => state.isFolderOpen(id)) : null;
  state.shownSessions = flatRows ? flatRows.filter((r) => r.type === 'session').map((r) => r.session) : [];
  state.kbdSessionId = state.kbdIndex !== null ? (state.shownSessions[state.kbdIndex]?.id ?? null) : null;

  const listChildren = [];
  if (state.creatingFolder?.parentId === null || (flatRows && flatRows.length > 0)) {
    const rowsWrap = el(doc, 'div', { attrs: { 'data-testid': 'session-rows' } });
    if (state.creatingFolder?.parentId === null) {
      const createOpts = {
        depth: 0, compact: state.compact,
        onCreate: (name) => state.treeHandlers.onCreateFolder(name, null),
        onCancel: state.treeHandlers.onCancelCreateFolder
      };
      rowsWrap.append(renderNewFolderRow(doc, createOpts));
    }
    if (tree) rowsWrap.append(...renderSidebarTreeNodes(doc, tree, 0, state));
    listChildren.push(rowsWrap);
  }
  if (flatRows === null) {
    listChildren.push(el(doc, 'div', { className: 'peer-sidebar-empty', text: 'Loading…' }));
  } else if (flatRows.length === 0 && !state.creatingFolder) {
    const emptyMsg = state.query.trim() ? 'No sessions match.' : 'No sessions yet.';
    listChildren.push(el(doc, 'div', { className: 'peer-sidebar-empty', text: emptyMsg }));
  }
  const rootDrop = el(doc, 'div', {
    className: 'peer-sidebar-root-drop',
    attrs: { 'data-testid': 'sidebar-root-drop', 'aria-label': 'Move outside folders', 'data-drop-active': 'false' }
  });
  bindDropZone(rootDrop, null, state.organization, state.dragState, state.treeHandlers.onMove);
  listChildren.push(rootDrop);
  placeChildren(dom.listEl, listChildren);
  syncContextMenuDom(doc, state);
}

function createTreeHandlers(doc, state, callbacks) {
  return {
    onToggleFolder: (id) => {
      const setRef = state.query.trim() !== '' ? state.searchFolded : state.collapsedFolders;
      if (setRef.has(id)) setRef.delete(id);
      else setRef.add(id);
      state.renderNow();
    },
    onFolderContextMenu: (ev, folder, anchorEl) => {
      ev.preventDefault();
      state.ctxChatId = null;
      state.ctxFolderId = folder.id;
      positionContextMenu(state.overlay.menuEl, anchorEl, { x: ev.clientX, y: ev.clientY });
      syncContextMenuDom(doc, state);
      bindMenuDismiss(state, doc, state.overlay.menuEl, anchorEl);
    },
    onCreateFolder: (name, parentId) => {
      state.creatingFolder = null;
      callbacks.onSessionsIntent?.({ type: 'source-action', method: 'POST', body: { action: 'create-folder', name, parentId } });
      state.renderNow();
    },
    onCancelCreateFolder: () => { state.creatingFolder = null; state.renderNow(); },
    onCommitRename: (folder, name) => {
      state.renamingFolderId = null;
      const body = { action: 'rename-folder', id: folder.id, name };
      if (name !== folder.name) callbacks.onSessionsIntent?.({ type: 'source-action', method: 'POST', body });
      state.renderNow();
    },
    onCancelRename: () => { state.renamingFolderId = null; state.renderNow(); },
    onMove: (body) => callbacks.onSessionsIntent?.({ type: 'source-action', method: 'POST', body })
  };
}

function attachSidebarActions(doc, state, callbacks) {
  state.withLocalTitle = (chat) => (
    state.localTitles.has(chat.id) ? { ...chat, title: state.localTitles.get(chat.id) } : chat
  );
  state.isFolderOpen = (id) => (
    state.query.trim() !== '' ? !state.searchFolded.has(id) : !state.collapsedFolders.has(id)
  );
  state.onSearchInput = (val) => {
    state.query = val;
    state.kbdIndex = null;
    state.searchFolded.clear();
    callbacks.onSessionsIntent?.({ type: 'set-search', query: val });
    state.renderNow();
  };
  state.commitSessionRename = (id, title) => {
    state.renamingSessionId = null;
    state.localTitles.set(id, title);
    callbacks.onSessionsIntent?.({ type: 'rename-session', id, chatId: id, title });
    state.renderNow();
  };
  state.handleExportMarkdown = (chat) => {
    const hasHandler = typeof callbacks.onExportMarkdown === 'function' || typeof callbacks.onSessionsIntent === 'function';
    callbacks.onExportMarkdown?.(chat.id);
    callbacks.onSessionsIntent?.({ type: 'export-markdown', id: chat.id, chatId: chat.id });
    if (!hasHandler) triggerMarkdownDownload(doc, { chatId: chat.id, title: chat.title });
  };
  state.closeMenus = () => {
    state.ctxChatId = null;
    state.ctxFolderId = null;
    state.menuLife?.destroy();
    state.menuLife = null;
    syncContextMenuDom(doc, state);
  };
  state.openSessionMenu = (ev, chat, anchorEl) => {
    ev.preventDefault();
    state.ctxFolderId = null;
    state.ctxChatId = chat.id;
    callbacks.onRequestCoverage?.(chat.id);
    positionContextMenu(state.overlay.menuEl, anchorEl, { x: ev.clientX, y: ev.clientY });
    syncContextMenuDom(doc, state);
    bindMenuDismiss(state, doc, state.overlay.menuEl, anchorEl);
  };
  state.treeHandlers = createTreeHandlers(doc, state, callbacks);
}

function attachDeleteFlows(state, callbacks) {
  const setDeleteModel = (next) => {
    state.deleteTarget = next;
    if (next) callbacks.layers?.push?.({ id: 'delete-session', kind: 'modal', onEscape: () => setDeleteModel(null) });
    else callbacks.layers?.remove?.('delete-session');
    state.overlay.deleteDialog.update(next);
  };
  state.openDeleteSession = (chat) => {
    setDeleteModel({ kind: 'session', id: chat.id, title: chat.title, copy: SESSION_DELETE_COPY });
  };
  state.requestDeleteFolder = (folderId) => {
    const folder = state.organization?.folders?.find((f) => f.id === folderId);
    const scope = state.directory ? folderDeletionScope(state.directory, folderId) : null;
    if (!folder || !scope) return;
    if (scope.chatIds.length === 0) {
      callbacks.onSessionsIntent?.({ type: 'delete-folder', id: folderId, folderId, mode: 'preserve-graph', scope });
      return;
    }
    const parentName = folder.parentId === null
      ? null
      : (state.organization.folders.find((f) => f.id === folder.parentId)?.name ?? null);
    const copy = folderDeleteCopy({
      sessions: scope.chatIds.length,
      subfolders: Math.max(0, scope.folderIds.length - 1),
      notes: scope.noteIds.length,
      parentName
    });
    setDeleteModel({ kind: 'folder', id: folderId, title: folder.name, copy, scope });
  };
  state.confirmDelete = async ({ kind, id, mode }) => {
    const intent = kind === 'folder'
      ? { type: 'delete-folder', id, folderId: id, mode, scope: state.deleteTarget?.scope ?? null }
      : { type: 'delete-session', id, chatId: id, mode };
    await callbacks.onSessionsIntent?.(intent);
    const deletedActive = kind === 'session'
      ? state.activeChatId === id
      : Boolean(state.deleteTarget?.scope?.chatIds?.includes(state.activeChatId));
    setDeleteModel(null);
    if (deletedActive) callbacks.onNavigate?.({ name: 'home' });
  };
}

function buildOverlayControls(doc, overlayHost, state, callbacks) {
  const menuEl = el(doc, 'div', { className: 'peer-sidebar-context-menu', attrs: { hidden: true } });
  const menuItemsHost = el(doc, 'div');
  const menuSep = el(doc, 'div', { className: 'peer-sidebar-menu-sep', attrs: { 'aria-hidden': 'true', hidden: true } });
  const covHost = el(doc, 'div');
  const coverageBlock = createCoverageMenuBlock(covHost, {
    onExtract: () => {
      if (!state.ctxChatId) return;
      const id = state.ctxChatId;
      state.extractingIds.add(id);
      callbacks.onExtractSession?.(id);
      callbacks.onSessionsIntent?.({ type: 'extract-session', id, chatId: id });
      syncContextMenuDom(doc, state);
    }
  });
  menuEl.append(menuItemsHost, menuSep, covHost);
  overlayHost.append(menuEl);
  const deleteDialog = createDeleteSessionDialog(overlayHost, {
    onClose: () => {
      state.deleteTarget = null;
      callbacks.layers?.remove?.('delete-session');
      deleteDialog.update(null);
    },
    onConfirm: (payload) => state.confirmDelete(payload)
  });
  return { menuEl, menuItemsHost, menuSep, coverageBlock, deleteDialog };
}

function applySidebarModelUpdate(doc, dom, state, model = {}) {
  if (state.life.dead) return;
  const slice = model?.sessionsStore ?? model;
  state.rawModel = slice ?? {};
  const rawList = Array.isArray(slice?.sessions)
    ? slice.sessions
    : (Array.isArray(slice?.chats) ? slice.chats : (Array.isArray(model?.sessions) ? model.sessions : null));
  state.loadingChats = rawList === null && slice?.load === 'loading';
  state.chats = rawList ?? [];
  for (const chat of state.chats) {
    if (state.localTitles.get(chat.id) === chat.title) state.localTitles.delete(chat.id);
    if (resolveChatCoverage(state.rawModel, chat.id, chat)?.running) state.extractingIds.delete(chat.id);
  }
  const resolved = resolveDirectory(slice, state.chats);
  state.directory = resolved.directory;
  state.organization = resolved.organization;
  state.activeChatId = model?.activeChatId ?? slice?.activeChatId ?? null;
  const app = model?.appearance ?? slice?.appearance ?? null;
  state.compact = Boolean(model?.compact ?? app?.compactSessionList);
  state.serif = Boolean(model?.serif ?? app?.sessionNameSerif);

  const incomingQuery = slice?.query ?? slice?.search ?? slice?.searchQuery;
  if (incomingQuery !== undefined && incomingQuery !== state.lastModelQuery) {
    state.lastModelQuery = incomingQuery;
    state.query = String(incomingQuery);
    if (doc.activeElement !== dom.searchInput) dom.searchInput.value = state.query;
  }
  const incomingFilter = slice?.kindFilter ?? slice?.filter;
  if (incomingFilter === 'teach' || incomingFilter === 'practice' || incomingFilter === 'all') {
    state.kindFilter = incomingFilter;
  }
  const exportPayload = slice?.lastExport ?? model?.lastExport ?? null;
  if (exportPayload && exportPayload !== state.seenExport) {
    state.seenExport = exportPayload;
    triggerMarkdownDownload(doc, {
      filename: exportPayload.filename,
      markdown: exportPayload.markdown ?? exportPayload.content,
      chatId: exportPayload.chatId ?? exportPayload.id,
      title: exportPayload.title
    });
  }
  state.activityDock.update(model?.activity ?? slice?.activity ?? {});
  state.renderNow();
}

export function createSidebarView(host, callbacks = {}) {
  const doc = documentOf(host);
  injectUiStyles(doc);
  injectSidebarStyles(doc);
  const life = createLife();
  const state = {
    life, callbacks, rawModel: {}, chats: [], loadingChats: false, directory: null, organization: emptySourceOrganization(),
    activeChatId: null, compact: false, serif: false, query: '', lastModelQuery: undefined, kindFilter: 'all',
    kbdIndex: null, kbdSessionId: null, shownSessions: [], collapsedFolders: new Set(), searchFolded: new Set(),
    creatingFolder: null, renamingFolderId: null, renamingSessionId: null, localTitles: new Map(),
    ctxChatId: null, ctxFolderId: null, menuLife: null, dragState: { current: null }, folderError: '',
    extractingIds: new Set(), seenExport: null, deleteTarget: null, overlay: null, activityDock: null, renderNow: null
  };
  const dom = buildSidebarChrome(doc, life, callbacks, state);
  attachDeleteFlows(state, callbacks);
  state.overlay = buildOverlayControls(doc, callbacks.layerHost ?? dom.root, state, callbacks);
  attachSidebarActions(doc, state, callbacks);
  state.activityDock = createActivityDock(dom.activityHost, {
    onAbort: (req) => callbacks.onActivityAbort?.(req),
    onNavigateSession: (chatId) => callbacks.onNavigate?.({ name: 'session', id: chatId })
  });
  state.renderNow = () => syncSidebarDom(doc, dom, state);
  host.append(dom.root);
  state.renderNow();

  const focusSearch = () => {
    if (life.dead) return;
    dom.searchInput.focus();
    dom.searchInput.select?.();
    queueMicrotask(() => {
      if (life.dead || doc.activeElement === dom.searchInput) return;
      dom.searchInput.focus();
      dom.searchInput.select?.();
    });
  };
  const destroy = () => {
    if (!life.destroy()) return;
    state.menuLife?.destroy();
    callbacks.layers?.remove?.('delete-session');
    state.overlay.coverageBlock.destroy();
    state.overlay.deleteDialog.destroy();
    state.overlay.menuEl.remove();
    state.activityDock.destroy();
    dom.root.remove();
  };
  return { root: dom.root, update: (m) => applySidebarModelUpdate(doc, dom, state, m), focusSearch, destroy };
}
