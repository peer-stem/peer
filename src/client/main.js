/**
 * Client composition root (`views §1.4`, `§2.1`, `R5`, `R6`, `f4-c2c`).
 * Sole module outside `src/client/state/` that imports `"peer-state"`.
 * Wires `state.appearance` onto `<html>` via `applyThemeTokens` (`R6`),
 * binds `createPluginUiHost` + dynamic code-block fences onto `state.plugins`,
 * and mounts `createShell` into `doc.body`.
 */
import { createState } from 'peer-state';
import { createBlockRegistry } from './blocks/registry.js';
import { applyThemeTokens } from './theme/apply.js';
import { createPluginUiHost } from './views/plugin/plugin-ui-host.js';
import { createShell } from './views/shell/shell.js';

function attachPluginHostToState(doc, state, blocks, getShell) {
  if (state.plugins?.setUiFactory) {
    state.plugins.setUiFactory(createPluginUiHost({
      doc,
      getLayerHost: () => getShell()?.layerHost ?? doc.body,
      getModels: () => state.models?.get?.()?.models ?? [],
      subscribeModels: (fn) => state.models?.subscribe?.(fn) ?? (() => {}),
      getPropositions: () => state.graph?.get?.()?.snapshot?.propositions ?? [],
      subscribeGraph: (fn) => state.graph?.subscribe?.(fn) ?? (() => {}),
      getDictation: () => state.dictation ?? null,
      onOpenDeepgramKey: () => state.shell?.send?.({ type: 'open-settings', section: 'keys' })
    }));
  }
  return state.plugins?.bindBlockRegistry ? state.plugins.bindBlockRegistry(blocks) : null;
}

export function mountClientApp(doc = globalThis.document, options = {}) {
  if (!doc?.documentElement || !doc?.body) {
    throw new TypeError('mountClientApp: a document with documentElement and body is required');
  }
  const ownsState = !options.state;
  const state = options.state ?? createState({ doc, ...options.stateOptions });
  const blocks = options.blocks ?? createBlockRegistry(options.renderers);
  const htmlEl = doc.documentElement;

  let shell = null;
  const unsubBlocks = attachPluginHostToState(doc, state, blocks, () => shell);
  const initialAppearance = state.appearance.get();
  if (initialAppearance?.tokens) applyThemeTokens(htmlEl, initialAppearance.tokens);
  const unsubAppearance = state.appearance.subscribe((appearanceModel) => {
    if (appearanceModel?.tokens) applyThemeTokens(htmlEl, appearanceModel.tokens);
  });

  shell = createShell(doc.body, {
    router: state.router, shell: state.shell, sessions: state.sessions, activity: state.activity,
    settings: state.settings, models: state.models, appearance: state.appearance, desktop: state.desktop,
    prefs: state.prefs, plugins: state.plugins, speech: state.speech, dictation: state.dictation,
    screen: (routeModel) => state.screen(routeModel), blocks
  });

  let destroyed = false;
  const destroy = () => {
    if (destroyed) return;
    destroyed = true;
    unsubBlocks?.();
    unsubAppearance?.();
    shell.destroy();
    blocks?.dispose?.();
    if (ownsState) state.dispose?.();
  };
  return { state, blocks, shell, destroy };
}

function bootWhenReady() {
  if (typeof window === 'undefined' || globalThis.__PEER_DISABLE_AUTO_BOOT__) return;
  const doc = globalThis.document;
  if (!doc) return;
  if (doc.readyState === 'loading') {
    doc.addEventListener('DOMContentLoaded', () => {
      if (!globalThis.__PEER_DISABLE_AUTO_BOOT__ && doc.body) mountClientApp(doc);
    }, { once: true });
    return;
  }
  if (doc.body) mountClientApp(doc);
}

bootWhenReady();
