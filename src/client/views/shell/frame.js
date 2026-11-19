/**
 * Shell DOM skeleton (`views §2.1`) and persistent layer overlays (`cheat-sheet`
 * and Sprint C1 `Settings -> Data` LearnHarness importer, `views §2.5` item 4).
 * Never touches `<html>` (`R6`).
 */
import { button, createLife, documentOf, el, injectUiStyles, input, textNode, writeText } from 'cloudcanvas-lib/ui';
import { KEYBOARD_ACTIONS, formatBinding } from './keys.js';
import { injectShellStyles } from './shell.css.js';

const CHEAT_SCOPES = [
  ['global', 'Global'],
  ['chat', 'Chat'],
  ['graph', 'Graph view']
];

function appendCheatScopeGroup(doc, modal, scope, heading) {
  const actions = KEYBOARD_ACTIONS.filter((item) => item.scope === scope);
  if (actions.length === 0) return;
  const group = el(doc, 'div', { className: 'peer-shell-cheat-group' });
  group.append(el(doc, 'div', { className: 'peer-shell-cheat-heading', text: heading }));
  for (const item of actions) {
    const row = el(doc, 'div', { className: 'peer-shell-cheat-row' });
    const kbd = el(doc, 'kbd', { className: 'peer-shell-kbd', text: formatBinding(item.binding) });
    row.append(el(doc, 'span', { text: item.label }), kbd);
    group.append(row);
  }
  modal.append(group);
}

function buildCheatSheetOverlay(doc, onClose) {
  const life = createLife();
  const backdrop = el(doc, 'div', {
    className: 'peer-shell-backdrop',
    attrs: { 'data-testid': 'cheat-sheet', 'data-peer-layer': 'cheat-sheet' }
  });
  const modal = el(doc, 'section', {
    className: 'peer-shell-modal',
    attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Keyboard shortcuts', tabindex: '-1' }
  });
  const header = el(doc, 'div', { className: 'peer-shell-modal-header' });
  header.append(
    el(doc, 'h2', { className: 'peer-shell-modal-title', text: 'Keyboard shortcuts' }),
    button(doc, { label: 'Close', signal: life.signal, onClick: () => onClose?.() })
  );
  modal.append(header);
  for (const [scope, heading] of CHEAT_SCOPES) appendCheatScopeGroup(doc, modal, scope, heading);
  life.on(backdrop, 'click', (event) => { if (event.target === backdrop) onClose?.(); });
  backdrop.append(modal);
  return { node: backdrop, destroy: () => { if (life.destroy()) backdrop.remove(); } };
}

function formatImportReportItems(report) {
  if (!report || typeof report !== 'object') return [];
  return [
    `Chats imported: ${Number(report.chatsImported ?? 0)}`,
    `Nodes imported: ${Number(report.nodesImported ?? 0)}`,
    `Chains imported: ${Number(report.chainsImported ?? 0)}`,
    `Sources imported: ${Number(report.sourcesImported ?? 0)}`,
    `Objects stored: ${Number(report.objectsStored ?? 0)}`,
    `Themes imported: ${Number(report.themesImported ?? 0)}`,
    `Prompts imported: ${Number(report.promptsImported ?? 0)}`,
    `Flashcard decks imported: ${Number(report.flashcardDecksImported ?? 0)}`,
    `Settings imported: ${report.settingsImported ? 'yes' : 'no'}`,
    `Corrupt files skipped: ${Number(report.corruptFilesSkipped ?? 0)}`
  ];
}

function buildImportSection(doc, life, onImportData) {
  const section = el(doc, 'div', { className: 'peer-shell-import-section', attrs: { 'data-peer-settings-section': 'data' } });
  section.append(el(doc, 'strong', { text: 'Data · Import LearnHarness Data' }));
  const row = el(doc, 'div', { className: 'peer-shell-import-row' });
  const dirInput = input(doc, {
    label: 'LearnHarness data directory',
    placeholder: '/path/to/learnharness/data',
    signal: life.signal,
    attrs: { 'data-peer-import-input': '' }
  });
  const submitImport = () => {
    const sourceDirectory = dirInput.value.trim();
    if (sourceDirectory) onImportData?.(sourceDirectory);
  };
  const importBtn = button(doc, {
    className: 'is-primary',
    label: 'Import LearnHarness Data',
    signal: life.signal,
    attrs: { 'data-peer-action': 'import-learnharness' },
    onClick: submitImport
  });
  row.append(dirInput, importBtn);
  const errorEl = el(doc, 'p', { className: 'peer-shell-import-error', attrs: { 'data-peer-import-error': '', hidden: true } });
  const errorText = textNode(doc, errorEl);
  const reportList = el(doc, 'ul', { className: 'peer-shell-import-report', attrs: { 'data-peer-import-report': '', hidden: true } });
  section.append(row, errorEl, reportList);
  return { section, errorEl, errorText, reportList };
}

