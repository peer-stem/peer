/**
 * Plain-JS layered Escape stack (`views §5`).
 * Listens for unhandled window `Escape` keydowns; pops and invokes the topmost
 * layer's `onEscape` when non-empty, or runs `onUnhandledEscape` otherwise.
 */
import { createLife } from 'cloudcanvas-lib/ui';

function popOrFallback(state, event) {
  if (state.life.dead || event?.defaultPrevented) return false;
  if (event && typeof event === 'object') {
    if (state.handled.has(event)) return false;
    state.handled.add(event);
  }
  const current = state.stack.pop();
  if (current) {
    event?.preventDefault?.();
    current.onEscape?.(event);
    return true;
  }
  if (typeof state.onUnhandledEscape === 'function' && state.onUnhandledEscape(event)) {
    event?.preventDefault?.();
    return true;
  }
  return false;
}

export function createLayerStack(win, { onUnhandledEscape } = {}) {
  const life = createLife();
  const state = { life, stack: [], handled: new WeakSet(), onUnhandledEscape };

  const remove = (id) => {
    const key = String(id ?? '');
    const index = state.stack.findIndex((entry) => entry.id === key);
    if (index === -1) return false;
    state.stack.splice(index, 1);
    return true;
  };

  const push = ({ id, kind = 'modal', onEscape } = {}) => {
    const key = String(id ?? '').trim();
    if (!key) throw new TypeError('createLayerStack: layer id is required');
    if (life.dead) return () => false;
    remove(key);
    state.stack.push({ id: key, kind, onEscape });
    return () => remove(key);
  };

  const top = () => (state.stack.length > 0 ? state.stack[state.stack.length - 1] : null);
  const size = () => state.stack.length;
  const handleEscape = (event) => popOrFallback(state, event);

  if (win && typeof win.addEventListener === 'function') {
    life.on(win, 'keydown', (event) => {
      if (event.key === 'Escape') handleEscape(event);
    });
  }

  const destroy = () => {
    if (life.destroy()) state.stack.length = 0;
  };

  return { push, remove, top, size, handleEscape, destroy };
}
