/**
 * Notes import control, active extraction runs badge, cost summary + breakdown popover,
 * and graph display/regions/physics tuning popover (`[data-peer-notes-import]`, `v0.7.0`).
 */
import {
  BUTTON_CLASS, button, createLife, documentOf, el, injectUiStyles,
  placeChildren, setValue, show, textNode, writeText
} from 'cloudcanvas-lib/ui';
import { REGION_BITMAP_OPTIONS, formatTokens } from 'peer-engine';
import { FALLBACK_RENDER_SETTINGS } from './graph-models.js';
import { injectGraphStyles } from './graph.css.js';

const DISPLAY_SLIDERS = Object.freeze([
  { key: 'nodeSize', label: 'Node size', min: '0.25', max: '12', step: '0.25' },
  { key: 'edgeWidth', label: 'Edge width', min: '0.1', max: '6', step: '0.1' },
  { key: 'arrowLength', label: 'Arrowhead size', min: '0.25', max: '12', step: '0.25' },
  { key: 'labelSize', label: 'Label size', min: '0.5', max: '16', step: '0.5' },
  { key: 'labelZoom', label: 'Labels until zoom', min: '0.125', max: '3', step: '0.125' },
  { key: 'clusterLabelSize', label: 'Cluster label size', min: '7', max: '28', step: '1' }
]);

const REGION_SLIDERS = Object.freeze([
  { key: 'dilation', label: 'Dilation', min: '4', max: '120', step: '1' },
  { key: 'blur', label: 'Blur', min: '10', max: '120', step: '5' },
  { key: 'edgeAlpha', label: 'Edge alpha', min: '0.025', max: '1', step: '0.025' }
]);

const PHYSICS_SLIDERS = Object.freeze([
  { key: 'chargeStrength', label: 'Node repulsion', min: '-480', max: '-120', step: '10' },
  { key: 'linkStrength', label: 'Edge attraction', min: '0.25', max: '4', step: '0.05' },
  { key: 'linkDistance', label: 'Edge length', min: '10', max: '160', step: '5' },
  { key: 'gravity', label: 'Central pull', min: '0.03', max: '0.48', step: '0.01' },
  { key: 'clusterPull', label: 'Cluster pull', min: '0', max: '1', step: '0.05' },
  { key: 'velocityDecay', label: 'Damping', min: '0.18', max: '0.9', step: '0.02' },
  { key: 'depthStrength', label: 'Depth pull', min: '0.2', max: '3.2', step: '0.1' }
]);

function buildRangeRow(doc, life, spec, attrKey, onCommit) {
  const row = el(doc, 'label', { className: 'peer-graph-setting-row' });
  const slider = el(doc, 'input', {
    attrs: {
      type: 'range', min: spec.min, max: spec.max, step: spec.step,
      'aria-label': spec.label, 'data-peer-setting': attrKey
    }
  });
  life.on(slider, 'change', () => {
    const val = Number(slider.value);
    if (Number.isFinite(val)) onCommit(val);
  });
  row.append(el(doc, 'span', { text: spec.label }), slider);
  return { row, slider };
}

function buildCheckboxRow(doc, life, labelText, settingKey, onToggle) {
  const row = el(doc, 'label', { className: 'peer-graph-setting-row' });
  const box = el(doc, 'input', {
    attrs: { type: 'checkbox', 'aria-label': labelText, 'data-peer-setting': settingKey }
  });
  life.on(box, 'change', () => onToggle(box.checked));
  row.append(el(doc, 'span', { text: labelText }), box);
  return { row, box };
}

function buildSelectRow(doc, life, labelText, settingKey, options, onPick) {
  const row = el(doc, 'label', { className: 'peer-graph-setting-row' });
  const selectEl = el(doc, 'select', {
    className: 'cloudcanvas-ui-field',
    attrs: { 'aria-label': labelText, 'data-peer-setting': settingKey }
  });
  for (const [val, text] of options) selectEl.append(el(doc, 'option', { text, attrs: { value: String(val) } }));
  life.on(selectEl, 'change', () => onPick(selectEl.value));
  row.append(el(doc, 'span', { text: labelText }), selectEl);
  return { row, selectEl };
}

