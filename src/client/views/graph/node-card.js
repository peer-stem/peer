/**
 * Selected proposition detail card (`[data-testid="node-card"]`, `C2a V-Graph`).
 * Displays full statement, LumberJack mastery % (`[data-peer-mastery]`), FSRS-6
 * schedule fields (`[data-peer-fsrs]`), multi-parent reasoning chains
 * (`premises -> conclusion`), deep-link provenance (`/chat/{chatId}#msg-{messageId}`),
 * and `[data-peer-action="delete-node"]`.
 */
import { button, createLife, documentOf, el, injectUiStyles } from 'cloudcanvas-lib/ui';
import { injectGraphStyles } from './graph.css.js';

const FSRS_FIELDS = Object.freeze([
  ['stability', 'Stability'],
  ['difficulty', 'Difficulty'],
  ['reps', 'Reps'],
  ['lapses', 'Lapses'],
  ['due', 'Due']
]);

function buildFsrsNode(doc, fsrs) {
  const list = el(doc, 'dl', { className: 'peer-graph-fsrs', attrs: { 'data-peer-fsrs': '' } });
  for (const [key, label] of FSRS_FIELDS) {
    const pair = el(doc, 'div', { className: 'peer-graph-fsrs-pair' });
    const dt = el(doc, 'dt', { text: label });
    const dd = el(doc, 'dd', { text: fsrs[key] ?? '—', attrs: { 'data-peer-fsrs-field': key } });
    pair.append(dt, dd);
    list.append(pair);
  }
  return list;
}

function buildChainsSection(doc, chains) {
  const wrap = el(doc, 'div', { attrs: { 'data-peer-node-chains': '' } });
  wrap.append(el(doc, 'div', { className: 'peer-graph-section-label', text: 'Reasoning chains' }));
  const ul = el(doc, 'ul', { className: 'peer-graph-list' });
  for (const chain of chains) {
    ul.append(el(doc, 'li', { text: chain.line, attrs: { 'data-peer-chain-id': chain.id } }));
  }
  wrap.append(ul);
  return wrap;
}

function renderProvenanceItem(doc, entry) {
  const li = el(doc, 'li');
  if (entry.kind === 'file' || !entry.href) {
    li.append(el(doc, 'span', {
      text: entry.label,
      attrs: { 'data-peer-provenance-file': entry.sourceId }
    }));
    return li;
  }
  li.append(el(doc, 'a', {
    className: 'peer-graph-provenance-link',
    text: entry.label,
    attrs: {
      href: entry.href,
      'data-peer-provenance-link': entry.href,
      'data-peer-chat-id': entry.sourceId
    }
  }));
  return li;
}

function buildProvenanceSection(doc, provenance) {
  const wrap = el(doc, 'div', { attrs: { 'data-peer-node-provenance': '' } });
  wrap.append(el(doc, 'div', { className: 'peer-graph-section-label', text: 'Provenance' }));
  if (provenance.length === 0) {
    wrap.append(el(doc, 'p', { className: 'peer-graph-import-notice', text: 'No sessions recorded.' }));
    return wrap;
  }
  const ul = el(doc, 'ul', { className: 'peer-graph-list' });
  for (const entry of provenance) ul.append(renderProvenanceItem(doc, entry));
  wrap.append(ul);
  return wrap;
}

function buildCardElement(doc, model) {
  const card = el(doc, 'aside', {
    className: 'peer-graph-node-card',
    attrs: { 'data-testid': 'node-card', 'data-peer-node-id': model.id, 'aria-label': `Proposition: ${model.name}` }
  });
  const head = el(doc, 'div', { className: 'peer-graph-node-head' });
  head.append(
    el(doc, 'h3', { className: 'peer-graph-node-title', text: model.name, attrs: { 'data-peer-node-name': '' } }),
    button(doc, { label: 'Close', ariaLabel: 'Close proposition card', attrs: { 'data-peer-action': 'close-node-card' } })
  );
  card.append(
    head,
    el(doc, 'p', { className: 'peer-graph-node-statement', text: model.statement, attrs: { 'data-peer-node-statement': '' } })
  );
  if (model.masteryText) {
    card.append(el(doc, 'div', {
      className: 'peer-graph-mastery',
      text: model.masteryText,
      attrs: { 'data-peer-mastery': model.masteryPercent ?? '' }
    }));
  }
  if (model.fsrs) card.append(buildFsrsNode(doc, model.fsrs));
  if (Array.isArray(model.chains) && model.chains.length > 0) card.append(buildChainsSection(doc, model.chains));
  card.append(buildProvenanceSection(doc, Array.isArray(model.provenance) ? model.provenance : []));

  const foot = el(doc, 'div', { className: 'peer-graph-node-foot' });
  foot.append(button(doc, {
    className: 'peer-graph-danger-btn',
    label: 'Delete proposition',
    ariaLabel: `Delete proposition ${model.name}`,
    attrs: { 'data-peer-action': 'delete-node', 'data-peer-delete-id': model.id }
  }));
  card.append(foot);
  return card;
}

export function createNodeCard(host, callbacks = {}) {
  const doc = documentOf(host);
  injectUiStyles(doc);
  injectGraphStyles(doc);
  const life = createLife();
  let currentCard = null;
  let currentModel = null;

  life.on(host, 'click', (event) => {
    const link = event.target?.closest?.('[data-peer-provenance-link]');
    if (link && event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
      event.preventDefault();
      const href = link.getAttribute('href');
      if (href) callbacks.onNavigate?.(href);
      return;
    }
    const action = event.target?.closest?.('[data-peer-action]')?.getAttribute('data-peer-action');
    if (action === 'close-node-card') callbacks.onClose?.();
    if (action === 'delete-node' && currentModel?.id) {
      callbacks.onDeleteNode?.(currentModel.id, currentModel.name);
    }
  });

  const update = (model = null) => {
    if (life.dead || model === currentModel) return;
    currentModel = model;
    currentCard?.remove();
    currentCard = null;
    if (!model || !model.id) return;
    currentCard = buildCardElement(doc, model);
    host.append(currentCard);
  };

  const destroy = () => {
    if (!life.destroy()) return;
    currentCard?.remove();
    currentCard = null;
    currentModel = null;
  };

  return { update, destroy };
}
