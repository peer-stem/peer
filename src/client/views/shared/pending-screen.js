/**
 * Placeholder screen for routes scheduled for Sprint C2 (`home`, `new-session`, `plugin-view`).
 * Wraps CloudCanvas UI `createEmptyState` (`views §2.3`, `R3`).
 */
import { createEmptyState, createLife, documentOf, el, injectUiStyles } from 'cloudcanvas-lib/ui';
import { injectSharedStyles } from './shared.css.js';

export function createPendingScreen(host, { send } = {}) {
  const doc = documentOf(host);
  injectUiStyles(doc);
  injectSharedStyles(doc);
  const life = createLife();
  const root = el(doc, 'section', {
    className: 'peer-shared-pending',
    attrs: { 'data-peer-screen': 'pending' }
  });
  const empty = createEmptyState(root, {
    onAction: () => send?.({ type: 'open-settings', section: 'models' })
  });
  host.append(root);
  let lastModel = null;

  const update = (model = {}) => {
    if (life.dead || model === lastModel) return;
    lastModel = model;
    if (model.routeName) root.setAttribute('data-peer-route', String(model.routeName));
    else root.removeAttribute('data-peer-route');
    empty.update({
      kind: 'empty',
      title: model.title ?? '',
      body: model.body ?? '',
      actionLabel: model.configured === false ? 'Open settings' : undefined
    });
  };

  const destroy = () => {
    if (!life.destroy()) return;
    empty.destroy();
    root.remove();
  };

  return { update, destroy, command() { return false; } };
}
