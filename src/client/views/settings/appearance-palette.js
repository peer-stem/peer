/**
 * 12-color palette customizer and transcript-width controls for `appearance-section.js` (`v0.7.0`).
 */
import { button, clamp, el, input, textNode, writeText } from 'cloudcanvas-lib/ui';
import { THEME_COLOR_KEYS, effectiveColors } from 'peer-engine';

export const COLOR_LABELS = Object.freeze({
  background: 'Background',
  surface: 'Surface',
  border: 'Border',
  text: 'Text',
  textMuted: 'Muted text',
  accent: 'Accent',
  bold: 'Bold',
  italic: 'Italic',
  code: 'Inline code',
  success: 'Success',
  warning: 'Warning',
  error: 'Error'
});

const LEGACY_COLOR_TESTIDS = Object.freeze({
  background: 'input-background',
  bold: 'input-bold-color',
  italic: 'input-italic-color'
});

const TRANSCRIPT_PRESETS = Object.freeze([
  ['', 'Full (no cap)'],
  ['narrow', 'Narrow (46rem)'],
  ['default', 'Default (64rem)'],
  ['wide', 'Wide (96rem)']
]);

const PRESET_TO_REM = Object.freeze({
  narrow: 46,
  default: 64,
  wide: 96
});

export function colorOverride(appearance, key) {
  if (key === 'background') return appearance?.background ?? '';
  if (key === 'bold') return appearance?.mdRendering?.boldColor ?? '';
  if (key === 'italic') return appearance?.mdRendering?.italicColor ?? '';
  return appearance?.colors?.[key] ?? '';
}

export function composeColorOverride(appearance, key, rawValue) {
  const val = String(rawValue ?? '').trim();
  const nextVal = val === '' ? null : val;
  if (key === 'background') return { ...(appearance ?? {}), background: nextVal };
  if (key === 'bold') {
    return { ...(appearance ?? {}), mdRendering: { ...(appearance?.mdRendering ?? {}), boldColor: nextVal } };
  }
  if (key === 'italic') {
    return { ...(appearance ?? {}), mdRendering: { ...(appearance?.mdRendering ?? {}), italicColor: nextVal } };
  }
  const colors = { ...(appearance?.colors ?? {}) };
  if (nextVal === null) delete colors[key];
  else colors[key] = nextVal;
  return { ...(appearance ?? {}), colors };
}

export function clearColorOverrides(appearance) {
  const { background: _bg, colors: _colors, ...rest } = appearance ?? {};
  const md = appearance?.mdRendering;
  if (!md) return rest;
  const { boldColor: _b, italicColor: _i, ...mdRest } = md;
  return Object.keys(mdRest).length > 0 ? { ...rest, mdRendering: mdRest } : rest;
}

function buildColorRow(doc, life, key, getRecord, onSaveAppearance) {
  const label = COLOR_LABELS[key] ?? key;
  const row = el(doc, 'div', { className: 'peer-settings-row', attrs: { 'data-testid': `row-color-${key}` } });
  const right = el(doc, 'div', { className: 'peer-settings-controls' });
  const swatch = el(doc, 'span', {
    className: 'peer-settings-swatch',
    attrs: { 'data-testid': `swatch-${key}`, 'aria-hidden': 'true' }
  });
  const inputAttrs = { 'data-peer-color-input': key, 'data-testid': LEGACY_COLOR_TESTIDS[key] ?? `input-color-${key}` };
  const hexInput = input(doc, { label: `${label.toLowerCase()} hex`, placeholder: '#1c1c1c', signal: life.signal, attrs: inputAttrs });
  life.on(hexInput, 'change', () => onSaveAppearance(composeColorOverride(getRecord()?.appearance, key, hexInput.value)));
  right.append(swatch, hexInput);
  row.append(el(doc, 'span', { className: 'peer-settings-row-label', text: label }), right);
  return { row, swatch, hexInput };
}

