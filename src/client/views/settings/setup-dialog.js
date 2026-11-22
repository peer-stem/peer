/**
 * First-run Setup wizard (`[data-testid="setup-dialog"][data-peer-layer="setup"]`).
 * Step 1: Provider API key (`save-key`). Step 2: Model slots (`strong`, `cheap`, `vision` -> `save-section` `models`).
 */
import { button, createLife, documentOf, el, injectUiStyles, input, textNode, writeText } from 'cloudcanvas-lib/ui';
import { injectShellStyles } from '../shell/shell.css.js';
import { resolveProviderOptions } from './keys-section.js';
import {
  SLOT_META,
  SLOT_ORDER,
  decodeModelCoord,
  defaultThinkingForEntry,
  populateModelSelect,
  populateThinkingSelect,
  supportedLevelsOf
} from './models-section.js';
import { injectSettingsStyles } from './settings.css.js';

function hasAnyKeyedProvider(settingsModel, modelsModel) {
  if (Array.isArray(modelsModel?.models) && modelsModel.models.length > 0) return true;
  if (Array.isArray(modelsModel?.providers)) {
    const anyKeyed = modelsModel.providers.some((p) => (typeof p === 'string' ? p.length > 0 : Boolean(p?.keyPresent)));
    if (anyKeyed) return true;
  }
  const keys = Array.isArray(settingsModel?.keys) ? settingsModel.keys : [];
  return keys.some((row) => Boolean(row?.present) && row?.id !== 'DEEPGRAM_API_KEY');
}

function buildStepIndicator(doc, life, onPickStep) {
  const bar = el(doc, 'div', { className: 'peer-settings-steps', attrs: { 'data-peer-setup-steps': '' } });
  const step1Btn = button(doc, {
    label: '1. Provider API key',
    signal: life.signal,
    attrs: { 'data-peer-setup-step': '1', 'data-testid': 'setup-step-1' },
    onClick: () => onPickStep(1)
  });
  const step2Btn = button(doc, {
    label: '2. Model slots',
    signal: life.signal,
    attrs: { 'data-peer-setup-step': '2', 'data-testid': 'setup-step-2' },
    onClick: () => onPickStep(2)
  });
  bar.append(step1Btn, step2Btn);
  return { bar, step1Btn, step2Btn };
}

function buildKeyStagePanel(doc, life, handlers) {
  const panel = el(doc, 'div', {
    className: 'peer-settings-panel',
    attrs: { 'data-testid': 'setup-stage-keys', 'data-peer-setup-panel': '1' }
  });
  panel.append(el(doc, 'p', {
    className: 'peer-settings-hint',
    text: 'Choose your AI provider and paste its API key. Next you will assign your model tiers.'
  }));
  const row = el(doc, 'div', { className: 'peer-settings-controls' });
  const providerSelect = el(doc, 'select', {
    className: 'peer-settings-select',
    attrs: { 'aria-label': 'Provider', 'data-testid': 'setup-key-provider', 'data-peer-setup-provider': '' }
  });
  const keyInput = input(doc, {
    type: 'password',
    label: 'Provider API key',
    placeholder: 'Paste API key…',
    signal: life.signal,
    attrs: { 'data-testid': 'setup-key-input', 'data-peer-setup-key-input': '' }
  });
  row.append(providerSelect, keyInput);
  const actions = el(doc, 'div', { className: 'peer-settings-controls' });
  actions.append(
    button(doc, {
      className: 'is-primary', label: 'Save key & continue', signal: life.signal,
      attrs: { 'data-testid': 'setup-key-save', 'data-peer-action': 'setup-save-key' },
      onClick: () => handlers.saveKey(providerSelect.value, keyInput.value)
    }),
    button(doc, {
      label: 'Next: Model slots →', signal: life.signal,
      attrs: { 'data-peer-action': 'setup-next-step' },
      onClick: handlers.goStep2
    })
  );
  panel.append(row, actions);
  return { panel, providerSelect, keyInput };
}

function buildSetupSlotRow(doc, life, slot, onModelChange, onThinkingChange) {
  const meta = SLOT_META[slot];
  const row = el(doc, 'div', {
    className: 'peer-settings-row',
    attrs: { 'data-testid': `setup-slot-${slot}`, 'data-peer-setup-slot': slot }
  });
  const info = el(doc, 'div', { className: 'peer-settings-row-meta' });
  info.append(
    el(doc, 'span', { className: 'peer-settings-row-label', text: meta.label }),
    el(doc, 'p', { className: 'peer-settings-hint', text: meta.hint })
  );
  const controls = el(doc, 'div', { className: 'peer-settings-controls' });
  const modelSelect = el(doc, 'select', {
    className: 'peer-settings-select',
    attrs: { 'aria-label': `${meta.label} model`, 'data-testid': `setup-model-${slot}`, 'data-peer-setup-model': slot }
  });
  const thinkingSelect = el(doc, 'select', {
    className: 'peer-settings-select peer-settings-select-narrow',
    attrs: { 'aria-label': `${meta.label} thinking`, 'data-testid': `setup-thinking-${slot}`, 'data-peer-setup-thinking': slot }
  });
  life.on(modelSelect, 'change', () => onModelChange(slot));
  life.on(thinkingSelect, 'change', () => onThinkingChange(slot));
  controls.append(modelSelect, thinkingSelect);
  row.append(info, controls);
  return { row, modelSelect, thinkingSelect };
}

