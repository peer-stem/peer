/**
 * Placed plugin action strips (`sidebar`, `graph`, `top-bar`) and shortcut dispatcher
 * (`components/plugin-chrome.tsx` parity).
 */
import { createLife, documentOf, el, show } from "cloudcanvas-lib/ui";
import { matchesPluginShortcut } from "peer-engine";
import { injectPluginStyles } from "./plugin.css.js";

function matchesTopBarPlacement(placement, surfaceCtx) {
	if (!surfaceCtx) return false;
	if (surfaceCtx.surface === "session") {
		if (!placement.sessions || placement.sessions.length === 0) return true;
		const normKind = surfaceCtx.kind === "practice" ? "practice" : "teaching";
		return placement.sessions.includes(normKind) || placement.sessions.includes(surfaceCtx.kind);
	}
	if (surfaceCtx.surface === "plugin-view") {
		if (!placement.views || placement.views.length === 0) return false;
		return placement.views.some((v) => v === surfaceCtx.viewId || v === `${surfaceCtx.pluginId}/${surfaceCtx.viewId}`);
	}
	return false;
}

function buildPlacementActionContext(location, surfaceCtx) {
	if (location === "sidebar") return { placement: "sidebar", surface: "sidebar" };
	if (location === "graph") return { placement: "graph", surface: "graph" };
	return surfaceCtx ? { ...surfaceCtx, placement: "top-bar" } : { placement: "top-bar", surface: "plugin-view", pluginId: "", viewId: "" };
}

function collectPluginPlacements(plugin, location, surfaceCtx, out) {
	const busySet = new Set(plugin.actionBusy ?? []);
	for (const placement of plugin.placements ?? []) {
		if (placement.location !== location) continue;
		if (location === "top-bar" && !matchesTopBarPlacement(placement, surfaceCtx)) continue;
		const action = (plugin.actions ?? []).find((a) => a.id === placement.actionId);
		if (!action) continue;
		const ctx = buildPlacementActionContext(location, surfaceCtx);
		if (typeof action.visible === "function" && !action.visible(ctx)) continue;
		const disabled = busySet.has(action.id) || Boolean(typeof action.disabled === "function" ? action.disabled(ctx) : action.disabled);
		const label = action.name || action.label || action.id;
		out.push({
			key: `${plugin.info.id}:${placement.id}`,
			pluginId: plugin.info.id, placement, action, label, disabled,
			order: typeof placement.order === "number" ? placement.order : 0, context: ctx,
		});
	}
}

export function placedPluginActions(pluginsSnap, location, surfaceCtx) {
	const plugins = Array.isArray(pluginsSnap?.plugins) ? pluginsSnap.plugins : [];
	const items = [];
	for (const plugin of plugins) {
		if (plugin.phase === "active") collectPluginPlacements(plugin, location, surfaceCtx, items);
	}
	items.sort((a, b) => a.order - b.order || a.key.localeCompare(b.key));
	return items;
}

function tryPluginShortcuts(plugin, event, manager, getContext) {
	for (const entry of plugin.shortcuts ?? []) {
		if (!matchesPluginShortcut(event, entry.shortcut)) continue;
		const action = (plugin.actions ?? []).find((a) => a.id === entry.actionId);
		if (!action) continue;
		const ctxFn = () => getContext?.() ?? manager.shortcutPageContext();
		if (manager.tryRunAction(plugin.info.id, action, ctxFn)) {
			event.preventDefault();
			return true;
		}
	}
	return false;
}

export function dispatchPluginActionShortcuts(event, pluginsSnap, manager, getContext) {
	if (!manager || event.defaultPrevented || event.isComposing) return false;
	const plugins = Array.isArray(pluginsSnap?.plugins) ? pluginsSnap.plugins : [];
	for (const plugin of plugins) {
		if (plugin.phase === "active" && tryPluginShortcuts(plugin, event, manager, getContext)) return true;
	}
	return false;
}

function buildActionBtnNode(doc, entry, onRun) {
	const btn = el(doc, "button", {
		className: "peer-plugin-btn",
		attrs: {
			type: "button", "data-size": "sm", "data-variant": "ghost",
			"data-testid": `plugin-action-${entry.pluginId}-${entry.action.id}`, "aria-label": entry.label,
		},
	});
	btn.disabled = entry.disabled;
	if (entry.action.icon) {
		const ic = el(doc, "span", { className: "peer-plugin-btn-icon", attrs: { "aria-hidden": "true" } });
		ic.innerHTML = entry.action.icon;
		btn.append(ic);
	}
	if (!entry.placement.iconOnly) btn.append(el(doc, "span", { text: entry.label }));
	btn.addEventListener("click", () => onRun(entry));
	return btn;
}

function buildOverflowMenuNode(doc, moreBtn, overflow, onRun) {
	const menuEl = el(doc, "div", { className: "peer-plugin-menu", attrs: { role: "menu" } });
	const rect = moreBtn.getBoundingClientRect?.() ?? { left: 16, bottom: 32 };
	menuEl.style.left = `${Math.max(8, rect.left)}px`;
	menuEl.style.top = `${Math.max(8, rect.bottom + 4)}px`;
	for (const item of overflow) {
		const m = el(doc, "button", { className: "peer-plugin-menu-item", text: item.label, attrs: { type: "button", role: "menuitem" } });
		m.disabled = item.disabled;
		m.addEventListener("click", () => onRun(item));
		menuEl.append(m);
	}
	doc.body.append(menuEl);
	return menuEl;
}

export function createPluginActionsBar(host, { location, testId, maxVisible = 4, onRunAction } = {}) {
	const doc = documentOf(host);
	injectPluginStyles(doc);
	const life = createLife();
	const bar = el(doc, "div", {
		className: "peer-plugin-actions-bar",
		attrs: { "data-testid": testId ?? `plugin-${location}-actions`, hidden: true },
	});
	let menuEl = null;
	const closeOverflow = () => { menuEl?.remove(); menuEl = null; };

	const update = ({ plugins = null, manager = null, context = null } = {}) => {
		if (life.dead) return;
		closeOverflow();
		const items = placedPluginActions(plugins, location, context);
		show(bar, items.length > 0);
		if (items.length === 0) { bar.replaceChildren(); return; }
		const onRun = (entry) => { closeOverflow(); if (onRunAction) onRunAction(entry); else manager?.runAction?.(entry.pluginId, entry.action, entry.context); };
		const visible = location === "top-bar" && items.length > maxVisible ? items.slice(0, maxVisible - 1) : items;
		const overflow = location === "top-bar" && items.length > visible.length ? items.slice(visible.length) : [];
		const nodes = visible.map((e) => buildActionBtnNode(doc, e, onRun));
		if (overflow.length > 0) {
			const moreAttrs = { type: "button", "data-size": "sm", "data-variant": "ghost", "data-testid": "plugin-top-bar-menu", "aria-label": "More plugin actions" };
			const moreBtn = el(doc, "button", { className: "peer-plugin-btn", text: "⋯", attrs: moreAttrs });
			moreBtn.addEventListener("click", () => { if (menuEl) closeOverflow(); else menuEl = buildOverflowMenuNode(doc, moreBtn, overflow, onRun); });
			nodes.push(moreBtn);
		}
		bar.replaceChildren(...nodes);
	};
	host.append(bar);
	return { node: bar, update, destroy() { if (life.destroy()) { closeOverflow(); bar.remove(); } } };
}
