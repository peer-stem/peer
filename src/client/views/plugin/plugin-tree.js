/**
 * `PluginUi.mountTree` implementation (`src/core/plugin-tree.ts`).
 * Validates props via `validatePluginTree` (`peer-engine`), flattens visible rows,
 * mounts custom `PluginTreeContent` cells with scoped cleanup, and wires arrow/space navigation.
 */
import { el } from "cloudcanvas-lib/ui";
import { flattenVisiblePluginTreeRows, navigateTreeRows, validatePluginTree } from "peer-engine";
import { injectPluginStyles } from "./plugin.css.js";
import { createInertHandle, invokePluginCallback, mountPluginContent } from "./plugin-widgets-basic.js";

function renderTreeCell(doc, host, content, signal, onError, leases) {
	if (typeof content === "string") {
		host.textContent = content;
		return;
	}
	leases.push(mountPluginContent(doc, host, content, signal, onError));
}

function buildTreeHeaderDom(doc, header, columns, signal, onError, leases) {
	if (header === undefined && columns.length === 0) return null;
	const rowEl = el(doc, "div", { className: "peer-plugin-tree-header" });
	const main = el(doc, "div", { className: "peer-plugin-tree-main" });
	if (header !== undefined) renderTreeCell(doc, main, header, signal, onError, leases);
	rowEl.append(main);
	for (const col of columns) {
		const cell = el(doc, "div", { className: "peer-plugin-tree-cell" });
		cell.style.width = col.width;
		cell.style.textAlign = col.align;
		renderTreeCell(doc, cell, col.header, signal, onError, leases);
		rowEl.append(cell);
	}
	return rowEl;
}

function buildTreeRowDom(doc, entry, columns, isActive, callbacks, signal, onError, leases) {
	const { row, depth, expanded } = entry;
	const attrs = {
		role: "treeitem", tabindex: isActive ? "0" : "-1",
		"aria-level": String(depth + 1), "data-plugin-tree-row": row.key,
		...(expanded !== undefined ? { "aria-expanded": String(expanded) } : {}),
		...(row.selection ? { "aria-checked": row.selection.indeterminate ? "mixed" : String(row.selection.checked) } : {}),
	};
	const rowEl = el(doc, "div", { className: "peer-plugin-tree-row", attrs });
	rowEl.style.paddingLeft = `${6 + depth * 16}px`;
	rowEl.addEventListener("focus", () => callbacks.onFocusRow(row.key));

	const main = el(doc, "div", { className: "peer-plugin-tree-main" });
	if (row.disclosure) {
		const disc = el(doc, "button", {
			className: "peer-plugin-btn", text: row.disclosure.expanded ? "▾" : "▸",
			attrs: { type: "button", "data-size": "xs", "data-variant": "ghost", "aria-label": row.disclosure.label },
		});
		disc.addEventListener("click", (ev) => { ev.stopPropagation(); invokePluginCallback(row.disclosure.onChange, !row.disclosure.expanded, onError); });
		main.append(disc);
	}
	if (row.selection) {
		const chk = el(doc, "input", { attrs: { type: "checkbox", "aria-label": row.selection.label } });
		chk.checked = row.selection.checked;
		chk.indeterminate = Boolean(row.selection.indeterminate);
		chk.disabled = Boolean(row.selection.disabled);
		chk.addEventListener("change", (ev) => { ev.stopPropagation(); invokePluginCallback(row.selection.onChange, chk.checked, onError); });
		main.append(chk);
	}
	const contentHost = el(doc, "div", { className: "peer-plugin-tree-main" });
	renderTreeCell(doc, contentHost, row.content, signal, onError, leases);
	main.append(contentHost);
	rowEl.append(main);

	for (const col of columns) {
		const cell = el(doc, "div", { className: "peer-plugin-tree-cell" });
		cell.style.width = col.width;
		cell.style.textAlign = col.align;
		const val = row.cells?.[col.key];
		if (val !== undefined) renderTreeCell(doc, cell, val, signal, onError, leases);
		rowEl.append(cell);
	}
	return rowEl;
}

function handleTreeKeyDown(ev, state, focusRow, onError) {
	if (ev.key === " " && state.activeKey) {
		const hit = state.visibleRows.find((r) => r.row.key === state.activeKey)?.row;
		if (hit?.selection && !hit.selection.disabled) {
			ev.preventDefault();
			invokePluginCallback(hit.selection.onChange, !hit.selection.checked, onError);
		}
		return;
	}
	if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(ev.key)) return;
	ev.preventDefault();
	const navRows = state.visibleRows.map((r) => ({ key: r.row.key, depth: r.depth, expanded: r.expanded }));
	const step = navigateTreeRows(navRows, state.activeKey, ev.key);
	if (step.toggle) {
		const hit = state.visibleRows.find((r) => r.row.key === step.toggle)?.row;
		if (hit?.disclosure) invokePluginCallback(hit.disclosure.onChange, !hit.disclosure.expanded, onError);
	}
	if (step.key) focusRow(step.key);
}

export function mountPluginTree(doc, container, initialProps, signal, onError) {
	let validated = validatePluginTree(initialProps);
	if (signal?.aborted) return createInertHandle();
	injectPluginStyles(doc);
	const state = { current: { ...initialProps }, activeKey: null, visibleRows: [], leases: [] };
	let disposed = false;
	const root = el(doc, "div", {
		className: "peer-plugin-tree",
		attrs: { role: "tree", "aria-label": validated.label, "data-testid": "plugin-ui-tree" },
	});
	const clearLeases = () => {
		for (let i = state.leases.length - 1; i >= 0; i -= 1) state.leases[i].dispose();
		state.leases = [];
	};
	const focusRow = (key) => {
		state.activeKey = key;
		for (const node of root.querySelectorAll("[data-plugin-tree-row]")) {
			const match = node.getAttribute("data-plugin-tree-row") === key;
			node.tabIndex = match ? 0 : -1;
			if (match) node.focus();
		}
	};
	const paint = () => {
		clearLeases();
		root.setAttribute("aria-label", validated.label);
		state.visibleRows = flattenVisiblePluginTreeRows(state.current.rows);
		if (!state.visibleRows.some((r) => r.row.key === state.activeKey)) state.activeKey = state.visibleRows[0]?.row.key ?? null;
		const children = [];
		const hdr = buildTreeHeaderDom(doc, state.current.header, validated.columns, signal, onError, state.leases);
		if (hdr) children.push(hdr);
		const cb = { onFocusRow: (k) => { state.activeKey = k; } };
		for (const entry of state.visibleRows) {
			children.push(buildTreeRowDom(doc, entry, validated.columns, entry.row.key === state.activeKey, cb, signal, onError, state.leases));
		}
		root.replaceChildren(...children);
	};
	root.addEventListener("keydown", (ev) => handleTreeKeyDown(ev, state, focusRow, onError));
	paint();
	container.replaceChildren(root);
	const dispose = () => { if (!disposed) { disposed = true; clearLeases(); root.remove(); } };
	signal?.addEventListener("abort", dispose, { once: true });
	return {
		update(patch) {
			if (disposed) return;
			const merged = { ...state.current, ...patch };
			validated = validatePluginTree(merged);
			state.current = merged;
			paint();
		},
		dispose,
	};
}
