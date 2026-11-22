/**
 * Knowledge-graph folder filter (`v0.7.0` parity, `[data-testid="graph-folder-filter"]`).
 * View-only filter over `SourceOrganization` folders using `graphFolderIds`,
 * `graphFolderCheck`, and `toggleGraphFolder` from `'peer-engine'`.
 */
import { button, createLife, documentOf, el, injectUiStyles, placeChildren, show } from 'cloudcanvas-lib/ui';
import { graphFolderCheck, graphFolderIds, toggleGraphFolder } from 'peer-engine';
import { injectGraphStyles } from './graph.css.js';

const COLLATOR = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

function normalizeListedSet(model, organization) {
  if (model?.listed instanceof Set) return model.listed;
  if (Array.isArray(model?.listedIds) && model.listedIds.length > 0) return new Set(model.listedIds.map(String));
  if (organization && model?.graphSourceIds) {
    const srcSet = model.graphSourceIds instanceof Set ? model.graphSourceIds : new Set(model.graphSourceIds);
    return graphFolderIds(organization, srcSet);
  }
  if (organization && Array.isArray(organization.folders) && !Array.isArray(model?.listedIds)) {
    return new Set(organization.folders.map((f) => f.id));
  }
  return new Set();
}

function normalizeSelectedSet(model) {
  if (model?.selected instanceof Set) return model.selected;
  const arr = model?.selectedIds ?? model?.selectedFolderIds ?? [];
  return new Set(Array.isArray(arr) ? arr.map(String) : []);
}

function activeFolderChoices(organization, selected, listed) {
  if (!organization || !Array.isArray(organization.folders)) return { active: new Set(), choices: [] };
  const active = new Set([...selected].filter((id) => listed.has(id)));
  const choices = organization.folders.filter(
    (f) => active.has(f.id) && !(f.parentId !== null && active.has(f.parentId))
  );
  return { active, choices };
}

function buildFolderCheckbox(doc, folder, check, state) {
  const attrs = { type: 'checkbox', 'data-folder-filter-control': '', 'aria-label': `Show folder ${folder.name}` };
  const box = el(doc, 'input', { attrs });
  box.checked = check.checked;
  box.indeterminate = check.indeterminate;
  box.addEventListener('change', () => {
    const next = toggleGraphFolder(state.organization, state.selected, folder.id, box.checked, state.listed);
    state.callbacks.onToggleFolder?.(folder.id, [...next], box.checked);
  }, { signal: state.life.signal });
  return box;
}

function renderFolderLevel(doc, state, parentId, depth) {
  const { organization, listed, selected } = state;
  const children = (organization?.folders ?? [])
    .filter((f) => f.parentId === parentId && listed.has(f.id))
    .sort((a, b) => COLLATOR.compare(a.name, b.name) || a.id.localeCompare(b.id));
  const out = [];
  for (const folder of children) {
    const check = graphFolderCheck(organization, selected, folder.id, listed);
    const wrap = el(doc, 'div');
    const row = el(doc, 'label', {
      className: 'peer-graph-folder-option',
      attrs: { 'data-testid': `graph-folder-option-${folder.id}` }
    });
    row.style.paddingLeft = `${8 + depth * 18}px`;
    row.append(buildFolderCheckbox(doc, folder, check, state), el(doc, 'span', { text: folder.name }));
    wrap.append(row, ...renderFolderLevel(doc, state, folder.id, depth + 1));
    out.push(wrap);
  }
  return out;
}

function syncTriggerButton(doc, triggerBtn, choices) {
  const count = choices.length;
  const soleName = count === 1 ? choices[0].name : null;
  triggerBtn.setAttribute('data-active', String(count > 0));
  const ariaLabel = soleName !== null
    ? `Folder filter: ${soleName}`
    : (count > 0 ? `Folder filter: ${count} selected` : 'Folder filter');
  triggerBtn.setAttribute('aria-label', ariaLabel);
  const parts = [el(doc, 'span', { text: 'Folders' })];
  if (soleName !== null) {
    parts.push(el(doc, 'span', { text: soleName, attrs: { 'data-testid': 'graph-folder-filter-name' } }));
  } else if (count > 0) {
    parts.push(el(doc, 'span', { text: String(count), attrs: { 'data-peer-folder-filter-count': '' } }));
  }
  triggerBtn.replaceChildren(...parts);
}

