/**
 * Root shell view (`views §2.1–§2.2`, `R4`, `R6`, `C2b`).
 * Subscribes to `router`, `shell`, and optional `sessions`, `activity`,
 * `settings`, `models`, `appearance`, `desktop`, and `prefs` stores,
 * coordinates `createScreenSlot`, `createLayerStack`, `createShortcutRouter`,
 * and `createToaster`, and never mutates `<html>` (`R6`).
 */
import { createLife, createToaster, documentOf } from 'cloudcanvas-lib/ui';
import { dispatchFocusedPluginShortcut } from 'peer-engine';
import { dispatchPluginActionShortcuts } from '../plugin/plugin-chrome.js';
import { createShellFrame } from './frame.js';
import { createShortcutRouter } from './keys.js';
import { createLayerStack } from './layers.js';
import { resolveScreenFactory } from './screens.js';
import { createScreenSlot } from './slot.js';

function sendQuiet(store, intent) {
  if (!store || typeof store.send !== 'function') return;
  try {
    const pending = store.send(intent);
    if (pending && typeof pending.catch === 'function') pending.catch(() => {});
  } catch {
    /* ignore unsupported intents on minimal mock stores */
  }
}

function handleShellShortcut(action, shell, router, frame) {
  switch (action) {
    case 'toggle-sidebar':
      shell.send({ type: 'toggle-sidebar' });
      return true;
    case 'sessions-search':
      shell.send({ type: 'set-sidebar', open: true });
      frame?.focusSidebarSearch?.();
      return true;
    case 'open-settings':
      shell.send({ type: 'open-settings' });
      return true;
    case 'cheat-sheet':
      shell.send({ type: 'toggle-cheat-sheet' });
      return true;
    case 'new-session':
      router.send({ type: 'navigate', to: { name: 'new-session', mode: 'teach' } });
      return true;
    case 'jump-graph':
      router.send({ type: 'navigate', to: { name: 'home' } });
      return true;
    default:
      return false;
  }
}

function buildDesktopPickers(desktop) {
  const isElectron = typeof desktop?.get === 'function' ? Boolean(desktop.get()?.electron) : Boolean(desktop);
  const hasPickDirectory = isElectron && typeof desktop?.pickDirectory === 'function';
  const hasPickFiles = isElectron && typeof desktop?.pickFiles === 'function';
  return {
    hasPickDirectory,
    onPickDirectory: hasPickDirectory ? () => desktop.pickDirectory() : undefined,
    onPickFiles: hasPickFiles ? () => desktop.pickFiles() : undefined
  };
}

function buildShellFrameCallbacks(layers, navigate, stores, pickers) {
  const { shell, sessions, activity, settings, models, appearance, desktop, prefs, plugins, speech } = stores;
  return {
    layers,
    onNavigate: (to) => navigate(to),
    onToggleSidebar: () => shell.send({ type: 'toggle-sidebar' }),
    onOpenSettings: (section) => shell.send({ type: 'open-settings', ...(section ? { section } : {}) }),
    onSelectSettingsSection: (section) => shell.send({ type: 'open-settings', section }),
    onCloseSettings: () => shell.send({ type: 'close-settings' }),
    onCloseSetup: () => sendQuiet(shell, { type: 'close-setup' }),
    onCloseCheatSheet: () => shell.send({ type: 'close-cheat-sheet' }),
    onDismissStartupMessage: (id) => {
      if (typeof desktop?.dismissStartupMessage === 'function') return desktop.dismissStartupMessage(id);
      return sendQuiet(shell, { type: 'clear-startup-message' });
    },
    onSessionsIntent: (intent) => {
      const normalized = intent?.type === 'source-action' && intent.body && !intent.action
        ? { ...intent, action: intent.body }
        : intent;
      if (normalized?.type === 'delete-session' || normalized?.type === 'delete-folder') return sessions?.send?.(normalized);
      return sendQuiet(sessions, normalized);
    },
    onSetKindFilter: (filter) => sendQuiet(sessions, { type: 'set-kind-filter', filter, kind: filter }),
    onRequestCoverage: (chatId) => sendQuiet(sessions, { type: 'load-coverage', id: chatId, chatId }),
    onExtractSession: (chatId) => sendQuiet(activity, { type: 'reload' }),
    onActivityAbort: ({ kind, id }) => activity?.send?.({ type: 'abort', kind, id }),
    onSettingsIntent: (intent) => settings?.send?.(intent),
    onModelsIntent: (intent) => models?.send?.(intent),
    onAppearanceIntent: (intent) => appearance?.send?.(intent),
    onDesktopIntent: (intent) => desktop?.send?.(intent),
    onPickDirectory: pickers.onPickDirectory,
    onPickFiles: pickers.onPickFiles,
    hasPickDirectory: pickers.hasPickDirectory,
    onPrefsIntent: (intent) => prefs?.send?.(intent),
    onPluginsIntent: (intent) => plugins?.send?.(intent),
    onSpeechIntent: (intent) => speech?.send?.(intent),
    onImportData: (sourceDirectory) => settings?.send?.({ type: 'import-learnharness', sourceDirectory })
  };
}

