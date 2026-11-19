/**
 * Shared screen top bar (`views §1.4`, `§2.1`).
 * Renders sidebar toggle, optional home trigger, title (`--peer-font-title`),
 * kind chip, subtitle, badge, and optional settings trigger.
 */
import { button, createLife, documentOf, el, injectUiStyles, textNode, writeText } from 'cloudcanvas-lib/ui';
import { injectSharedStyles } from './shared.css.js';

function formatKindLabel(kind) {
  if (kind === 'practice') return 'Practice';
  if (kind === 'teach') return 'Lesson';
  return kind ? String(kind) : '';
}

function buildTopBarNodes(doc, life, callbacks) {
  const root = el(doc, 'header', { className: 'peer-shared-top-bar', attrs: { 'data-peer-top-bar': '' } });
  const start = el(doc, 'div', { className: 'peer-shared-top-bar-start' });
  const heading = el(doc, 'div', { className: 'peer-shared-top-bar-heading' });
  const end = el(doc, 'div', { className: 'peer-shared-top-bar-end' });

  const sidebarBtn = button(doc, {
    className: 'peer-shared-top-bar-sidebar',
    label: 'Sidebar',
    ariaLabel: 'Toggle sessions sidebar',
    signal: life.signal,
    onClick: () => callbacks.onToggleSidebar?.(),
    attrs: { 'data-peer-action': 'toggle-sidebar', hidden: typeof callbacks.onToggleSidebar !== 'function' }
  });
  const homeBtn = button(doc, {
    className: 'peer-shared-top-bar-home',
    label: 'Map',
    ariaLabel: 'Knowledge map',
    signal: life.signal,
    onClick: () => callbacks.onNavigateHome?.(),
    attrs: { 'data-peer-action': 'navigate-home', hidden: typeof callbacks.onNavigateHome !== 'function' }
  });
  start.append(sidebarBtn, homeBtn);

  const titleEl = el(doc, 'h1', { className: 'peer-shared-top-bar-title' });
  const kindEl = el(doc, 'span', { className: 'peer-shared-top-bar-kind', attrs: { 'data-peer-kind': '', hidden: true } });
  const subtitleEl = el(doc, 'span', { className: 'peer-shared-top-bar-subtitle', attrs: { hidden: true } });
  const texts = {
    title: textNode(doc, titleEl),
    kind: textNode(doc, kindEl),
    subtitle: textNode(doc, subtitleEl)
  };
  heading.append(titleEl, kindEl, subtitleEl);

  const badgeEl = el(doc, 'span', { className: 'peer-shared-top-bar-badge', attrs: { 'data-peer-badge': '', hidden: true } });
  texts.badge = textNode(doc, badgeEl);
  const settingsBtn = button(doc, {
    className: 'peer-shared-top-bar-settings',
    label: 'Settings',
    ariaLabel: 'Open settings',
    signal: life.signal,
    onClick: () => callbacks.onOpenSettings?.(),
    attrs: { 'data-peer-action': 'open-settings', hidden: typeof callbacks.onOpenSettings !== 'function' }
  });
  end.append(badgeEl, settingsBtn);
  root.append(start, heading, end);
  return { root, sidebarBtn, kindEl, subtitleEl, badgeEl, texts };
}

function applyTopBarModel(nodes, model = {}) {
  writeText(nodes.texts.title, model.title ?? '');
  const kindText = formatKindLabel(model.kind);
  writeText(nodes.texts.kind, kindText);
  nodes.kindEl.hidden = kindText === '';
  if (model.kind) nodes.kindEl.setAttribute('data-peer-kind', String(model.kind));
  else nodes.kindEl.removeAttribute('data-peer-kind');

  const subtitle = String(model.subtitle ?? '').trim();
  writeText(nodes.texts.subtitle, subtitle);
  nodes.subtitleEl.hidden = subtitle === '';

  const badge = String(model.badge ?? '').trim();
  writeText(nodes.texts.badge, badge);
  nodes.badgeEl.hidden = badge === '';

  if (model.sidebarOpen !== undefined) {
    nodes.sidebarBtn.setAttribute('aria-expanded', String(Boolean(model.sidebarOpen)));
  }
}

export function createTopBar(host, callbacks = {}) {
  const doc = documentOf(host);
  injectUiStyles(doc);
  injectSharedStyles(doc);
  const life = createLife();
  const nodes = buildTopBarNodes(doc, life, callbacks);
  host.append(nodes.root);
  let lastModel = null;

  const update = (model = {}) => {
    if (life.dead || model === lastModel) return;
    lastModel = model;
    applyTopBarModel(nodes, model);
  };

  const destroy = () => {
    if (life.destroy()) nodes.root.remove();
  };

  return { update, destroy };
}
