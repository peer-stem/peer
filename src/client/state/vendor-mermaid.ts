/**
 * Browser bundle entry for Mermaid diagram rendering (`C-04`, `C-12`).
 * Consumed via import map by `src/client/blocks/` so views never import `peer-state`.
 */

export { createMermaidPlugin, mermaid } from "@streamdown/mermaid";
