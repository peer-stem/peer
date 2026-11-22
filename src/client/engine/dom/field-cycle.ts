import { isInteractionScopeEligible } from "../plugins/plugin-input-focus.ts";
import type { InteractionScopeController } from "./interaction-scope.ts";

export function cycleEligibleField(
	fields: readonly HTMLElement[],
	controller?: InteractionScopeController | null,
): void {
	const list = fields.filter((el) => isInteractionScopeEligible(el, controller));
	if (list.length === 0) return;
	const active = document.activeElement;
	const idx = active ? list.findIndex((el) => el === active || el.contains(active)) : -1;
	if (idx < 0) {
		list[0]!.focus();
		return;
	}
	list[(idx + 1) % list.length]!.focus();
}

export function bindFieldCycle(
	fields: () => readonly HTMLElement[],
	controller?: InteractionScopeController | null,
): () => void {
	const onCycle = () => cycleEligibleField(fields(), controller);
	window.addEventListener("lh:kbd-cycle-fields", onCycle);
	return () => window.removeEventListener("lh:kbd-cycle-fields", onCycle);
}
