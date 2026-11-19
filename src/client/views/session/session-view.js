/**
 * Read-only session screen view (`views §2.5`, Sprint C1).
 * Composes `createTopBar`, kit `createStatus`, and `createViewList` over
 * `deriveSessionViewModel` / `createMarkdown` with zero view-owned app state.
 */
import { button, createLife, createStatus, documentOf, el, injectUiStyles, textNode, writeText } from 'cloudcanvas-lib/ui';
import { createMarkdown } from '../../blocks/markdown.js';
import { createTopBar } from '../shared/top-bar.js';
import { createViewList } from '../shared/view-list.js';
import { deriveTopBarModel, deriveTranscriptItem } from './session-models.js';
import { injectSessionStyles } from './session.css.js';

function renderGraphContextNode(doc, part) {
  const details = el(doc, 'details', {
    className: 'peer-session-context',
    attrs: { 'data-peer-graph-context': '', 'data-peer-part-type': 'data-graph-context' }
  });
  const count = part.propositions.length;
  details.append(el(doc, 'summary', { text: `Session knowledge context (${count} propositions)` }));
  const body = el(doc, 'div', { className: 'peer-session-context-body' });
  if (part.propositions.length > 0) {
    const propList = el(doc, 'ul', { className: 'peer-session-context-list' });
    for (const prop of part.propositions) {
      propList.append(el(doc, 'li', { text: `[${prop.id}] ${prop.name}: ${prop.statement}` }));
    }
    body.append(propList);
  }
  if (part.chains.length > 0) {
    const chainList = el(doc, 'ul', { className: 'peer-session-context-list' });
    for (const chain of part.chains) chainList.append(el(doc, 'li', { text: chain }));
    body.append(chainList);
  }
  details.append(body);
  return details;
}

function renderCompactionNode(doc, part) {
  const isCut = part.kind === 'compaction-cut';
  const root = el(doc, 'div', {
    className: 'peer-session-divider',
    attrs: {
      'data-peer-part-type': part.partType,
      [isCut ? 'data-peer-compaction-cut' : 'data-peer-compaction']: ''
    }
  });
  const suffix = part.tokensBefore !== null ? ` (${part.tokensBefore.toLocaleString('en-US')} tokens)` : '';
  const details = el(doc, 'details');
  details.append(
    el(doc, 'summary', { text: `${part.label}${suffix}` }),
    el(doc, 'div', { className: 'peer-session-divider-body', text: part.content })
  );
  root.append(details);
  return root;
}

function renderReasoningNode(doc, part, open) {
  const details = el(doc, 'details', {
    className: 'peer-session-thinking',
    attrs: { 'data-peer-thinking': '', 'data-peer-part-type': 'reasoning' }
  });
  details.open = Boolean(open);
  const label = part.streaming ? 'Thinking…' : 'Thinking';
  details.append(
    el(doc, 'summary', { text: label }),
    el(doc, 'div', { className: 'peer-session-thinking-body', text: part.text })
  );
  return details;
}

function renderInlineImageNode(doc, part) {
  const figure = el(doc, 'figure', {
    className: 'peer-session-image',
    attrs: { 'data-peer-image': '', 'data-peer-part-type': 'image' }
  });
  figure.append(el(doc, 'img', {
    attrs: { src: `data:${part.mimeType};base64,${part.data}`, alt: part.alt || 'Attached image' }
  }));
  return figure;
}

function renderSnapshotImageNode(doc, part) {
  if (part.status === 'loading') {
    return el(doc, 'div', {
      className: 'peer-session-card',
      text: 'Loading image…',
      attrs: { 'data-peer-part-type': part.partType, 'data-peer-snapshot-id': part.snapshotId, 'data-peer-snapshot-status': 'loading' }
    });
  }
  if (part.status === 'error' || !part.image) {
    return el(doc, 'div', {
      className: 'peer-session-card peer-session-card-error',
      text: 'Could not load session image.',
      attrs: { 'data-peer-part-type': part.partType, 'data-peer-snapshot-id': part.snapshotId, 'data-peer-snapshot-status': 'error' }
    });
  }
  const img = part.image;
  const figAttrs = {
    'data-testid': 'image-card',
    'data-peer-snapshot-id': part.snapshotId,
    'data-peer-snapshot-status': 'ready',
    'data-peer-part-type': part.partType
  };
  const imgAttrs = {
    src: `data:${img.mimeType};base64,${img.data}`,
    width: img.width,
    height: img.height,
    alt: part.caption || 'Session image'
  };
  const figure = el(doc, 'figure', { className: 'peer-session-image', attrs: figAttrs });
  const caption = el(doc, 'figcaption', { text: part.caption || '', attrs: { hidden: !part.caption } });
  figure.append(el(doc, 'img', { attrs: imgAttrs }), caption);
  return figure;
}

