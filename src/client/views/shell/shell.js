/**
 * Root shell view (`views §2.1–§2.2`, `R4`, `R6`).
 * Subscribes to `router`, `shell`, and optional `settings` stores, coordinates
 * `createScreenSlot`, `createLayerStack`, `createShortcutRouter`, and `createToaster`,
 * and never mutates `<html>` (`R6`).
 */
import { createLife, createToaster, documentOf } from 'cloudcanvas-lib/ui';
import { createShellFrame } from './frame.js';
import { createShortcutRouter } from './keys.js';
import { createLayerStack } from './layers.js';
import { resolveScreenFactory } from './screens.js';
import { createScreenSlot } from './slot.js';

function handleShellShortcut(action, shell, router) {
  switch (action) {
    case 'toggle-sidebar':
      shell.send({ type: 'toggle-sidebar' });
      return true;
    case 'sessions-search':
      shell.send({ type: 'set-sidebar', open: true });
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

function buildShellFrameCallbacks(layers, navigate, shell, settings) {
  return {
    layers,
    onNavigate: (to) => navigate(to),
    onOpenSettings: () => shell.send({ type: 'open-settings' }),
    onCloseSettings: () => shell.send({ type: 'close-settings' }),
    onCloseCheatSheet: () => shell.send({ type: 'close-cheat-sheet' }),
    onImportData: (sourceDirectory) => settings?.send({ type: 'import-learnharness', sourceDirectory })
  };
}

export function createShell(host, { router, shell, settings, screen, blocks } = {}) {
  const doc = documentOf(host);
  const win = doc.defaultView;
  const life = createLife();
  const navigate = (to, options) => router.send({ type: 'navigate', to, replace: options?.replace });
  const layers = createLayerStack(win);
  const frame = createShellFrame(host, buildShellFrameCallbacks(layers, navigate, shell, settings));
  const toaster = createToaster(frame.layerHost);
  const onToggleSidebar = () => shell.send({ type: 'toggle-sidebar' });
  const slot = createScreenSlot(frame.content, {
    screen,
    navigate,
    resolveFactory: (route) => resolveScreenFactory(route, { blocks, onToggleSidebar })
  });
  const keys = createShortcutRouter(win, {
    layers,
    onShellAction: (action) => handleShellShortcut(action, shell, router),
    onScreenAction: (action) => slot.command(action)
  });

  const syncChrome = () => {
    if (!life.dead) frame.update(shell.get(), settings ? settings.get() : null);
  };
  syncChrome();
  slot.syncRoute(router.get());
  life.add(shell.subscribe(syncChrome));
  if (settings) life.add(settings.subscribe(syncChrome));
  life.add(router.subscribe((routeModel) => slot.syncRoute(routeModel)));

  const destroy = () => {
    if (!life.destroy()) return;
    keys.destroy();
    slot.destroy();
    toaster.destroy();
    layers.destroy();
    frame.destroy();
  };

  return { toaster, destroy };
}
