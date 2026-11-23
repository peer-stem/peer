/**
 * Imperative CloudCanvas `PluginUi` host factory (`src/core/plugin-ui.ts`).
 * Registered onto `state.plugins.setUiFactory(...)` from `src/client/main.js`.
 */
import { openPluginDialog, openPluginMenu, openPluginSurface } from "./plugin-overlays.js";
import {
	mountPluginComposer,
	mountPluginDictation,
	mountPluginKnowledgePicker,
	mountPluginModelPicker,
	mountPluginStandardComposer,
	mountPluginThinkingPicker,
} from "./plugin-pickers-composer.js";
import { mountPluginSettingsRows } from "./plugin-settings-rows.js";
import { mountPluginTree } from "./plugin-tree.js";
import {
	combineSignals,
	mountPluginBadge,
	mountPluginButton,
	mountPluginMarkdown,
	mountPluginWorkerResult,
} from "./plugin-widgets-basic.js";

function requireSignal(options) {
	if (!options || !(options.signal instanceof AbortSignal)) {
		throw new Error("PluginUi widget options require an AbortSignal");
	}
	return options.signal;
}

function requireContainer(container) {
	if (!container || typeof container.replaceChildren !== "function") {
		throw new Error("PluginUi mount requires a valid HTMLElement container");
	}
}

function wrapContainerMount(fallbackDoc, scoped, fn) {
	return (container, props, options) => {
		requireContainer(container);
		return fn(container.ownerDocument ?? fallbackDoc, container, props, scoped(options));
	};
}

function createPluginUiInstance(hostDeps, pluginSignal, onError) {
	const { doc, getLayerHost } = hostDeps;
	const ownerMenus = new WeakMap();
	const scoped = (options) => combineSignals(pluginSignal, requireSignal(options));
	const pickerDeps = { ...hostDeps, onError };
	return {
		mountButton: wrapContainerMount(doc, scoped, (d, c, p, s) => mountPluginButton(d, c, p, s, onError)),
		mountBadge: wrapContainerMount(doc, scoped, (d, c, p, s) => mountPluginBadge(d, c, p, s)),
		mountSettingsRows: wrapContainerMount(doc, scoped, (d, c, p, s) => mountPluginSettingsRows(d, c, p, s, onError)),
		mountMarkdown: wrapContainerMount(doc, scoped, (d, c, p, s) => mountPluginMarkdown(d, c, p, s)),
		mountTree: wrapContainerMount(doc, scoped, (d, c, p, s) => mountPluginTree(d, c, p, s, onError)),
		mountWorkerResult: wrapContainerMount(doc, scoped, (d, c, p, s) => mountPluginWorkerResult(d, c, p, s, onError)),
		mountModelPicker: wrapContainerMount(doc, scoped, (d, c, p, s) => mountPluginModelPicker(d, c, p, s, pickerDeps)),
		mountThinkingPicker: wrapContainerMount(doc, scoped, (d, c, p, s) => mountPluginThinkingPicker(d, c, p, s, pickerDeps)),
		mountKnowledgePicker: wrapContainerMount(doc, scoped, (d, c, p, s) => mountPluginKnowledgePicker(d, c, p, s, pickerDeps)),
		mountComposer: wrapContainerMount(doc, scoped, (d, c, p, s) => mountPluginComposer(d, c, p, s, pickerDeps)),
		mountDictation: wrapContainerMount(doc, scoped, (d, c, p, s) => mountPluginDictation(d, c, p, s, pickerDeps)),
		mountStandardComposer: wrapContainerMount(doc, scoped, (d, c, p, s) => mountPluginStandardComposer(d, c, p, s, pickerDeps)),
		openMenu: (anchor, props, options) => openPluginMenu(anchor?.ownerDocument ?? doc, getLayerHost?.(), ownerMenus, anchor, props, scoped(options), onError),
		openDialog: (props, options) => openPluginDialog(doc, getLayerHost?.(), props, scoped(options), onError),
		openSurface(targetOrProps, maybeProps, maybeOptions) {
			requireSignal(maybeOptions !== undefined ? maybeOptions : maybeProps);
			return openPluginSurface(doc, targetOrProps, maybeProps, maybeOptions, pluginSignal, onError);
		},
	};
}

export function createPluginUiHost(hostDeps = {}) {
	return ({ signal, onError }) => createPluginUiInstance(hostDeps, signal, onError);
}