export function buildPaletteGroup(doc, life, getRecord, onSaveAppearance) {
  const group = el(doc, 'div', {
    className: 'peer-settings-group',
    attrs: { 'data-testid': 'group-colors', 'data-peer-color-palette': '' }
  });
  const head = el(doc, 'div', { className: 'peer-settings-row' });
  head.append(
    el(doc, 'h3', { className: 'peer-settings-group-title', text: 'Colors · overrides on top of theme' }),
    button(doc, {
      label: 'Reset all',
      signal: life.signal,
      onClick: () => onSaveAppearance(clearColorOverrides(getRecord()?.appearance)),
      attrs: { 'data-testid': 'colors-reset', 'data-peer-action': 'reset-colors' }
    })
  );
  const grid = el(doc, 'div', { className: 'peer-settings-color-grid' });
  const items = new Map();
  for (const key of THEME_COLOR_KEYS) {
    const built = buildColorRow(doc, life, key, getRecord, onSaveAppearance);
    grid.append(built.row);
    items.set(key, built);
  }
  group.append(head, grid);
  const sync = (activeTheme, recApp) => {
    const merged = effectiveColors(activeTheme, recApp ?? {});
    for (const key of THEME_COLOR_KEYS) {
      const entry = items.get(key);
      entry.swatch.style.backgroundColor = merged[key] ?? '#1c1c1c';
      entry.hexInput.placeholder = activeTheme?.colors?.[key] ?? '#1c1c1c';
      if (entry.hexInput !== doc.activeElement) entry.hexInput.value = colorOverride(recApp, key);
    }
  };
  return { group, sync };
}

function snapTranscriptRem(num) {
  const clamped = clamp(Math.round(num), 46, 120);
  return clamped % 2 === 0 ? clamped : clamped + 1;
}

function presetForRem(rem) {
  if (rem === null || rem === undefined) return '';
  if (rem <= 48) return 'narrow';
  if (rem === 64) return 'default';
  if (rem >= 94 && rem <= 98) return 'wide';
  return 'custom';
}

function bindTranscriptWidthEvents(life, presetSelect, numInput, commitWidth) {
  life.on(presetSelect, 'change', () => {
    const key = presetSelect.value;
    if (key === '') commitWidth(null);
    else if (PRESET_TO_REM[key]) commitWidth(PRESET_TO_REM[key]);
  });
  life.on(numInput, 'change', () => {
    const raw = numInput.value.trim();
    if (raw === '') { commitWidth(null); return; }
    if (PRESET_TO_REM[raw]) { commitWidth(PRESET_TO_REM[raw]); return; }
    const n = Number(raw);
    if (Number.isFinite(n)) commitWidth(n);
  });
}

export function buildTranscriptWidthRow(doc, life, getRecord, onSaveAppearance) {
  const row = el(doc, 'div', {
    className: 'peer-settings-row',
    attrs: { 'data-testid': 'row-transcript-width', 'data-peer-transcript-width': '' }
  });
  const meta = el(doc, 'div', { className: 'peer-settings-row-meta' });
  const valHint = el(doc, 'p', { className: 'peer-settings-hint', attrs: { 'data-testid': 'transcript-width-value' } });
  const valText = textNode(doc, valHint, 'Full');
  meta.append(el(doc, 'span', { className: 'peer-settings-row-label', text: 'Transcript width' }), valHint);
  const controls = el(doc, 'div', { className: 'peer-settings-controls' });
  const presetSelect = el(doc, 'select', {
    className: 'peer-settings-select peer-settings-select-narrow',
    attrs: { 'aria-label': 'Transcript width preset', 'data-testid': 'select-transcript-width', 'data-peer-transcript-width-preset': '' }
  });
  for (const [val, label] of TRANSCRIPT_PRESETS) presetSelect.append(el(doc, 'option', { text: label, attrs: { value: val } }));
  presetSelect.append(el(doc, 'option', { text: 'Custom', attrs: { value: 'custom' } }));
  const numInput = input(doc, {
    type: 'number', label: 'Transcript width', placeholder: 'Full', signal: life.signal,
    attrs: { min: '46', max: '120', step: '2', 'data-testid': 'input-transcript-width', 'data-peer-transcript-width-input': '' }
  });
  bindTranscriptWidthEvents(life, presetSelect, numInput, (remOrNull) => {
    const prev = { ...(getRecord()?.appearance ?? {}) };
    if (remOrNull === null || remOrNull === undefined) delete prev.transcriptMaxWidth;
    else prev.transcriptMaxWidth = snapTranscriptRem(remOrNull);
    onSaveAppearance(prev);
  });
  controls.append(presetSelect, numInput);
  row.append(meta, controls);
  const sync = (resolvedRem, storedRem) => {
    const rem = storedRem ?? resolvedRem ?? null;
    writeText(valText, rem === null ? 'Full' : `${rem * 16}px (${rem}rem)`);
    presetSelect.value = presetForRem(rem);
    if (numInput !== doc.activeElement) numInput.value = rem === null ? '' : String(rem);
  };
  return { row, sync };
}
