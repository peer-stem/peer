/**
 * Screen mounted for unmatched paths (`route.name === "not-found"`).
 * Composes CloudCanvas UI `createStatus` and `button` (`views §2.3`).
 */
import { button, createLife, createStatus, documentOf, el, injectUiStyles } from 'cloudcanvas-lib/ui';
import { injectSharedStyles } from './shared.css.js';

export function createNotFoundScreen(host, { navigate } = {}) {
  const doc = documentOf(host);
  injectUiStyles(doc);
  injectSharedStyles(doc);
  const life = createLife();
  const root = el(doc, 'section', {
    className: 'peer-shared-not-found',
    attrs: { 'data-peer-screen': 'not-found' }
  });
  const status = createStatus(root);
  const actions = el(doc, 'div', { className: 'peer-shared-not-found-actions' });
  const homeBtn = button(doc, {
    className: 'peer-shared-not-found-home',
    label: 'Back to Home',
    signal: life.signal,
    onClick: () => navigate?.({ name: 'home' })
  });
  actions.append(homeBtn);
  root.append(actions);
  host.append(root);
  let lastModel = null;

  const update = (model = {}) => {
    if (life.dead || model === lastModel) return;
    lastModel = model;
    const path = model?.path ?? '';
    status.update({ status: 'error', message: `Route not found: ${path}` });
  };

  const destroy = () => {
    if (!life.destroy()) return;
    status.destroy();
    root.remove();
  };

  return { update, destroy, command() { return false; } };
}
