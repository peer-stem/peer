/**
 * Settings sections for Core Plugins (`[data-testid="section-core-plugins"]`),
 * Community/User Plugins (`[data-testid="section-plugins"]`), and dynamic
 * per-plugin settings (`[data-testid="section-plugin-<id>"]`).
 */
import { button, createLife, createSwitch, documentOf, el, show, textNode, writeText } from "cloudcanvas-lib/ui";
import { mountPluginSettingsRows } from "./plugin-settings-rows.js";

const AUTHORING_ZIP_HREF = "/plugin-authoring/learnharness-plugins.zip";

function appendViewLinks(doc, right, id, views) {
	for (const v of views ?? []) {
		right.append(el(doc, "a", {
			className: "peer-plugin-btn", text: v.name || v.title || v.id,
			attrs: { href: `/plugins/${encodeURIComponent(id)}/${encodeURIComponent(v.id)}`, "data-testid": `plugin-open-view-${id}-${v.id}` },
		}));
	}
}

function renderPluginCard(doc, plugin, onToggleEnabled, onOpenPluginSettings) {
	const id = plugin.info.id;
	const name = plugin.info.manifest?.name ?? id;
	const desc = plugin.info.manifest?.description ?? "";
	const ver = plugin.info.manifest?.version ?? "";
	const card = el(doc, "div", { className: "peer-settings-group", attrs: { "data-testid": `plugin-${id}`, "data-plugin-phase": plugin.phase } });
	const row = el(doc, "div", { className: "peer-settings-row" });
	const left = el(doc, "div");
	left.append(
		el(doc, "div", { className: "peer-settings-row-label", text: ver ? `${name} · v${ver}` : name }),
		...(desc ? [el(doc, "div", { className: "peer-settings-hint", text: desc })] : []),
	);
	const right = el(doc, "div", { className: "peer-settings-controls" });
	appendViewLinks(doc, right, id, plugin.views);
	if (plugin.settings && onOpenPluginSettings) {
		right.append(button(doc, { label: "Configure", onClick: () => onOpenPluginSettings(`plugin:${id}`), attrs: { "data-testid": `plugin-configure-${id}` } }));
	}
	const swHost = el(doc, "div", { attrs: { "data-testid": `plugin-toggle-${id}` } });
	const sw = createSwitch(swHost, { onChange: (checked) => onToggleEnabled?.(id, checked) });
	sw.update({ label: plugin.info.enabled ? "Enabled" : "Disabled", checked: Boolean(plugin.info.enabled), disabled: Boolean(plugin.busy) });
	right.append(swHost);
	row.append(left, right);
	card.append(row);

	const err = plugin.error ?? plugin.info.error;
	if (err) card.append(el(doc, "p", { className: "peer-settings-error", text: String(err), attrs: { role: "alert", "data-testid": `plugin-error-${id}` } }));
	return { card, destroy: () => sw.destroy() };
}

function syncPluginCardList(doc, listEl, handlesRef, items, onToggle, onOpenSection) {
	for (const h of handlesRef.list) h.destroy();
	handlesRef.list = [];
	if (items.length === 0) {
		listEl.replaceChildren(el(doc, "p", { className: "peer-settings-hint", text: "No plugins found." }));
		return;
	}
	const nodes = items.map((p) => {
		const rendered = renderPluginCard(doc, p, onToggle, onOpenSection);
		handlesRef.list.push(rendered);
		return rendered.card;
	});
	listEl.replaceChildren(...nodes);
}

export function createCorePluginsSection(host, { onPluginsIntent, onSelectSection } = {}) {
	const doc = documentOf(host);
	const life = createLife();
	const root = el(doc, "div", {
		className: "peer-settings-panel",
		attrs: { "data-peer-settings-section": "core-plugins", "data-testid": "section-core-plugins" },
	});
	root.append(
		el(doc, "h3", { className: "peer-settings-group-title", text: "Core extensions" }),
		el(doc, "p", { className: "peer-settings-hint", text: "Built-in learning extensions shipped with Peer (Flashcards, Coding Questions, Drawing Pad, Rich Code Blocks)." }),
	);
	const listEl = el(doc, "div", { className: "peer-settings-group" });
	root.append(listEl);
	host.append(root);
	const handlesRef = { list: [] };

	const update = ({ plugins = null } = {}) => {
		if (life.dead) return;
		const core = (Array.isArray(plugins?.plugins) ? plugins.plugins : []).filter((p) => (p.info?.origin ?? p.info?.source) === "core");
		syncPluginCardList(doc, listEl, handlesRef, core, (id, enabled) => onPluginsIntent?.({ type: "set-enabled", id, enabled }), onSelectSection);
	};
	update({});
	return { update, destroy: () => { if (life.destroy()) { for (const h of handlesRef.list) h.destroy(); root.remove(); } } };
}

