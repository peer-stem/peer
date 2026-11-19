/**
 * Browser bundle entry for KaTeX and Markdown math pre-pass helpers (`C-04`, `C-12`).
 * Consumed via import map by `src/client/blocks/` so views never import `peer-state`.
 */

import katex from "katex";

export { repairMathForDisplay, transformMathDelimiters } from "../../core/math-delims.ts";
export { katex };
export default katex;
