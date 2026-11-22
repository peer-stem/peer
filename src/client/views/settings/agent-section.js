/**
 * Agent & Knowledge Graph settings section (`views/settings/agent-section.js`, `v0.7.0` parity).
 * Worker concurrency, research/demo/visual/pdf switches, quiz mechanics (`choice` vs `free`),
 * `graphTools`, `fileAccess`, `search`, `compaction`, and graph extraction/rendering controls.
 */
import { button, createLife, createSwitch, documentOf, el, input, show, textNode, writeText } from 'cloudcanvas-lib/ui';
import { resolveSettings } from 'peer-engine';
import {
  buildFileAccessGroup,
  buildSearchAndCompactionGroups,
  composeQuizMechanics,
  composeWorkerRequestConcurrency
} from './agent-helpers.js';

const TOOL_ROWS = Object.freeze([
  { id: 'research', label: 'Web research', detail: 'Background researcher sub-agent' },
  { id: 'demo', label: 'Interactive demos', detail: 'Sandboxed visual demo builder' },
  { id: 'visual', label: 'Visual maker', detail: 'Diagram and illustration generator' },
  { id: 'pdf', label: 'PDF reader', detail: 'Background document extraction' }
]);

function composeAgentSection(record, patch) {
  return { ...(record?.agent ?? {}), ...patch };
}

function composeGraphSection(record, patch) {
  return { ...(record?.graph ?? {}), ...patch };
}

function buildConcurrencyGroup(doc, life, getSettings, onSettingsIntent) {
  const group = el(doc, 'div', {
    className: 'peer-settings-group',
    attrs: { 'data-peer-concurrency-row': '', 'data-testid': 'worker-request-concurrency-row' }
  });
  group.append(el(doc, 'h3', { className: 'peer-settings-group-title', text: 'Worker concurrency' }));
  const row = el(doc, 'div', { className: 'peer-settings-row' });
  const meta = el(doc, 'div', { className: 'peer-settings-row-meta' });
  meta.append(
    el(doc, 'span', { className: 'peer-settings-row-label', text: 'Concurrent worker requests' }),
    el(doc, 'p', { className: 'peer-settings-hint', text: 'Maximum simultaneous background model calls (default 8).' })
  );
  const controls = el(doc, 'div', { className: 'peer-settings-controls' });
  const numInput = input(doc, {
    type: 'number',
    label: 'Concurrent worker requests',
    placeholder: '8',
    signal: life.signal,
    attrs: { min: '1', step: '1', 'data-peer-concurrency-input': '', 'data-testid': 'agent-concurrency-input' }
  });
  const errEl = el(doc, 'p', {
    className: 'peer-settings-error',
    attrs: { role: 'alert', 'data-peer-concurrency-error': '', hidden: true }
  });
  const errText = textNode(doc, errEl, '');
  const commit = () => {
    const result = composeWorkerRequestConcurrency(getSettings()?.record?.agent, numInput.value);
    if (!result.ok) {
      writeText(errText, result.error);
      show(errEl, true);
      return;
    }
    writeText(errText, '');
    show(errEl, false);
    onSettingsIntent?.({ type: 'save-section', section: 'agent', value: result.settings });
  };
  life.on(numInput, 'input', () => { writeText(errText, ''); show(errEl, false); });
  life.on(numInput, 'change', commit);
  controls.append(numInput, button(doc, {
    label: 'Apply',
    signal: life.signal,
    attrs: { 'data-peer-action': 'save-concurrency' },
    onClick: commit
  }));
  row.append(meta, controls);
  group.append(row, errEl);
  return { group, numInput };
}

function mountSwitchRow(doc, parent, attrName, attrVal, testid, onChange) {
  const wrap = el(doc, 'div', { attrs: { [attrName]: attrVal, ...(testid ? { 'data-testid': testid } : {}) } });
  parent.append(wrap);
  return createSwitch(wrap, { onChange });
}

