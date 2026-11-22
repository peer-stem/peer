/**
 * Full-page plugin view screen (`/plugins/:pluginId/:viewId`, `[data-testid="plugin-view"]`,
 * `components/plugin-view.tsx` parity).
 */
import { button, createLife, createStatus, documentOf, el, injectUiStyles, show } from "cloudcanvas-lib/ui";
import { createInteractionScopeController, registerSurfaceBoundary } from "peer-engine";
import { createTopBar } from "../shared/top-bar.js";
import { createPluginActionsBar } from "./plugin-chrome.js";
import { injectPluginStyles } from "./plugin.css.js";

function mountActivePluginView(state, model) {
	const { pluginId, viewId, view, manager } = model;
	const mountKey = `${pluginId}:${model.plugin?.info?.revision ?? ""}:${viewId}`;
	if (mountKey === state.mountKey && state.unmountView) return;
	state.unmountView?.();
	state.unmountView = null;
	state.mountKey = mountKey;
	state.mountError = null;
	state.nodes.mountHost.replaceChildren();
	if (!view || !manager) return;
	state.unmountView = manager.mount(
		pluginId,
		(container, signal) => view.mount(container, signal),
		state.nodes.mountHost,
		(errMsg) => {
			state.mountError = errMsg;
			show(state.nodes.statusSlot, true);
			state.nodes.statusControl.update({ status: "error", message: errMsg });
		},
	);
}

function buildPluginViewDom(doc, life, callbacks, getPluginId) {
	const root = el(doc, "section", {
		className: "peer-plugin-view",
		attrs: { "data-peer-screen": "plugin-view", "data-testid": "plugin-view" },
	});
	const headerEl = el(doc, "div", { className: "peer-session-header", attrs: { "data-plugin-chrome-title": "" } });
	const topBar = createTopBar(headerEl, {
		onToggleSidebar: callbacks.onToggleSidebar,
		onNavigateHome: callbacks.navigate ? () => callbacks.navigate({ name: "home" }) : undefined,
		onOpenSettings: callbacks.send ? () => callbacks.send({ type: "open-settings" }) : undefined,
	});
	const actionsSlot = el(doc, "div");
	const actionsBar = createPluginActionsBar(actionsSlot, { location: "top-bar", testId: "plugin-top-bar-actions" });
	const pluginSettingsBtn = button(doc, {
		label: "Plugin settings", signal: life.signal,
		onClick: () => callbacks.send?.({ type: "open-settings", section: `plugin:${getPluginId()}` }),
		attrs: { "data-testid": "plugin-view-settings" },
	});
	headerEl.append(actionsSlot, pluginSettingsBtn);

	const body = el(doc, "div", { className: "peer-plugin-view-body" });
	const scrollEl = el(doc, "div", { className: "peer-plugin-view-scroll", attrs: { "data-plugin-view-scroll": "" } });
	const statusSlot = el(doc, "div", { attrs: { hidden: true } });
	const statusControl = createStatus(statusSlot);
	const mountHost = el(doc, "div", { className: "peer-plugin-view-body" });
	scrollEl.append(statusSlot, mountHost);

	const surfaceRegion = el(doc, "div", { className: "peer-plugin-surface-region", attrs: { "data-session-surface-region": "" } });
	surfaceRegion.append(el(doc, "div", { attrs: { "data-session-surface-mounts": "" } }));
	body.append(scrollEl, surfaceRegion);
	root.append(headerEl, body);
	return { root, body, topBar, actionsBar, pluginSettingsBtn, statusSlot, statusControl, mountHost };
}

function applyPluginViewUpdate(life, state, dom, model = {}) {
	if (life.dead) return;
	state.pluginId = String(model.pluginId ?? model.route?.pluginId ?? "");
	state.viewId = String(model.viewId ?? model.route?.viewId ?? "");
	const title = model.view?.name ?? model.view?.title ?? model.plugin?.info?.manifest?.name ?? (state.viewId || "Plugin");
	dom.topBar.update({ title, subtitle: model.plugin?.info?.manifest?.name ?? "" });
	dom.pluginSettingsBtn.hidden = !model.plugin?.settings;

	const ctx = { surface: "plugin-view", pluginId: state.pluginId, viewId: state.viewId };
	const pathname = `/plugins/${encodeURIComponent(state.pluginId)}/${encodeURIComponent(state.viewId)}`;
	dom.actionsBar.update({ plugins: model.plugins, manager: model.manager, context: ctx });
	state.unregisterShortcut?.();
	state.unregisterShortcut = model.manager?.registerShortcutPage?.(pathname, () => ctx) ?? null;

	if (model.unavailableReason) {
		state.unmountView?.();
		state.unmountView = null;
		state.mountKey = "";
		dom.mountHost.replaceChildren();
		show(dom.statusSlot, true);
		dom.statusControl.update({ status: model.loading ? "loading" : "error", message: model.unavailableReason });
		return;
	}
	if (!state.mountError) show(dom.statusSlot, false);
	mountActivePluginView(state, model);
}

export function createPluginView(host, { send, navigate, onToggleSidebar } = {}) {
	const doc = documentOf(host);
	injectUiStyles(doc);
	injectPluginStyles(doc);
	const life = createLife();
	const state = {
		pluginId: "", viewId: "", mountKey: "", mountError: null,
		unmountView: null, unregisterShortcut: null, boundary: null, nodes: null,
	};
	const dom = buildPluginViewDom(doc, life, { send, navigate, onToggleSidebar }, () => state.pluginId);
	host.append(dom.root);
	state.boundary = registerSurfaceBoundary(dom.body, life.signal, createInteractionScopeController());
	state.nodes = { statusSlot: dom.statusSlot, statusControl: dom.statusControl, mountHost: dom.mountHost };

	const destroy = () => {
		if (!life.destroy()) return;
		state.unregisterShortcut?.();
		state.unmountView?.();
		dom.actionsBar.destroy();
		dom.statusControl.destroy();
		dom.topBar.destroy();
		dom.root.remove();
	};
	return { update: (model) => applyPluginViewUpdate(life, state, dom, model), command: () => false, destroy };
}
