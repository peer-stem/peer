/**
 * Grouped searchable menu/picker (`L-12`): trigger button + anchored popover
 * with live filter input, section headings, badges/details, and keyboard navigation.
 */
import { button, clamp, createLife, documentOf, el, input, textNode, uniqueId, writeText } from "cloudcanvas-lib/ui";
import { injectKitStyles } from "./styles.js";

const CLASS = "cloudcanvas-ui-search-menu";

function filterItems(items, query) {
	const q = query.trim().toLowerCase();
	if (!q) return items;
	return items.filter((item) => {
		const hay = `${item.label ?? ""} ${item.group ?? ""} ${item.detail ?? ""} ${item.keywords ?? ""}`.toLowerCase();
		return hay.includes(q);
	});
}

function positionPanel(trigger, panel, doc) {
	const win = doc.defaultView;
	if (!win || typeof trigger.getBoundingClientRect !== "function") return;
	const rect = trigger.getBoundingClientRect();
	const vw = win.innerWidth || 1024;
	const vh = win.innerHeight || 768;
	const pw = panel.offsetWidth || 260;
	const ph = panel.offsetHeight || 240;
	const left = clamp(rect.left, 8, Math.max(8, vw - pw - 8));
	const below = rect.bottom + 6;
	const top = below + ph <= vh - 8 ? below : Math.max(8, rect.top - ph - 6);
	panel.style.left = `${Math.round(left)}px`;
	panel.style.top = `${Math.round(top)}px`;
}

function createOptionButton(doc, item, active, selected, onPick) {
	const attrs = {
		type: "button",
		role: "option",
		"data-item-id": item.id,
		"aria-selected": selected ? "true" : "false",
	};
	const opt = el(doc, "button", { className: `${CLASS}-option${active ? " is-active" : ""}`, attrs });
	opt.disabled = Boolean(item.disabled);
	opt.append(el(doc, "span", { className: `${CLASS}-label`, text: item.label ?? item.id }));
	if (item.detail || item.badge) {
		opt.append(el(doc, "span", { className: `${CLASS}-detail`, text: item.badge ?? item.detail }));
	}
	opt.addEventListener("click", () => { if (!item.disabled) onPick(item); });
	return opt;
}

function renderListDom(doc, listEl, filtered, activeIndex, selectedId, onPick) {
	listEl.replaceChildren();
	if (filtered.length === 0) {
		listEl.append(el(doc, "div", { className: `${CLASS}-empty`, text: "No matches" }));
		return;
	}
	let lastGroup = null;
	filtered.forEach((item, idx) => {
		if (item.group && item.group !== lastGroup) {
			lastGroup = item.group;
			listEl.append(el(doc, "div", { className: `${CLASS}-group`, text: item.group }));
		}
		const opt = createOptionButton(doc, item, idx === activeIndex, item.id === selectedId, onPick);
		listEl.append(opt);
	});
}

function bindSearchMenuKeys(life, doc, root, panel, trigger, state, refreshList, setOpen, pick) {
	life.on(panel, "keydown", (event) => {
		const filtered = filterItems(state.items, state.query);
		if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.focus(); }
		else if (event.key === "ArrowDown" && filtered.length) {
			event.preventDefault();
			state.activeIndex = (state.activeIndex + 1) % filtered.length;
			refreshList();
		} else if (event.key === "ArrowUp" && filtered.length) {
			event.preventDefault();
			state.activeIndex = (state.activeIndex - 1 + filtered.length) % filtered.length;
			refreshList();
		} else if (event.key === "Enter" && filtered[state.activeIndex] && !filtered[state.activeIndex].disabled) {
			event.preventDefault();
			pick(filtered[state.activeIndex]);
		}
	});
	life.on(doc, "pointerdown", (event) => {
		if (!state.open) return;
		const t = event.target;
		if (!root.contains(t) && !panel.contains(t)) setOpen(false);
	}, { capture: true });
}