function buildPickersStagePanel(doc, life, state, handlers) {
  const panel = el(doc, 'div', {
    className: 'peer-settings-panel',
    attrs: { 'data-testid': 'setup-stage-pickers', 'data-peer-setup-panel': '2' }
  });
  panel.append(el(doc, 'p', {
    className: 'peer-settings-hint',
    text: 'Select a model for each tier before starting a session.'
  }));
  for (const slot of SLOT_ORDER) {
    state.slotRows[slot] = buildSetupSlotRow(doc, life, slot, handlers.onModelPick, handlers.onThinkingPick);
    panel.append(state.slotRows[slot].row);
  }
  const actions = el(doc, 'div', { className: 'peer-settings-controls' });
  actions.append(
    button(doc, {
      label: '← Back', signal: life.signal,
      attrs: { 'data-peer-action': 'setup-prev-step' },
      onClick: handlers.goStep1
    }),
    button(doc, {
      className: 'is-primary', label: 'Save models & finish', signal: life.signal,
      attrs: { 'data-testid': 'setup-save', 'data-peer-action': 'setup-finish' },
      onClick: handlers.finish
    })
  );
  panel.append(actions);
  return panel;
}

function syncSetupView(state) {
  const { doc, settings, models } = state;
  const options = resolveProviderOptions(settings?.providerKeys);
  const sig = options.map((o) => `${o.envVar}:${o.label}`).join('|');
  if (sig !== state.providerSig) {
    const prev = state.keyStage.providerSelect.value;
    state.keyStage.providerSelect.replaceChildren(
      ...options.map((o) => el(doc, 'option', { text: o.label, attrs: { value: o.envVar } }))
    );
    if (prev && options.some((o) => o.envVar === prev)) state.keyStage.providerSelect.value = prev;
    state.providerSig = sig;
  }
  const catalog = Array.isArray(models?.models) ? models.models : [];
  for (const slot of SLOT_ORDER) {
    const row = state.slotRows[slot];
    const saved = settings?.record?.models?.[slot]?.model ?? settings?.effective?.models?.[slot] ?? null;
    const savedCoord = saved?.provider && saved?.id ? { provider: saved.provider, id: saved.id } : null;
    const coord = state.draftCoords[slot] ?? savedCoord;
    populateModelSelect(doc, row.modelSelect, catalog, slot, coord);
    const matched = coord ? catalog.find((m) => m.provider === coord.provider && m.id === coord.id) : null;
    const savedLevel = settings?.record?.models?.[slot]?.thinkingLevel ?? settings?.effective?.models?.[slot]?.thinkingLevel ?? '';
    const level = state.draftLevels[slot] || savedLevel || (matched ? defaultThinkingForEntry(matched) : 'off');
    populateThinkingSelect(doc, row.thinkingSelect, supportedLevelsOf(matched), level, Boolean(coord));
  }
  state.steps.step1Btn.classList.toggle('is-primary', state.step === 1);
  state.steps.step2Btn.classList.toggle('is-primary', state.step === 2);
  state.keyStage.panel.hidden = state.step !== 1;
  state.pickerPanel.hidden = state.step !== 2;
  const err = String(state.localError || settings?.error || models?.error || '').trim();
  writeText(state.errorText, err);
  state.errorEl.hidden = err === '';
}

async function runSetupSaveKey(state, callbacks, envVar, rawKey) {
  const id = String(envVar ?? '').trim();
  const value = String(rawKey ?? '').trim();
  if (!id || !value) {
    state.localError = 'Select a provider and enter an API key.';
    syncSetupView(state);
    return;
  }
  state.localError = '';
  try {
    await callbacks.onSettingsIntent?.({ type: 'save-key', id, value });
    if (state.life.dead) return;
    if (!state.settings?.error) {
      state.keyStage.keyInput.value = '';
      callbacks.onModelsIntent?.({ type: 'reload' });
      state.step = 2;
      state.manualStep = true;
    }
  } catch (err) {
    state.localError = err instanceof Error ? err.message : String(err);
  }
  if (!state.life.dead) syncSetupView(state);
}

