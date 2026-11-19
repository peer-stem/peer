/**
 * Route screen-key derivation and C1 screen-view factory resolver (`views §2.3–§2.4`, `R1`).
 */
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

export function resolveScreenFactory(route, { blocks, onToggleSidebar } = {}) {
  if (route?.name === 'session') {
    return (host, ctx) => createSessionView(host, { ...ctx, blocks, onToggleSidebar });
  }
  if (route?.name === 'not-found') {
    return (host, ctx) => createNotFoundScreen(host, ctx);
  }
  return (host, ctx) => createPendingScreen(host, ctx);
}