function buildSettingsOverlay(doc, callbacks) {
  const life = createLife();
  const backdrop = el(doc, 'div', {
    className: 'peer-shell-backdrop',
    attrs: { 'data-testid': 'settings-dialog', 'data-peer-layer': 'settings' }
  });
  const modal = el(doc, 'section', {
    className: 'peer-shell-modal',
    attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Settings', tabindex: '-1' }
  });
  const header = el(doc, 'div', { className: 'peer-shell-modal-header' });
  const titleEl = el(doc, 'h2', { className: 'peer-shell-modal-title' });
  const titleText = textNode(doc, titleEl, 'Settings');
  header.append(titleEl, button(doc, { label: 'Close', signal: life.signal, onClick: () => callbacks.onCloseSettings?.() }));
  const importer = buildImportSection(doc, life, callbacks.onImportData);
  modal.append(header, importer.section);
  life.on(backdrop, 'click', (event) => { if (event.target === backdrop) callbacks.onCloseSettings?.(); });
  backdrop.append(modal);

  const update = (shellSection, settingsModel) => {
    writeText(titleText, shellSection ? `Settings · ${shellSection}` : 'Settings');
    const err = String(settingsModel?.error ?? '').trim();
    writeText(importer.errorText, err);
    importer.errorEl.hidden = err === '';
    const lines = formatImportReportItems(settingsModel?.lastImport);
    importer.reportList.hidden = lines.length === 0;
    importer.reportList.replaceChildren(...lines.map((line) => el(doc, 'li', { text: line })));
  };

  return { node: backdrop, update, destroy: () => { if (life.destroy()) backdrop.remove(); } };
}

function buildSidebar(doc, life, callbacks) {
  const side = el(doc, 'aside', { className: 'peer-shell-side', attrs: { 'aria-label': 'Workspace navigation' } });
  const nav = el(doc, 'nav', { className: 'peer-shell-nav' });
  nav.append(
    button(doc, {
      label: 'New', signal: life.signal, attrs: { 'data-peer-nav': 'new-session' },
      onClick: () => callbacks.onNavigate?.({ name: 'new-session', mode: 'teach' })
    }),
    button(doc, {
      label: 'Graph', signal: life.signal, attrs: { 'data-peer-nav': 'home' },
      onClick: () => callbacks.onNavigate?.({ name: 'home' })
    }),
    button(doc, {
      label: 'Settings', signal: life.signal, attrs: { 'data-peer-nav': 'settings' },
      onClick: () => callbacks.onOpenSettings?.()
    })
  );
  side.append(nav);
  return side;
}

function syncLayerOverlays(state, shellModel, settingsModel) {
  const wantSettings = Boolean(shellModel?.settings?.open);
  if (wantSettings && !state.settingsOverlay) {
    state.settingsOverlay = buildSettingsOverlay(state.doc, state.callbacks);
    state.layerHost.append(state.settingsOverlay.node);
    state.layers?.push({ id: 'settings', kind: 'modal', onEscape: () => state.callbacks.onCloseSettings?.() });
  } else if (!wantSettings && state.settingsOverlay) {
    state.layers?.remove('settings');
    state.settingsOverlay.destroy();
    state.settingsOverlay = null;
  }
  if (state.settingsOverlay) state.settingsOverlay.update(shellModel?.settings?.section ?? null, settingsModel);

  const wantCheat = Boolean(shellModel?.cheatSheet);
  if (wantCheat && !state.cheatOverlay) {
    state.cheatOverlay = buildCheatSheetOverlay(state.doc, state.callbacks.onCloseCheatSheet);
    state.layerHost.append(state.cheatOverlay.node);
    state.layers?.push({ id: 'cheat-sheet', kind: 'modal', onEscape: () => state.callbacks.onCloseCheatSheet?.() });
  } else if (!wantCheat && state.cheatOverlay) {
    state.layers?.remove('cheat-sheet');
    state.cheatOverlay.destroy();
    state.cheatOverlay = null;
  }
}

export function createShellFrame(host, { layers, ...callbacks } = {}) {
  const doc = documentOf(host);
  injectUiStyles(doc);
  injectShellStyles(doc);
  const life = createLife();
  const root = el(doc, 'div', {
    className: 'peer-shell',
    attrs: { 'data-peer-platform': 'web', 'data-peer-electron': 'false' }
  });
  const side = buildSidebar(doc, life, callbacks);
  const content = el(doc, 'main', { className: 'peer-shell-content' });
  const layerHost = el(doc, 'div', { className: 'peer-shell-layer' });
  const updateBanner = el(doc, 'div', { className: 'peer-shell-update', attrs: { 'data-peer-update': '', hidden: true } });
  const updateText = textNode(doc, updateBanner);
  layerHost.append(updateBanner);
  root.append(side, content, layerHost);
  host.append(root);
  const state = { doc, layerHost, layers, callbacks, settingsOverlay: null, cheatOverlay: null };

  const update = (shellModel = {}, settingsModel = null) => {
    if (life.dead) return;
    root.setAttribute('data-peer-platform', String(shellModel?.platform ?? 'web'));
    root.setAttribute('data-peer-electron', String(Boolean(shellModel?.electron)));
    side.hidden = !shellModel?.sidebar?.open;
    side.setAttribute('data-peer-narrow', String(Boolean(shellModel?.sidebar?.narrow)));
    const upd = shellModel?.update;
    const bannerMsg = upd ? `Update ${upd.version} (${upd.status})` : '';
    writeText(updateText, bannerMsg);
    updateBanner.hidden = bannerMsg === '';
    syncLayerOverlays(state, shellModel, settingsModel);
  };

  const destroy = () => {
    if (!life.destroy()) return;
    state.cheatOverlay?.destroy();
    state.settingsOverlay?.destroy();
    state.cheatOverlay = null;
    state.settingsOverlay = null;
    root.remove();
  };

  return { root, side, content, layerHost, update, destroy };
}
