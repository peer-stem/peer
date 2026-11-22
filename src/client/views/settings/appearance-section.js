/**
 * Appearance settings section (`views/settings/appearance-section.js`, `v0.7.0` parity).
 * Preset + custom theme cards (`[data-peer-theme-id]`), 12-color palette customizer,
 * custom theme JSON import & delete, reading font, prose size, heading weight,
 * transcript width (`narrow` / `default` / `wide` / numeric), `adaptiveQuestions`,
 * code ligatures, serif session titles, and compact session list.
 */
import { button, clamp, createLife, createSwitch, documentOf, el, input, textNode, writeText } from 'cloudcanvas-lib/ui';
import { BUILTIN_THEMES, resolveSettings } from 'peer-engine';
import { buildPaletteGroup, buildTranscriptWidthRow } from './appearance-palette.js';

function reloadCatalogAfter(promiseLike, onAppearanceIntent) {
  if (!onAppearanceIntent) return;
  if (promiseLike && typeof promiseLike.then === 'function') {
    promiseLike.then(() => onAppearanceIntent({ type: 'reload' }), () => {});
    return;
  }
  onAppearanceIntent({ type: 'reload' });
}

function renderThemeCard(doc, signal, theme, isActive, onSelect, onDelete) {
  const card = el(doc, 'div', {
    className: 'peer-settings-theme-card',
    attrs: { 'data-peer-theme-card': theme.id, 'data-peer-active': String(isActive) }
  });
  const swatches = el(doc, 'div', { className: 'peer-settings-swatches' });
  for (const key of ['background', 'surface', 'accent', 'text']) {
    const hex = theme.colors?.[key] || '#1c1c1c';
    const dot = el(doc, 'span', { className: 'peer-settings-swatch' });
    dot.style.backgroundColor = hex;
    swatches.append(dot);
  }
  const head = el(doc, 'div', { className: 'peer-settings-row' });
  head.append(
    el(doc, 'span', { className: 'peer-settings-row-label', text: theme.name || theme.id }),
    el(doc, 'span', { className: 'peer-settings-badge', text: theme.builtin ? (theme.mode || 'dark') : 'custom' })
  );
  const actions = el(doc, 'div', { className: 'peer-settings-controls' });
  actions.append(button(doc, {
    className: isActive ? 'is-primary' : '',
    label: isActive ? 'Selected' : 'Use theme',
    signal,
    attrs: {
      'aria-pressed': String(isActive),
      'data-peer-action': 'select-theme',
      'data-peer-theme-id': theme.id,
      'data-testid': `theme-card-${theme.id}`
    },
    onClick: () => onSelect(theme.id)
  }));
  if (!theme.builtin) {
    const delAttrs = { 'data-peer-action': 'delete-theme', 'data-peer-theme-id': theme.id, 'data-testid': `theme-remove-${theme.id}` };
    actions.append(button(doc, { label: 'Delete', ariaLabel: `Remove ${theme.name || theme.id}`, signal, attrs: delAttrs, onClick: () => onDelete(theme.id) }));
  }
  card.append(head, swatches, actions);
  return card;
}

function submitThemeJson(jsonArea, errorEl, errorText, onImport) {
  const raw = jsonArea.value.trim();
  if (!raw) return;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    writeText(errorText, 'Theme must be valid JSON.');
    errorEl.hidden = false;
    return;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    writeText(errorText, 'Theme JSON must be an object.');
    errorEl.hidden = false;
    return;
  }
  writeText(errorText, '');
  errorEl.hidden = true;
  onImport(parsed);
  jsonArea.value = '';
}

function buildThemeImportGroup(doc, life, onImport) {
  const group = el(doc, 'div', { className: 'peer-settings-group', attrs: { 'data-peer-theme-import': '' } });
  group.append(el(doc, 'h3', { className: 'peer-settings-group-title', text: 'Import custom theme JSON' }));
  const jsonArea = el(doc, 'textarea', {
    className: 'peer-settings-textarea',
    attrs: {
      placeholder: '{"name":"Custom","mode":"dark","colors":{...}}',
      'aria-label': 'Custom theme JSON',
      'data-peer-theme-json': ''
    }
  });
  const errorEl = el(doc, 'p', { className: 'peer-settings-error', attrs: { 'data-peer-theme-error': '', hidden: true } });
  const errorText = textNode(doc, errorEl);
  const importBtn = button(doc, {
    className: 'is-primary', label: 'Import theme', signal: life.signal,
    attrs: { 'data-peer-action': 'create-theme' },
    onClick: () => submitThemeJson(jsonArea, errorEl, errorText, onImport)
  });
  group.append(jsonArea, errorEl, importBtn);
  return group;
}