async function runSetupFinish(state, callbacks) {
  const payload = {};
  for (const slot of SLOT_ORDER) {
    const coord = decodeModelCoord(state.slotRows[slot].modelSelect.value) ?? state.draftCoords[slot];
    if (!coord) {
      state.localError = 'Select a model for every tier (Strong, Cheap, and Vision).';
      syncSetupView(state);
      return;
    }
    const thinking = String(state.slotRows[slot].thinkingSelect.value ?? state.draftLevels[slot] ?? '').trim();
    const prevRetention = state.settings?.record?.models?.[slot]?.cacheRetention;
    payload[slot] = {
      ...(prevRetention !== undefined ? { cacheRetention: prevRetention } : {}),
      model: coord,
      ...(thinking ? { thinkingLevel: thinking } : {})
    };
  }
  state.localError = '';
  try {
    await callbacks.onSettingsIntent?.({ type: 'save-section', section: 'models', value: payload });
    if (!state.life.dead && !state.settings?.error) callbacks.onClose?.();
  } catch (err) {
    state.localError = err instanceof Error ? err.message : String(err);
    if (!state.life.dead) syncSetupView(state);
  }
}

function bindSetupDismiss(life, win, backdrop, onClose) {
  life.on(backdrop, 'click', (event) => { if (event.target === backdrop) onClose?.(); });
  if (!win || typeof win.addEventListener !== 'function') return;
  life.on(win, 'keydown', (event) => {
    if (event.key === 'Escape' && !event.defaultPrevented) {
      event.preventDefault();
      onClose?.();
    }
  });
}

function handleSetupSlotPick(state, slot) {
  const coord = decodeModelCoord(state.slotRows[slot].modelSelect.value);
  state.draftCoords[slot] = coord;
  const catalog = Array.isArray(state.models?.models) ? state.models.models : [];
  const matched = coord ? catalog.find((m) => m.provider === coord.provider && m.id === coord.id) : null;
  if (coord && !state.draftLevels[slot]) {
    state.draftLevels[slot] = matched ? defaultThinkingForEntry(matched) : 'off';
  }
  syncSetupView(state);
}

function buildSetupShellDom(doc, life, onClose) {
  const backdrop = el(doc, 'div', {
    className: 'peer-shell-backdrop',
    attrs: { 'data-testid': 'setup-dialog', 'data-peer-layer': 'setup' }
  });
  const modal = el(doc, 'section', {
    className: 'peer-shell-modal peer-settings-setup-modal',
    attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Set up your models', tabindex: '-1' }
  });
  const header = el(doc, 'div', { className: 'peer-shell-modal-header' });
  header.append(
    el(doc, 'h2', { className: 'peer-shell-modal-title', text: 'Set up your models' }),
    button(doc, {
      label: 'Close', signal: life.signal,
      attrs: { 'data-testid': 'setup-close', 'data-peer-action': 'close-setup' },
      onClick: () => onClose?.()
    })
  );
  const errorEl = el(doc, 'p', {
    className: 'peer-settings-error',
    attrs: { 'data-testid': 'setup-error', 'data-peer-setup-error': '', hidden: true }
  });
  const errorText = textNode(doc, errorEl);
  backdrop.append(modal);
  return { backdrop, modal, header, errorEl, errorText };
}

export function createSetupDialog(host, callbacks = {}) {
  const doc = documentOf(host);
  injectUiStyles(doc);
  injectShellStyles(doc);
  injectSettingsStyles(doc);
  const life = createLife();
  const { backdrop, modal, header, errorEl, errorText } = buildSetupShellDom(doc, life, callbacks.onClose);

  const state = {
    doc, life, settings: null, models: null, step: 1, manualStep: false, localError: '',
    providerSig: '', draftCoords: {}, draftLevels: {}, slotRows: {},
    steps: null, keyStage: null, pickerPanel: null, errorEl, errorText
  };
  const setStep = (step) => { state.step = step; state.manualStep = true; state.localError = ''; syncSetupView(state); };
  state.steps = buildStepIndicator(doc, life, setStep);
  state.keyStage = buildKeyStagePanel(doc, life, {
    saveKey: (envVar, val) => { void runSetupSaveKey(state, callbacks, envVar, val); },
    goStep2: () => setStep(2)
  });
  state.pickerPanel = buildPickersStagePanel(doc, life, state, {
    onModelPick: (slot) => handleSetupSlotPick(state, slot),
    onThinkingPick: (slot) => { state.draftLevels[slot] = state.slotRows[slot].thinkingSelect.value; },
    goStep1: () => setStep(1),
    finish: () => { void runSetupFinish(state, callbacks); }
  });

  modal.append(header, state.steps.bar, errorEl, state.keyStage.panel, state.pickerPanel);
  host.append(backdrop);
  bindSetupDismiss(life, doc.defaultView, backdrop, callbacks.onClose);

  const update = ({ settings = null, models = null } = {}) => {
    if (life.dead) return;
    state.settings = settings;
    state.models = models;
    if (!state.manualStep) state.step = hasAnyKeyedProvider(settings, models) ? 2 : 1;
    syncSetupView(state);
  };
  update({});

  return { node: backdrop, update, destroy: () => { if (life.destroy()) backdrop.remove(); } };
}
