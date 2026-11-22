/**
 * Pure composition helpers and sub-group builders for `agent-section.js` (`v0.7.0` parity).
 * Covers `workerRequestConcurrency`, `quizMechanics`, `fileAccess` (`isFileAccessFolder`),
 * `search` engine preference, and `compaction` (`COMPACTION_THRESHOLD_FLOOR`).
 */
import { button, createSwitch, el, input, placeChildren, show, textNode, writeText } from 'cloudcanvas-lib/ui';
import { COMPACTION_THRESHOLD_FLOOR, SEARCH_ENGINES, isFileAccessFolder } from 'peer-engine';

export function composeWorkerRequestConcurrency(agent, rawValue) {
  const next = { ...(agent ?? {}) };
  const draft = String(rawValue ?? '').trim();
  if (draft === '') {
    delete next.workerRequestConcurrency;
    return { ok: true, settings: next };
  }
  const invalid = { ok: false, error: 'Enter a positive, safely representable whole number.' };
  const concurrency = Number(draft);
  if (!Number.isSafeInteger(concurrency) || concurrency <= 0) return invalid;
  const decimal = draft.match(/^\+?(\d+(?:\.\d*)?|\.\d+)(?:e([+-]?\d+))?$/i);
  if (!decimal) return invalid;
  const mantissa = decimal[1];
  const fractionalPlaces = mantissa.split('.')[1]?.length ?? 0;
  const coefficient = mantissa.replace('.', '');
  const trailingZeroes = coefficient.length - coefficient.replace(/0+$/, '').length;
  if (Number(decimal[2] ?? 0) - fractionalPlaces + trailingZeroes < 0) return invalid;
  next.workerRequestConcurrency = concurrency;
  return { ok: true, settings: next };
}

export function composeQuizMechanics(agent, mechanics) {
  return { ...(agent ?? {}), tools: { ...(agent?.tools ?? {}), explain: mechanics === 'free' } };
}

export function composeFileRestriction(agent, restricted) {
  return {
    ...(agent ?? {}),
    fileAccess: { restricted: Boolean(restricted), folders: [...(agent?.fileAccess?.folders ?? [])] }
  };
}

export function composeAddFolder(agent, folder) {
  const next = String(folder ?? '').trim();
  const folders = agent?.fileAccess?.folders ?? [];
  const restricted = agent?.fileAccess?.restricted ?? false;
  if (!isFileAccessFolder(next) || folders.includes(next)) {
    return { ...(agent ?? {}), fileAccess: { restricted, folders: [...folders] } };
  }
  return { ...(agent ?? {}), fileAccess: { restricted, folders: [...folders, next] } };
}

export function composeRemoveFolder(agent, folder) {
  return {
    ...(agent ?? {}),
    fileAccess: {
      restricted: agent?.fileAccess?.restricted ?? false,
      folders: (agent?.fileAccess?.folders ?? []).filter((f) => f !== folder)
    }
  };
}

export function composeSearchEngine(agent, engine) {
  if (!engine) {
    if (!agent?.search) return { ...(agent ?? {}) };
    const { search: _drop, ...rest } = agent;
    return { ...rest };
  }
  return { ...(agent ?? {}), search: { engine } };
}

function renderAllowedFolderRow(doc, life, folder, effectiveAgent, onSettingsIntent) {
  const row = el(doc, 'div', { className: 'peer-settings-row', attrs: { 'data-testid': 'file-access-folder' } });
  const rmBtn = button(doc, {
    label: 'Remove', ariaLabel: `Remove ${folder}`, signal: life.signal,
    onClick: () => onSettingsIntent?.({ type: 'save-section', section: 'agent', value: composeRemoveFolder(effectiveAgent(), folder) }),
    attrs: { 'data-testid': 'file-access-remove', 'data-peer-remove-folder': folder }
  });
  row.append(el(doc, 'span', { className: 'peer-settings-hint', text: folder }), rmBtn);
  return row;
}