function renderCardNode(doc, part, thinkingOpen) {
  if (part.cardKind === 'practice-thinking') {
    const details = el(doc, 'details', {
      className: 'peer-session-thinking',
      attrs: { 'data-peer-thinking': '', 'data-peer-part-type': part.partType }
    });
    details.open = Boolean(thinkingOpen);
    details.append(
      el(doc, 'summary', { text: part.title }),
      el(doc, 'div', { className: 'peer-session-thinking-body', text: part.lines.join('\n') })
    );
    return details;
  }
  const card = el(doc, 'div', {
    className: 'peer-session-card',
    attrs: { 'data-peer-part-type': part.partType, 'data-peer-card-kind': part.cardKind }
  });
  const head = el(doc, 'div', { className: 'peer-session-card-head' });
  head.append(el(doc, 'span', { className: 'peer-session-card-title', text: part.title }));
  if (part.meta) head.append(el(doc, 'span', { className: 'peer-session-card-meta', text: part.meta }));
  card.append(head);
  for (const line of part.lines) {
    card.append(el(doc, 'div', { className: 'peer-session-card-line', text: line }));
  }
  if (part.errorText) {
    card.append(el(doc, 'div', { className: 'peer-session-card-error', text: part.errorText }));
  }
  return card;
}

function mountPart(doc, parent, part, ctx) {
  if (part.kind === 'graph-context') { parent.append(renderGraphContextNode(doc, part)); return null; }
  if (part.kind === 'compaction-cut' || part.kind === 'compaction') {
    parent.append(renderCompactionNode(doc, part));
    return null;
  }
  if (part.kind === 'step-anchor') {
    parent.append(el(doc, 'span', { attrs: { 'data-peer-step-message-id': part.sourceMessageId, hidden: true } }));
    return null;
  }
  if (part.kind === 'reasoning') {
    parent.append(renderReasoningNode(doc, part, ctx.getThinkingOpen()));
    return null;
  }
  if (part.kind === 'inline-image') { parent.append(renderInlineImageNode(doc, part)); return null; }
  if (part.kind === 'snapshot-image') { parent.append(renderSnapshotImageNode(doc, part)); return null; }
  if (part.kind === 'text') {
    const slot = el(doc, 'div', { className: 'peer-session-markdown', attrs: { 'data-peer-part-type': 'text' } });
    parent.append(slot);
    const fenceFor = ctx.blocks ? (lang) => ctx.blocks.fenceFor(lang) : undefined;
    const md = createMarkdown(slot, { fenceFor });
    md.update({ source: part.source, streaming: part.streaming, mode: part.mode, displayOnly: false });
    return md;
  }
  parent.append(renderCardNode(doc, part, ctx.getThinkingOpen()));
  return null;
}

function createTranscriptItemView(itemHost, ctx) {
  const doc = documentOf(itemHost);
  const life = createLife();
  let childHandles = [];
  let rootNode = null;

  const clearChildren = () => {
    for (let i = childHandles.length - 1; i >= 0; i -= 1) childHandles[i].destroy();
    childHandles = [];
    rootNode?.remove();
    rootNode = null;
  };

  const update = (item) => {
    if (life.dead || !item) return;
    clearChildren();
    const msgAttrs = { id: `msg-${item.id}`, 'data-peer-message-id': item.id, 'data-peer-role': item.role };
    const container = item.standalone
      ? el(doc, 'div', { className: 'peer-session-standalone', attrs: { 'data-peer-message-id': item.id } })
      : el(doc, 'article', { className: 'peer-session-message', attrs: msgAttrs });
    for (const part of item.parts) {
      const handle = mountPart(doc, container, part, ctx);
      if (handle) childHandles.push(handle);
    }
    rootNode = container;
    itemHost.append(container);
  };

  const destroy = () => {
    if (!life.destroy()) return;
    clearChildren();
  };

  return { update, destroy };
}