function buildTypographyInputs(doc, life, commitAppearance) {
  const sizeInput = input(doc, {
    type: 'number', label: 'Prose font size', placeholder: '16', signal: life.signal,
    attrs: { min: '12', max: '24', step: '1', 'data-peer-prose-size': '', 'data-testid': 'input-prose-size' }
  });
  const weightInput = input(doc, {
    type: 'number', label: 'Heading weight', placeholder: '900', signal: life.signal,
    attrs: { min: '100', max: '900', step: '100', 'data-peer-heading-weight': '', 'data-testid': 'input-heading-weight' }
  });
  const fontInput = input(doc, {
    label: 'Reading font family', placeholder: 'Source Sans 3', signal: life.signal,
    attrs: { 'data-peer-font-family': '', 'data-testid': 'input-font-family' }
  });
  life.on(sizeInput, 'change', commitAppearance);
  life.on(weightInput, 'change', commitAppearance);
  life.on(fontInput, 'change', commitAppearance);
  return { sizeInput, weightInput, fontInput };
}

function buildTypographyGroup(doc, life, getRecord, onSaveAppearance) {
  const group = el(doc, 'div', { className: 'peer-settings-group', attrs: { 'data-peer-typography': '' } });
  group.append(el(doc, 'h3', { className: 'peer-settings-group-title', text: 'Typography & Layout' }));
  let fields = null;
  const commit = () => {
    const prev = getRecord()?.appearance ?? {};
    const next = { ...prev };
    const rawSize = fields.sizeInput.value.trim();
    if (rawSize === '') delete next.proseFontSize;
    else if (Number.isFinite(Number(rawSize))) next.proseFontSize = clamp(Math.round(Number(rawSize)), 12, 24);
    const rawWeight = fields.weightInput.value.trim();
    const nextMd = { ...(prev.mdRendering ?? {}) };
    if (rawWeight === '') delete nextMd.headingWeight;
    else if (Number.isFinite(Number(rawWeight))) nextMd.headingWeight = clamp(Math.round(Number(rawWeight)), 100, 900);
    if (Object.keys(nextMd).length > 0) next.mdRendering = nextMd;
    else delete next.mdRendering;
    const rawFont = fields.fontInput.value.trim();
    next.fontFamily = rawFont === '' ? null : rawFont;
    onSaveAppearance(next);
  };
  fields = buildTypographyInputs(doc, life, commit);
  const row = el(doc, 'div', { className: 'peer-settings-controls' });
  row.append(fields.sizeInput, fields.weightInput, fields.fontInput, button(doc, {
    label: 'Apply typography', signal: life.signal,
    attrs: { 'data-peer-action': 'save-appearance' },
    onClick: commit
  }));
  const widthRow = buildTranscriptWidthRow(doc, life, getRecord, onSaveAppearance);
  const adaptiveWrap = el(doc, 'div', { attrs: { 'data-testid': 'row-adaptive-questions', 'data-peer-adaptive-questions': '' } });
  const adaptiveSwitch = createSwitch(adaptiveWrap, {
    onChange: (checked) => onSaveAppearance({ ...(getRecord()?.appearance ?? {}), adaptiveQuestions: checked })
  });
  const ligWrap = el(doc, 'div', { attrs: { 'data-testid': 'row-code-ligatures', 'data-peer-code-ligatures': '' } });
  const ligSwitch = createSwitch(ligWrap, {
    onChange: (checked) => onSaveAppearance({ ...(getRecord()?.appearance ?? {}), codeLigatures: checked })
  });
  const serifWrap = el(doc, 'div', { attrs: { 'data-testid': 'row-session-serif', 'data-peer-session-serif': '' } });
  const serifSwitch = createSwitch(serifWrap, {
    onChange: (checked) => onSaveAppearance({ ...(getRecord()?.appearance ?? {}), sessionNameSerif: checked })
  });
  const compactWrap = el(doc, 'div', { attrs: { 'data-testid': 'row-compact-session-list', 'data-peer-compact-sessions': '' } });
  const compactSwitch = createSwitch(compactWrap, {
    onChange: (checked) => onSaveAppearance({ ...(getRecord()?.appearance ?? {}), compactSessionList: checked })
  });
  group.append(row, widthRow.row, adaptiveWrap, ligWrap, serifWrap, compactWrap);
  return { group, ...fields, widthRow, adaptiveSwitch, ligSwitch, serifSwitch, compactSwitch };
}