function buildQuizMechanicsRow(doc, life, getSettings, onSettingsIntent) {
  const row = el(doc, 'div', {
    className: 'peer-settings-row',
    attrs: { 'data-testid': 'quiz-mechanics-row', 'data-peer-setting': 'quiz-mechanics' }
  });
  const meta = el(doc, 'div', { className: 'peer-settings-row-meta' });
  meta.append(
    el(doc, 'span', { className: 'peer-settings-row-label', text: 'Quizzing' }),
    el(doc, 'p', { className: 'peer-settings-hint', text: 'How both tutors check your understanding' })
  );
  const seg = el(doc, 'div', {
    className: 'peer-settings-segmented',
    attrs: { role: 'group', 'aria-label': 'Quizzing mechanics' }
  });
  const choiceBtn = button(doc, {
    label: 'Multiple choice',
    signal: life.signal,
    onClick: () => onSettingsIntent?.({
      type: 'save-section', section: 'agent', value: composeQuizMechanics(getSettings()?.record?.agent, 'choice')
    }),
    attrs: { 'data-testid': 'quiz-mechanics-choice', 'data-peer-quiz-mode': 'choice', 'aria-pressed': 'true' }
  });
  const freeBtn = button(doc, {
    label: 'Free recall',
    signal: life.signal,
    onClick: () => onSettingsIntent?.({
      type: 'save-section', section: 'agent', value: composeQuizMechanics(getSettings()?.record?.agent, 'free')
    }),
    attrs: { 'data-testid': 'quiz-mechanics-free', 'data-peer-quiz-mode': 'free', 'aria-pressed': 'false' }
  });
  seg.append(choiceBtn, freeBtn);
  row.append(meta, seg);
  return { row, choiceBtn, freeBtn };
}

function buildToolsSwitches(doc, life, getSettings, onSettingsIntent) {
  const group = el(doc, 'div', {
    className: 'peer-settings-group',
    attrs: { 'data-peer-tools-group': '', 'data-testid': 'group-tools' }
  });
  group.append(el(doc, 'h3', { className: 'peer-settings-group-title', text: 'Capabilities & quizzing' }));
  const graphToolsSwitch = mountSwitchRow(doc, group, 'data-peer-setting', 'graph-tools', 'graph-tools-row', (checked) => {
    onSettingsIntent?.({
      type: 'save-section',
      section: 'agent',
      value: composeAgentSection(getSettings()?.record, { graphTools: { enabled: checked } })
    });
  });
  const quiz = buildQuizMechanicsRow(doc, life, getSettings, onSettingsIntent);
  group.append(quiz.row);
  const toolSwitches = {};
  for (const item of TOOL_ROWS) {
    toolSwitches[item.id] = mountSwitchRow(doc, group, 'data-peer-tool', item.id, `tool-row-${item.id}`, (checked) => {
      const record = getSettings()?.record;
      const tools = { ...(record?.agent?.tools ?? {}), [item.id]: checked };
      onSettingsIntent?.({ type: 'save-section', section: 'agent', value: composeAgentSection(record, { tools }) });
    });
  }
  return { group, toolSwitches, quiz, graphToolsSwitch };
}

function buildGraphSwitches(doc, life, getSettings, onSettingsIntent) {
  const group = el(doc, 'div', { className: 'peer-settings-group', attrs: { 'data-peer-graph-group': '' } });
  group.append(el(doc, 'h3', { className: 'peer-settings-group-title', text: 'Knowledge graph' }));
  const enabledSwitch = mountSwitchRow(doc, group, 'data-peer-setting', 'graph-enabled', 'graph-row-enabled', (checked) => {
    onSettingsIntent?.({ type: 'save-section', section: 'graph', value: composeGraphSection(getSettings()?.record, { enabled: checked }) });
  });
  const renderingSwitch = mountSwitchRow(doc, group, 'data-peer-setting', 'graph-rendering', 'graph-row-rendering', (checked) => {
    onSettingsIntent?.({ type: 'save-section', section: 'graph', value: composeGraphSection(getSettings()?.record, { rendering: checked }) });
  });
  const chunkRow = el(doc, 'div', { className: 'peer-settings-row', attrs: { 'data-testid': 'graph-row-chunk-tokens' } });
  const chunkInput = input(doc, {
    type: 'number', label: 'Extraction chunk budget', placeholder: '4096', signal: life.signal,
    attrs: { min: '500', step: '256', 'data-testid': 'input-chunk-tokens', 'data-peer-chunk-tokens': '' }
  });
  life.on(chunkInput, 'change', () => {
    const raw = chunkInput.value.trim();
    const prev = { ...(getSettings()?.record?.graph ?? {}) };
    if (raw === '') {
      delete prev.extractionChunkTokens;
      onSettingsIntent?.({ type: 'save-section', section: 'graph', value: prev });
      return;
    }
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return;
    prev.extractionChunkTokens = Math.max(500, Math.round(n));
    onSettingsIntent?.({ type: 'save-section', section: 'graph', value: prev });
  });
  chunkRow.append(el(doc, 'span', { className: 'peer-settings-row-label', text: 'Extraction chunk budget' }), chunkInput);
  group.append(chunkRow);
  return { group, enabledSwitch, renderingSwitch, chunkInput };
}

