/**
 * Custom plugin code-fence wrapper (`PluginCodeBlockRenderer` contract).
 * Aborts `signal` and runs cleanup on replacement/destroy; falls back to
 * readable `createCodeBlock` source when `renderer.mount` throws or rejects.
 */
import { createLife, documentOf, el } from "cloudcanvas-lib/ui";
import { injectBlocksStyles } from "./blocks.css.js";
import { createCodeBlock } from "./code.js";

function invokeCleanupSafe(cleanup) {
	if (typeof cleanup !== "function") return;
	try {
		cleanup();
	} catch {
		/* plugin cleanup errors must not break host teardown */
	}
}

function stopActiveMount(state) {
	if (state.abortController) {
		state.abortController.abort();
		state.abortController = null;
	}
	const cleanup = state.cleanup;
	state.cleanup = null;
	invokeCleanupSafe(cleanup);
	if (state.mountContainer) {
		state.mountContainer.remove();
		state.mountContainer = null;
	}
}

function stopFallback(state) {
	if (!state.fallback) return;
	state.fallback.destroy();
	state.fallback = null;
}

function toCodeModel(model) {
	return {
		code: String(model?.source ?? ""),
		language: String(model?.language ?? ""),
		meta: String(model?.meta ?? ""),
		incomplete: Boolean(model?.incomplete),
		mode: model?.mode === "light" ? "light" : "dark",
		displayOnly: Boolean(model?.displayOnly),
	};
}

function renderFallbackCode(state, model) {
	stopActiveMount(state);
	if (!state.fallback) {
		state.fallback = createCodeBlock(state.root, {
			onCopy: state.onCopy,
			onExpand: state.onExpand,
		});
	}
	state.fallback.update(toCodeModel(model));
}

function settleAsyncMount(state, controller, asyncCleanup) {
	if (controller.signal.aborted || state.life.dead) {
		invokeCleanupSafe(asyncCleanup);
		return;
	}
	if (typeof asyncCleanup === "function") state.cleanup = asyncCleanup;
}

function failAsyncMount(state, controller, model) {
	if (controller.signal.aborted || state.life.dead) return;
	renderFallbackCode(state, model);
}

function attachMountReturn(state, controller, result, model) {
	if (typeof result === "function") {
		if (controller.signal.aborted) invokeCleanupSafe(result);
		else state.cleanup = result;
		return;
	}
	if (!result || typeof result.then !== "function") return;
	result.then(
		(asyncCleanup) => settleAsyncMount(state, controller, asyncCleanup),
		() => failAsyncMount(state, controller, model),
	);
}

function mountPluginFence(state, model) {
	stopFallback(state);
	stopActiveMount(state);
	if (Boolean(model?.displayOnly) || typeof state.renderer?.mount !== "function") {
		renderFallbackCode(state, model);
		return;
	}
	const language = String(model?.language ?? "");
	const source = String(model?.source ?? "");
	const meta = String(model?.meta ?? "");
	const incomplete = Boolean(model?.incomplete);
	const container = el(state.doc, "div", {
		className: "peer-blocks-plugin-mount",
		attrs: { "data-peer-plugin-language": language },
	});
	state.root.append(container);
	state.mountContainer = container;
	const controller = new AbortController();
	state.abortController = controller;
	try {
		const ret = state.renderer.mount(container, {
			language,
			source,
			meta,
			incomplete,
			signal: controller.signal,
		});
		attachMountReturn(state, controller, ret, model);
	} catch {
		renderFallbackCode(state, model);
	}
}

function updatePluginFence(state, model) {
	if (state.life.dead || model === state.prevModel) return;
	state.prevModel = model;
	const mountKey = JSON.stringify([
		String(model?.language ?? ""),
		String(model?.source ?? ""),
		String(model?.meta ?? ""),
		Boolean(model?.incomplete),
		Boolean(model?.displayOnly),
	]);
	if (mountKey !== state.mountKey) {
		state.mountKey = mountKey;
		mountPluginFence(state, model);
		return;
	}
	if (state.fallback) state.fallback.update(toCodeModel(model));
}

/**
 * Mount a custom plugin code-fence block into `host`.
 * @param {Element} host
 * @param {{renderer?: {language: string, mount: Function}, onCopy?: Function, onExpand?: Function}} [options]
 */
export function createPluginFenceBlock(host, { renderer, onCopy, onExpand } = {}) {
	const doc = documentOf(host);
	injectBlocksStyles(doc);
	const life = createLife();
	const root = el(doc, "div", {
		className: "peer-blocks-plugin-fence",
		attrs: { "data-peer-block": "plugin-fence" },
	});
	host.append(root);
	const state = {
		doc, life, root, renderer, onCopy, onExpand,
		abortController: null, cleanup: null, mountContainer: null,
		fallback: null, mountKey: null, prevModel: null,
	};
	const update = (model = {}) => updatePluginFence(state, model);
	const destroy = () => {
		if (!life.destroy()) return;
		stopActiveMount(state);
		stopFallback(state);
		root.remove();
	};
	return { update, destroy };
}