function appendPhysicsSection(doc, life, panel, getSettings, onSave) {
  panel.append(el(doc, 'div', { className: 'peer-graph-section-label', text: 'Physics' }));
  const physicsSliders = new Map();
  for (const spec of PHYSICS_SLIDERS) {
    const built = buildRangeRow(doc, life, spec, `physics-${spec.key}`, (val) => {
      const cur = getSettings()?.physics ?? FALLBACK_RENDER_SETTINGS.physics;
      onSave?.({ physics: { ...cur, [spec.key]: val } });
    });
    physicsSliders.set(spec.key, built.slider);
    panel.append(built.row);
  }
  const depthRow = buildSelectRow(
    doc, life, 'Depth anchor', 'depthMode',
    [['off', 'Off'], ['vertical', 'Vertical'], ['radial', 'Radial']],
    (depthMode) => {
      const cur = getSettings()?.physics ?? FALLBACK_RENDER_SETTINGS.physics;
      onSave?.({ physics: { ...cur, depthMode } });
    }
  );
  panel.append(depthRow.row);
  return { physicsSliders, depthSelect: depthRow.selectEl };
}

function buildRenderPanel(doc, life, getSettings, onSave) {
  const panel = el(doc, 'div', {
    className: 'peer-graph-render-panel',
    attrs: { 'data-peer-render-settings': '', hidden: true }
  });
  const displaySliders = new Map();
  for (const spec of DISPLAY_SLIDERS) {
    const built = buildRangeRow(doc, life, spec, spec.key, (val) => onSave?.({ [spec.key]: val }));
    displaySliders.set(spec.key, built.slider);
    panel.append(built.row);
  }
  const clusterToggle = buildCheckboxRow(doc, life, 'Cluster labels', 'clusterLabels', (checked) => onSave?.({ clusterLabels: checked }));
  panel.append(clusterToggle.row, el(doc, 'div', { className: 'peer-graph-section-label', text: 'Regions' }));

  const regionsToggle = buildCheckboxRow(doc, life, 'Region tints', 'regionsEnabled', (checked) => {
    const cur = getSettings()?.regions ?? FALLBACK_RENDER_SETTINGS.regions;
    onSave?.({ regions: { ...cur, enabled: checked } });
  });
  panel.append(regionsToggle.row);
  const regionSliders = new Map();
  for (const spec of REGION_SLIDERS) {
    const built = buildRangeRow(doc, life, spec, `region-${spec.key}`, (val) => {
      const cur = getSettings()?.regions ?? FALLBACK_RENDER_SETTINGS.regions;
      onSave?.({ regions: { ...cur, [spec.key]: val } });
    });
    regionSliders.set(spec.key, built.slider);
    panel.append(built.row);
  }
  const bitmapRow = buildSelectRow(
    doc, life, 'Bitmap resolution', 'region-bitmap',
    REGION_BITMAP_OPTIONS.map((v) => [v, String(v)]),
    (val) => {
      const cur = getSettings()?.regions ?? FALLBACK_RENDER_SETTINGS.regions;
      onSave?.({ regions: { ...cur, bitmap: Number(val) } });
    }
  );
  panel.append(bitmapRow.row);
  const phy = appendPhysicsSection(doc, life, panel, getSettings, onSave);
  return {
    panel, displaySliders, regionSliders, ...phy,
    clusterBox: clusterToggle.box, regionsBox: regionsToggle.box, bitmapSelect: bitmapRow.selectEl
  };
}

function syncRenderPanel(controls, settings = FALLBACK_RENDER_SETTINGS) {
  if (!controls) return;
  const resolved = settings ?? FALLBACK_RENDER_SETTINGS;
  const reg = resolved.regions ?? FALLBACK_RENDER_SETTINGS.regions;
  const phy = resolved.physics ?? FALLBACK_RENDER_SETTINGS.physics;
  for (const [key, slider] of controls.displaySliders) {
    if (resolved[key] !== undefined) setValue(slider, resolved[key]);
  }
  for (const [key, slider] of controls.regionSliders) {
    if (reg[key] !== undefined) setValue(slider, reg[key]);
    slider.disabled = reg.enabled === false;
  }
  for (const [key, slider] of controls.physicsSliders) {
    if (phy[key] !== undefined) setValue(slider, phy[key]);
  }
  controls.clusterBox.checked = resolved.clusterLabels !== false;
  controls.regionsBox.checked = reg.enabled !== false;
  controls.bitmapSelect.disabled = reg.enabled === false;
  setValue(controls.bitmapSelect, String(reg.bitmap ?? 256));
  setValue(controls.depthSelect, phy.depthMode ?? 'off');
}

