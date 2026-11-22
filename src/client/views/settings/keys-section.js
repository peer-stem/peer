/**
 * Keys & Providers settings section (`views/settings/keys-section.js`, `v0.7.0` parity).
 * Masked key status rows, provider key save/delete, custom OpenAI-compatible
 * endpoint configuration, Subscriptions / ChatGPT, Claude Code toggle, External CLI,
 * and Dictation language controls.
 */
import { button, createLife, createSwitch, documentOf, el, input, textNode, writeText } from 'cloudcanvas-lib/ui';

export const FALLBACK_PROVIDER_KEYS = Object.freeze([
  { id: 'openai', envVar: 'OPENAI_API_KEY', label: 'OpenAI' },
  { id: 'anthropic', envVar: 'ANTHROPIC_API_KEY', label: 'Anthropic' },
  { id: 'google', envVar: 'GEMINI_API_KEY', label: 'Google' },
  { id: 'openrouter', envVar: 'OPENROUTER_API_KEY', label: 'OpenRouter' },
  { id: 'deepseek', envVar: 'DEEPSEEK_API_KEY', label: 'DeepSeek' },
  { id: 'groq', envVar: 'GROQ_API_KEY', label: 'Groq' },
  { id: 'mistral', envVar: 'MISTRAL_API_KEY', label: 'Mistral' },
  { id: 'xai', envVar: 'XAI_API_KEY', label: 'xAI' },
  { id: 'tavily', envVar: 'TAVILY_API_KEY', label: 'Tavily Search' },
  { id: 'brave', envVar: 'BRAVE_API_KEY', label: 'Brave Search' },
  { id: 'exa', envVar: 'EXA_API_KEY', label: 'Exa Search' },
  { id: 'deepgram', envVar: 'DEEPGRAM_API_KEY', label: 'Deepgram Dictation' }
]);

const DICTATION_LANGUAGES = Object.freeze([
  ['en', 'English'],
  ['multi', 'Multilingual'],
  ['es', 'Spanish'],
  ['fr', 'French'],
  ['de', 'German'],
  ['ja', 'Japanese'],
  ['zh', 'Chinese']
]);

export function resolveProviderOptions(providerKeys) {
  const source = Array.isArray(providerKeys) && providerKeys.length > 0
    ? [...providerKeys, ...FALLBACK_PROVIDER_KEYS.filter((f) => ['tavily', 'brave', 'exa', 'deepgram'].includes(f.id))]
    : FALLBACK_PROVIDER_KEYS;
  const seen = new Set();
  const out = [];
  for (const entry of source) {
    const envVar = String(entry?.envVar ?? '').trim();
    if (!envVar || seen.has(envVar)) continue;
    seen.add(envVar);
    out.push({ id: String(entry.id ?? envVar), envVar, label: String(entry.label ?? envVar) });
  }
  return out;
}

function formatKeyBadge(row) {
  if (!row?.present) return 'not set';
  const masked = row.masked ? String(row.masked) : 'configured';
  const envTag = row.source === 'env' ? ' · env' : '';
  const shadowTag = row.shadowedByEnv ? ' · shadowed by env' : '';
  return `${masked}${envTag}${shadowTag}`;
}

function renderKeyStatusRows(doc, signal, listEl, keys, providerOptions, onDelete) {
  const byEnv = new Map(providerOptions.map((item) => [item.envVar, item.label]));
  if (!Array.isArray(keys) || keys.length === 0) {
    listEl.replaceChildren(el(doc, 'p', { className: 'peer-settings-hint', text: 'No API keys stored yet.' }));
    return;
  }
  const nodes = keys.map((row) => {
    const id = String(row?.id ?? '');
    const label = row?.label || row?.info?.label || byEnv.get(id) || id;
    const item = el(doc, 'div', { className: 'peer-settings-row', attrs: { 'data-peer-key-row': id, 'data-testid': `key-${id.toLowerCase()}` } });
    item.append(el(doc, 'span', { className: 'peer-settings-row-label', text: label }));
    const right = el(doc, 'div', { className: 'peer-settings-controls' });
    right.append(el(doc, 'span', {
      className: 'peer-settings-badge',
      text: formatKeyBadge(row),
      attrs: { 'data-peer-key-status': id }
    }));
    if (row?.present && row?.source !== 'env') {
      const delAttrs = { 'data-peer-action': 'delete-key', 'data-peer-key-id': id };
      right.append(button(doc, { label: 'Delete', signal, attrs: delAttrs, onClick: () => onDelete(id) }));
    }
    item.append(right);
    return item;
  });
  listEl.replaceChildren(...nodes);
}

