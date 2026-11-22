/**
 * Editable hierarchical tree (`L-15`, `L-19`) with folder expand/collapse,
 * roving keyboard navigation (`ArrowUp/Down/Left/Right`, `Enter`, `F2`),
 * inline rename, drag-and-drop reparenting, and optional tri-state checkboxes.
 */
import { FIELD_CLASS, clamp, createLife, documentOf, el } from "cloudcanvas-lib/ui";
import { injectKitStyles } from "./styles.js";

const CLASS = "cloudcanvas-ui-editable-tree";

function flattenVisible(nodes, expandedSet, depth = 0, out = []) {
	for (const node of nodes ?? []) {
		const isFolder = node.kind === "folder" || Array.isArray(node.children);
		const open = isFolder && expandedSet.has(node.id);
		out.push({ node, depth, isFolder, open });
		if (open && Array.isArray(node.children)) flattenVisible(node.children, expandedSet, depth + 1, out);
	}
	return out;
}

function appendCheckbox(doc, rowEl, item, onCheck) {
	const box = el(doc, "input", { attrs: { type: "checkbox", tabindex: "-1", "aria-label": `Select ${item.label}` } });
	box.checked = Boolean(item.checked);
	box.indeterminate = Boolean(item.indeterminate);
	box.addEventListener("click", (e) => e.stopPropagation());
	box.addEventListener("change", () => onCheck?.(item.id, box.checked));
	rowEl.append(box);
}

function appendRenameInput(doc, rowEl, item, onCommit, onCancel) {
	const field = el(doc, "input", { className: FIELD_CLASS, attrs: { type: "text", value: item.label ?? "" } });
	field.value = item.label ?? "";
	let done = false;
	const finish = (commit) => {
		if (done) return;
		done = true;
		const next = field.value.trim();
		if (commit && next && next !== item.label) onCommit(item.id, next);
		else onCancel();
	};
	field.addEventListener("click", (e) => e.stopPropagation());
	field.addEventListener("keydown", (e) => {
		if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); finish(true); }
		else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); finish(false); }
	});
	field.addEventListener("blur", () => finish(true));
	rowEl.append(field);
	queueMicrotask(() => { field.focus(); field.select?.(); });
}

function bindDragEvents(rowEl, entry, callbacks) {
	if (!callbacks.onMove) return;
	rowEl.draggable = true;
	rowEl.addEventListener("dragstart", (e) => e.dataTransfer?.setData("text/plain", entry.node.id));
	if (!entry.isFolder) return;
	rowEl.addEventListener("dragover", (e) => { e.preventDefault(); rowEl.classList.add("is-drop-target"); });
	rowEl.addEventListener("dragleave", () => rowEl.classList.remove("is-drop-target"));
	rowEl.addEventListener("drop", (e) => {
		e.preventDefault();
		rowEl.classList.remove("is-drop-target");
		const draggedId = e.dataTransfer?.getData("text/plain");
		if (draggedId && draggedId !== entry.node.id) callbacks.onMove(draggedId, entry.node.id);
	});
}

function buildTreeRowElement(doc, entry, idx, state, callbacks, render) {
	const { node, depth, isFolder, open } = entry;
	const selected = node.id === state.selectedId;
	const attrs = {
		role: "treeitem",
		"data-tree-id": node.id,
		"aria-level": String(depth + 1),
		"aria-selected": selected ? "true" : "false",
		...(isFolder ? { "aria-expanded": open ? "true" : "false" } : {}),
	};
	const rowEl = el(doc, "div", { className: `${CLASS}-row${selected ? " is-selected" : ""}`, attrs });
	rowEl.style.paddingLeft = `${8 + depth * 16}px`;
	if (isFolder) {
		const twisty = el(doc, "span", { text: open ? "▾" : "▸", attrs: { "aria-hidden": "true" } });
		twisty.addEventListener("click", (e) => { e.stopPropagation(); callbacks.onToggle?.(node.id, !open); });
		rowEl.append(twisty);
	}
	if (state.checkable) appendCheckbox(doc, rowEl, node, callbacks.onCheck);
	if (state.renamingId === node.id) {
		const commit = (id, name) => { state.renamingId = null; callbacks.onRename?.(id, name); render(); };
		const cancel = () => { state.renamingId = null; render(); };
		appendRenameInput(doc, rowEl, node, commit, cancel);
	} else {
		rowEl.append(el(doc, "span", { className: `${CLASS}-label`, text: node.label ?? node.id }));
		if (node.badge) rowEl.append(el(doc, "span", { className: `${CLASS}-badge`, text: node.badge }));
	}
	rowEl.addEventListener("click", () => {
		state.focusIndex = idx;
		if (isFolder && !callbacks.onSelect) callbacks.onToggle?.(node.id, !open);
		else callbacks.onSelect?.(node.id, node);
	});
	rowEl.addEventListener("contextmenu", (e) => {
		if (callbacks.onContextMenu) { e.preventDefault(); callbacks.onContextMenu(node.id, e); }
	});
	bindDragEvents(rowEl, entry, callbacks);
	return rowEl;
}