function sameSnapshots(snapshotIds, nextMap, prevMap) {
  if (snapshotIds.length === 0 || nextMap === prevMap) return true;
  for (const id of snapshotIds) {
    if (nextMap?.[id] !== prevMap?.[id]) return false;
  }
  return true;
}

function deriveCachedItems(cache, screenModel) {
  const mode = screenModel?.mode === 'light' ? 'light' : 'dark';
  const status = String(screenModel?.status ?? 'ready');
  const imageSnapshots = screenModel?.imageSnapshots ?? {};
  const rawMessages = Array.isArray(screenModel?.messages) ? screenModel.messages : [];
  const nextCache = new Map();
  const items = [];
  for (const msg of rawMessages) {
    const id = String(msg?.id ?? '');
    const prev = id ? cache.get(id) : null;
    const canReuse = prev && prev.rawMsg === msg && prev.mode === mode && prev.status === status
      && sameSnapshots(prev.snapshotIds, imageSnapshots, prev.imageSnapshots);
    const derived = canReuse ? prev.derived : deriveTranscriptItem(msg, { mode, status, imageSnapshots });
    if (id) {
      nextCache.set(id, { rawMsg: msg, mode, status, imageSnapshots, snapshotIds: derived?.snapshotIds ?? [], derived });
    }
    if (derived) items.push(derived);
  }
  cache.clear();
  for (const [k, v] of nextCache) cache.set(k, v);
  return items;
}