function buildKeyAddForm(doc, life, onSettingsIntent) {
  const group = el(doc, 'div', { className: 'peer-settings-group', attrs: { 'data-peer-key-form': '' } });
  group.append(el(doc, 'h3', { className: 'peer-settings-group-title', text: 'Add or update API key' }));
  const row = el(doc, 'div', { className: 'peer-settings-controls' });
  const providerSelect = el(doc, 'select', {
    className: 'peer-settings-select',
    attrs: { 'aria-label': 'API key provider', 'data-peer-key-select': '', 'data-testid': 'keys-provider-select' }
  });
  const secretInput = input(doc, {
    type: 'password',
    label: 'API key secret',
    placeholder: 'Paste API key…',
    signal: life.signal,
    attrs: { 'data-peer-key-input': '', 'data-testid': 'keys-secret-input' }
  });
  const submit = () => {
    const id = String(providerSelect.value ?? '').trim();
    const value = secretInput.value.trim();
    if (!id || !value) return;
    onSettingsIntent?.({ type: 'save-key', id, value });
    secretInput.value = '';
  };
  row.append(providerSelect, secretInput, button(doc, {
    className: 'is-primary',
    label: 'Save key',
    signal: life.signal,
    attrs: { 'data-peer-action': 'save-key', 'data-testid': 'keys-save-btn' },
    onClick: submit
  }));
  group.append(row);
  return { group, providerSelect };
}

function parseManualList(raw) {
  return String(raw ?? '').split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
}

function buildCustomEndpointGroup(doc, life, onSettingsIntent) {
  const group = el(doc, 'div', { className: 'peer-settings-group', attrs: { 'data-peer-custom-provider': '' } });
  group.append(el(doc, 'h3', { className: 'peer-settings-group-title', text: 'Custom OpenAI-compatible endpoint' }));
  const statusEl = el(doc, 'p', { className: 'peer-settings-hint', attrs: { 'data-peer-custom-status': '' } });
  const statusText = textNode(doc, statusEl, 'Not connected');
  const urlInput = input(doc, {
    label: 'Custom endpoint base URL', placeholder: 'http://127.0.0.1:11434/v1', signal: life.signal,
    attrs: { 'data-peer-custom-url': '' }
  });
  const authSelect = el(doc, 'select', {
    className: 'peer-settings-select peer-settings-select-narrow',
    attrs: { 'aria-label': 'Custom endpoint auth mode', 'data-peer-custom-auth': '' }
  });
  authSelect.append(
    el(doc, 'option', { text: 'Keyless', attrs: { value: 'keyless' } }),
    el(doc, 'option', { text: 'API key', attrs: { value: 'apiKey' } })
  );
  const keyInput = input(doc, {
    type: 'password', label: 'Custom endpoint API key', placeholder: 'Optional API key…', signal: life.signal,
    attrs: { 'data-peer-custom-key': '' }
  });
  const modelsInput = input(doc, {
    label: 'Manual model IDs', placeholder: 'model-a, model-b', signal: life.signal,
    attrs: { 'data-peer-custom-models': '' }
  });
  const controls = el(doc, 'div', { className: 'peer-settings-controls' });
  controls.append(urlInput, authSelect, keyInput, modelsInput);
  const submitCustom = () => {
    const baseUrl = urlInput.value.trim();
    if (!baseUrl) return;
    const authMode = authSelect.value === 'apiKey' ? 'apiKey' : 'keyless';
    const key = keyInput.value.trim();
    const manualModels = parseManualList(modelsInput.value);
    onSettingsIntent?.({
      type: 'save-custom-provider',
      value: { baseUrl, authMode, ...(key ? { key } : {}), ...(manualModels.length ? { manualModels } : {}) }
    });
    keyInput.value = '';
  };
  const actions = el(doc, 'div', { className: 'peer-settings-controls' });
  actions.append(
    button(doc, { className: 'is-primary', label: 'Save endpoint', signal: life.signal, attrs: { 'data-peer-action': 'save-custom-provider' }, onClick: submitCustom }),
    button(doc, { label: 'Disconnect endpoint', signal: life.signal, attrs: { 'data-peer-action': 'delete-custom-provider' }, onClick: () => onSettingsIntent?.({ type: 'delete-custom-provider' }) })
  );
  group.append(statusEl, controls, actions);
  return { group, statusText, urlInput, authSelect };
}

