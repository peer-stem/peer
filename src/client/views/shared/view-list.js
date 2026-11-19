/**
 * Keyed subview list reconciler (`views §1.3` item 3).
 * Wraps `reconcileKeyedList` from `cloudcanvas-lib/ui` so departed keys invoke
 * `handle.destroy()` BEFORE their DOM node is removed, and retained keys invoke
 * `handle.update(derivedModel)` only when `derivedModel !== entry.lastModel`.
 */
import { createLife, documentOf, el, reconcileKeyedList } from 'cloudcanvas-lib/ui';

function defaultKey(item, index) {
  if (item && typeof item === 'object') {
    if (item.id !== undefined && item.id !== null) return item.id;
    if (item.key !== undefined && item.key !== null) return item.key;
  }
  return index;
}

function defaultModel(item) {
  return item;
}

function buildListPlan(list, keyOf) {
  const order = [];
  const keep = new Set();
  const byKey = new Map();
  for (let i = 0; i < list.length; i += 1) {
    const item = list[i];
    const key = String(keyOf(item, i));
    if (keep.has(key)) continue;
    keep.add(key);
    order.push(key);
    byKey.set(key, { item, index: i });
  }
  return { order, keep, byKey };
}

function retireDepartedEntries(entries, previousOrder, keep) {
  const retiredNodes = [];
  for (let i = previousOrder.length - 1; i >= 0; i -= 1) {
    const key = previousOrder[i];
    if (keep.has(key)) continue;
    const entry = entries.get(key);
    if (!entry) continue;
    entry.handle?.destroy?.();
    retiredNodes.push(entry.node);
    entries.delete(key);
  }
  return retiredNodes;
}

function mountListEntry(doc, entries, createFn, item, index, key, itemTag, itemClass) {
  const existing = entries.get(key);
  if (existing) return existing.node;
  const slot = el(doc, itemTag, { className: itemClass });
  const created = createFn(slot, item, index);
  const node = created?.node?.nodeType === 1 ? created.node : slot;
  const handle = created?.handle ?? created;
  entries.set(key, { node, handle, lastModel: undefined, initialized: false });
  return node;
}

function updateActiveEntries(entries, plan, modelOf) {
  for (const key of plan.order) {
    const entry = entries.get(key);
    const meta = plan.byKey.get(key);
    if (!entry || !meta) continue;
    const derived = modelOf(meta.item, meta.index);
    if (!entry.initialized || derived !== entry.lastModel) {
      entry.initialized = true;
      entry.lastModel = derived;
      entry.handle?.update?.(derived);
    }
  }
}

export function createViewList(container, options = {}) {
  const doc = documentOf(container);
  const { key: keyOption, create, model: modelOption, itemTag = 'div', itemClass = '' } = options;
  if (typeof create !== 'function') {
    throw new TypeError('createViewList: options.create must be a function');
  }
  const keyOf = typeof keyOption === 'function' ? keyOption : defaultKey;
  const modelOf = typeof modelOption === 'function' ? modelOption : defaultModel;
  const life = createLife();
  const entries = new Map();
  let currentOrder = [];

  const update = (items = []) => {
    if (life.dead) return;
    const list = Array.from(items ?? []);
    const plan = buildListPlan(list, keyOf);
    const retiredNodes = retireDepartedEntries(entries, currentOrder, plan.keep);
    reconcileKeyedList(container, list, {
      key: (item, index) => String(keyOf(item, index)),
      create: (item, index) => mountListEntry(
        doc, entries, create, item, index, String(keyOf(item, index)), itemTag, itemClass
      )
    });
    for (const node of retiredNodes) {
      if (node.parentNode === container) node.remove();
    }
    updateActiveEntries(entries, plan, modelOf);
    currentOrder = plan.order;
  };

  const destroy = () => {
    if (!life.destroy()) return;
    for (let i = currentOrder.length - 1; i >= 0; i -= 1) {
      const entry = entries.get(currentOrder[i]);
      if (!entry) continue;
      entry.handle?.destroy?.();
      entry.node.remove();
    }
    entries.clear();
    currentOrder = [];
  };

  return { update, destroy };
}
