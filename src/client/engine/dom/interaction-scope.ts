/** DOM-only eligibility and structural layer controller seam. */

export interface SurfaceLayerSnapshot {
	id: string;
	kind: "modal" | "popup" | "view";
	rootRef: { readonly current: HTMLElement | null };
	order: number;
}

export interface InteractionScopeController {
	isElementEligible(element: HTMLElement | null): boolean;
	getTopLayer(): SurfaceLayerSnapshot | null;
	ownerOf(element: Element | null): SurfaceLayerSnapshot | null;
	belongsTo(id: string, ancestorId: string): boolean;
	isPopupOrigin(element: HTMLElement | null): boolean;
	getGeneration(): number;
	getFocusRevision(): number;
	getSnapshot(): readonly SurfaceLayerSnapshot[];
}

/** DOM-only eligibility. No browser access during module initialization/SSR. */
export function isInteractionElementVisible(element: HTMLElement | null): element is HTMLElement {
	if (!element?.isConnected) return false;
	for (let node: HTMLElement | null = element; node; node = node.parentElement) {
		if (node.hidden || node.hasAttribute("inert") || node.getAttribute("aria-hidden") === "true") return false;
		const style = node.ownerDocument.defaultView?.getComputedStyle?.(node);
		if (style?.display === "none" || style?.visibility === "hidden" || style?.visibility === "collapse") return false;
	}
	return !element.matches(":disabled, [disabled], [aria-disabled='true'], input[type='hidden']");
}

export function createInteractionScopeController(): InteractionScopeController {
	const empty: readonly SurfaceLayerSnapshot[] = Object.freeze([]);
	return {
		isElementEligible: (element) => isInteractionElementVisible(element),
		getTopLayer: () => null,
		ownerOf: () => null,
		belongsTo: (id, ancestorId) => id === ancestorId,
		isPopupOrigin: () => false,
		getGeneration: () => 0,
		getFocusRevision: () => 0,
		getSnapshot: () => empty,
	};
}