function scrollHashIntoView(transcriptEl, rawHash) {
  const clean = String(rawHash ?? '').replace(/^#/, '').trim();
  if (!clean) return false;
  let targetId = clean;
  try { targetId = decodeURIComponent(clean); } catch { /* keep literal */ }
  const candidates = transcriptEl.querySelectorAll('[data-peer-message-id], [data-peer-step-message-id]');
  for (const node of candidates) {
    const msgId = node.getAttribute('data-peer-message-id') ?? node.getAttribute('data-peer-step-message-id');
    if (msgId === targetId || `msg-${msgId}` === targetId) {
      node.scrollIntoView?.({ block: 'start' });
      return true;
    }
  }
  return false;
}

function syncSessionStatus(nodes, state, chatId, error, send) {
  if (state === 'ready') {
    nodes.statusHost.hidden = true;
    nodes.transcriptEl.hidden = false;
    nodes.footerEl.hidden = false;
    nodes.notFoundHomeBtn.hidden = true;
    return;
  }
  nodes.statusHost.hidden = false;
  nodes.transcriptEl.hidden = true;
  nodes.footerEl.hidden = true;
  if (state === 'loading') {
    nodes.notFoundHomeBtn.hidden = true;
    nodes.statusControl.update({ status: 'loading', message: 'Loading session…' });
    return;
  }
  if (state === 'not-found') {
    nodes.notFoundHomeBtn.hidden = !nodes.hasNavigate;
    nodes.statusControl.update({
      status: 'empty',
      labels: { empty: 'Session not found' },
      message: error || `Session "${chatId}" could not be found.`
    });
    return;
  }
  nodes.notFoundHomeBtn.hidden = true;
  nodes.statusControl.update({
    status: 'error',
    message: error || 'Could not load session.',
    retry: () => send?.({ type: 'reload' })
  });
}

function buildSessionDom(doc, life, callbacks) {
  const root = el(doc, 'section', { className: 'peer-session', attrs: { 'data-peer-screen': 'session' } });
  const topBarHost = el(doc, 'div', { className: 'peer-session-header' });
  const topBar = createTopBar(topBarHost, {
    onToggleSidebar: callbacks.onToggleSidebar,
    onNavigateHome: callbacks.navigate ? () => callbacks.navigate({ name: 'home' }) : undefined
  });
  const statusHost = el(doc, 'div', { className: 'peer-session-status' });
  const statusControl = createStatus(statusHost);
  const notFoundHomeBtn = button(doc, {
    label: 'Back to Home',
    signal: life.signal,
    onClick: () => callbacks.navigate?.({ name: 'home' }),
    attrs: { hidden: true }
  });
  statusHost.append(notFoundHomeBtn);

  const transcriptEl = el(doc, 'div', {
    className: 'peer-session-transcript',
    attrs: { 'data-peer-transcript': '', hidden: true }
  });
  const footerEl = el(doc, 'footer', {
    className: 'peer-session-footer',
    attrs: { 'data-peer-readonly': 'true', hidden: true }
  });
  const readonlyBadge = el(doc, 'span', { className: 'peer-session-readonly-label', text: 'Read-only transcript' });
  const turnErrorEl = el(doc, 'span', {
    className: 'peer-session-turn-error',
    attrs: { 'data-peer-turn-error': '', hidden: true }
  });
  const turnErrorText = textNode(doc, turnErrorEl);
  footerEl.append(readonlyBadge, turnErrorEl);
  root.append(topBarHost, statusHost, transcriptEl, footerEl);
  return {
    root, topBar, statusHost, statusControl, notFoundHomeBtn,
    hasNavigate: typeof callbacks.navigate === 'function',
    transcriptEl, footerEl, turnErrorEl, turnErrorText
  };
}

function applySessionUpdate(state, screenModel = {}) {
  if (state.life.dead || screenModel === state.lastModel) return;
  state.lastModel = screenModel;
  const rawLoad = screenModel?.load;
  const loadState = rawLoad === 'ready' || rawLoad === 'not-found' || rawLoad === 'error' ? rawLoad : 'loading';
  const chatId = String(screenModel?.chatId ?? screenModel?.route?.id ?? '');
  const errText = screenModel?.error ? String(screenModel.error) : null;
  state.nodes.topBar.update(deriveTopBarModel(screenModel));
  syncSessionStatus(state.nodes, loadState, chatId, errText, state.send);
  if (loadState !== 'ready') { state.viewList.update([]); return; }
  state.viewList.update(deriveCachedItems(state.itemCache, screenModel));
  const turnError = String(screenModel?.turnError ?? '').trim();
  writeText(state.nodes.turnErrorText, turnError);
  state.nodes.turnErrorEl.hidden = turnError === '';
  const nextHash = String(screenModel?.hash ?? '');
  if (nextHash && nextHash !== state.lastHash && scrollHashIntoView(state.nodes.transcriptEl, nextHash)) {
    state.lastHash = nextHash;
  } else if (!nextHash) {
    state.lastHash = '';
  }
}

export function createSessionView(host, { send, navigate, blocks, onToggleSidebar } = {}) {
  const doc = documentOf(host);
  injectUiStyles(doc);
  injectSessionStyles(doc);
  const life = createLife();
  const nodes = buildSessionDom(doc, life, { navigate, onToggleSidebar });
  const state = { life, nodes, send, thinkingOpen: false, lastModel: null, lastHash: '', itemCache: new Map(), viewList: null };
  const itemCtx = { blocks, getThinkingOpen: () => state.thinkingOpen };
  state.viewList = createViewList(nodes.transcriptEl, {
    key: (item) => item.key,
    model: (item) => item,
    itemClass: 'peer-session-item',
    create: (slot) => createTranscriptItemView(slot, itemCtx)
  });
  host.append(nodes.root);

  const command = (action) => {
    if (life.dead || action !== 'toggle-user-thinking') return false;
    state.thinkingOpen = !state.thinkingOpen;
    for (const details of nodes.transcriptEl.querySelectorAll('[data-peer-thinking]')) {
      details.open = state.thinkingOpen;
    }
    return true;
  };

  const destroy = () => {
    if (!life.destroy()) return;
    state.itemCache.clear();
    state.viewList.destroy();
    nodes.statusControl.destroy();
    nodes.topBar.destroy();
    nodes.root.remove();
  };

  return { update: (model) => applySessionUpdate(state, model), command, destroy };
}
