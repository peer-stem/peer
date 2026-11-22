import { isTypingSurface } from "../../../core/index.ts";
import { isInteractionScopeEligible } from "../plugins/plugin-input-focus.ts";
import { composingQuestionKey, pluginQuestionKeySuppressed } from "../plugins/plugin-question-keys.ts";
import type { InteractionScopeController } from "./interaction-scope.ts";

const OVERLAY_ROOTS = '[data-lh-menu], [data-radix-popper-content-wrapper], [role="menu"], [role="dialog"]';

/** Pure decision: does a focused BUTTON keep native Enter (true) or yield to submit (false)? */
export function buttonKeepsNativeEnter(el: HTMLElement): boolean {
	try {
		if (el.matches(":focus-visible")) return true;
	} catch {
		// unsupported pseudo — treat as pointer focus
	}
	return Boolean(el.closest(OVERLAY_ROOTS));
}

export function bindEnterSubmits(options: {
	submit: () => void;
	getScope: () => HTMLElement | null;
	controller?: InteractionScopeController | null;
}): () => void {
	const onKey = (e: KeyboardEvent) => {
		if (e.key !== "Enter" || e.defaultPrevented || pluginQuestionKeySuppressed(e) || composingQuestionKey(e)) return;
		if (!isInteractionScopeEligible(options.getScope(), options.controller)) return;
		if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
		if (isTypingSurface(e)) return;
		const target = e.target as HTMLElement | null;
		if (target?.tagName === "BUTTON" && buttonKeepsNativeEnter(target)) return;
		e.preventDefault();
		options.submit();
	};
	window.addEventListener("keydown", onKey);
	return () => window.removeEventListener("keydown", onKey);
}