function summarizeRecord(record, fallback) {
  if (!record || typeof record !== 'object') return fallback;
  if (typeof record.status === 'string') return record.status;
  if (typeof record.installed === 'boolean') {
    const ver = record.version ? ` (${record.version})` : '';
    return record.installed ? `Installed${ver}` : 'Not installed';
  }
  if (Array.isArray(record.providers)) return `${record.providers.length} provider(s)`;
  const keys = Object.keys(record);
  return keys.length > 0 ? keys.map((k) => `${k}: ${String(record[k])}`).slice(0, 3).join(' · ') : fallback;
}

function buildConnectionsGroup(doc, life, onSettingsIntent) {
  const group = el(doc, 'div', {
    className: 'peer-settings-group',
    attrs: { 'data-peer-connections': '', 'data-testid': 'group-external-cli' }
  });
  group.append(el(doc, 'h3', { className: 'peer-settings-group-title', text: 'Subscriptions, CLI & Dictation' }));
  const makeStatusRow = (label, attr, testid) => {
    const row = el(doc, 'div', { className: 'peer-settings-row', attrs: { [attr]: '', ...(testid ? { 'data-testid': testid } : {}) } });
    const badge = el(doc, 'span', { className: 'peer-settings-badge' });
    const txt = textNode(doc, badge, 'Unavailable');
    row.append(el(doc, 'span', { className: 'peer-settings-row-label', text: label }), badge);
    group.append(row);
    return txt;
  };
  const subsText = makeStatusRow('Subscriptions & ChatGPT', 'data-peer-subscriptions', 'group-subscriptions');
  const claudeText = makeStatusRow('Claude Code CLI', 'data-peer-claude-code');
  const claudeWrap = el(doc, 'div', { attrs: { 'data-testid': 'claude-code-toggle' } });
  const claudeSwitch = createSwitch(claudeWrap, {
    onChange: (checked) => onSettingsIntent?.({ type: 'save-section', section: 'claudeCode', value: { enabled: checked } })
  });
  group.append(claudeWrap);
  const cliText = makeStatusRow('External CLI', 'data-peer-external-cli');

  const dictRow = el(doc, 'div', { className: 'peer-settings-row', attrs: { 'data-testid': 'group-dictation' } });
  const dictSelect = el(doc, 'select', {
    className: 'peer-settings-select peer-settings-select-narrow',
    attrs: { 'aria-label': 'Dictation language', 'data-testid': 'dictation-language-select', 'data-peer-dictation-language': '' }
  });
  for (const [val, text] of DICTATION_LANGUAGES) dictSelect.append(el(doc, 'option', { text, attrs: { value: val } }));
  life.on(dictSelect, 'change', () => {
    onSettingsIntent?.({ type: 'save-section', section: 'dictation', value: { language: dictSelect.value } });
  });
  dictRow.append(el(doc, 'span', { className: 'peer-settings-row-label', text: 'Dictation language' }), dictSelect);
  group.append(dictRow);
  return { group, subsText, claudeText, claudeSwitch, cliText, dictSelect };
}

