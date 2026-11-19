/**
 * Screen slot lifecycle controller (`views §2.4`, `R1`, `R2`, `C-08`).
 * Mounts one screen view + screen store per identity key, coalesces store updates
 * to `1/requestAnimationFrame`, and catches view throws in a `createStatus` boundary.
 */
import { createLife, createStatus, documentOf } from 'cloudcanvas-lib/ui';
import { resolveScreenFactory, screenKeyForRoute } from './screens.js';

function cancelFrame(state) {
  state.frameToken += 1;
  if (state.rafId !== null && typeof state.win?.cancelAnimationFrame === 'function') {
    state.win.cancelAnimationFrame(state.rafId);
  }
  state.rafId = null;
  state.microQueued = false;
}

function scheduleFrame(state, callback) {
  if (state.life.dead) return;
  if (typeof state.win?.requestAnimationFrame === 'function') {
    if (state.rafId !== null) return;
    const token = state.frameToken;
    state.rafId = state.win.requestAnimationFrame(() => {
      state.rafId = null;
      if (!state.life.dead && state.frameToken === token) callback();
    });
    return;
  }
  if (state.microQueued) return;
  state.microQueued = true;
  const token = state.frameToken;
  queueMicrotask(() => {
    state.microQueued = false;
    if (!state.life.dead && state.frameToken === token) callback();
  });
}

function unmountSlot(state) {
  cancelFrame(state);
  state.unsubscribe?.();
  state.unsubscribe = null;
  if (state.errorStatus) { state.errorStatus.destroy(); state.errorStatus = null; }
  if (state.view) {
    try { state.view.destroy?.(); } finally { state.view = null; }
  }
  if (state.source) {
    try { state.source.dispose?.(); } finally { state.source = null; }
  }
  if (state.slotHost.childElementCount !== 0) state.slotHost.replaceChildren();
}

function tripSlotErrorBoundary(state, err, remount) {
  cancelFrame(state);
  state.unsubscribe?.();
  state.unsubscribe = null;
  if (state.view) {
    try { state.view.destroy?.(); } catch { /* broken view */ }
    state.view = null;
  }
  if (state.source) {
    try { state.source.dispose?.(); } catch { /* broken store */ }
    state.source = null;
  }
  if (state.errorStatus) { state.errorStatus.destroy(); state.errorStatus = null; }
  state.slotHost.replaceChildren();
  const message = err instanceof Error ? err.message : String(err ?? 'Screen failed to render');
  state.errorStatus = createStatus(state.slotHost);
  state.errorStatus.update({ status: 'error', message, retry: remount });
}

function remountSlot(state) {
  if (state.life.dead || !state.lastRouteModel) return;
  unmountSlot(state);
  mountSlotRoute(state, state.lastRouteModel);
}

function flushSlotUpdate(state) {
  if (state.life.dead || !state.source || !state.view || state.errorStatus) return;
  try {
    state.view.update(state.source.get());
  } catch (err) {
    tripSlotErrorBoundary(state, err, () => remountSlot(state));
  }
}

function mountSlotRoute(state, routeModel) {
  try {
    const source = state.screen(routeModel);
    state.source = source;
    const factory = state.resolveFactory(routeModel.route);
    const view = factory(state.slotHost, {
      send: (intent) => source.send(intent),
      navigate: state.navigate
    });
    state.view = view;
    view.update(source.get());
    state.unsubscribe = source.subscribe(() => scheduleFrame(state, () => flushSlotUpdate(state)));
  } catch (err) {
    tripSlotErrorBoundary(state, err, () => remountSlot(state));
  }
}

function syncSlotRoute(state, routeModel) {
  if (state.life.dead || !routeModel?.route) return;
  state.lastRouteModel = routeModel;
  const nextKey = screenKeyForRoute(routeModel.route);
  if (nextKey === state.activeKey && state.source && !state.errorStatus) {
    scheduleFrame(state, () => flushSlotUpdate(state));
    return;
  }
  unmountSlot(state);
  state.activeKey = nextKey;
  mountSlotRoute(state, routeModel);
}

export function createScreenSlot(slotHost, { screen, navigate, resolveFactory } = {}) {
  const doc = documentOf(slotHost);
  if (typeof screen !== 'function') {
    throw new TypeError('createScreenSlot: options.screen must be a function');
  }
  const factoryOf = typeof resolveFactory === 'function' ? resolveFactory : resolveScreenFactory;
  const state = {
    slotHost, win: doc.defaultView, life: createLife(), screen, navigate, resolveFactory: factoryOf,
    activeKey: null, lastRouteModel: null, source: null, view: null, unsubscribe: null,
    errorStatus: null, rafId: null, microQueued: false, frameToken: 0
  };

  const command = (action) => {
    if (state.life.dead || !state.view || state.errorStatus) return false;
    return Boolean(state.view.command?.(action));
  };

  const destroy = () => {
    if (!state.life.destroy()) return;
    unmountSlot(state);
    state.activeKey = null;
    state.lastRouteModel = null;
  };

  return { syncRoute: (routeModel) => syncSlotRoute(state, routeModel), command, destroy };
}
