/**
 * Shell DOM skeleton (`views §2.1`) and persistent layer overlays (`settings`,
 * `setup`, `cheat-sheet`, `startup-message`, and `pan-zoom-viewer`), plus
 * `createSidebarView` (`C2b`). Never touches `<html>` (`R6`).
 */
import { createLife, documentOf, el, injectUiStyles, textNode, writeText } from 'cloudcanvas-lib/ui';
import { createCheatSheet } from '../overlays/cheat-sheet.js';
import { createPanZoomViewer } from '../overlays/pan-zoom-viewer.js';
import { createStartupMessageDialog } from '../overlays/startup-message.js';
import { createSettingsDialog } from '../settings/settings-dialog.js';
import { createSetupDialog } from '../settings/setup-dialog.js';
import { createSidebarView } from '../sidebar/sidebar-view.js';
import { injectShellStyles } from './shell.css.js';

const AUX_STORE_KEYS = [
  'settings', 'models', 'appearance', 'desktop', 'prefs', 'sessions', 'activity',
  'plugins', 'pluginManager', 'speech', 'activeRoute', 'pathname'
];

function isLegacySettingsModel(aux) {
  if (!aux || typeof aux !== 'object') return false;
  if (AUX_STORE_KEYS.some((key) => key in aux)) return false;
  return 'record' in aux || 'load' in aux || 'lastImport' in aux || 'effective' in aux || 'error' in aux;
}

function normalizeAuxStores(aux) {
  const empty = {
    settings: null, models: null, appearance: null, desktop: null,
    prefs: null, sessions: null, activity: null, plugins: null,
    pluginManager: null, speech: null, activeRoute: null, pathname: '/'
  };
  if (!aux || typeof aux !== 'object') return empty;
  if (isLegacySettingsModel(aux)) return { ...empty, settings: aux };
  return {
    settings: aux.settings ?? null,
    models: aux.models ?? null,
    appearance: aux.appearance ?? null,
    desktop: aux.desktop ?? null,
    prefs: aux.prefs ?? null,
    sessions: aux.sessions ?? null,
    activity: aux.activity ?? null,
    plugins: aux.plugins ?? null,
    pluginManager: aux.pluginManager ?? null,
    speech: aux.speech ?? null,
    activeRoute: aux.activeRoute ?? null,
    pathname: aux.pathname ?? '/'
  };
}

function deriveSidebarModel(auxStores) {
  const activeRoute = auxStores.activeRoute;
  const activeChatId = activeRoute?.name === 'session'
    ? activeRoute.id
    : (auxStores.sessions?.activeChatId ?? null);
  const appearance = auxStores.appearance?.appearance
    ?? auxStores.settings?.effective?.appearance
    ?? auxStores.settings?.record?.appearance
    ?? null;
  return {
    sessionsStore: auxStores.sessions ?? {},
    activity: auxStores.activity ?? {},
    plugins: auxStores.plugins,
    pluginManager: auxStores.pluginManager,
    pathname: auxStores.pathname,
    activeChatId,
    appearance
  };
}

function syncSettingsLayer(state, shellModel, auxStores) {
  const want = Boolean(shellModel?.settings?.open);
  if (want && !state.settingsOverlay) {
    state.settingsOverlay = createSettingsDialog(state.layerHost, {
      ...state.callbacks,
      onSelectSection: state.callbacks.onSelectSettingsSection ?? state.callbacks.onSelectSection,
      onClose: () => state.callbacks.onCloseSettings?.()
    });
    state.layers?.push({ id: 'settings', kind: 'modal', onEscape: () => state.callbacks.onCloseSettings?.() });
  } else if (!want && state.settingsOverlay) {
    state.layers?.remove('settings');
    state.settingsOverlay.destroy();
    state.settingsOverlay = null;
  }
  if (!state.settingsOverlay) return;
  state.settingsOverlay.update({
    section: shellModel?.settings?.section ?? null,
    shell: shellModel,
    settings: auxStores.settings,
    models: auxStores.models,
    appearance: auxStores.appearance,
    desktop: auxStores.desktop,
    prefs: auxStores.prefs,
    plugins: auxStores.plugins,
    pluginManager: auxStores.pluginManager,
    speech: auxStores.speech
  });
}

function syncSetupAndCheatLayers(state, shellModel, auxStores) {
  const wantSetup = Boolean(shellModel?.setupOpen);
  if (wantSetup && !state.setupOverlay) {
    state.setupOverlay = createSetupDialog(state.layerHost, {
      onClose: () => state.callbacks.onCloseSetup?.(),
      onSettingsIntent: state.callbacks.onSettingsIntent,
      onModelsIntent: state.callbacks.onModelsIntent
    });
    state.layers?.push({ id: 'setup', kind: 'modal', onEscape: () => state.callbacks.onCloseSetup?.() });
  } else if (!wantSetup && state.setupOverlay) {
    state.layers?.remove('setup');
    state.setupOverlay.destroy();
    state.setupOverlay = null;
  }
  if (state.setupOverlay) state.setupOverlay.update({ settings: auxStores.settings, models: auxStores.models });

  const wantCheat = Boolean(shellModel?.cheatSheet);
  if (wantCheat && !state.cheatOverlay) {
    state.cheatOverlay = createCheatSheet(state.layerHost, { onClose: () => state.callbacks.onCloseCheatSheet?.() });
    state.layers?.push({ id: 'cheat-sheet', kind: 'modal', onEscape: () => state.callbacks.onCloseCheatSheet?.() });
  } else if (!wantCheat && state.cheatOverlay) {
    state.layers?.remove('cheat-sheet');
    state.cheatOverlay.destroy();
    state.cheatOverlay = null;
  }
  if (state.cheatOverlay) {
    state.cheatOverlay.update({ open: true, keymapOverrides: auxStores.prefs?.keymapOverrides ?? null });
  }
}

