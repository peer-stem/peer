/**
 * Data & Updates settings sections (`views/settings/data-section.js`).
 * LearnHarness read-only directory importer (`[data-peer-import-input]`,
 * `[data-peer-action="import-learnharness"]`, `[data-peer-import-error]`,
 * `[data-peer-import-report]`), desktop folder picker, and update controls.
 */
import { button, createLife, createSwitch, documentOf, el, input, textNode, writeText } from 'cloudcanvas-lib/ui';

export function formatImportReportItems(report) {
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

function formatUpdateStatus(desktopModel, shellModel) {
  const upd = desktopModel?.update ?? shellModel?.update ?? null;
  if (upd && upd.version) return `Update ${upd.version} (${upd.status || 'available'})`;
  const isElectron = Boolean(desktopModel?.electron ?? shellModel?.electron);
  return isElectron ? 'Up to date' : 'Desktop updates available in the Electron app';
}

function buildUpdateControlsGroup(doc, life, onDesktopIntent, attrPrefix = 'data-peer') {
  const group = el(doc, 'div', { className: 'peer-settings-group' });
  group.append(el(doc, 'h3', { className: 'peer-settings-group-title', text: 'Application updates' }));
  const row = el(doc, 'div', { className: 'peer-settings-row' });
  const statusEl = el(doc, 'p', {
    className: 'peer-settings-hint',
    attrs: { [`${attrPrefix}-update-status`]: '' }
  });
  const statusText = textNode(doc, statusEl, 'Up to date');
  const controls = el(doc, 'div', { className: 'peer-settings-controls' });
  const checkBtn = button(doc, {
    label: 'Check for updates',
    signal: life.signal,
    attrs: { [`${attrPrefix}-action`]: 'check-updates' },
    onClick: () => onDesktopIntent?.({ type: 'check-updates' })
  });
  const installBtn = button(doc, {
    className: 'is-primary',
    label: 'Install update',
    signal: life.signal,
    attrs: { [`${attrPrefix}-action`]: 'install-update', hidden: true },
    onClick: () => onDesktopIntent?.({ type: 'install-update' })
  });
  controls.append(checkBtn, installBtn);
  row.append(statusEl, controls);
  group.append(row);
  return { group, statusText, installBtn };
}

async function pickFolderIntoInput(life, callbacks, dirInput) {
  try {
    const picked = await callbacks.onPickDirectory?.();
    if (!life.dead && typeof picked === 'string' && picked.trim()) dirInput.value = picked.trim();
  } catch {
    /* user cancelled or desktop picker unavailable */
  }
}

function buildImporterGroup(doc, life, callbacks) {
  const group = el(doc, 'div', { className: 'peer-settings-group' });
  group.append(el(doc, 'strong', { className: 'peer-settings-row-label', text: 'Data · Import LearnHarness Data' }));
  const row = el(doc, 'div', { className: 'peer-settings-controls' });
  const dirInput = input(doc, {
    label: 'LearnHarness data directory',
    placeholder: '/path/to/learnharness/data',
    signal: life.signal,
    attrs: { 'data-peer-import-input': '' }
  });
  const pickBtn = button(doc, {
    label: 'Pick folder…',
    signal: life.signal,
    attrs: { 'data-peer-action': 'pick-import-folder', hidden: true },
    onClick: () => { void pickFolderIntoInput(life, callbacks, dirInput); }
  });
  const submitImport = () => {
    const sourceDirectory = dirInput.value.trim();
    if (sourceDirectory) callbacks.onSettingsIntent?.({ type: 'import-learnharness', sourceDirectory });
  };
  const importBtn = button(doc, {
    className: 'is-primary',
    label: 'Import LearnHarness Data',
    signal: life.signal,
    attrs: { 'data-peer-action': 'import-learnharness' },
    onClick: submitImport
  });
  row.append(dirInput, pickBtn, importBtn);
  const errorEl = el(doc, 'p', {
    className: 'peer-settings-error',
    attrs: { 'data-peer-import-error': '', hidden: true }
  });
  const errorText = textNode(doc, errorEl);
  const reportList = el(doc, 'ul', {
    className: 'peer-settings-report',
    attrs: { 'data-peer-import-report': '', hidden: true }
  });
  group.append(row, errorEl, reportList);
  return { group, pickBtn, errorEl, errorText, reportList };
}

export function createDataSection(host, callbacks = {}) {
  const doc = documentOf(host);
  const life = createLife();
  const root = el(doc, 'div', { className: 'peer-settings-panel', attrs: { 'data-peer-settings-section': 'data' } });
  const importer = buildImporterGroup(doc, life, callbacks);
  const updates = buildUpdateControlsGroup(doc, life, callbacks.onDesktopIntent, 'data-peer');
  root.append(importer.group, updates.group);
  host.append(root);

  const update = ({ settings = null, desktop = null, shell = null } = {}) => {
    if (life.dead) return;
    const hasFn = Boolean(callbacks.hasPickDirectory && typeof callbacks.onPickDirectory === 'function');
    const isDesktop = desktop === null && shell === null ? true : Boolean(desktop?.electron ?? shell?.electron);
    importer.pickBtn.hidden = !(hasFn && isDesktop);
    const err = String(settings?.error ?? '').trim();
    writeText(importer.errorText, err);
    importer.errorEl.hidden = err === '';
    const lines = formatImportReportItems(settings?.lastImport);
    importer.reportList.hidden = lines.length === 0;
    importer.reportList.replaceChildren(...lines.map((line) => el(doc, 'li', { text: line })));
    writeText(updates.statusText, formatUpdateStatus(desktop, shell));
    const upd = desktop?.update ?? shell?.update ?? null;
    updates.installBtn.hidden = !upd;
  };
  update({});

  return { update, destroy: () => { if (life.destroy()) root.remove(); } };
}

export function createUpdatesSection(host, { onSettingsIntent, onDesktopIntent } = {}) {
  const doc = documentOf(host);
  const life = createLife();
  const root = el(doc, 'div', { className: 'peer-settings-panel', attrs: { 'data-peer-settings-section': 'updates' } });
  let latestRecord = null;
  const autoWrap = el(doc, 'div', { attrs: { 'data-peer-auto-update': '' } });
  const autoSwitch = createSwitch(autoWrap, {
    onChange: (checked) => onSettingsIntent?.({
      type: 'save-section',
      section: 'general',
      value: { ...(latestRecord?.general ?? {}), autoUpdate: checked }
    })
  });
  const updates = buildUpdateControlsGroup(doc, life, onDesktopIntent, 'data-peer-updates');
  root.append(autoWrap, updates.group);
  host.append(root);

  const update = ({ settings = null, desktop = null, shell = null } = {}) => {
    if (life.dead) return;
    latestRecord = settings?.record ?? null;
    const autoOn = (settings?.record?.general?.autoUpdate ?? settings?.effective?.general?.autoUpdate) !== false;
    autoSwitch.update({
      label: 'Automatic update checks',
      detail: 'Check for desktop releases periodically in the background',
      checked: autoOn
    });
    writeText(updates.statusText, formatUpdateStatus(desktop, shell));
    const upd = desktop?.update ?? shell?.update ?? null;
    updates.installBtn.hidden = !upd;
  };
  update({});

  const destroy = () => {
    if (!life.destroy()) return;
    autoSwitch.destroy();
    root.remove();
  };

  return { update, destroy };
}
