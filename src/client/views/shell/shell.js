/**
 * Root shell view (`views §2.1–§2.2`, `R4`, `R6`, `C2b`).
 * Subscribes to `router`, `shell`, and optional `sessions`, `activity`,
 * `settings`, `models`, `appearance`, `desktop`, and `prefs` stores,
 * coordinates `createScreenSlot`, `createLayerStack`, `createShortcutRouter`,
 * and `createToaster`, and never mutates `<html>` (`R6`).
 */
import { createLife, createToaster, documentOf } from 'cloudcanvas-lib/ui';
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
  const hasPickDirectory = typeof desktop?.pickDirectory === 'function';
  const hasPickFiles = typeof desktop?.pickFiles === 'function';
  return {
    hasPickDirectory,
    onPickDirectory: hasPickDirectory ? () => desktop.pickDirectory() : undefined,
    onPickFiles: hasPickFiles ? () => desktop.pickFiles() : undefined
  };
}

function buildShellFrameCallbacks(layers, navigate, stores, pickers) {
  const { shell, sessions, activity, settings, models, appearance, desktop, prefs } = stores;
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
    onImportData: (sourceDirectory) => settings?.send?.({ type: 'import-learnharness', sourceDirectory })
  };
}

function subscribeOptionalStores(life, stores, listener) {
  for (const store of stores) {
    if (store && typeof store.subscribe === 'function') life.add(store.subscribe(listener));
  }
}

function createChromeSyncer(life, frame, stores) {
  const { router, shell, sessions, activity, settings, models, appearance, desktop, prefs } = stores;
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
      activeRoute: router?.get?.()?.route ?? null
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
  router, shell, sessions, activity, settings, models, appearance, desktop, prefs, screen, blocks
} = {}) {
  const doc = documentOf(host);
  const win = doc.defaultView;
  const life = createLife();
  const navigate = (to, options) => router.send({ type: 'navigate', to, replace: options?.replace });
  let slot = null;
  const layers = createLayerStack(win, { onUnhandledEscape: () => Boolean(slot?.command('escape-session')) });
  const stores = { router, shell, sessions, activity, settings, models, appearance, desktop, prefs };
  const pickers = buildDesktopPickers(desktop);
  const frame = createShellFrame(host, buildShellFrameCallbacks(layers, navigate, stores, pickers));
  const toaster = createToaster(frame.layerHost);
  slot = mountShellSlot(frame, screen, navigate, blocks, shell, pickers);
  const keys = createShortcutRouter(win, {
    layers,
    getOverrides: () => prefs?.get?.()?.keymapOverrides ?? null,
    onShellAction: (action) => handleShellShortcut(action, shell, router, frame),
    onScreenAction: (action) => slot.command(action)
  });

  const syncChrome = createChromeSyncer(life, frame, stores);
  syncChrome();
  slot.syncRoute(router.get());
  subscribeOptionalStores(life, [shell, sessions, activity, settings, models, appearance, desktop, prefs], syncChrome);
  life.add(router.subscribe((routeModel) => { slot.syncRoute(routeModel); syncChrome(); }));

  return {
    toaster,
    focusSidebarSearch: () => frame.focusSidebarSearch(),
    openViewer: (payload) => frame.openViewer(payload),
    closeViewer: () => frame.closeViewer(),
    destroy: () => {
      if (!life.destroy()) return;
      keys.destroy(); slot.destroy(); toaster.destroy(); layers.destroy(); frame.destroy();
    }
  };
}