function syncAppearanceState(state) {
  const { doc, settings, appearance, gridEl, palette, typo } = state;
  const themes = Array.isArray(appearance?.themes) && appearance.themes.length > 0
    ? appearance.themes
    : (appearance?.theme ? [appearance.theme] : BUILTIN_THEMES);
  const recApp = settings?.record?.appearance;
  const effApp = settings?.effective?.appearance ?? resolveSettings(settings?.record ?? null).appearance;
  const activeId = appearance?.theme?.id ?? recApp?.theme ?? effApp.theme ?? 'default';
  const activeTheme = themes.find((t) => t.id === activeId) ?? BUILTIN_THEMES[0];

  gridEl.replaceChildren(...themes.map((t) => renderThemeCard(doc, state.life.signal, t, t.id === activeId, state.selectTheme, state.deleteTheme)));
  palette.sync(activeTheme, recApp);

  if (typo.sizeInput !== doc.activeElement) {
    typo.sizeInput.value = recApp?.proseFontSize !== undefined ? String(recApp.proseFontSize) : String(effApp.proseFontSize);
  }
  if (typo.weightInput !== doc.activeElement) {
    const hw = recApp?.mdRendering?.headingWeight ?? effApp.mdRendering.headingWeight;
    typo.weightInput.value = String(hw);
  }
  if (typo.fontInput !== doc.activeElement) typo.fontInput.value = String(recApp?.fontFamily ?? effApp.fontFamily ?? '');
  typo.widthRow.sync(effApp.transcriptMaxWidth, recApp?.transcriptMaxWidth);
  typo.adaptiveSwitch.update({
    label: 'Adapt question layout',
    detail: 'Expand native questions side-by-side when viewport space permits',
    checked: (recApp?.adaptiveQuestions ?? effApp.adaptiveQuestions) !== false
  });
  typo.ligSwitch.update({
    label: 'Code ligatures', detail: 'Enable font ligatures in code blocks',
    checked: Boolean(recApp?.codeLigatures ?? effApp.codeLigatures)
  });
  typo.serifSwitch.update({
    label: 'Session names in serif', detail: 'Render session titles in serif display face',
    checked: (recApp?.sessionNameSerif ?? effApp.sessionNameSerif) !== false
  });
  typo.compactSwitch.update({
    label: 'Compact session list', detail: 'Single-line monospace rows in the session sidebar',
    checked: Boolean(recApp?.compactSessionList ?? effApp.compactSessionList)
  });
}

export function createAppearanceSection(host, { onSettingsIntent, onAppearanceIntent } = {}) {
  const doc = documentOf(host);
  const life = createLife();
  const root = el(doc, 'div', { className: 'peer-settings-panel', attrs: { 'data-peer-settings-section': 'appearance' } });
  const themeGroup = el(doc, 'div', { className: 'peer-settings-group', attrs: { 'data-testid': 'row-theme' } });
  themeGroup.append(el(doc, 'h3', { className: 'peer-settings-group-title', text: 'Themes' }));
  const gridEl = el(doc, 'div', { className: 'peer-settings-theme-grid', attrs: { 'data-peer-theme-grid': '' } });
  themeGroup.append(gridEl);

  const saveAppearance = (value) => onSettingsIntent?.({ type: 'save-section', section: 'appearance', value });
  const state = {
    doc, life, settings: null, appearance: null, gridEl, palette: null, typo: null,
    selectTheme: (themeId) => saveAppearance({ ...(state.settings?.record?.appearance ?? {}), theme: themeId }),
    deleteTheme: (id) => reloadCatalogAfter(onSettingsIntent?.({ type: 'delete-theme', id }), onAppearanceIntent)
  };
  const importGroup = buildThemeImportGroup(doc, life, (theme) => {
    reloadCatalogAfter(onSettingsIntent?.({ type: 'create-theme', theme }), onAppearanceIntent);
  });
  state.palette = buildPaletteGroup(doc, life, () => state.settings?.record, saveAppearance);
  state.typo = buildTypographyGroup(doc, life, () => state.settings?.record, saveAppearance);
  root.append(themeGroup, state.palette.group, importGroup, state.typo.group);
  host.append(root);

  const update = ({ settings = null, appearance = null } = {}) => {
    if (life.dead) return;
    state.settings = settings;
    state.appearance = appearance;
    syncAppearanceState(state);
  };
  update({});

  const destroy = () => {
    if (!life.destroy()) return;
    state.typo.compactSwitch.destroy();
    state.typo.serifSwitch.destroy();
    state.typo.ligSwitch.destroy();
    state.typo.adaptiveSwitch.destroy();
    root.remove();
  };

  return { update, destroy };
}