function syncCustomFields(customUi, cp, fallbackCp) {
  const baseUrl = String(cp?.baseUrl ?? fallbackCp?.baseUrl ?? '');
  const models = Array.isArray(cp?.models) ? cp.models : (Array.isArray(fallbackCp?.models) ? fallbackCp.models : []);
  const authMode = cp?.authMode === 'apiKey' ? 'apiKey' : 'keyless';
  writeText(customUi.statusText, baseUrl ? `${baseUrl} · ${models.length} model(s) · ${authMode}` : 'Not connected');
  if (customUi.urlInput !== customUi.urlInput.ownerDocument?.activeElement) customUi.urlInput.value = baseUrl;
  customUi.authSelect.value = authMode;
}

function syncKeysSection(doc, life, addForm, listEl, customUi, connUi, state, onSettingsIntent) {
  const settings = state.settings;
  const options = resolveProviderOptions(settings?.providerKeys);
  const sig = options.map((o) => `${o.envVar}:${o.label}`).join('|');
  if (sig !== state.prevSig) {
    const current = addForm.providerSelect.value;
    const optNodes = options.map((o) => el(doc, 'option', { text: `${o.label} (${o.envVar})`, attrs: { value: o.envVar } }));
    addForm.providerSelect.replaceChildren(...optNodes);
    if (current && options.some((o) => o.envVar === current)) addForm.providerSelect.value = current;
    state.prevSig = sig;
  }
  renderKeyStatusRows(doc, life.signal, listEl, settings?.keys ?? [], options, (id) => {
    if (!life.dead) onSettingsIntent?.({ type: 'delete-key', id });
  });
  syncCustomFields(customUi, settings?.customProvider, settings?.effective?.customProvider);
  writeText(connUi.claudeText, summarizeRecord(settings?.claudeCode, 'Not detected'));
  connUi.claudeSwitch.update({
    label: 'Enable Claude Code provider',
    detail: 'Use local Claude Code subscription for conversations',
    checked: Boolean(settings?.record?.claudeCode?.enabled)
  });
  writeText(connUi.cliText, summarizeRecord(settings?.externalCli, 'None configured'));
  writeText(connUi.subsText, summarizeRecord(settings?.subscriptions, 'No active subscriptions'));
  connUi.dictSelect.value = settings?.record?.dictation?.language ?? settings?.effective?.dictation?.language ?? 'en';
}

export function createKeysSection(host, { onSettingsIntent } = {}) {
  const doc = documentOf(host);
  const life = createLife();
  const root = el(doc, 'div', { className: 'peer-settings-panel', attrs: { 'data-peer-settings-section': 'keys' } });
  const listGroup = el(doc, 'div', { className: 'peer-settings-group', attrs: { 'data-testid': 'group-provider-keys' } });
  listGroup.append(el(doc, 'h3', { className: 'peer-settings-group-title', text: 'Configured API keys' }));
  const listEl = el(doc, 'div', { className: 'peer-settings-group', attrs: { 'data-peer-keys-list': '' } });
  listGroup.append(listEl);
  const addForm = buildKeyAddForm(doc, life, onSettingsIntent);
  const customUi = buildCustomEndpointGroup(doc, life, onSettingsIntent);
  const connUi = buildConnectionsGroup(doc, life, onSettingsIntent);
  root.append(listGroup, addForm.group, customUi.group, connUi.group);
  host.append(root);
  const state = { settings: null, prevSig: '' };
  const update = ({ settings = null } = {}) => {
    if (life.dead) return;
    state.settings = settings;
    syncKeysSection(doc, life, addForm, listEl, customUi, connUi, state, onSettingsIntent);
  };
  update({});
  return { update, destroy: () => { if (life.destroy()) { connUi.claudeSwitch.destroy(); root.remove(); } } };
}