function syncFolderPanel(doc, state) {
  const { choices } = activeFolderChoices(state.organization, state.selected, state.listed);
  syncTriggerButton(doc, state.triggerBtn, choices);
  state.triggerBtn.setAttribute('aria-expanded', String(state.open));
  show(state.panel, state.open);
  show(state.clearBtn, choices.length > 0);
  if (state.listed.size === 0) {
    placeChildren(state.listEl, [
      el(doc, 'p', { className: 'peer-graph-import-notice', text: 'No folders contain graph material yet.' })
    ]);
    return;
  }
  placeChildren(state.listEl, renderFolderLevel(doc, state, null, 0));
}

function bindFolderKeyboardAndDismiss(doc, state) {
  const setOpen = (next) => {
    if (state.open === next) return;
    state.open = next;
    syncFolderPanel(doc, state);
  };
  state.life.on(state.root, 'keydown', (event) => {
    if (event.key === 'Escape' && state.open) {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      state.triggerBtn.focus();
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    event.preventDefault();
    if (!state.open) setOpen(true);
    const items = Array.from(state.panel.querySelectorAll('[data-folder-filter-control]:not(:disabled)'));
    if (items.length === 0) return;
    const cur = items.indexOf(event.target);
    const delta = event.key === 'ArrowDown' ? 1 : -1;
    const start = cur < 0 ? (delta === 1 ? -1 : 0) : cur;
    const idx = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (start + delta + items.length) % items.length;
    items[idx]?.focus();
  });
  const win = doc.defaultView;
  if (!win?.addEventListener) return;
  state.life.on(win, 'pointerdown', (event) => {
    if (state.open && !state.root.contains(event.target)) setOpen(false);
  });
}

function mountFolderFilterDom(doc, host, life) {
  const root = el(doc, 'div', { className: 'peer-graph-folder-filter', attrs: { 'data-peer-folder-filter': '' } });
  const triggerBtn = button(doc, {
    label: 'Folders',
    ariaLabel: 'Folder filter',
    signal: life.signal,
    attrs: { 'data-testid': 'graph-folder-filter', 'data-active': 'false', 'aria-expanded': 'false' }
  });
  const panelAttrs = {
    role: 'group', 'aria-label': 'Show folders', tabindex: '-1',
    'data-testid': 'graph-folder-filter-panel', hidden: true
  };
  const panel = el(doc, 'div', { className: 'peer-graph-popover', attrs: panelAttrs });
  const head = el(doc, 'div', { className: 'peer-graph-popover-head' });
  head.append(el(doc, 'span', { className: 'peer-graph-section-label', text: 'Show folders' }));
  const clearBtn = button(doc, {
    label: 'Show all',
    signal: life.signal,
    attrs: { 'data-testid': 'graph-folder-filter-clear', 'data-folder-filter-control': '', hidden: true }
  });
  head.append(clearBtn);
  const listEl = el(doc, 'div');
  panel.append(head, listEl);
  root.append(triggerBtn, panel);
  host.append(root);
  return { root, triggerBtn, panel, clearBtn, listEl };
}

export function createGraphFolderFilter(host, callbacks = {}) {
  const doc = documentOf(host);
  injectUiStyles(doc);
  injectGraphStyles(doc);
  const life = createLife();
  const dom = mountFolderFilterDom(doc, host, life);
  const state = {
    life, callbacks, ...dom,
    open: false, organization: null, listed: new Set(), selected: new Set()
  };
  life.on(dom.triggerBtn, 'click', () => { state.open = !state.open; syncFolderPanel(doc, state); });
  life.on(dom.clearBtn, 'click', () => {
    (dom.panel.querySelector('input[data-folder-filter-control]') ?? dom.panel).focus();
    callbacks.onClearFolders?.();
  });
  bindFolderKeyboardAndDismiss(doc, state);
  syncFolderPanel(doc, state);

  const update = (model = {}) => {
    if (life.dead) return;
    state.organization = model?.organization ?? null;
    state.listed = normalizeListedSet(model, state.organization);
    state.selected = normalizeSelectedSet(model);
    syncFolderPanel(doc, state);
  };

  return { update, destroy: () => { if (life.destroy()) dom.root.remove(); } };
}
