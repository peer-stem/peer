/**
 * CloudCanvas `peer-graph` widget specification (`views §3.2`, `C-03`).
 * Hosts the constant `<canvas>` surface inside a bare `blit()` root while
 * guarding duplicate registration across tests and repeated mounts.
 */
import { type } from 'cloudcanvas';
import { isWidget, widget } from 'cloudcanvas-lib/widget';

export const GRAPH_WIDGET = Object.freeze({
  name: 'peer-graph',
  keys: [],
  html: '<div class="peer-graph-stage"><canvas class="peer-graph-canvas" width="0" height="0" data-peer-graph-canvas=""></canvas></div>',
  bind(node) {
    return {
      stage: node.querySelector('.peer-graph-stage'),
      canvas: node.querySelector('canvas')
    };
  },
  render() {}
});

export function ensureGraphWidgetRegistered() {
  if (isWidget(GRAPH_WIDGET.name)) return type(GRAPH_WIDGET.name);
  const existing = type(GRAPH_WIDGET.name);
  if (existing) return existing;
  try {
    return widget(GRAPH_WIDGET);
  } catch {
    return type(GRAPH_WIDGET.name);
  }
}
