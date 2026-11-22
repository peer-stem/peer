/**
 * Prompts settings section (`views/settings/prompts-section.js`, `v0.7.0` parity).
 * Renders `sectionedSegments` (`Teacher`, `Prober`, `Practice`, deduplicated `Shared`
 * with `"Used by …"` hint), inline editor (`[data-peer-prompt-list]`,
 * `[data-peer-action="save-prompt"]`, `[data-peer-action="delete-prompt"]`), and
 * `"View default"` / `"Edit override"` modal (`createPromptSegmentDialog`).
 */
import { button, createLife, documentOf, el, placeChildren, textNode, writeText } from 'cloudcanvas-lib/ui';
import { createPromptSegmentDialog } from './prompt-segment-dialog.js';

const AGENT_ORDER = Object.freeze([
  { id: 'teacher', label: 'Teacher' },
  { id: 'prober', label: 'Prober' },
  { id: 'practice', label: 'Practice' }
]);

export function promptSegmentName(path) {
  const base = (String(path ?? '').split('/').at(-1) ?? '')
    .replace(/\.[^.]+$/, '')
    .replace(/^[\d-]+/, '')
    .replace(/-+/g, ' ');
  return base ? base.charAt(0).toUpperCase() + base.slice(1) : String(path ?? '');
}

export function composePromptSwitch(agentRecord, path, enabled) {
  const prompts = { ...(agentRecord?.prompts ?? {}) };
  if (enabled) prompts[path] = true;
  else delete prompts[path];
  return { ...(agentRecord ?? {}), prompts };
}

function segmentsForAgent(promptsMap, agentId) {
  const list = promptsMap?.[agentId];
  return Array.isArray(list) ? list : [];
}

export function sectionedSegments(promptsMap) {
  const shared = new Map();
  for (const { id } of AGENT_ORDER) {
    for (const seg of segmentsForAgent(promptsMap, id)) {
      if (seg?.shared && !shared.has(seg.path)) shared.set(seg.path, seg);
    }
  }
  const sections = AGENT_ORDER.map(({ id, label }) => ({
    id,
    label,
    segments: segmentsForAgent(promptsMap, id).filter((s) => !s?.shared)
  }));
  const sharedRows = [...shared.values()].map((seg) => {
    const users = AGENT_ORDER
      .filter(({ id }) => segmentsForAgent(promptsMap, id).some((s) => s.path === seg.path))
      .map(({ label }) => label);
    const usage = users.length > 1 ? `${users.slice(0, -1).join(', ')} and ${users.at(-1)}` : (users[0] ?? 'Agents');
    return { ...seg, usageHint: `Used by ${usage}` };
  });
  sections.push({ id: 'shared', label: 'Shared', segments: sharedRows });
  return sections;
}

function findSegment(promptsMap, path) {
  if (!promptsMap || !path) return null;
  for (const { id } of AGENT_ORDER) {
    const found = segmentsForAgent(promptsMap, id).find((seg) => seg?.path === path);
    if (found) return found;
  }
  return null;
}

function firstAvailablePath(promptsMap) {
  for (const sec of sectionedSegments(promptsMap)) {
    if (sec.segments.length > 0) return sec.segments[0].path;
  }
  return null;
}

function buildSegmentRightControls(doc, signal, seg, name, hasOverride, handlers) {
  const right = el(doc, 'div', { className: 'peer-settings-controls' });
  right.append(
    button(doc, {
      label: 'View default', signal, onClick: () => handlers.onOpenModal(seg.path, 'view'),
      attrs: { 'data-testid': `prompt-view-${seg.path}`, 'data-peer-action': 'view-prompt-default' }
    }),
    button(doc, {
      label: hasOverride ? 'Edit override' : '+ Add override', signal,
      onClick: () => handlers.onOpenModal(seg.path, 'edit'),
      attrs: { 'data-testid': `prompt-edit-${seg.path}`, 'data-peer-action': 'edit-prompt-override' }
    }),
    el(doc, 'span', { className: 'peer-settings-badge', text: `In use: ${seg.enabled ? 'Your version' : 'Default'}` })
  );
  const toggleAttrs = { type: 'checkbox', role: 'switch', 'aria-label': `Use your override for ${name}`, 'data-peer-prompt-enable': seg.path };
  const toggle = el(doc, 'input', { attrs: toggleAttrs });
  toggle.checked = Boolean(seg.enabled);
  toggle.disabled = !hasOverride;
  toggle.addEventListener('change', () => handlers.onToggle(seg.path, Boolean(toggle.checked)), { signal });
  right.append(toggle);
  return right;
}

