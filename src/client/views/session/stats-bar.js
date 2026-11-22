/**
 * Session stats bar (`[data-peer-stats-bar]`), per-session model + thinking
 * picker (`[data-peer-model-picker]`), and top-bar inline rename controller.
 */
import { FIELD_CLASS, button, createLife, documentOf, el, input, textNode, writeText } from "cloudcanvas-lib/ui";
import {
	defaultThinkingLevel,
	formatTokens,
	formatUsd,
	shortModelName,
	thinkingLevelLabel,
} from "peer-engine";

const FALLBACK_THINKING_LEVELS = ["off", "low", "medium", "high"];

function formatShortModel(raw) {
	const str = String(raw ?? "").trim();
	if (!str) return "Default model";
	return shortModelName(str) || str;
}

function formatThinkingText(level) {
	return thinkingLevelLabel(String(level ?? "off"));
}

function resolveDefaultThinking(supported) {
	const list = Array.isArray(supported) && supported.length > 0 ? supported : FALLBACK_THINKING_LEVELS;
	return defaultThinkingLevel(list);
}

function deriveCostDisplay(pricing) {
	if (!pricing || typeof pricing !== "object") return "—";
	const providers = Array.isArray(pricing.subscriptionProviders) ? pricing.subscriptionProviders : [];
	const rawCost = pricing.cost ?? pricing.totalCost;
	const cost = typeof rawCost === "number" && Number.isFinite(rawCost) ? rawCost : null;
	const turnCosts = pricing.turnCosts && typeof pricing.turnCosts === "object" ? Object.values(pricing.turnCosts) : [];
	const hasPricedTurn = turnCosts.some((v) => typeof v === "number" && Number.isFinite(v));
	const parts = [];
	if (cost !== null && (cost > 0 || hasPricedTurn)) parts.push(formatUsd(cost));
	for (const label of providers) {
		if (label && !parts.includes(label)) parts.push(String(label));
	}
	return parts.length > 0 ? parts.join(" + ") : "—";
}

function deriveTokensDisplay(contextTokens, contextWindow) {
	if (typeof contextTokens !== "number" || !Number.isFinite(contextTokens)) return "— tokens";
	const used = formatTokens(contextTokens);
	if (typeof contextWindow === "number" && contextWindow > 0) {
		return `${used} / ${formatTokens(contextWindow)} tokens`;
	}
	return `${used} tokens`;
}

function resolveActiveCoords(model) {
	const chatModel = model?.chatSettings?.model;
	if (chatModel?.provider && chatModel?.id) {
		return {
			provider: String(chatModel.provider),
			id: String(chatModel.id),
			thinkingLevel: model?.chatSettings?.thinkingLevel ?? model?.effectiveModel?.thinkingLevel,
		};
	}
	const eff = model?.effectiveModel;
	if (eff?.provider && eff?.id) {
		return {
			provider: String(eff.provider),
			id: String(eff.id),
			thinkingLevel: model?.chatSettings?.thinkingLevel ?? eff.thinkingLevel,
		};
	}
	return null;
}

function buildModelCatalogList(availableModels, active) {
	const raw = Array.isArray(availableModels) ? availableModels : [];
	const list = raw
		.filter((entry) => entry && entry.provider && entry.id)
		.map((entry) => ({
			key: `${entry.provider}:${entry.id}`,
			provider: String(entry.provider),
			id: String(entry.id),
			label: `${formatShortModel(entry.name || entry.id)} · ${entry.provider}`,
			supportedThinkingLevels: Array.isArray(entry.supportedThinkingLevels) ? entry.supportedThinkingLevels : null,
			contextWindow: typeof entry.contextWindow === "number" ? entry.contextWindow : null,
		}));
	if (active && !list.some((item) => item.provider === active.provider && item.id === active.id)) {
		list.unshift({
			key: `${active.provider}:${active.id}`,
			provider: active.provider,
			id: active.id,
			label: `${formatShortModel(active.id)} · ${active.provider}`,
			supportedThinkingLevels: null,
			contextWindow: null,
		});
	}
	return list;
}

function syncSelectOptions(doc, selectEl, options, prevSig, value) {
	const sig = JSON.stringify(options);
	if (sig !== prevSig) {
		const nodes = options.map((opt) => {
			const node = el(doc, "option", { text: opt.label });
			node.value = opt.value;
			return node;
		});
		selectEl.replaceChildren(...nodes);
	}
	if (options.some((opt) => opt.value === value)) selectEl.value = value;
	return sig;
}

