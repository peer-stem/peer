/**
 * Route screen-key derivation and C2a screen-view factory resolver (`views §2.3–§2.4`, `R1`).
 */
import { createHomeView } from '../home/home-view.js';
import { createNewSessionView } from '../new-session/new-session-view.js';
import { createPluginView } from '../plugin/plugin-view.js';
import { createSessionView } from '../session/session-view.js';
import { createNotFoundScreen } from '../shared/not-found-screen.js';
import { createPendingScreen } from '../shared/pending-screen.js';

export function screenKeyForRoute(route) {
  if (!route || typeof route !== 'object') return 'not-found';
  switch (route.name) {
    case 'home':
      return 'home';
    case 'new-session':
      return 'new-session';
    case 'session':
      return `session:${String(route.id ?? '')}`;
    case 'plugin-view':
      return `plugin-view:${String(route.pluginId ?? '')}/${String(route.viewId ?? '')}`;
    default:
      return 'not-found';
  }
}

export function resolveScreenFactory(route, {
  blocks, onToggleSidebar, onExpand, onPickDirectory, onPickFiles
} = {}) {
  if (route?.name === 'home') {
    return (host, ctx) => createHomeView(host, { ...ctx, onToggleSidebar, onPickDirectory, onPickFiles });
  }
  if (route?.name === 'new-session') {
    return (host, ctx) => createNewSessionView(host, { ...ctx, onToggleSidebar, onPickDirectory, onPickFiles });
  }
  if (route?.name === 'session') {
    return (host, ctx) => createSessionView(host, {
      ...ctx, blocks, onToggleSidebar, onExpand, onPickDirectory, onPickFiles
    });
  }
  if (route?.name === 'plugin-view') {
    return (host, ctx) => createPluginView(host, { ...ctx, onToggleSidebar });
  }
  if (route?.name === 'not-found') {
    return (host, ctx) => createNotFoundScreen(host, ctx);
  }
  return (host, ctx) => createPendingScreen(host, ctx);
}
