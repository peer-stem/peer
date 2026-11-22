/**
 * Client composition root (`views §1.4`, `§2.1`, `R5`, `R6`).
 * Sole module outside `src/client/state/` that imports `"peer-state"`.
 * Wires `state.appearance` onto `<html>` via `applyThemeTokens` (`R6`) and
 * mounts `createShell` into `doc.body`.
 */
import { createState } from 'peer-state';
import { createBlockRegistry } from './blocks/registry.js';
import { applyThemeTokens } from './theme/apply.js';
import { createShell } from './views/shell/shell.js';

export function mountClientApp(doc = globalThis.document, options = {}) {
  if (!doc?.documentElement || !doc?.body) {
    throw new TypeError('mountClientApp: a document with documentElement and body is required');
  }
  const ownsState = !options.state;
  const state = options.state ?? createState(options.stateOptions);
  const blocks = options.blocks ?? createBlockRegistry(options.renderers);
  const htmlEl = doc.documentElement;

  const initialAppearance = state.appearance.get();
  if (initialAppearance?.tokens) applyThemeTokens(htmlEl, initialAppearance.tokens);
  const unsubAppearance = state.appearance.subscribe((appearanceModel) => {
    if (appearanceModel?.tokens) applyThemeTokens(htmlEl, appearanceModel.tokens);
  });

  const shell = createShell(doc.body, {
    router: state.router,
    shell: state.shell,
    sessions: state.sessions,
    activity: state.activity,
    settings: state.settings,
    models: state.models,
    appearance: state.appearance,
    desktop: state.desktop,
    prefs: state.prefs,
    screen: (routeModel) => state.screen(routeModel),
    blocks
  });

  let destroyed = false;
  const destroy = () => {
    if (destroyed) return;
    destroyed = true;
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
