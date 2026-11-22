/**
 * Full Settings modal (`[data-testid="settings-dialog"][data-peer-layer="settings"]`).
 * Derives active tab strictly from `model.section` (`R4`), falling back to
 * `state.fallbackTab` ONLY when `callbacks.onSelectSection` is omitted in standalone
 * unit tests. Mounts all 8 section panels simultaneously (`panel.hidden = !isCurrent`)
 * so `[data-peer-import-input]` remains permanently queryable in the dialog DOM.
 */
import { button, createLife, documentOf, el, injectUiStyles, textNode, uniqueId, writeText } from 'cloudcanvas-lib/ui';
import { injectShellStyles } from '../shell/shell.css.js';
import { createAgentSection } from './agent-section.js';
import { createAppearanceSection } from './appearance-section.js';
import { createDataSection, createUpdatesSection } from './data-section.js';
import { createKeyboardSection } from './keyboard-section.js';
import { createKeysSection } from './keys-section.js';
import { createModelsSection } from './models-section.js';
import { createPromptsSection } from './prompts-section.js';
import { injectSettingsStyles } from './settings.css.js';

export const SETTINGS_TABS = Object.freeze([
  { id: 'models', label: 'Models' },
  { id: 'keys', label: 'Keys' },
  { id: 'agent', label: 'Agent' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'prompts', label: 'Prompts' },
  { id: 'keyboard', label: 'Keyboard' },
  { id: 'updates', label: 'Updates' },
  { id: 'data', label: 'Data' }
]);

const VALID_TAB_IDS = /* @__PURE__ */ new Set(SETTINGS_TABS.map((t) => t.id));

function buildTabStrip(doc, life, panelIds, onPickTab) {
  const strip = el(doc, 'div', {
    className: 'peer-settings-tabs',
    attrs: { role: 'tablist', 'aria-label': 'Settings sections' }
  });
  const tabButtons = new Map();
  for (const tab of SETTINGS_TABS) {
    const tabAttrs = {
      type: 'button', role: 'tab', 'aria-selected': 'false',
      'aria-controls': panelIds.get(tab.id), 'data-peer-settings-tab': tab.id, 'data-testid': `settings-tab-${tab.id}`
    };
    const btn = el(doc, 'button', { className: 'peer-settings-tab', text: tab.label, attrs: tabAttrs });
    life.on(btn, 'click', () => onPickTab(tab.id));
    tabButtons.set(tab.id, btn);
    strip.append(btn);
  }
  life.on(strip, 'keydown', (event) => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    const focused = event.target?.getAttribute?.('data-peer-settings-tab');
    const idx = SETTINGS_TABS.findIndex((t) => t.id === focused);
    if (idx === -1) return;
    event.preventDefault();
    const delta = event.key === 'ArrowRight' ? 1 : -1;
    const next = SETTINGS_TABS[(idx + delta + SETTINGS_TABS.length) % SETTINGS_TABS.length];
    tabButtons.get(next.id)?.focus();
    onPickTab(next.id);
  });
  return { strip, tabButtons };
}

function mountSectionPanels(doc, panelsHost, panelIds, callbacks) {
  const forwardSettings = (intent) => {
    if (intent?.type === 'import-learnharness' && callbacks.onImportData && !callbacks.onSettingsIntent) {
      return callbacks.onImportData(intent.sourceDirectory);
    }
    return callbacks.onSettingsIntent?.(intent);
  };
  const hasPicker = callbacks.hasPickDirectory !== undefined
    ? Boolean(callbacks.hasPickDirectory)
    : typeof callbacks.onPickDirectory === 'function';
  const shared = {
    onSettingsIntent: forwardSettings,
    onModelsIntent: callbacks.onModelsIntent,
    onAppearanceIntent: callbacks.onAppearanceIntent,
    onDesktopIntent: callbacks.onDesktopIntent,
    onPickDirectory: callbacks.onPickDirectory,
    onPickFiles: callbacks.onPickFiles,
    hasPickDirectory: hasPicker,
    onPrefsIntent: callbacks.onPrefsIntent
  };
  const factories = {
    models: (h) => createModelsSection(h, shared),
    keys: (h) => createKeysSection(h, shared),
    agent: (h) => createAgentSection(h, shared),
    appearance: (h) => createAppearanceSection(h, shared),
    prompts: (h) => createPromptsSection(h, shared),
    keyboard: (h) => createKeyboardSection(h, shared),
    updates: (h) => createUpdatesSection(h, shared),
    data: (h) => createDataSection(h, shared)
  };
  const panels = new Map();
  const handles = [];
  for (const tab of SETTINGS_TABS) {
    const panelAttrs = {
      id: panelIds.get(tab.id), role: 'tabpanel',
      'data-peer-settings-panel': tab.id, 'data-testid': `settings-panel-${tab.id}`
    };
    const panel = el(doc, 'div', { className: 'peer-settings-panel', attrs: panelAttrs });
    panelsHost.append(panel);
    const handle = factories[tab.id](panel);
    panels.set(tab.id, panel);
    handles.push(handle);
  }
  return { panels, handles };
}

