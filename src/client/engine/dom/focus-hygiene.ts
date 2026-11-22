/**
 * FOCUS HYGIENE — transient transcript controls don't keep focus after pointer clicks;
 * keyboard-activated clicks (detail === 0) keep focus.
 */

export function blurAfterPointerClick(e: {
	detail: number;
	currentTarget: EventTarget | null;
}): void {
	if (e.detail === 0) return;
	const el = e.currentTarget as { blur?: unknown } | null;
	if (el && typeof el.blur === "function") (el.blur as () => void).call(el);
}
