/**
 * Models settings section (`views/settings/models-section.js`, `v0.7.0` parity).
 * Manages tier slots (`strong`, `cheap`, `vision`), thinking levels, advanced
 * `cacheRetention` (`Cache: default` / `none` / `short` / `long`), and the
 * `v0.7.0` Model catalog refresh row (`[data-testid="model-catalog-refresh-row"]`).
 */
import { button, createLife, documentOf, el, setOff, show, textNode, writeText } from 'cloudcanvas-lib/ui';
import { MODEL_SLOTS, defaultOrderLevel } from 'peer-engine';

export const SLOT_ORDER = MODEL_SLOTS;

export const SLOT_META = Object.freeze({
  strong: { label: 'Strong', hint: 'Primary session model for Prober and Teacher' },
  cheap: { label: 'Cheap', hint: 'Fast worker model for Researcher, Demo builder, Extractor, and Auditor' },
  vision: { label: 'Vision', hint: 'Multimodal model for Visual maker and PDF reader' }
});

export const ALL_THINKING_LEVELS = Object.freeze(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

const CACHE_OPTIONS = Object.freeze([
  ['', 'Cache: default'],
  ['none', 'Cache: not requested'],
  ['short', 'Cache: short'],
  ['long', 'Cache: long']
]);

const CATALOG_REFRESH_MESSAGES = Object.freeze({
  idle: 'Check Pi for new models',
  pending: 'Refreshing…',
  refreshing: 'Refreshing…',
  updated: 'Model catalog updated.',
  unchanged: 'No catalog changes found.',
  'no-providers': 'No configured providers support catalog refresh.',
  failed: 'Could not refresh. Your current catalog is still available.',
  error: 'Could not refresh. Your current catalog is still available.'
});

export function encodeModelCoord(provider, id) {
  if (!provider || !id) return '';
  return `${provider}::${id}`;
}

export function decodeModelCoord(raw) {
  const value = String(raw ?? '');
  const sep = value.indexOf('::');
  if (sep <= 0) return null;
  const provider = value.slice(0, sep).trim();
  const id = value.slice(sep + 2).trim();
  return provider && id ? { provider, id } : null;
}

export function supportedLevelsOf(entry) {
  const list = entry?.supportedThinkingLevels ?? entry?.supportedLevels;
  return Array.isArray(list) && list.length > 0 ? list.map(String) : [...ALL_THINKING_LEVELS];
}

export function defaultThinkingForEntry(entry) {
  return defaultOrderLevel(supportedLevelsOf(entry));
}

export function isVisionModelEntry(entry) {
  const modalities = entry?.inputModality ?? entry?.input;
  if (!Array.isArray(modalities)) return true;
  return modalities.includes('image') || entry?.provider === 'custom';
}

export function populateModelSelect(doc, selectEl, catalog, slot, currentCoord) {
  const filtered = slot === 'vision' ? catalog.filter(isVisionModelEntry) : catalog;
  const options = [el(doc, 'option', { text: '— Select model —', attrs: { value: '' } })];
  const seen = new Set(['']);
  if (currentCoord) {
    const curVal = encodeModelCoord(currentCoord.provider, currentCoord.id);
    const inList = filtered.some((m) => encodeModelCoord(m.provider, m.id) === curVal);
    if (curVal && !inList) {
      seen.add(curVal);
      options.push(el(doc, 'option', { text: `${currentCoord.id} (${currentCoord.provider} · saved)`, attrs: { value: curVal } }));
    }
  }
  for (const item of filtered) {
    const val = encodeModelCoord(item.provider, item.id);
    if (!val || seen.has(val)) continue;
    seen.add(val);
    const label = item.name ? `${item.name} (${item.provider})` : `${item.id} (${item.provider})`;
    options.push(el(doc, 'option', { text: label, attrs: { value: val } }));
  }
  selectEl.replaceChildren(...options);
  selectEl.value = currentCoord ? encodeModelCoord(currentCoord.provider, currentCoord.id) : '';
}

export function populateThinkingSelect(doc, selectEl, levels, currentLevel, hasModel) {
  if (!hasModel) {
    selectEl.replaceChildren(el(doc, 'option', { text: '—', attrs: { value: '' } }));
    selectEl.value = '';
    selectEl.disabled = true;
    return;
  }
  const allowed = Array.from(new Set(levels.length > 0 ? levels : ALL_THINKING_LEVELS));
  if (currentLevel && !allowed.includes(currentLevel)) allowed.unshift(currentLevel);
  selectEl.replaceChildren(...allowed.map((lvl) => el(doc, 'option', { text: lvl, attrs: { value: lvl } })));
  selectEl.disabled = false;
  selectEl.value = currentLevel && allowed.includes(currentLevel) ? currentLevel : (allowed[0] ?? 'off');
}

function readSlotCoord(settingsModel, slot) {
  const fromRecord = settingsModel?.record?.models?.[slot]?.model;
  if (fromRecord?.provider && fromRecord?.id) return fromRecord;
  const fromEff = settingsModel?.effective?.models?.[slot];
  if (fromEff?.provider && fromEff?.id) return { provider: fromEff.provider, id: fromEff.id };
  return null;
}

function readSlotThinking(settingsModel, slot) {
  return settingsModel?.record?.models?.[slot]?.thinkingLevel
    ?? settingsModel?.effective?.models?.[slot]?.thinkingLevel
    ?? '';
}

function readSlotRetention(settingsModel, slot) {
  const raw = settingsModel?.record?.models?.[slot]?.cacheRetention
    ?? settingsModel?.effective?.models?.[slot]?.cacheRetention
    ?? '';
  return raw === 'none' || raw === 'short' || raw === 'long' ? raw : '';
}

function composeModelsPayload(state) {
  const payload = {};
  for (const slot of SLOT_ORDER) {
    const row = state.rows[slot];
    const coord = decodeModelCoord(row.modelSelect.value);
    if (!coord) continue;
    const thinking = String(row.thinkingSelect.value ?? '').trim();
    const retention = String(row.cacheSelect.value ?? '').trim();
    payload[slot] = {
      ...(retention ? { cacheRetention: retention } : {}),
      model: coord,
      ...(thinking ? { thinkingLevel: thinking } : {})
    };
  }
  return payload;
}

function buildSlotRow(doc, life, slot, onPickModel, onSaveSlot) {
  const meta = SLOT_META[slot];
  const row = el(doc, 'div', {
    className: 'peer-settings-row',
    attrs: { 'data-peer-slot': slot, 'data-testid': `slot-row-${slot}` }
  });
  const info = el(doc, 'div', { className: 'peer-settings-row-meta' });
  info.append(
    el(doc, 'span', { className: 'peer-settings-row-label', text: meta.label }),
    el(doc, 'p', { className: 'peer-settings-hint', text: meta.hint })
  );
  const controls = el(doc, 'div', { className: 'peer-settings-controls' });
  const modelSelect = el(doc, 'select', {
    className: 'peer-settings-select',
    attrs: { 'aria-label': `${meta.label} model`, 'data-peer-slot-model': slot, 'data-testid': `slot-model-${slot}` }
  });
  const thinkingSelect = el(doc, 'select', {
    className: 'peer-settings-select peer-settings-select-narrow',
    attrs: { 'aria-label': `${meta.label} thinking`, 'data-peer-slot-thinking': slot, 'data-testid': `slot-thinking-${slot}` }
  });
  const cacheSelect = el(doc, 'select', {
    className: 'peer-settings-select peer-settings-select-narrow',
    attrs: {
      'aria-label': `${meta.label} cache retention`,
      'data-peer-slot-cache': slot,
      'data-testid': `slot-cache-${slot}`,
      hidden: true
    }
  });
  for (const [val, label] of CACHE_OPTIONS) cacheSelect.append(el(doc, 'option', { text: label, attrs: { value: val } }));

  life.on(modelSelect, 'change', () => onPickModel(slot));
  life.on(thinkingSelect, 'change', onSaveSlot);
  life.on(cacheSelect, 'change', onSaveSlot);
  controls.append(modelSelect, thinkingSelect, cacheSelect);
  row.append(info, controls);
  return { row, modelSelect, thinkingSelect, cacheSelect };
}

function resolveRefreshCopy(models) {
  const raw = models?.refreshStatus;
  if (!raw) return { text: CATALOG_REFRESH_MESSAGES.idle, pending: false, failed: false };
  const key = typeof raw === 'string' ? raw : String(raw?.status ?? raw?.outcome ?? '');
  const pending = key === 'pending' || key === 'refreshing' || Boolean(models?.refreshing);
  const failed = key === 'failed' || key === 'error';
  const text = CATALOG_REFRESH_MESSAGES[key] ?? (typeof raw === 'string' ? raw : String(raw?.message ?? CATALOG_REFRESH_MESSAGES.idle));
  return { text, pending, failed };
}

function buildCatalogRefreshRow(doc, life, onRefresh) {
  const row = el(doc, 'div', {
    className: 'peer-settings-row',
    attrs: { 'data-testid': 'model-catalog-refresh-row', 'data-peer-catalog-refresh-row': '' }
  });
  const meta = el(doc, 'div', { className: 'peer-settings-row-meta' });
  const statusEl = el(doc, 'p', {
    className: 'peer-settings-hint',
    attrs: { role: 'status', 'data-testid': 'model-catalog-refresh-status' }
  });
  const statusText = textNode(doc, statusEl, CATALOG_REFRESH_MESSAGES.idle);
  meta.append(el(doc, 'span', { className: 'peer-settings-row-label', text: 'Model catalog' }), statusEl);
  const btn = button(doc, {
    label: 'Refresh',
    ariaLabel: 'Refresh model catalog',
    signal: life.signal,
    onClick: onRefresh,
    attrs: {
      title: 'Refresh model catalog',
      'aria-busy': 'false',
      'data-testid': 'refresh-model-catalog',
      'data-peer-action': 'refresh-model-catalog'
    }
  });
  row.append(meta, btn);
  return { row, statusEl, statusText, btn };
}

function syncModelsRows(state) {
  const catalog = Array.isArray(state.models?.models) ? state.models.models : [];
  state.advancedBtn.setAttribute('aria-expanded', String(state.advancedOpen));
  state.advancedBtn.textContent = state.advancedOpen ? 'Hide advanced settings' : 'Show advanced settings';
  for (const slot of SLOT_ORDER) {
    const row = state.rows[slot];
    const coord = readSlotCoord(state.settings, slot);
    const storedThinking = readSlotThinking(state.settings, slot);
    populateModelSelect(state.doc, row.modelSelect, catalog, slot, coord);
    const matched = coord ? catalog.find((m) => m.provider === coord.provider && m.id === coord.id) : null;
    const effectiveThinking = storedThinking || (matched ? defaultThinkingForEntry(matched) : 'off');
    populateThinkingSelect(state.doc, row.thinkingSelect, supportedLevelsOf(matched), effectiveThinking, Boolean(coord));
    row.cacheSelect.value = readSlotRetention(state.settings, slot);
    row.cacheSelect.disabled = !coord;
    show(row.cacheSelect, state.advancedOpen);
  }
  const refreshInfo = resolveRefreshCopy(state.models);
  writeText(state.refreshRow.statusText, refreshInfo.text);
  state.refreshRow.statusEl.className = refreshInfo.failed ? 'peer-settings-error' : 'peer-settings-hint';
  state.refreshRow.btn.setAttribute('aria-busy', String(refreshInfo.pending));
  setOff(state.refreshRow.btn, refreshInfo.pending);

  const err = String(state.models?.error ?? '').trim();
  writeText(state.errorText, err);
  state.errorWrap.hidden = err === '';
}

function handleSlotModelPick(state, slot, saveNow) {
  const catalog = Array.isArray(state.models?.models) ? state.models.models : [];
  const coord = decodeModelCoord(state.rows[slot].modelSelect.value);
  const matched = coord ? catalog.find((m) => m.provider === coord.provider && m.id === coord.id) : null;
  const prevLevel = String(state.rows[slot].thinkingSelect.value ?? '').trim();
  const nextLevel = prevLevel || (matched ? defaultThinkingForEntry(matched) : 'off');
  populateThinkingSelect(state.doc, state.rows[slot].thinkingSelect, supportedLevelsOf(matched), nextLevel, Boolean(coord));
  state.rows[slot].cacheSelect.disabled = !coord;
  if (coord || readSlotCoord(state.settings, slot)) saveNow();
}

function buildModelsErrorBar(doc, life, onModelsIntent) {
  const errorWrap = el(doc, 'div', { className: 'peer-settings-row', attrs: { hidden: true } });
  const errorEl = el(doc, 'p', { className: 'peer-settings-error', attrs: { 'data-peer-models-error': '' } });
  const errorText = textNode(doc, errorEl);
  errorWrap.append(errorEl, button(doc, {
    label: 'Retry catalog', signal: life.signal,
    attrs: { 'data-peer-action': 'reload-models' },
    onClick: () => onModelsIntent?.({ type: 'reload' })
  }));
  return { errorWrap, errorText };
}

export function createModelsSection(host, { onSettingsIntent, onModelsIntent } = {}) {
  const doc = documentOf(host);
  const life = createLife();
  const root = el(doc, 'div', { className: 'peer-settings-group', attrs: { 'data-peer-settings-section': 'models' } });
  const headRow = el(doc, 'div', { className: 'peer-settings-row' });
  const advancedBtn = button(doc, { label: 'Show advanced settings', signal: life.signal, attrs: { 'data-testid': 'models-advanced', 'aria-expanded': 'false' } });
  headRow.append(el(doc, 'h3', { className: 'peer-settings-group-title', text: 'Model tiers' }), advancedBtn);
  const { errorWrap, errorText } = buildModelsErrorBar(doc, life, onModelsIntent);
  const refreshRow = buildCatalogRefreshRow(doc, life, () => onModelsIntent?.({ type: 'refresh-catalog' }));
  root.append(headRow, errorWrap);
  const state = { doc, life, rows: {}, settings: null, models: null, advancedOpen: false, advancedBtn, refreshRow, errorWrap, errorText };
  life.on(advancedBtn, 'click', () => { state.advancedOpen = !state.advancedOpen; syncModelsRows(state); });
  const saveNow = () => onSettingsIntent?.({ type: 'save-section', section: 'models', value: composeModelsPayload(state) });
  for (const slot of SLOT_ORDER) {
    state.rows[slot] = buildSlotRow(doc, life, slot, (s) => handleSlotModelPick(state, s, saveNow), saveNow);
    root.append(state.rows[slot].row);
  }
  const footer = el(doc, 'div', { className: 'peer-settings-controls' });
  footer.append(button(doc, { className: 'is-primary', label: 'Save models', signal: life.signal, attrs: { 'data-peer-action': 'save-models', 'data-testid': 'models-save-btn' }, onClick: saveNow }));
  root.append(refreshRow.row, footer);
  host.append(root);
  const update = ({ settings = null, models = null } = {}) => { if (!life.dead) { state.settings = settings; state.models = models; syncModelsRows(state); } };
  update({});
  return { update, destroy: () => { if (life.destroy()) root.remove(); } };
}