function syncActiveTabUi(state, explicitSection) {
  const active = VALID_TAB_IDS.has(explicitSection) ? explicitSection : state.fallbackTab;
  for (const tab of SETTINGS_TABS) {
    const isCurrent = tab.id === active;
    const btn = state.tabButtons.get(tab.id);
    btn.setAttribute('aria-selected', String(isCurrent));
    btn.tabIndex = isCurrent ? 0 : -1;
    state.panels.get(tab.id).hidden = !isCurrent;
  }
  writeText(state.titleText, explicitSection ? `Settings · ${explicitSection}` : 'Settings');
}

function bindSettingsDismiss(life, win, backdrop, onClose) {
  life.on(backdrop, 'click', (event) => {
    if (event.target === backdrop) onClose?.();
  });
  if (!win || typeof win.addEventListener !== 'function') return;
  life.on(win, 'keydown', (event) => {
    if (event.key === 'Escape' && !event.defaultPrevented) {
      event.preventDefault();
      onClose?.();
    }
  });
}

function buildSettingsHeader(doc, life, onClose) {
  const header = el(doc, 'div', { className: 'peer-shell-modal-header' });
  const titleEl = el(doc, 'h2', { className: 'peer-shell-modal-title' });
  const titleText = textNode(doc, titleEl, 'Settings');
  header.append(titleEl, button(doc, {
    label: 'Close',
    signal: life.signal,
    attrs: { 'data-testid': 'settings-close', 'data-peer-action': 'close-settings' },
    onClick: () => onClose?.()
  }));
  return { header, titleText };
}

function applySettingsDialogUpdate(state, fileErrEl, fileErrText, model = {}) {
  if (state.life.dead) return;
  state.lastSection = model?.section ?? null;
  syncActiveTabUi(state, state.lastSection);
  const accessErr = String(model?.settings?.fileAccessError ?? '').trim();
  writeText(fileErrText, accessErr);
  fileErrEl.hidden = accessErr === '';
  for (const handle of state.handles) handle.update(model);
}

function handleTabPick(state, callbacks, tabId) {
  if (!VALID_TAB_IDS.has(tabId)) return;
  if (typeof callbacks.onSelectSection === 'function') { callbacks.onSelectSection(tabId); return; }
  state.fallbackTab = tabId;
  syncActiveTabUi(state, state.lastSection);
}

export function createSettingsDialog(host, callbacks = {}) {
  const doc = documentOf(host);
  injectUiStyles(doc);
  injectShellStyles(doc);
  injectSettingsStyles(doc);
  const life = createLife();
  const backdrop = el(doc, 'div', {
    className: 'peer-shell-backdrop',
    attrs: { 'data-testid': 'settings-dialog', 'data-peer-layer': 'settings' }
  });
  const modal = el(doc, 'section', {
    className: 'peer-shell-modal peer-settings-modal',
    attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Settings', tabindex: '-1' }
  });
  const { header, titleText } = buildSettingsHeader(doc, life, callbacks.onClose);
  const fileErrEl = el(doc, 'p', { className: 'peer-settings-error', attrs: { 'data-peer-file-access-error': '', hidden: true } });
  const fileErrText = textNode(doc, fileErrEl);
  const panelIds = new Map(SETTINGS_TABS.map((t) => [t.id, uniqueId(`peer-settings-${t.id}`)]));
  const panelsHost = el(doc, 'div', { className: 'peer-settings-panels' });
  const state = { life, fallbackTab: 'models', lastSection: null, tabButtons: null, panels: null, handles: null, titleText };
  const tabs = buildTabStrip(doc, life, panelIds, (tabId) => handleTabPick(state, callbacks, tabId));
  const mounted = mountSectionPanels(doc, panelsHost, panelIds, callbacks);
  state.tabButtons = tabs.tabButtons;
  state.panels = mounted.panels;
  state.handles = mounted.handles;
  modal.append(header, fileErrEl, tabs.strip, panelsHost);
  backdrop.append(modal);
  host.append(backdrop);
  bindSettingsDismiss(life, doc.defaultView, backdrop, callbacks.onClose);
  const update = (model = {}) => applySettingsDialogUpdate(state, fileErrEl, fileErrText, model);
  update({});
  const destroy = () => {
    if (!life.destroy()) return;
    for (let i = state.handles.length - 1; i >= 0; i -= 1) state.handles[i].destroy();
    backdrop.remove();
  };
  return { node: backdrop, update, destroy };
}