function syncAgentControls(state) {
  const record = state.settings?.record ?? null;
  const eff = state.settings?.effective ?? resolveSettings(record);
  const concurrency = record?.agent?.workerRequestConcurrency ?? eff.agent.workerRequestConcurrency;
  if (state.concurrency.numInput !== state.doc.activeElement) {
    state.concurrency.numInput.value = String(concurrency);
  }
  const toolsMap = record?.agent?.tools ?? eff.agent.tools ?? {};
  for (const item of TOOL_ROWS) {
    state.tools.toolSwitches[item.id].update({
      label: item.label, detail: item.detail, checked: toolsMap[item.id] !== false
    });
  }
  const isFree = Boolean(toolsMap.explain);
  state.tools.quiz.choiceBtn.setAttribute('aria-pressed', String(!isFree));
  state.tools.quiz.freeBtn.setAttribute('aria-pressed', String(isFree));

  const graphEnabled = record?.graph?.enabled ?? eff.graph.enabled ?? true;
  const graphToolsStored = record?.agent?.graphTools?.enabled ?? eff.agent.graphTools?.enabled ?? true;
  state.tools.graphToolsSwitch.update({
    label: 'Graph tools',
    detail: graphEnabled ? 'Lets the tutor consult your knowledge map between sessions' : 'Graph is disabled',
    checked: Boolean(graphToolsStored),
    disabled: !graphEnabled
  });
  state.fileAccess.sync(state.settings);
  state.searchAndComp.sync(state.settings, eff.compaction);

  state.graph.enabledSwitch.update({
    label: 'Extraction', detail: 'Off = the graph stops growing', checked: graphEnabled
  });
  state.graph.renderingSwitch.update({
    label: 'Graph rendering',
    detail: 'Off = home shows the chains view',
    checked: record?.graph?.rendering ?? eff.graph.rendering ?? true
  });
  state.graph.chunkInput.placeholder = String(eff.graph.extractionChunkTokens);
  if (state.graph.chunkInput !== state.doc.activeElement) {
    const storedChunk = record?.graph?.extractionChunkTokens;
    state.graph.chunkInput.value = storedChunk !== undefined ? String(storedChunk) : '';
  }
}

export function createAgentSection(host, callbacks = {}) {
  const { onSettingsIntent } = callbacks;
  const doc = documentOf(host);
  const life = createLife();
  const root = el(doc, 'div', { className: 'peer-settings-panel', attrs: { 'data-peer-settings-section': 'agent' } });
  const state = {
    doc, life, settings: null,
    concurrency: null, tools: null, fileAccess: null, searchAndComp: null, graph: null
  };
  const getSettings = () => state.settings;
  state.concurrency = buildConcurrencyGroup(doc, life, getSettings, onSettingsIntent);
  state.tools = buildToolsSwitches(doc, life, getSettings, onSettingsIntent);
  state.fileAccess = buildFileAccessGroup(doc, life, getSettings, callbacks);
  state.searchAndComp = buildSearchAndCompactionGroups(doc, life, getSettings, onSettingsIntent);
  state.graph = buildGraphSwitches(doc, life, getSettings, onSettingsIntent);
  root.append(
    state.concurrency.group,
    state.tools.group,
    state.fileAccess.group,
    state.searchAndComp.searchGroup,
    state.searchAndComp.compGroup,
    state.graph.group
  );
  host.append(root);

  const update = ({ settings = null } = {}) => {
    if (life.dead) return;
    state.settings = settings;
    syncAgentControls(state);
  };
  update({});

  const destroy = () => {
    if (!life.destroy()) return;
    state.graph.renderingSwitch.destroy();
    state.graph.enabledSwitch.destroy();
    state.searchAndComp.destroy();
    state.fileAccess.destroy();
    state.tools.graphToolsSwitch.destroy();
    for (const item of TOOL_ROWS) state.tools.toolSwitches[item.id].destroy();
    root.remove();
  };

  return { update, destroy };
}