function renderSegmentRow(doc, signal, seg, isSelected, handlers) {
  const hasOverride = seg.overrideText !== null && seg.overrideText !== undefined;
  const name = promptSegmentName(seg.path);
  const rowAttrs = { 'data-peer-prompt-row': seg.path, 'data-testid': `prompt-row-${seg.path}`, 'data-peer-selected': String(isSelected) };
  const row = el(doc, 'div', { className: 'peer-settings-prompt-item', attrs: rowAttrs });
  const left = el(doc, 'div', { className: 'peer-settings-row-meta' });
  left.append(button(doc, {
    label: `${name} (${seg.path})`, signal,
    attrs: { 'data-peer-prompt-select': seg.path },
    onClick: () => handlers.onSelect(seg.path)
  }));
  if (seg.usageHint) {
    left.append(el(doc, 'p', { className: 'peer-settings-hint', text: seg.usageHint, attrs: { 'data-peer-prompt-usage': seg.path } }));
  }
  row.append(left, buildSegmentRightControls(doc, signal, seg, name, hasOverride, handlers));
  return row;
}

function buildPromptEditor(doc, life, onSave, onDelete) {
  const wrap = el(doc, 'div', { className: 'peer-settings-group', attrs: { 'data-peer-prompt-editor': '' } });
  const pathEl = el(doc, 'h4', { className: 'peer-settings-group-title', attrs: { 'data-peer-prompt-active-path': '' } });
  const pathText = textNode(doc, pathEl, 'Select a segment');
  const sourceArea = el(doc, 'textarea', {
    className: 'peer-settings-textarea',
    attrs: { readonly: true, 'aria-label': 'Source prompt instructions', 'data-peer-prompt-source': '' }
  });
  const overrideArea = el(doc, 'textarea', {
    className: 'peer-settings-textarea',
    attrs: {
      placeholder: 'Enter custom prompt override…',
      'aria-label': 'Override prompt instructions',
      'data-peer-prompt-override': ''
    }
  });
  const actions = el(doc, 'div', { className: 'peer-settings-controls' });
  const saveBtn = button(doc, {
    className: 'is-primary', label: 'Save override', signal: life.signal,
    attrs: { 'data-peer-action': 'save-prompt' },
    onClick: () => onSave(overrideArea.value)
  });
  const deleteBtn = button(doc, {
    label: 'Delete override', signal: life.signal,
    attrs: { 'data-peer-action': 'delete-prompt' },
    onClick: onDelete
  });
  actions.append(saveBtn, deleteBtn);
  wrap.append(
    pathEl,
    el(doc, 'p', { className: 'peer-settings-hint', text: 'Source instructions (read-only)' }),
    sourceArea,
    el(doc, 'p', { className: 'peer-settings-hint', text: 'Override instructions' }),
    overrideArea,
    actions
  );
  return { wrap, pathText, sourceArea, overrideArea, saveBtn, deleteBtn };
}

function buildSectionNode(doc, signal, sec, selectedPath, handlers) {
  const group = el(doc, 'div', { className: 'peer-settings-group', attrs: { 'data-testid': `prompt-section-${sec.id}` } });
  group.append(el(doc, 'h3', { className: 'peer-settings-group-title', text: sec.label }));
  for (const seg of sec.segments) {
    group.append(renderSegmentRow(doc, signal, seg, seg.path === selectedPath, handlers));
  }
  return group;
}