function buildUserPluginsChrome(doc, life, onPluginsIntent) {
	const trustBox = el(doc, "div", { className: "peer-settings-group", attrs: { "data-testid": "plugins-trust-notice" } });
	trustBox.append(
		el(doc, "h3", { className: "peer-settings-group-title", text: "Local plugins" }),
		el(doc, "p", { className: "peer-settings-hint", text: "Plugins run with full local access on your machine. Only install plugins you trust." }),
		el(doc, "a", {
			className: "peer-plugin-btn", text: "Download plugin authoring skill (.zip)",
			attrs: { href: AUTHORING_ZIP_HREF, download: "learnharness-plugins.zip", "data-testid": "download-plugin-authoring" },
		}),
	);
	const dirGroup = el(doc, "div", { className: "peer-settings-group" });
	const dirRow = el(doc, "div", { className: "peer-settings-row" });
	const dirCode = el(doc, "code", { attrs: { "data-testid": "plugins-directory" } });
	const dirText = textNode(doc, dirCode, "—");
	const refreshBtn = button(doc, { label: "Refresh", signal: life.signal, onClick: () => onPluginsIntent?.({ type: "refresh" }), attrs: { "data-testid": "plugins-refresh" } });
	dirRow.append(dirCode, refreshBtn);
	dirGroup.append(dirRow);
	return { trustBox, dirGroup, dirText, refreshBtn };
}

export function createPluginsSection(host, { onPluginsIntent, onSelectSection } = {}) {
	const doc = documentOf(host);
	const life = createLife();
	const root = el(doc, "div", {
		className: "peer-settings-panel",
		attrs: { "data-peer-settings-section": "plugins", "data-testid": "section-plugins" },
	});
	const chrome = buildUserPluginsChrome(doc, life, onPluginsIntent);
	const errEl = el(doc, "p", { className: "peer-settings-error", attrs: { role: "alert", hidden: true } });
	const errText = textNode(doc, errEl, "");
	const listEl = el(doc, "div", { className: "peer-settings-group", attrs: { "data-testid": "user-plugins-list" } });
	root.append(chrome.trustBox, chrome.dirGroup, errEl, listEl);
	host.append(root);
	const handlesRef = { list: [] };

	const update = ({ plugins = null } = {}) => {
		if (life.dead) return;
		writeText(chrome.dirText, plugins?.directory || "—");
		chrome.refreshBtn.disabled = Boolean(plugins?.refreshing);
		const err = String(plugins?.error ?? "").trim();
		show(errEl, err !== "");
		writeText(errText, err);
		const userPlugins = (Array.isArray(plugins?.plugins) ? plugins.plugins : []).filter((p) => (p.info?.origin ?? p.info?.source) !== "core");
		syncPluginCardList(doc, listEl, handlesRef, userPlugins, (id, enabled) => onPluginsIntent?.({ type: "set-enabled", id, enabled }), onSelectSection);
	};
	update({});
	return { update, destroy: () => { if (life.destroy()) { for (const h of handlesRef.list) h.destroy(); root.remove(); } } };
}

function applyPluginSettingsMount(doc, life, state, bodyEl, plugin, pluginId, manager) {
	if (!plugin?.settings || plugin.phase !== "active") {
		state.activeKey = "";
		state.clearMount();
		bodyEl.append(el(doc, "p", { className: "peer-settings-hint", text: "Plugin settings are unavailable." }));
		return;
	}
	if (typeof plugin.settings === "function") {
		const nextKey = `fn:${pluginId}:${plugin.info.revision}`;
		if (nextKey !== state.activeKey) {
			state.clearMount();
			state.activeKey = nextKey;
			state.customUnmount = manager ? manager.mount(pluginId, (c, sig) => plugin.settings(c, sig), bodyEl, () => {}) : null;
		}
		return;
	}
	const nextKey = `schema:${pluginId}:${plugin.info.revision}`;
	if (nextKey !== state.activeKey || !state.schemaHandle) {
		state.clearMount();
		state.activeKey = nextKey;
		state.schemaHandle = mountPluginSettingsRows(doc, bodyEl, plugin.settings, life.signal, () => {});
	} else {
		state.schemaHandle.update(plugin.settings);
	}
}

export function createPluginSettingsPage(host) {
	const doc = documentOf(host);
	const life = createLife();
	const root = el(doc, "div", { className: "peer-settings-panel" });
	const titleEl = el(doc, "h3", { className: "peer-settings-group-title" });
	const titleText = textNode(doc, titleEl, "Plugin settings");
	const bodyEl = el(doc, "div");
	root.append(titleEl, bodyEl);
	host.append(root);
	const state = {
		activeKey: "", schemaHandle: null, customUnmount: null,
		clearMount() { state.schemaHandle?.dispose(); state.schemaHandle = null; state.customUnmount?.(); state.customUnmount = null; bodyEl.replaceChildren(); },
	};
	const update = ({ pluginId = "", plugins = null, manager = null } = {}) => {
		if (life.dead) return;
		root.setAttribute("data-testid", `section-plugin-${pluginId}`);
		const plugin = (plugins?.plugins ?? []).find((p) => p.info.id === pluginId);
		writeText(titleText, plugin?.info?.manifest?.name ?? pluginId ?? "Plugin settings");
		applyPluginSettingsMount(doc, life, state, bodyEl, plugin, pluginId, manager);
	};
	return { node: root, update, destroy: () => { if (life.destroy()) { state.clearMount(); root.remove(); } } };
}
