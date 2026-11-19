/**
 * Per-application fence block registry (`views §4.2`).
 * Reserves `"mermaid"` as an exclusive built-in language and holds zero
 * module-level mutable state.
 */
import { createMermaidBlock } from "./mermaid.js";

export const BUILTIN_MERMAID_LANGUAGE = "mermaid";

function normalizeLanguage(language) {
	return String(language ?? "").trim().toLowerCase();
}

function mountBuiltinMermaid(container, block) {
	const handle = createMermaidBlock(container);
	handle.update({
		source: block?.source ?? "",
		incomplete: Boolean(block?.incomplete),
		mode: "dark",
		displayOnly: false,
	});
	if (block?.signal) {
		block.signal.addEventListener("abort", () => handle.destroy(), { once: true });
	}
	return () => handle.destroy();
}

function createBuiltinMermaidRenderer() {
	return Object.freeze({
		language: BUILTIN_MERMAID_LANGUAGE,
		builtin: true,
		mount: mountBuiltinMermaid,
	});
}

/**
 * Create an isolated block renderer registry instance.
 * @param {Array<{language: string, mount: Function}>} [initialRenderers]
 */
export function createBlockRegistry(initialRenderers = []) {
	const renderers = new Map();
	renderers.set(BUILTIN_MERMAID_LANGUAGE, createBuiltinMermaidRenderer());

	const register = (renderer) => {
		if (!renderer || typeof renderer.mount !== "function") return () => {};
		const key = normalizeLanguage(renderer.language);
		if (!key || key === BUILTIN_MERMAID_LANGUAGE) return () => {};
		renderers.set(key, renderer);
		return () => {
			if (renderers.get(key) === renderer) renderers.delete(key);
		};
	};

	const unregister = (language) => {
		const key = normalizeLanguage(language);
		if (!key || key === BUILTIN_MERMAID_LANGUAGE) return false;
		return renderers.delete(key);
	};

	const fenceFor = (language) => {
		const key = normalizeLanguage(language);
		return key ? (renderers.get(key) ?? null) : null;
	};

	const has = (language) => {
		const key = normalizeLanguage(language);
		return key ? renderers.has(key) : false;
	};

	const dispose = () => {
		for (const key of Array.from(renderers.keys())) {
			if (key !== BUILTIN_MERMAID_LANGUAGE) renderers.delete(key);
		}
	};

	if (Array.isArray(initialRenderers)) {
		for (const entry of initialRenderers) register(entry);
	}

	return { register, unregister, fenceFor, has, dispose };
}