function syncStartupMessageLayer(state, shellModel, auxStores) {
  const message = shellModel?.startupMessage ?? auxStores.desktop?.startupMessage ?? null;
  const want = Boolean(message);
  if (want && !state.startupOverlay) {
    state.startupOverlay = createStartupMessageDialog(state.layerHost, {
      onDismiss: (id) => state.callbacks.onDismissStartupMessage?.(id ?? state.lastStartupId)
    });
    state.layers?.push({
      id: 'startup-message',
      kind: 'modal',
      onEscape: () => state.callbacks.onDismissStartupMessage?.(state.lastStartupId)
    });
  } else if (!want && state.startupOverlay) {
    state.layers?.remove('startup-message');
    state.startupOverlay.destroy();
    state.startupOverlay = null;
    state.lastStartupId = null;
  }
  if (state.startupOverlay && message) {
    state.lastStartupId = message.id ?? message.message?.id ?? null;
    state.startupOverlay.update(message);
  }
}

function openViewerOverlay(state, payload) {
  if (state.life.dead) return;
  if (!state.viewerOverlay) {
    state.viewerOverlay = createPanZoomViewer(state.layerHost, { onClose: () => closeViewerOverlay(state) });
    state.layers?.push({ id: 'viewer', kind: 'modal', onEscape: () => closeViewerOverlay(state) });
  }
  state.viewerOverlay.update(payload);
}

function closeViewerOverlay(state) {
  if (!state.viewerOverlay) return;
  state.layers?.remove('viewer');
  state.viewerOverlay.destroy();
  state.viewerOverlay = null;
}

function applyFrameUpdate(state, nodes, shellModel = {}, aux = null) {
  if (state.life.dead) return;
  const auxStores = normalizeAuxStores(aux);
  nodes.root.setAttribute('data-peer-platform', String(shellModel?.platform ?? 'web'));
  nodes.root.setAttribute('data-peer-electron', String(Boolean(shellModel?.electron)));
  nodes.side.hidden = !shellModel?.sidebar?.open;
  nodes.side.setAttribute('data-peer-narrow', String(Boolean(shellModel?.sidebar?.narrow)));
  state.sidebarView.update(deriveSidebarModel(auxStores));
  const upd = shellModel?.update ?? auxStores.desktop?.update ?? null;
  const bannerMsg = upd ? `Update ${upd.version} (${upd.status})` : '';
  writeText(nodes.updateText, bannerMsg);
  nodes.updateBanner.hidden = bannerMsg === '';
  syncSettingsLayer(state, shellModel, auxStores);
  syncSetupAndCheatLayers(state, shellModel, auxStores);
  syncStartupMessageLayer(state, shellModel, auxStores);
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
  const side = el(doc, 'aside', { className: 'peer-shell-side', attrs: { 'aria-label': 'Workspace navigation' } });
  const content = el(doc, 'main', { className: 'peer-shell-content' });
  const layerHost = el(doc, 'div', { className: 'peer-shell-layer' });
  const updateBanner = el(doc, 'div', { className: 'peer-shell-update', attrs: { 'data-peer-update': '', hidden: true } });
  const updateText = textNode(doc, updateBanner);
  layerHost.append(updateBanner);
  const sidebarView = createSidebarView(side, {
    ...callbacks,
    layerHost,
    layers
  });
  root.append(side, content, layerHost);
  host.append(root);
  const state = {
    doc, life, layerHost, layers, callbacks, sidebarView, lastStartupId: null,
    settingsOverlay: null, setupOverlay: null, cheatOverlay: null, startupOverlay: null, viewerOverlay: null
  };
  const nodes = { root, side, updateBanner, updateText };

  const destroy = () => {
    if (!life.destroy()) return;
    state.viewerOverlay?.destroy();
    state.startupOverlay?.destroy();
    state.cheatOverlay?.destroy();
    state.setupOverlay?.destroy();
    state.settingsOverlay?.destroy();
    state.sidebarView.destroy();
    state.viewerOverlay = null;
    state.startupOverlay = null;
    state.cheatOverlay = null;
    state.setupOverlay = null;
    state.settingsOverlay = null;
    root.remove();
  };

  return {
    root, side, content, layerHost,
    update: (shellModel, aux) => applyFrameUpdate(state, nodes, shellModel, aux),
    focusSidebarSearch: () => sidebarView.focusSearch(),
    openViewer: (payload) => openViewerOverlay(state, payload),
    closeViewer: () => closeViewerOverlay(state),
    destroy
  };
}