function buildFolderAddControls(doc, life, callbacks, tryAddFolder, clearInputErr) {
  const addRow = el(doc, 'div', { className: 'peer-settings-controls' });
  const folderInput = input(doc, {
    label: 'Allowed folder path', placeholder: 'Absolute path or ~/folder',
    signal: life.signal, attrs: { 'data-testid': 'file-access-add' }
  });
  life.on(folderInput, 'input', clearInputErr);
  life.on(folderInput, 'keydown', (ev) => {
    if (ev.key === 'Enter') { ev.preventDefault(); tryAddFolder(folderInput.value); }
  });
  const addBtn = button(doc, {
    label: 'Add folder', signal: life.signal, onClick: () => tryAddFolder(folderInput.value),
    attrs: { 'data-testid': 'file-access-add-button', 'data-peer-action': 'add-file-access-folder' }
  });
  const pickFolder = () => {
    void Promise.resolve(callbacks.onPickDirectory?.()).then((picked) => {
      if (!life.dead && typeof picked === 'string' && picked.trim()) tryAddFolder(picked);
    }).catch(() => {});
  };
  const pickBtn = button(doc, {
    label: 'Pick folder…', signal: life.signal, onClick: pickFolder,
    attrs: { 'data-testid': 'file-access-pick-button', 'data-peer-action': 'pick-file-access-folder', hidden: true }
  });
  addRow.append(folderInput, addBtn, pickBtn);
  return { addRow, folderInput, pickBtn };
}

export function buildFileAccessGroup(doc, life, getSettings, callbacks) {
  const group = el(doc, 'div', { className: 'peer-settings-group', attrs: { 'data-testid': 'file-access-row', 'data-peer-file-access': '' } });
  group.append(el(doc, 'h3', { className: 'peer-settings-group-title', text: 'File access' }));
  const switchWrap = el(doc, 'div', { attrs: { 'data-testid': 'file-access-restricted', 'data-peer-setting': 'file-access-restricted' } });
  const effectiveAgent = () => {
    const s = getSettings();
    const agent = s?.record?.agent;
    const folders = agent?.fileAccess?.folders ?? [];
    return s?.fileAccessError ? { ...(agent ?? {}), fileAccess: { restricted: true, folders } } : agent;
  };
  const restrictedSwitch = createSwitch(switchWrap, {
    onChange: (checked) => callbacks.onSettingsIntent?.({ type: 'save-section', section: 'agent', value: composeFileRestriction(effectiveAgent(), checked) })
  });
  const configErrEl = el(doc, 'p', { className: 'peer-settings-error', attrs: { role: 'alert', 'data-testid': 'file-access-config-error', hidden: true } });
  const configErrText = textNode(doc, configErrEl, '');
  const inputErrEl = el(doc, 'p', { className: 'peer-settings-error', attrs: { role: 'alert', 'data-testid': 'file-access-input-error', hidden: true } });
  const inputErrText = textNode(doc, inputErrEl, '');
  let addUi = null;
  const tryAddFolder = (raw) => {
    const candidate = String(raw ?? '').trim();
    if (!isFileAccessFolder(candidate)) { writeText(inputErrText, 'Enter an absolute path or ~/folder.'); show(inputErrEl, true); return; }
    writeText(inputErrText, '');
    show(inputErrEl, false);
    const curAgent = effectiveAgent();
    if (!(curAgent?.fileAccess?.folders ?? []).includes(candidate)) {
      callbacks.onSettingsIntent?.({ type: 'save-section', section: 'agent', value: composeAddFolder(curAgent, candidate) });
    }
    addUi.folderInput.value = '';
  };
  addUi = buildFolderAddControls(doc, life, callbacks, tryAddFolder, () => { writeText(inputErrText, ''); show(inputErrEl, false); });
  const foldersList = el(doc, 'div', { className: 'peer-settings-group', attrs: { 'data-peer-file-access-list': '' } });
  group.append(switchWrap, configErrEl, addUi.addRow, inputErrEl, foldersList);
  const sync = (settings) => {
    const folders = settings?.record?.agent?.fileAccess?.folders ?? [];
    const restricted = Boolean(settings?.fileAccessError) || settings?.record?.agent?.fileAccess?.restricted === true;
    const hint = !restricted ? 'Broad local source access, except protected locations' : (folders.length > 0 ? 'Only listed folders and subfolders.' : 'Restricted: no folders allowed. Add a folder to enable access.');
    restrictedSwitch.update({ label: 'Restrict to listed folders', detail: hint, checked: restricted });
    const cfgErr = String(settings?.fileAccessError ?? '').trim();
    writeText(configErrText, cfgErr);
    show(configErrEl, cfgErr !== '');
    show(addUi.pickBtn, Boolean(callbacks.hasPickDirectory && typeof callbacks.onPickDirectory === 'function'));
    placeChildren(foldersList, folders.map((f) => renderAllowedFolderRow(doc, life, f, effectiveAgent, callbacks.onSettingsIntent)));
  };
  return { group, sync, destroy: () => restrictedSwitch.destroy() };
}