function readCostHeadline(costs) {
  if (!costs || typeof costs !== 'object') return null;
  const extDollars = costs.stages?.extraction?.dollars;
  const audDollars = costs.stages?.audit?.dollars;
  const total = typeof extDollars === 'number' && typeof audDollars === 'number'
    ? extDollars + audDollars
    : (typeof costs.totalDollars === 'number' ? costs.totalDollars : costs.totalUsd);
  const hasRuns = Array.isArray(costs.runs) && costs.runs.length > 0;
  if (typeof total !== 'number' || (!hasRuns && total <= 0)) return null;
  return { total, label: `$${total.toFixed(2)}` };
}

function renderCostsBreakdown(doc, popoverEl, costs, headline) {
  if (!headline) { popoverEl.replaceChildren(); return; }
  const rows = [
    el(doc, 'div', { className: 'peer-graph-popover-head', text: `Graph pipeline costs · ${headline.label}` })
  ];
  const ext = costs.stages?.extraction ?? costs.stages?.extractor;
  const aud = costs.stages?.audit ?? costs.stages?.auditor;
  for (const [name, st] of [['Extraction', ext], ['Audit', aud]]) {
    if (!st) continue;
    const usd = typeof st.dollars === 'number' ? st.dollars : (st.usd ?? 0);
    const inTok = st.tokens?.inputTokens !== undefined ? formatTokens(st.tokens.inputTokens) : '—';
    const outTok = st.tokens?.outputTokens !== undefined ? formatTokens(st.tokens.outputTokens) : '—';
    rows.push(el(doc, 'div', {
      className: 'peer-graph-setting-row',
      text: `${name}: $${Number(usd).toFixed(3)} · ${inTok} in / ${outTok} out`
    }));
  }
  for (const run of Array.isArray(costs.runs) ? costs.runs : []) {
    const merged = run.merged?.nodes ? ` (+${run.merged.nodes}n)` : '';
    const price = typeof run.dollars === 'number' ? `$${run.dollars.toFixed(3)}` : '—';
    rows.push(el(doc, 'div', { className: 'peer-graph-setting-row', text: `${run.title}${merged} · ${price}` }));
  }
  placeChildren(popoverEl, rows);
}

function renderImportResultItem(doc, item) {
  if (!item.ok && item.error) {
    return el(doc, 'p', {
      className: 'peer-graph-import-error',
      text: `${item.filePath}: ${item.error}`,
      attrs: { role: 'alert', 'data-peer-import-error': '' }
    });
  }
  if (item.notice) {
    return el(doc, 'p', {
      className: 'peer-graph-import-notice',
      text: `${item.filePath}: ${item.notice}`,
      attrs: { role: 'status', 'data-peer-import-notice': '' }
    });
  }
  return null;
}

function syncImportFeedback(doc, nodes, model) {
  writeText(nodes.importLabelText, model.importing ? 'Extracting…' : 'Extract files…');
  nodes.importLabel.setAttribute('data-peer-importing', String(Boolean(model.importing)));

  const runs = Array.isArray(model.runs) ? model.runs : [];
  show(nodes.runsBadge, runs.length > 0);
  if (runs.length > 0) {
    const summary = runs.map((r) => `${r.phase}: ${r.title}`).join(' · ');
    writeText(nodes.runsText, `${runs.length} active (${summary})`);
  }

  const headline = readCostHeadline(model.costs);
  show(nodes.costsWrap, Boolean(headline));
  if (headline) {
    writeText(nodes.costsText, headline.label);
    renderCostsBreakdown(doc, nodes.costsPopover, model.costs, headline);
  } else {
    show(nodes.costsPopover, false);
  }

  const results = Array.isArray(model.importResults) ? model.importResults : [];
  const messages = results.map((item) => renderImportResultItem(doc, item)).filter(Boolean);
  show(nodes.resultsBox, messages.length > 0);
  placeChildren(nodes.resultsBox, messages);
}

