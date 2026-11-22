/**
 * Shell DOM skeleton (`views §2.1`) and persistent layer overlays (`settings`,
 * `setup`, `cheat-sheet`, `startup-message`, and `pan-zoom-viewer`).
 * Never touches `<html>` (`R6`).
 */
import { button, createLife, documentOf, el, injectUiStyles, textNode, writeText } from 'cloudcanvas-lib/ui';
import { createCheatSheet } from '../overlays/cheat-sheet.js';
import { createPanZoomViewer } from '../overlays/pan-zoom-viewer.js';
import { createStartupMessageDialog } from '../overlays/startup-message.js';
import { createSettingsDialog } from '../settings/settings-dialog.js';
import { createSetupDialog } from '../settings/setup-dialog.js';
import { injectShellStyles } from './shell.css.js';

const AUX_STORE_KEYS = ['settings', 'models', 'appearance', 'desktop', 'prefs'];

function isLegacySettingsModel(aux) {
  if (!aux || typeof aux !== 'object') return false;
  if (AUX_STORE_KEYS.some((key) => key in aux)) return false;
  return 'record' in aux || 'load' in aux || 'lastImport' in aux || 'effective' in aux || 'error' in aux;
}

function normalizeAuxStores(aux) {
  if (!aux || typeof aux !== 'object') {
    return { settings: null, models: null, appearance: null, desktop: null, prefs: null };
  }
  if (isLegacySettingsModel(aux)) {
    return { settings: aux, models: null, appearance: null, desktop: null, prefs: null };
  }
  return {
    settings: aux.settings ?? null,
    models: aux.models ?? null,
    appearance: aux.appearance ?? null,
    desktop: aux.desktop ?? null,
    prefs: aux.prefs ?? null
  };
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
    prefs: auxStores.prefs
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
  const side = buildSidebar(doc, life, callbacks);
  const content = el(doc, 'main', { className: 'peer-shell-content' });
  const layerHost = el(doc, 'div', { className: 'peer-shell-layer' });
  const updateBanner = el(doc, 'div', { className: 'peer-shell-update', attrs: { 'data-peer-update': '', hidden: true } });
  const updateText = textNode(doc, updateBanner);
  layerHost.append(updateBanner);
  root.append(side, content, layerHost);
  host.append(root);
  const state = {
    doc, life, layerHost, layers, callbacks, lastStartupId: null,
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
    openViewer: (payload) => openViewerOverlay(state, payload),
    closeViewer: () => closeViewerOverlay(state),
    destroy
  };
}