function buildSearchGroupNodes(doc, life, getSettings, onSettingsIntent) {
  const searchGroup = el(doc, 'div', { className: 'peer-settings-group', attrs: { 'data-testid': 'search-engine-row', 'data-peer-search-row': '' } });
  searchGroup.append(el(doc, 'h3', { className: 'peer-settings-group-title', text: 'Web search engine' }));
  const searchRow = el(doc, 'div', { className: 'peer-settings-row' });
  const searchMeta = el(doc, 'div', { className: 'peer-settings-row-meta' });
  const reasonEl = el(doc, 'p', { className: 'peer-settings-hint', attrs: { 'data-testid': 'search-engine-reason', 'data-peer-search-reason': '' } });
  const reasonText = textNode(doc, reasonEl, '');
  searchMeta.append(el(doc, 'span', { className: 'peer-settings-row-label', text: 'Search engine' }), reasonEl);
  const searchSelect = el(doc, 'select', {
    className: 'peer-settings-select peer-settings-select-narrow',
    attrs: { 'aria-label': 'Search engine', 'data-testid': 'search-engine-select', 'data-peer-search-engine': '' }
  });
  life.on(searchSelect, 'change', () => {
    const val = searchSelect.value || null;
    onSettingsIntent?.({ type: 'save-section', section: 'agent', value: composeSearchEngine(getSettings()?.record?.agent, val) });
  });
  searchRow.append(searchMeta, searchSelect);
  searchGroup.append(searchRow);
  return { searchGroup, searchSelect, reasonText };
}

