/**
 * `PluginUi` overlays: `openMenu`, `openDialog`, and `openSurface` (`src/core/plugin-ui.ts`).
 */
import { button, el } from "cloudcanvas-lib/ui";
import { findCurrentSurfaceBoundary, requireSurfaceBoundary } from "peer-engine";
import { injectPluginStyles } from "./plugin.css.js";
import { createInertHandle, invokePluginCallback, mountPluginContent } from "./plugin-widgets-basic.js";

function validateMenuItems(items) {
	if (!Array.isArray(items)) throw new Error("Menu items must be an array");
	const seen = new Set();
	for (const item of items) {
		if (!item || typeof item.key !== "string" || !item.key.trim()) throw new Error("Menu item key must be nonempty");
		if (seen.has(item.key)) throw new Error(`Duplicate menu item key: ${item.key}`);
		seen.add(item.key);
		if (typeof item.label !== "string" || !item.label.trim()) throw new Error("Menu item label must be nonempty");
		if (typeof item.onSelect !== "function") throw new Error("Menu item onSelect must be a function");
	}
}

function buildMenuButtons(doc, items, onSelect) {
	return items.map((item) => {
		const b = el(doc, "button", {
			className: "peer-plugin-menu-item", text: item.label,
			attrs: { type: "button", role: "menuitem", "data-menu-item": item.key },
		});
		b.disabled = Boolean(item.disabled);
		b.addEventListener("click", () => { if (!b.disabled) onSelect(item); });
		return b;
	});
}

export function openPluginMenu(doc, layerHost, ownerMenus, anchor, initialProps, signal, onError) {
	validateMenuItems(initialProps?.items);
	if (!anchor?.isConnected || signal?.aborted) return createInertHandle();
	const existing = ownerMenus.get(anchor);
	if (existing) { existing.userClose(); return createInertHandle(); }
	injectPluginStyles(doc);
	let current = { ...initialProps };
	let disposed = false;
	const menu = el(doc, "div", {
		className: "peer-plugin-menu",
		attrs: { role: "menu", "data-lh-menu": "", "data-testid": "plugin-ui-menu", ...(current.label ? { "aria-label": current.label } : {}) },
	});
	const rect = anchor.getBoundingClientRect?.() ?? { left: 16, bottom: 32, top: 16 };
	menu.style.left = `${Math.max(8, rect.left)}px`;
	menu.style.top = current.preferredSide === "up" ? `${Math.max(8, rect.top - 8)}px` : `${Math.max(8, rect.bottom + 4)}px`;

	const cleanup = (notifyClose) => {
		if (disposed) return;
		disposed = true;
		ownerMenus.delete(anchor);
		doc.removeEventListener("pointerdown", onDocPointer, true);
		doc.defaultView?.removeEventListener?.("keydown", onKeyDown, true);
		menu.remove();
		if (notifyClose && current.onClose) invokePluginCallback(current.onClose, undefined, onError);
	};
	const onDocPointer = (ev) => { if (!menu.contains(ev.target) && !anchor.contains(ev.target)) cleanup(true); };
	const onKeyDown = (ev) => { if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); cleanup(true); } };
	const paint = () => menu.replaceChildren(...buildMenuButtons(doc, current.items, (item) => {
		cleanup(false);
		invokePluginCallback(item.onSelect, undefined, onError);
	}));

	paint();
	(layerHost ?? doc.body).append(menu);
	doc.addEventListener("pointerdown", onDocPointer, true);
	doc.defaultView?.addEventListener?.("keydown", onKeyDown, true);
	ownerMenus.set(anchor, { userClose: () => cleanup(true) });
	signal?.addEventListener("abort", () => cleanup(false), { once: true });
	return {
		update(patch) {
			if (disposed) return;
			const merged = { ...current, ...patch };
			validateMenuItems(merged.items);
			current = merged;
			paint();
		},
		dispose: () => cleanup(false),
	};
}

function validateOverlayProps(props, kind) {
	if (!props || typeof props.title !== "string" || !props.title.trim()) throw new Error(`Plugin ${kind} requires a nonempty accessible title`);
	if (props.content === undefined || props.content === null) throw new Error(`Plugin ${kind} requires content`);
}

