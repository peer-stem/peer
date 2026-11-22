import type { InteractionScopeController } from "./interaction-scope.ts";

export function bindOutsidePointerDismiss(options: {
	getRoot: () => HTMLElement | null;
	getPanel: () => HTMLElement | null;
	controller: Pick<InteractionScopeController, "isElementEligible">;
	onOutside: () => void;
}): () => void {
	const onPointerDown = (e: PointerEvent) => {
		if (!options.controller.isElementEligible(options.getPanel())) return;
		const root = options.getRoot();
		if (root && !root.contains(e.target as Node)) options.onOutside();
	};
	document.addEventListener("pointerdown", onPointerDown);
	return () => document.removeEventListener("pointerdown", onPointerDown);
}
