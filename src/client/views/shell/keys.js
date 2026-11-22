/**
 * Keyboard shortcut router (`views §5`, `C-07`).
 * Maps `peer-keyboard` bindings onto shell intents and active screen `command(action)`
 * calls without `lh:kbd-*` window CustomEvents.
 */
import { createLife } from 'cloudcanvas-lib/ui';
import {
  KEYBOARD_ACTIONS,
  actionForBinding,
  eventBinding,
  formatBinding,
  isTypingSurface
} from 'peer-keyboard';

export { KEYBOARD_ACTIONS, formatBinding };

const SHELL_ACTIONS = new Set([
  'toggle-sidebar',
  'open-settings',
  'cheat-sheet',
  'new-session',
  'jump-graph',
  'sessions-search'
]);

const SCREEN_ACTIONS = new Set([
  'find',
  'rename-session',
  'toggle-user-thinking',
  'toggle-question-thread',
  'cycle-thinking',
  'open-model-picker',
  'toggle-dictation'
]);

function resolveAction(binding, overrides) {
  if (overrides && typeof overrides === 'object') {
    for (const def of KEYBOARD_ACTIONS) {
      if (def.displayOnly) continue;
      const effective = overrides[def.id] ?? def.binding;
      if (effective === binding) return def.id;
    }
  }
  return actionForBinding(binding);
}

function handleTabShortcut(event, onScreenAction) {
  if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
  event.preventDefault();
  if (event.shiftKey) onScreenAction?.('cycle-thinking');
}

function dispatchAction(event, action, onShellAction, onScreenAction) {
  if (SHELL_ACTIONS.has(action)) {
    if (!onShellAction) return;
    const outcome = onShellAction(action);
    if (outcome !== false) event.preventDefault();
    return;
  }
  if (SCREEN_ACTIONS.has(action) && onScreenAction?.(action)) {
    event.preventDefault();
  }
}

export function createShortcutRouter(win, { onShellAction, onScreenAction, layers, getOverrides } = {}) {
  const life = createLife();

  const onKeyDown = (event) => {
    if (life.dead || event.isComposing) return;
    if (event.key === 'Escape') {
      if (!event.defaultPrevented && layers?.handleEscape?.(event)) event.preventDefault();
      return;
    }
    if (event.key === 'Tab') {
      handleTabShortcut(event, onScreenAction);
      return;
    }
    if (event.defaultPrevented) return;
    const action = resolveAction(eventBinding(event), getOverrides?.());
    if (!action) return;
    const hasModifier = Boolean(event.metaKey || event.ctrlKey || event.altKey);
    if (isTypingSurface(event) && !hasModifier) return;
    dispatchAction(event, action, onShellAction, onScreenAction);
  };

  if (win && typeof win.addEventListener === 'function') {
    life.on(win, 'keydown', onKeyDown);
  }

  return { destroy: () => { life.destroy(); } };
}