function applySearchMenuModel(state, nodes, refreshList, model = {}) {
	state.items = Array.isArray(model.items) ? model.items : [];
	state.selectedId = model.value ?? null;
	const current = state.items.find((it) => it.id === state.selectedId);
	writeText(nodes.triggerText, model.triggerLabel ?? current?.label ?? model.placeholder ?? "Select");
	nodes.trigger.disabled = Boolean(model.disabled);
	if (model.searchPlaceholder) nodes.search.placeholder = String(model.searchPlaceholder);
	const foot = model.footerText ? String(model.footerText) : "";
	nodes.footer.hidden = foot === "";
	writeText(nodes.footerText, foot);
	if (state.open) refreshList();
}

function buildSearchMenuDom(doc, life, state, onToggle, onQuery) {
	const root = el(doc, "div", { className: CLASS });
	const trigger = button(doc, {
		label: "Select",
		className: `${CLASS}-trigger`,
		signal: life.signal,
		attrs: { "aria-haspopup": "listbox", "aria-expanded": "false" },
		onClick: onToggle,
	});
	const panel = el(doc, "div", { className: `${CLASS}-panel`, attrs: { hidden: true } });
	const search = input(doc, {
		label: "Filter options",
		placeholder: "Search…",
		className: `${CLASS}-search`,
		signal: life.signal,
		onInput: onQuery,
	});
	const listEl = el(doc, "div", { className: `${CLASS}-list`, attrs: { id: uniqueId(`${CLASS}-list`), role: "listbox" } });
	const footer = el(doc, "div", { className: `${CLASS}-footer`, attrs: { hidden: true } });
	panel.append(search, listEl, footer);
	root.append(trigger);
	return { root, trigger, triggerText: trigger.firstChild, panel, search, listEl, footer, footerText: textNode(doc, footer, "") };
}

/**
 * @param {HTMLElement} host
 * @param {{onSelect?: (id: string, item: object) => void, onOpenChange?: (open: boolean) => void}} [callbacks]
 */
export function createSearchMenu(host, { onSelect, onOpenChange } = {}) {
	const doc = documentOf(host);
	injectKitStyles(doc);
	const life = createLife();
	const state = { open: false, items: [], selectedId: null, query: "", activeIndex: 0 };
	let setOpen = () => {};
	let refreshList = () => [];
	const nodes = buildSearchMenuDom(
		doc, life, state,
		() => setOpen(!state.open),
		(val) => { state.query = val; state.activeIndex = 0; refreshList(); },
	);
	host.append(nodes.root);

	const pick = (item) => { setOpen(false); nodes.trigger.focus(); onSelect?.(item.id, item); };
	refreshList = () => {
		const filtered = filterItems(state.items, state.query);
		state.activeIndex = filtered.length ? clamp(state.activeIndex, 0, filtered.length - 1) : 0;
		renderListDom(doc, nodes.listEl, filtered, state.activeIndex, state.selectedId, pick);
		return filtered;
	};
	setOpen = (next) => {
		if (state.open === next || life.dead) return;
		state.open = next;
		nodes.trigger.setAttribute("aria-expanded", next ? "true" : "false");
		if (next) {
			state.query = "";
			nodes.search.value = "";
			const idx = state.items.findIndex((it) => it.id === state.selectedId);
			state.activeIndex = idx >= 0 ? idx : 0;
			if (!nodes.panel.isConnected) (doc.body ?? nodes.root).append(nodes.panel);
			nodes.panel.hidden = false;
			refreshList();
			positionPanel(nodes.trigger, nodes.panel, doc);
			nodes.search.focus();
		} else nodes.panel.hidden = true;
		onOpenChange?.(next);
	};
	bindSearchMenuKeys(life, doc, nodes.root, nodes.panel, nodes.trigger, state, refreshList, setOpen, pick);

	return {
		root: nodes.root, trigger: nodes.trigger, panel: nodes.panel,
		open: () => setOpen(true),
		close: () => setOpen(false),
		update: (model = {}) => { if (!life.dead) applySearchMenuModel(state, nodes, refreshList, model); },
		destroy() { if (life.destroy()) { nodes.panel.remove(); nodes.root.remove(); } },
	};
}