export function openPluginDialog(doc, layerHost, initialProps, signal, onError) {
	validateOverlayProps(initialProps, "dialog");
	if (signal?.aborted) return createInertHandle();
	injectPluginStyles(doc);
	let current = { ...initialProps };
	let disposed = false;
	const backdrop = el(doc, "div", { className: "peer-shell-backdrop", attrs: { "data-testid": "plugin-ui-dialog" } });
	const modal = el(doc, "section", {
		className: "peer-shell-modal",
		attrs: { role: "dialog", "aria-modal": "true", "aria-label": current.title, tabindex: "-1" },
	});
	const contentHost = el(doc, "div");
	modal.append(contentHost);
	backdrop.append(modal);
	let lease = mountPluginContent(doc, contentHost, current.content, signal, onError);

	const cleanup = (notifyClose) => {
		if (disposed) return;
		disposed = true;
		doc.defaultView?.removeEventListener?.("keydown", onKey, true);
		lease?.dispose();
		backdrop.remove();
		if (notifyClose && current.onClose) invokePluginCallback(current.onClose, undefined, onError);
	};
	const onKey = (ev) => { if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); cleanup(true); } };
	backdrop.addEventListener("click", (ev) => { if (ev.target === backdrop) cleanup(true); });
	doc.defaultView?.addEventListener?.("keydown", onKey, true);
	(layerHost ?? doc.body).append(backdrop);
	modal.focus();
	signal?.addEventListener("abort", () => cleanup(false), { once: true });

	return {
		update(patch) {
			if (disposed) return;
			const merged = { ...current, ...patch };
			validateOverlayProps(merged, "dialog");
			const contentChanged = "content" in patch && patch.content !== current.content;
			current = merged;
			modal.setAttribute("aria-label", current.title);
			if (contentChanged) { lease?.dispose(); lease = mountPluginContent(doc, contentHost, current.content, signal, onError); }
		},
		dispose: () => cleanup(false),
	};
}

function buildSurfaceNodes(doc, current, onUserClose) {
	const surface = el(doc, "section", {
		className: "peer-plugin-surface",
		attrs: { role: "region", "aria-label": current.title, "data-testid": "plugin-surface", "data-background": current.background ?? "dimmed" },
	});
	const topRow = el(doc, "div", { className: "peer-dock-head" });
	topRow.append(el(doc, "span"), button(doc, { label: "Close", ariaLabel: `Close ${current.title}`, onClick: onUserClose, attrs: { "data-testid": "plugin-surface-close" } }));
	const body = el(doc, "div", { className: "peer-plugin-view-body" });
	surface.append(topRow, body);
	return { surface, body };
}

export function openPluginSurface(doc, targetOrProps, maybeProps, maybeOptions, pluginSignal, onError) {
	const hasExplicitTarget = maybeOptions !== undefined;
	const props = hasExplicitTarget ? maybeProps : targetOrProps;
	const options = hasExplicitTarget ? maybeOptions : maybeProps;
	validateOverlayProps(props, "surface");
	const callerSignal = options?.signal;
	if (callerSignal?.aborted || pluginSignal?.aborted) return createInertHandle();

	const boundary = hasExplicitTarget ? requireSurfaceBoundary(targetOrProps) : findCurrentSurfaceBoundary(doc);
	if (!boundary?.stack?.isConnected) throw new Error("Surface target is no longer active");
	const mountsHost = boundary.stack.querySelector("[data-session-surface-mounts]") ?? boundary.stack;

	injectPluginStyles(doc);
	let current = { ...props };
	let disposed = false;
	let lease = null;
	const cleanup = (notifyClose) => {
		if (disposed) return;
		disposed = true;
		lease?.dispose();
		nodes.surface.remove();
		if (notifyClose && current.onClose) invokePluginCallback(current.onClose, undefined, onError);
	};
	const nodes = buildSurfaceNodes(doc, current, () => cleanup(true));
	const combined = AbortSignal.any([callerSignal, pluginSignal, boundary.signal].filter(Boolean));
	lease = mountPluginContent(doc, nodes.body, current.content, combined, onError);
	mountsHost.append(nodes.surface);
	combined.addEventListener("abort", () => cleanup(false), { once: true });

	return {
		update(patch) {
			if (disposed) return;
			const merged = { ...current, ...patch };
			validateOverlayProps(merged, "surface");
			const contentChanged = "content" in patch && patch.content !== current.content;
			current = merged;
			nodes.surface.setAttribute("aria-label", current.title);
			nodes.surface.setAttribute("data-background", current.background ?? "dimmed");
			if (contentChanged) { lease?.dispose(); lease = mountPluginContent(doc, nodes.body, current.content, combined, onError); }
		},
		dispose: () => cleanup(false),
	};
}
