import { isInteractionElementVisible, type InteractionScopeController } from "../dom/interaction-scope.ts";

const FOREGROUND_ROOTS = [
	"[data-lh-menu]",
	"[data-radix-popper-content-wrapper]",
	'[role="menu"]',
	'[role="dialog"]',
	'[data-testid="cheat-sheet"]',
	'[data-testid="chain-table-overlay"]',
	'[data-testid="mermaid-overlay"]',
	'[data-testid="plan-popup"]',
].join(", ");

/** Legacy standalone fixtures have no provider. Never create a second store. */
export function hasLegacyInteractionForeground(doc: Document, scope?: HTMLElement | null): boolean {
	return Array.from(doc.querySelectorAll<HTMLElement>(FOREGROUND_ROOTS)).some((element) => {
		if (element.contains(scope ?? null) || element.getAttribute("data-state") === "closed") return false;
		if (!isInteractionElementVisible(element)) return false;
		const style = doc.defaultView?.getComputedStyle?.(element) ?? element.style;
		return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
	});
}

/** Strict command scope: covered/hidden fields never receive Find, Enter or Tab. */
export function isInteractionScopeEligible(
	scope: HTMLElement | null,
	controller?: InteractionScopeController | null,
): boolean {
	if (!isInteractionElementVisible(scope)) return false;
	if (!controller) return !hasLegacyInteractionForeground(scope.ownerDocument, scope);
	if (!controller.isElementEligible(scope)) return false;
	const foreground = controller.getTopLayer();
	if (foreground?.kind === "view") {
		const owner = controller.ownerOf(scope);
		if (!owner || !controller.belongsTo(owner.id, foreground.id)) return false;
	}
	return true;
}

/** ONLY model/thinking commands may address their own popup's origin. */
export function isInputShortcutScopeEligible(
	scope: HTMLElement | null,
	controller?: InteractionScopeController | null,
): boolean {
	return isInteractionScopeEligible(scope, controller) || Boolean(controller?.isPopupOrigin(scope));
}

export type PluginInputShortcut = "toggle-dictation" | "open-model-picker" | "cycle-thinking";
export type PluginInputFocusHandlers = {
	toggleDictation?: () => void;
	cycleModel?: () => void;
	cycleThinking?: () => void;
};

const claims = new Map<HTMLElement, PluginInputFocusHandlers>();

export function claimPluginInputFocus(root: HTMLElement, handlers: PluginInputFocusHandlers): () => void {
	claims.set(root, handlers);
	return () => {
		if (claims.get(root) === handlers) claims.delete(root);
	};
}

function dispatchPopupOriginShortcut(
	key: keyof PluginInputFocusHandlers,
	controller: InteractionScopeController,
): boolean {
	const origins = [...claims.keys()].filter((root) => controller.isPopupOrigin(root));
	origins.sort((a, b) => (a.contains(b) ? 1 : b.contains(a) ? -1 : 0));
	for (const root of origins) {
		const handler = claims.get(root)?.[key];
		if (handler) {
			handler();
			return true;
		}
	}
	return false;
}

export function dispatchFocusedPluginShortcut(
	action: string,
	controller?: InteractionScopeController | null,
): boolean {
	const keys: Partial<Record<string, keyof PluginInputFocusHandlers>> = {
		"toggle-dictation": "toggleDictation",
		"open-model-picker": "cycleModel",
		"cycle-thinking": "cycleThinking",
	};
	const key = Object.hasOwn(keys, action) ? keys[action] : undefined;
	if (!key || typeof document === "undefined") return false;
	const focused = document.activeElement;
	if (!focused) return false;
	const popupOriginAction = action === "open-model-picker" || action === "cycle-thinking";
	const eligible = (root: HTMLElement) =>
		popupOriginAction ? isInputShortcutScopeEligible(root, controller) : isInteractionScopeEligible(root, controller);
	for (let node: Element | null = focused; node; node = node.parentElement) {
		const root = node as HTMLElement;
		const handler = claims.get(root)?.[key];
		if (handler && eligible(root)) {
			handler();
			return true;
		}
	}
	return popupOriginAction && controller ? dispatchPopupOriginShortcut(key, controller) : false;
}