function handleTreeKeydown(event, state, callbacks, render) {
	if (state.renamingId) return;
	const flat = flattenVisible(state.nodes, state.expanded);
	if (!flat.length) return;
	const current = flat[state.focusIndex];
	if (event.key === "ArrowDown" || event.key === "ArrowUp") {
		event.preventDefault();
		const delta = event.key === "ArrowDown" ? 1 : -1;
		state.focusIndex = clamp(state.focusIndex + delta, 0, flat.length - 1);
		callbacks.onSelect?.(flat[state.focusIndex].node.id, flat[state.focusIndex].node);
		render();
	} else if (event.key === "ArrowRight" && current?.isFolder && !current.open) {
		event.preventDefault();
		callbacks.onToggle?.(current.node.id, true);
	} else if (event.key === "ArrowLeft" && current?.isFolder && current.open) {
		event.preventDefault();
		callbacks.onToggle?.(current.node.id, false);
	} else if (event.key === "Enter" && current) {
		event.preventDefault();
		callbacks.onSelect?.(current.node.id, current.node);
	} else if (event.key === "F2" && current && callbacks.onRename) {
		event.preventDefault();
		state.renamingId = current.node.id;
		render();
	}
}

/**
 * @param {HTMLElement} host
 * @param {{onSelect?: (id: string, node: object) => void, onToggle?: (id: string, open: boolean) => void, onRename?: (id: string, nextName: string) => void, onMove?: (id: string, targetFolderId: string|null) => void, onCheck?: (id: string, checked: boolean) => void, onContextMenu?: (id: string, event: MouseEvent) => void}} [callbacks]
 */
export function createEditableTree(host, callbacks = {}) {
	const doc = documentOf(host);
	injectKitStyles(doc);
	const life = createLife();
	const root = el(doc, "div", { className: CLASS, attrs: { role: "tree", tabindex: "0" } });
	host.append(root);
	const state = { nodes: [], expanded: new Set(), selectedId: null, renamingId: null, checkable: false, focusIndex: 0 };

	const render = () => {
		const flat = flattenVisible(state.nodes, state.expanded);
		state.focusIndex = flat.length ? clamp(state.focusIndex, 0, flat.length - 1) : 0;
		root.replaceChildren();
		flat.forEach((entry, idx) => root.append(buildTreeRowElement(doc, entry, idx, state, callbacks, render)));
	};
	life.on(root, "keydown", (event) => handleTreeKeydown(event, state, callbacks, render));

	return {
		root,
		startRename: (id) => { state.renamingId = id; render(); },
		update(model = {}) {
			if (life.dead) return;
			state.nodes = Array.isArray(model.nodes) ? model.nodes : [];
			state.expanded = new Set(model.expandedIds ?? []);
			state.selectedId = model.selectedId ?? null;
			state.checkable = Boolean(model.checkable);
			if (model.renamingId !== undefined) state.renamingId = model.renamingId;
			if (model.ariaLabel) root.setAttribute("aria-label", String(model.ariaLabel));
			render();
		},
		destroy: () => { if (life.destroy()) root.remove(); },
	};
}