function buildCompactionGroupNodes(doc, life, getSettings, onSettingsIntent) {
  const compGroup = el(doc, 'div', { className: 'peer-settings-group', attrs: { 'data-testid': 'group-context' } });
  compGroup.append(el(doc, 'h3', { className: 'peer-settings-group-title', text: 'Context compaction' }));
  const compRow = el(doc, 'div', { className: 'peer-settings-row', attrs: { 'data-testid': 'compaction-row-threshold' } });
  const compMeta = el(doc, 'div', { className: 'peer-settings-row-meta' });
  const compHintEl = el(doc, 'p', { className: 'peer-settings-hint' });
  const compHintText = textNode(doc, compHintEl, '150000 tok');
  compMeta.append(el(doc, 'span', { className: 'peer-settings-row-label', text: 'Compaction threshold' }), compHintEl);
  const compControls = el(doc, 'div', { className: 'peer-settings-controls' });
  const compInput = input(doc, {
    type: 'number', label: 'Compaction threshold', placeholder: '150000', signal: life.signal,
    attrs: { min: String(COMPACTION_THRESHOLD_FLOOR), step: '1000', 'data-testid': 'input-compaction-threshold', 'data-peer-compaction-threshold': '' }
  });
  const commitCompaction = () => {
    const raw = compInput.value.trim();
    const prev = { ...(getSettings()?.record?.compaction ?? {}) };
    if (raw === '') { delete prev.thresholdTokens; onSettingsIntent?.({ type: 'save-section', section: 'compaction', value: prev }); return; }
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return;
    prev.thresholdTokens = Math.max(COMPACTION_THRESHOLD_FLOOR, Math.round(n));
    onSettingsIntent?.({ type: 'save-section', section: 'compaction', value: prev });
  };
  life.on(compInput, 'change', commitCompaction);
  compControls.append(compInput, button(doc, { label: 'Apply', signal: life.signal, attrs: { 'data-peer-action': 'save-compaction' }, onClick: commitCompaction }));
  compRow.append(compMeta, compControls);
  const reasoningWrap = el(doc, 'div', { attrs: { 'data-testid': 'compaction-row-reasoning', 'data-peer-setting': 'compaction-reasoning' } });
  const reasoningSwitch = createSwitch(reasoningWrap, {
    onChange: (checked) => onSettingsIntent?.({ type: 'save-section', section: 'compaction', value: { ...(getSettings()?.record?.compaction ?? {}), includeReasoning: checked } })
  });
  compGroup.append(compRow, reasoningWrap);
  return { compGroup, compHintText, compInput, reasoningSwitch };
}

export function buildSearchAndCompactionGroups(doc, life, getSettings, onSettingsIntent) {
  const sUi = buildSearchGroupNodes(doc, life, getSettings, onSettingsIntent);
  const cUi = buildCompactionGroupNodes(doc, life, getSettings, onSettingsIntent);
  const sync = (settings, resolvedCompaction) => {
    const keys = Array.isArray(settings?.keys) ? settings.keys : [];
    const presentById = new Map(keys.map((k) => [k.id, Boolean(k.present)]));
    const anyKey = SEARCH_ENGINES.some(({ envVar }) => presentById.get(envVar) === true);
    const curEngine = settings?.record?.agent?.search?.engine ?? '';
    const options = [el(doc, 'option', { text: 'Automatic', attrs: { value: '' } })];
    for (const eng of SEARCH_ENGINES) {
      const live = presentById.get(eng.envVar) === true;
      const optLabel = keys.length > 0 ? `${eng.label} (${live ? 'key set' : 'no key'})` : eng.label;
      options.push(el(doc, 'option', { text: optLabel, attrs: { value: eng.id } }));
    }
    sUi.searchSelect.replaceChildren(...options);
    sUi.searchSelect.value = curEngine;
    sUi.searchSelect.disabled = keys.length > 0 && !anyKey && !curEngine;
    const statusReason = settings?.searchStatus?.reason ?? settings?.search?.reason ?? (keys.length > 0 && !anyKey ? 'Add a search API key in Keys to enable web search.' : 'Auto-activates when a search key is configured.');
    writeText(sUi.reasonText, String(statusReason));
    writeText(cUi.compHintText, `${resolvedCompaction.thresholdTokens} tok`);
    cUi.compInput.placeholder = String(resolvedCompaction.thresholdTokens);
    if (cUi.compInput !== doc.activeElement) {
      const stored = settings?.record?.compaction?.thresholdTokens;
      cUi.compInput.value = stored !== undefined ? String(stored) : '';
    }
    cUi.reasoningSwitch.update({
      label: 'Include reasoning in token estimates (OpenAI Responses only)',
      detail: 'Account for replayed reasoning tokens on matching OpenAI Responses models',
      checked: Boolean(resolvedCompaction.includeReasoning)
    });
  };
  return { searchGroup: sUi.searchGroup, compGroup: cUi.compGroup, sync, destroy: () => cUi.reasoningSwitch.destroy() };
}
