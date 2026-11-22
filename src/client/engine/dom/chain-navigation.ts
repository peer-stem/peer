import { isInteractionScopeEligible } from "../plugins/plugin-input-focus.ts";
import type { InteractionScopeController } from "./interaction-scope.ts";
import { navigateTreeRows as navigateChainRows, type TreeNavigationRow } from "./tree-navigation.ts";

export { navigateChainRows };
export type { TreeNavigationRow as ChainNavigationRow };

export function chainRow(parts: string[], depth: number, expanded?: boolean) {
	return {
		"data-chain-nav-row": JSON.stringify(parts),
		"data-chain-nav-depth": depth,
		"data-chain-nav-expanded": expanded,
		tabIndex: -1,
	};
}

export interface ChainDomRow extends TreeNavigationRow {
	element: HTMLElement;
}

export function readChainDomRows(root: HTMLElement | null): ChainDomRow[] {
	return [...(root?.querySelectorAll<HTMLElement>("[data-chain-nav-row]") ?? [])].map((element) => ({
		element,
		key: element.dataset.chainNavRow!,
		depth: Number(element.dataset.chainNavDepth),
		expanded: element.dataset.chainNavExpanded === undefined ? undefined : element.dataset.chainNavExpanded === "true",
	}));
}

export function highlightChainDomRow(
	root: HTMLElement | null,
	key: string | null,
	focus = false,
	controller?: InteractionScopeController | null,
): string | null {
	root?.querySelectorAll<HTMLElement>("[data-chain-nav-active]").forEach((row) => row.removeAttribute("data-chain-nav-active"));
	const row = readChainDomRows(root).find((r) => r.key === key)?.element;
	if (row) {
		row.dataset.chainNavActive = "true";
		if (focus && isInteractionScopeEligible(row, controller)) {
			row.focus({ preventScroll: true });
			row.scrollIntoView({ block: "nearest", inline: "nearest" });
		}
	}
	return row ? key : null;
}

export function handleChainPointerDown(
	event: PointerEvent,
	root: HTMLElement | null,
	onHighlight: (key: string | null) => void,
	onClearPending: () => void,
): void {
	const row = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-chain-nav-row]") : null;
	if (row) {
		onHighlight(row.dataset.chainNavRow!);
		return;
	}
	if (event.target instanceof Element && event.target.closest('[data-testid="source-root-drop"]')) {
		event.preventDefault();
		onClearPending();
		onHighlight(null);
		const focused = document.activeElement;
		if (focused && root?.contains(focused) && "blur" in focused) (focused as HTMLElement).blur();
	}
}

export function handleChainKeyDown(options: {
	event: KeyboardEvent;
	root: HTMLElement | null;
	searchInput: HTMLInputElement | null;
	activeKey: string | null;
	controller?: InteractionScopeController | null;
	onHighlight: (key: string | null, focus: boolean) => void;
	onPendingEnter: (key: string | null) => void;
}): void {
	const { event, root, searchInput, activeKey, controller } = options;
	if (event.defaultPrevented || event.isComposing || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
	if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", " "].includes(event.key)) return;
	if (!isInteractionScopeEligible(root, controller)) return;
	const target = event.target instanceof Element ? event.target : null;
	if (target && !root?.contains(target) && target !== document.body && target !== document.documentElement) return;
	const fromSearch = target === searchInput;
	if (fromSearch ? event.key !== "ArrowDown" : target?.closest('input:not([type="checkbox"]),textarea,[contenteditable="true"]')) return;
	const rows = readChainDomRows(root);
	if (event.key === " ") {
		if (target?.closest('button,a[href],[role="button"]') && (!target.closest("[data-chain-nav-row]") || target.closest("[data-chain-statement]"))) return;
		const row = rows.find((r) => r.key === activeKey);
		const checkbox = row?.element.querySelector<HTMLInputElement>('input[type="checkbox"]');
		if (!row || !checkbox || checkbox.disabled) return;
		event.preventDefault();
		event.stopPropagation();
		checkbox.click();
		options.onHighlight(row.key, true);
		return;
	}
	const result = navigateChainRows(rows, fromSearch ? null : activeKey, event.key);
	if (!result.key) return;
	event.preventDefault();
	event.stopPropagation();
	options.onHighlight(result.key, true);
	if (result.toggle) {
		options.onPendingEnter(result.enter ? result.key : null);
		rows.find((r) => r.key === result.toggle)?.element.querySelector<HTMLButtonElement>("button[aria-expanded]")?.click();
	}
}