function syncPromptsView(state) {
  const promptsMap = state.settings?.prompts ?? null;
  if (!promptsMap) {
    placeChildren(state.listEl, [el(state.doc, 'p', { className: 'peer-settings-hint', text: 'Loading prompt segments…' })]);
    state.dialog.update(null);
    return;
  }
  const sections = sectionedSegments(promptsMap);
  if (!findSegment(promptsMap, state.selectedPath)) state.selectedPath = firstAvailablePath(promptsMap);
  const sectionNodes = sections
    .filter((sec) => sec.segments.length > 0)
    .map((sec) => buildSectionNode(state.doc, state.life.signal, sec, state.selectedPath, state.handlers));
  placeChildren(state.listEl, sectionNodes.length > 0 ? sectionNodes : [el(state.doc, 'p', { className: 'peer-settings-hint', text: 'No prompt segments configured.' })]);

  const active = findSegment(promptsMap, state.selectedPath);
  writeText(state.editor.pathText, active ? `Segment · ${active.path}` : 'No segment selected');
  state.editor.sourceArea.value = active ? String(active.sourceText ?? '') : '';
  if (active && state.loadedPath !== active.path) {
    state.editor.overrideArea.value = active.overrideText ?? '';
    state.loadedPath = active.path;
  } else if (!active) {
    state.editor.overrideArea.value = '';
    state.loadedPath = null;
  }
  state.editor.saveBtn.disabled = !active;
  state.editor.deleteBtn.disabled = !active || active.overrideText === null || active.overrideText === undefined;

  const modalSeg = state.modalState ? findSegment(promptsMap, state.modalState.path) : null;
  state.dialog.update(modalSeg ? {
    open: true, path: modalSeg.path, name: promptSegmentName(modalSeg.path),
    mode: state.modalState.mode, sourceText: modalSeg.sourceText, overrideText: modalSeg.overrideText
  } : null);
}

function mountPromptModal(dialogSlot, state, onSettingsIntent) {
  return createPromptSegmentDialog(dialogSlot, {
    onClose: () => { state.modalState = null; syncPromptsView(state); },
    onSave: async (path, text) => {
      state.loadedPath = null;
      await onSettingsIntent?.({ type: 'save-prompt', path, text });
      const nextAgent = composePromptSwitch(state.settings?.record?.agent, path, true);
      await onSettingsIntent?.({ type: 'save-section', section: 'agent', value: nextAgent });
    },
    onDelete: async (path) => {
      state.loadedPath = null;
      await onSettingsIntent?.({ type: 'delete-prompt', path });
    }
  });
}

export function createPromptsSection(host, { onSettingsIntent } = {}) {
  const doc = documentOf(host);
  const life = createLife();
  const root = el(doc, 'div', { className: 'peer-settings-panel', attrs: { 'data-peer-settings-section': 'prompts' } });
  const listEl = el(doc, 'div', { className: 'peer-settings-prompt-list', attrs: { 'data-peer-prompt-list': '' } });
  const dialogSlot = el(doc, 'div');
  const state = { doc, life, settings: null, selectedPath: null, loadedPath: null, modalState: null, listEl, editor: null, dialog: null, handlers: null };
  state.handlers = {
    onSelect: (path) => { state.selectedPath = path; state.loadedPath = null; syncPromptsView(state); },
    onOpenModal: (path, mode) => { state.selectedPath = path; state.modalState = { path, mode }; syncPromptsView(state); },
    onToggle: (path, checked) => onSettingsIntent?.({ type: 'save-section', section: 'agent', value: composePromptSwitch(state.settings?.record?.agent, path, checked) })
  };
  state.editor = buildPromptEditor(
    doc, life,
    (text) => { if (state.selectedPath) onSettingsIntent?.({ type: 'save-prompt', path: state.selectedPath, text }); },
    () => { if (state.selectedPath) { state.loadedPath = null; onSettingsIntent?.({ type: 'delete-prompt', path: state.selectedPath }); } }
  );
  state.dialog = mountPromptModal(dialogSlot, state, onSettingsIntent);
  root.append(listEl, state.editor.wrap, dialogSlot);
  host.append(root);
  const update = ({ settings = null } = {}) => { if (!life.dead) { state.settings = settings; syncPromptsView(state); } };
  update({});
  return { update, destroy: () => { if (life.destroy()) { state.dialog.destroy(); root.remove(); } } };
}