function buildStatsBarNodes(doc) {
	const root = el(doc, "div", { className: "peer-stats-bar", attrs: { "data-peer-stats-bar": "" } });
	const summary = el(doc, "div", { className: "peer-stats-summary" });
	const tokensEl = el(doc, "span", { className: "peer-stats-tokens", attrs: { "data-peer-stats-tokens": "" } });
	const dotEl = el(doc, "span", { className: "peer-stats-sep", text: "·", attrs: { "aria-hidden": "true" } });
	const costEl = el(doc, "span", { className: "peer-stats-cost", attrs: { "data-peer-stats-cost": "" } });
	const tokensText = textNode(doc, tokensEl, "— tokens");
	const costText = textNode(doc, costEl, "—");
	summary.append(tokensEl, dotEl, costEl);

	const picker = el(doc, "div", { className: "peer-model-picker", attrs: { "data-peer-model-picker": "" } });
	const modelSelect = el(doc, "select", {
		className: `${FIELD_CLASS} peer-model-select`,
		attrs: { "data-peer-model-select": "", "aria-label": "Session model" },
	});
	const thinkingSelect = el(doc, "select", {
		className: `${FIELD_CLASS} peer-thinking-select`,
		attrs: { "data-peer-thinking-select": "", "aria-label": "Thinking level" },
	});
	picker.append(modelSelect, thinkingSelect);
	root.append(summary, picker);
	return { root, tokensText, costText, modelSelect, thinkingSelect };
}

function applyStatsBarUpdate(doc, nodes, state, model) {
	state.active = resolveActiveCoords(model);
	state.catalog = buildModelCatalogList(model.availableModels, state.active);
	const matched = state.active
		? state.catalog.find((item) => item.provider === state.active.provider && item.id === state.active.id)
		: state.catalog[0] ?? null;

	writeText(nodes.tokensText, deriveTokensDisplay(model.contextTokens, matched?.contextWindow ?? null));
	writeText(nodes.costText, deriveCostDisplay(model.pricing));

	const modelOpts = state.catalog.length > 0
		? state.catalog.map((item) => ({ value: item.key, label: item.label }))
		: [{ value: "", label: "No models configured" }];
	const selectedKey = matched?.key ?? modelOpts[0].value;
	state.modelSig = syncSelectOptions(doc, nodes.modelSelect, modelOpts, state.modelSig, selectedKey);
	nodes.modelSelect.disabled = state.catalog.length === 0;

	const baseLevels = matched?.supportedThinkingLevels?.length
		? [...matched.supportedThinkingLevels]
		: [...FALLBACK_THINKING_LEVELS];
	const currentThinking = state.active?.thinkingLevel ?? resolveDefaultThinking(baseLevels);
	if (currentThinking && !baseLevels.includes(currentThinking)) baseLevels.push(currentThinking);
	state.levels = baseLevels;
	const thinkOpts = baseLevels.map((lvl) => ({ value: lvl, label: formatThinkingText(lvl) }));
	state.thinkSig = syncSelectOptions(doc, nodes.thinkingSelect, thinkOpts, state.thinkSig, currentThinking);
	nodes.thinkingSelect.disabled = state.catalog.length === 0;
}