function subscribeOptionalStores(life, stores, listener) {
  for (const store of stores) {
    if (store && typeof store.subscribe === 'function') life.add(store.subscribe(listener));
  }
}

function createChromeSyncer(life, frame, stores) {
  const { router, shell, sessions, activity, settings, models, appearance, desktop, prefs, plugins, speech } = stores;
  let wasSettingsOpen = Boolean(shell.get()?.settings?.open);
  let wasSetupOpen = Boolean(shell.get()?.setupOpen);
  return () => {
    if (life.dead) return;
    const shellModel = shell.get();
    const nowSettingsOpen = Boolean(shellModel?.settings?.open);
    const nowSetupOpen = Boolean(shellModel?.setupOpen);
    if ((!wasSettingsOpen && nowSettingsOpen) || (!wasSetupOpen && nowSetupOpen)) {
      sendQuiet(settings, { type: 'load-aux' });
    }
    wasSettingsOpen = nowSettingsOpen;
    wasSetupOpen = nowSetupOpen;
    frame.update(shellModel, {
      settings: settings?.get?.() ?? null,
      models: models?.get?.() ?? null,
      appearance: appearance?.get?.() ?? null,
      desktop: desktop?.get?.() ?? null,
      prefs: prefs?.get?.() ?? null,
      sessions: sessions?.get?.() ?? null,
      activity: activity?.get?.() ?? null,
      plugins: plugins?.get?.() ?? null,
      pluginManager: plugins?.manager ?? null,
      speech: speech?.get?.() ?? null,
      activeRoute: router?.get?.()?.route ?? null,
      pathname: router?.get?.()?.pathname ?? '/'
    });
  };
}

function mountShellSlot(frame, screen, navigate, blocks, shell, pickers) {
  return createScreenSlot(frame.content, {
    screen,
    navigate,
    resolveFactory: (route) => resolveScreenFactory(route, {
      blocks,
      onToggleSidebar: () => shell.send({ type: 'toggle-sidebar' }),
      onExpand: (payload) => frame.openViewer(payload),
      onPickDirectory: pickers.onPickDirectory,
      onPickFiles: pickers.onPickFiles
    })
  });
}

export function createShell(host, {
  router, shell, sessions, activity, settings, models, appearance, desktop, prefs, plugins, speech, dictation, screen, blocks
} = {}) {
  const doc = documentOf(host);
  const win = doc.defaultView;
  const life = createLife();
  const navigate = (to, options) => router.send({ type: 'navigate', to, replace: options?.replace });
  let slot = null;
  const onEscapeFallback = () => {
    if (dictation?.get?.()?.phase && dictation.get().phase !== 'idle') {
      dictation.cancel();
      return true;
    }
    return Boolean(slot?.command('escape-session'));
  };
  const layers = createLayerStack(win, { onUnhandledEscape: onEscapeFallback });
  const stores = { router, shell, sessions, activity, settings, models, appearance, desktop, prefs, plugins, speech };
  const pickers = buildDesktopPickers(desktop);
  const frame = createShellFrame(host, buildShellFrameCallbacks(layers, navigate, stores, pickers));
  const toaster = createToaster(frame.layerHost);
  slot = mountShellSlot(frame, screen, navigate, blocks, shell, pickers);
  const keys = createShortcutRouter(win, {
    layers,
    getOverrides: () => prefs?.get?.()?.keymapOverrides ?? null,
    onShellAction: (action) => handleShellShortcut(action, shell, router, frame),
    onScreenAction: (action) => dispatchFocusedPluginShortcut(action) || slot.command(action),
    onRawKeyDown: (ev) => dispatchPluginActionShortcuts(ev, plugins?.get?.(), plugins?.manager)
  });

  const syncChrome = createChromeSyncer(life, frame, stores);
  syncChrome();
  slot.syncRoute(router.get());
  subscribeOptionalStores(life, [shell, sessions, activity, settings, models, appearance, desktop, prefs, plugins, speech], syncChrome);
  life.add(router.subscribe((routeModel) => { slot.syncRoute(routeModel); syncChrome(); }));

  return {
    toaster,
    layerHost: frame.layerHost,
    focusSidebarSearch: () => frame.focusSidebarSearch(),
    openViewer: (payload) => frame.openViewer(payload),
    closeViewer: () => frame.closeViewer(),
    destroy: () => {
      if (!life.destroy()) return;
      keys.destroy(); slot.destroy(); toaster.destroy(); layers.destroy(); frame.destroy();
    }
  };
}
