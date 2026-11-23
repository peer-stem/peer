/**
 * Browser bundle entry for Mermaid diagram rendering (`C-04`, `C-12`).
 * Framework-free direct Mermaid adapter consumed via import map by `src/client/blocks/`.
 */

import mermaidLib, { type MermaidConfig } from "mermaid";

export type { MermaidConfig };

export interface MermaidInstance {
	initialize: (config: MermaidConfig) => void;
	render: (id: string, source: string) => Promise<{ svg: string }>;
}

export interface DiagramPlugin {
	readonly name: "mermaid";
	readonly type: "diagram";
	readonly language: string;
	getMermaid: (config?: MermaidConfig) => MermaidInstance;
}

const DEFAULT_MERMAID_CONFIG: MermaidConfig = {
	startOnLoad: false,
	theme: "default",
	securityLevel: "strict",
	fontFamily: "monospace",
	suppressErrorRendering: true,
};

export function createMermaidPlugin(options?: { config?: MermaidConfig }): DiagramPlugin {
	let initialized = false;
	let activeConfig: MermaidConfig = { ...DEFAULT_MERMAID_CONFIG, ...options?.config };
	const instance: MermaidInstance = {
		initialize(next) {
			activeConfig = { ...DEFAULT_MERMAID_CONFIG, ...options?.config, ...next };
			mermaidLib.initialize(activeConfig);
			initialized = true;
		},
		async render(id, source) {
			if (!initialized) {
				mermaidLib.initialize(activeConfig);
				initialized = true;
			}
			const { svg } = await mermaidLib.render(id, source);
			return { svg };
		},
	};
	return {
		name: "mermaid",
		type: "diagram",
		language: "mermaid",
		getMermaid(config) {
			if (config) instance.initialize(config);
			return instance;
		},
	};
}

export const mermaid: DiagramPlugin = createMermaidPlugin();