export function createStatsBar(host, { onSaveChatSettings } = {}) {
	const doc = documentOf(host);
	const life = createLife();
	const nodes = buildStatsBarNodes(doc);
	host.append(nodes.root);
	const state = { catalog: [], active: null, levels: FALLBACK_THINKING_LEVELS, modelSig: "", thinkSig: "" };

	life.on(nodes.modelSelect, "change", () => {
		const entry = state.catalog.find((item) => item.key === nodes.modelSelect.value);
		if (!entry) return;
		const thinkingLevel = state.active?.thinkingLevel ?? resolveDefaultThinking(entry.supportedThinkingLevels);
		onSaveChatSettings?.({
			model: { provider: entry.provider, id: entry.id },
			...(thinkingLevel ? { thinkingLevel } : {}),
		});
	});

	life.on(nodes.thinkingSelect, "change", () => {
		const nextLevel = nodes.thinkingSelect.value;
		if (!nextLevel) return;
		const modelCoords = state.active ? { provider: state.active.provider, id: state.active.id } : undefined;
		onSaveChatSettings?.({ ...(modelCoords ? { model: modelCoords } : {}), thinkingLevel: nextLevel });
	});

	const cycleThinking = () => {
		if (life.dead || state.levels.length === 0) return false;
		const idx = state.levels.indexOf(nodes.thinkingSelect.value);
		const nextLevel = state.levels[(idx + 1) % state.levels.length];
		const modelCoords = state.active ? { provider: state.active.provider, id: state.active.id } : undefined;
		onSaveChatSettings?.({ ...(modelCoords ? { model: modelCoords } : {}), thinkingLevel: nextLevel });
		return true;
	};

	const focusModelPicker = () => {
		if (life.dead || nodes.modelSelect.disabled) return false;
		nodes.modelSelect.focus();
		return true;
	};

	return {
		update: (model = {}) => {
			if (!life.dead) applyStatsBarUpdate(doc, nodes, state, model);
		},
		cycleThinking,
		focusModelPicker,
		destroy: () => {
			if (life.destroy()) nodes.root.remove();
		},
	};
}

function buildRenameNodes(doc, life) {
	const wrap = el(doc, "div", { className: "peer-session-rename-bar" });
	const triggerBtn = button(doc, {
		className: "peer-session-rename-trigger",
		label: "Rename",
		ariaLabel: "Rename session",
		signal: life.signal,
		attrs: { "data-peer-action": "rename-session" },
	});
	const form = el(doc, "form", {
		className: "peer-session-rename-form",
		attrs: { "data-peer-rename-form": "", hidden: true },
	});
	const titleInput = input(doc, {
		type: "text",
		label: "Session title",
		className: "peer-session-rename-input",
		attrs: { "data-peer-rename-input": "" },
	});
	const saveBtn = button(doc, {
		className: "peer-session-rename-save is-primary",
		label: "Save",
		signal: life.signal,
		attrs: { "data-peer-action": "save-rename" },
	});
	const cancelBtn = button(doc, {
		className: "peer-session-rename-cancel",
		label: "Cancel",
		signal: life.signal,
		attrs: { "data-peer-action": "cancel-rename" },
	});
	form.append(titleInput, saveBtn, cancelBtn);
	wrap.append(triggerBtn, form);
	return { wrap, triggerBtn, form, titleInput, saveBtn, cancelBtn };
}

function bindRenameListeners(life, nodes, openEditor, closeEditor, commitRename) {
	life.on(nodes.triggerBtn, "click", () => openEditor());
	life.on(nodes.saveBtn, "click", () => commitRename());
	life.on(nodes.cancelBtn, "click", () => closeEditor());
	life.on(nodes.form, "submit", (event) => {
		event.preventDefault();
		commitRename();
	});
	life.on(nodes.titleInput, "keydown", (event) => {
		if (event.key !== "Escape") return;
		event.preventDefault();
		event.stopPropagation();
		closeEditor();
	});
}

export function createHeaderRename(host, { onRename } = {}) {
	const doc = documentOf(host);
	const life = createLife();
	const nodes = buildRenameNodes(doc, life);
	host.append(nodes.wrap);

	let currentTitle = "";
	const closeEditor = () => { nodes.form.hidden = true; nodes.triggerBtn.hidden = false; };
	const openEditor = () => {
		if (life.dead) return false;
		nodes.titleInput.value = currentTitle;
		nodes.triggerBtn.hidden = true;
		nodes.form.hidden = false;
		nodes.titleInput.focus();
		nodes.titleInput.select?.();
		return true;
	};
	const commitRename = () => {
		const trimmed = nodes.titleInput.value.trim();
		closeEditor();
		if (trimmed && trimmed !== currentTitle) onRename?.(trimmed);
	};
	bindRenameListeners(life, nodes, openEditor, closeEditor, commitRename);

	const update = ({ title = "", ready = true } = {}) => {
		if (life.dead) return;
		currentTitle = String(title ?? "");
		nodes.wrap.hidden = !ready;
		if (!ready) closeEditor();
	};
	return {
		update,
		open: openEditor,
		destroy: () => { if (life.destroy()) nodes.wrap.remove(); },
	};
}