function buildCostsWidget(doc, life) {
  const costsWrap = el(doc, 'div', { className: 'peer-graph-costs-wrap', attrs: { hidden: true } });
  let costsOpen = false;
  const costsPopover = el(doc, 'div', {
    className: 'peer-graph-popover',
    attrs: { 'data-peer-costs-popover': '', 'data-testid': 'graph-costs-panel', hidden: true }
  });
  const costsBtn = el(doc, 'button', {
    className: 'peer-graph-costs-badge',
    attrs: { type: 'button', 'data-peer-graph-costs': '', 'data-testid': 'graph-costs-trigger', 'aria-expanded': 'false' }
  });
  const costsText = textNode(doc, costsBtn, '');
  life.on(costsBtn, 'click', () => {
    costsOpen = !costsOpen;
    costsBtn.setAttribute('aria-expanded', String(costsOpen));
    show(costsPopover, costsOpen);
  });
  costsWrap.append(costsBtn, costsPopover);
  return { costsWrap, costsPopover, costsText };
}

function buildNotesImportDom(doc, life, callbacks, getSettings) {
  const root = el(doc, 'div', { className: 'peer-graph-notes-bar', attrs: { 'data-peer-notes-toolbar': '' } });
  const importLabel = el(doc, 'label', {
    className: `${BUTTON_CLASS} peer-graph-import-label`,
    attrs: { 'data-testid': 'import-notes' }
  });
  const importLabelText = textNode(doc, importLabel, 'Extract files…');
  const fileInput = el(doc, 'input', {
    className: 'peer-graph-import-input',
    attrs: { type: 'file', multiple: true, 'aria-label': 'Extract notes files into knowledge graph', 'data-peer-notes-import': '' }
  });
  importLabel.append(fileInput);
  life.on(fileInput, 'change', () => {
    const files = Array.from(fileInput.files ?? []);
    if (files.length === 0) return;
    callbacks.onImportNotes?.(files);
    try { fileInput.value = ''; } catch { /* mock file lists may disallow reset */ }
  });
  const runsBadge = el(doc, 'span', { className: 'peer-graph-runs-badge', attrs: { 'data-peer-runs-badge': '', role: 'status', hidden: true } });
  const runsText = textNode(doc, runsBadge, '');
  const { costsWrap, costsPopover, costsText } = buildCostsWidget(doc, life);
  const resultsBox = el(doc, 'div', { className: 'peer-graph-import-results', attrs: { 'data-peer-import-results': '', hidden: true } });
  root.append(importLabel, runsBadge, costsWrap);

  let renderControls = null;
  let panelOpen = false;
  if (callbacks.showRenderSettings !== false) {
    renderControls = buildRenderPanel(doc, life, getSettings, callbacks.onSaveRenderSettings);
    const togglePanel = () => {
      panelOpen = !panelOpen;
      gearBtn.setAttribute('aria-expanded', String(panelOpen));
      show(renderControls.panel, panelOpen);
    };
    const gearBtn = button(doc, {
      label: 'Display', ariaLabel: 'Graph display settings', signal: life.signal, onClick: togglePanel,
      attrs: { 'data-peer-action': 'toggle-render-settings', 'aria-expanded': 'false' }
    });
    root.append(gearBtn, renderControls.panel);
  }
  root.append(resultsBox);
  return {
    root, renderControls,
    nodes: { importLabel, importLabelText, runsBadge, runsText, costsWrap, costsText, costsPopover, resultsBox }
  };
}

export function createNotesImport(host, callbacks = {}) {
  const doc = documentOf(host);
  injectUiStyles(doc);
  injectGraphStyles(doc);
  const life = createLife();
  let lastModel = null;
  const built = buildNotesImportDom(doc, life, callbacks, () => lastModel?.renderSettings);
  host.append(built.root);

  const update = (model = {}) => {
    if (life.dead || model === lastModel) return;
    lastModel = model;
    syncImportFeedback(doc, built.nodes, model);
    syncRenderPanel(built.renderControls, model.renderSettings);
  };

  return { update, destroy: () => { if (life.destroy()) { lastModel = null; built.root.remove(); } } };
}
