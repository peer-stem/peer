import type { PluginSurfaceTarget } from "../../../core/index.ts";
import type { InteractionScopeController } from "../dom/interaction-scope.ts";

export interface SurfaceBoundary {
	target: PluginSurfaceTarget;
	body: HTMLElement;
	stack: HTMLElement | null;
	signal: AbortSignal;
	controller: InteractionScopeController;
	remembered: WeakMap<HTMLElement, HTMLElement>;
}

const boundaries = new WeakMap<PluginSurfaceTarget, SurfaceBoundary>();
const currentPages = new WeakMap<Document, SurfaceBoundary>();

export function registerSurfaceBoundary(
	body: HTMLElement,
	signal: AbortSignal,
	controller: InteractionScopeController,
): SurfaceBoundary {
	const target = Object.freeze({}) as PluginSurfaceTarget;
	const HtmlElement = body.ownerDocument.defaultView?.HTMLElement;
	const stack = Array.from(body.children).find((child): child is HTMLElement =>
		Boolean(HtmlElement) &&
		child instanceof HtmlElement! &&
		child.isConnected &&
		child.hasAttribute("data-session-surface-region") &&
		Array.from(child.children).some((mount) => mount instanceof HtmlElement! && mount.hasAttribute("data-session-surface-mounts")),
	);
	const boundary: SurfaceBoundary = {
		target,
		body,
		stack: stack ?? null,
		signal,
		controller,
		remembered: new WeakMap(),
	};
	if (signal.aborted) return boundary;
	boundaries.set(target, boundary);
	currentPages.set(body.ownerDocument, boundary);
	signal.addEventListener("abort", () => {
		boundaries.delete(target);
		if (currentPages.get(body.ownerDocument) === boundary) currentPages.delete(body.ownerDocument);
	}, { once: true });
	return boundary;
}

export function findSurfaceBoundary(target: PluginSurfaceTarget | undefined): SurfaceBoundary | undefined {
	if (!target) return;
	const boundary = boundaries.get(target);
	return boundary && !boundary.signal.aborted && boundary.body.isConnected ? boundary : undefined;
}

export function findCurrentSurfaceBoundary(document: Document): SurfaceBoundary | undefined {
	return findSurfaceBoundary(currentPages.get(document)?.target);
}

export function requireSurfaceBoundary(target: PluginSurfaceTarget | undefined): SurfaceBoundary {
	const boundary = findSurfaceBoundary(target);
	if (!boundary?.stack?.isConnected) throw new Error("Surface target is no longer active");
	return boundary;
}
