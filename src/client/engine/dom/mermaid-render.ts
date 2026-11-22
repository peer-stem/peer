/**
 * App-owned mermaid renderer shared by in-chat blocks and the focus overlay.
 */

import { createMermaidPlugin } from "@streamdown/mermaid";
import type { MermaidConfig } from "mermaid";
import type { RenderedMode } from "../../../core/index.ts";

export const MERMAID_FONT_SIZE = 16;

export function mermaidConfig(mode: RenderedMode): MermaidConfig {
	return {
		fontFamily: "ui-sans-serif, system-ui, sans-serif",
		fontSize: MERMAID_FONT_SIZE,
		securityLevel: "strict",
		theme: mode === "dark" ? "dark" : "default",
	};
}

const plugin = createMermaidPlugin();

/** Render one chart source to an svg string using a unique render id per call. */
export async function renderMermaid(chart: string, mode: RenderedMode): Promise<string> {
	const id = `lh-mermaid-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
	const { svg } = await plugin.getMermaid(mermaidConfig(mode)).render(id, chart);
	return svg;
}
