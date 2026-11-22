/**
 * `/chat/new` draft screen view (`[data-peer-screen="new-session"]`, `C2a §3.7`, `§4.2`).
 * Renders teach/practice mode switch, practice proposition picker (`[data-peer-node-picker]`)
 * with store-driven `nodeFilter` (`set-node-filter`, Finding #2 fix), model pill,
 * `@path`-aware `[data-peer-draft-input]`, optional desktop folder/file pickers,
 * `[data-peer-action="start-session"]`, and `[data-peer-setup-cta]`.
 */
import { FIELD_CLASS, button, createLife, documentOf, el, injectUiStyles, input, textNode, writeText } from "cloudcanvas-lib/ui";
import { appendPathTokenToText, extractPathTokens, removePathTokenFromText } from "../session/composer-tokens.js";
import { createTopBar } from "../shared/top-bar.js";
import {
	deriveNewSessionViewModel,
	formatDraftThinkingLabel,
	resolveDraftDefaultThinking,
} from "./new-session-models.js";
import { injectNewSessionStyles } from "./new-session.css.js";

function syncSelectNodes(doc, selectEl, options, prevSig, value) {
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

function buildToolbarNodes(doc, life, send) {
	const toolbar = el(doc, "div", { className: "peer-new-session-toolbar" });
	const modes = el(doc, "div", { className: "peer-new-session-modes", attrs: { role: "group", "aria-label": "Session mode" } });
	const teachBtn = button(doc, {
		className: "peer-new-session-mode",
		label: "Teach",
		signal: life.signal,
		onClick: () => send?.({ type: "set-mode", mode: "teach" }),
		attrs: { "data-peer-mode": "teach", "aria-pressed": "true" },
	});
	const practiceBtn = button(doc, {
		className: "peer-new-session-mode",
		label: "Practice",
		signal: life.signal,
		onClick: () => send?.({ type: "set-mode", mode: "practice" }),
		attrs: { "data-peer-mode": "practice", "aria-pressed": "false" },
	});
	modes.append(teachBtn, practiceBtn);

	const modelPill = el(doc, "div", {
		className: "peer-new-session-model-pill",
		attrs: { "data-peer-model-pill": "", "data-peer-model-picker": "" },
	});
	const modelBadge = el(doc, "span", { className: "peer-new-session-model-badge", attrs: { "data-peer-model-badge": "" } });
	const modelBadgeText = textNode(doc, modelBadge, "Default model");
	const modelSelect = el(doc, "select", {
		className: `${FIELD_CLASS} peer-new-session-model-select`,
		attrs: { "data-peer-default-model-select": "", "aria-label": "Default model" },
	});
	const thinkingSelect = el(doc, "select", {
		className: `${FIELD_CLASS} peer-new-session-thinking-select`,
		attrs: { "data-peer-default-thinking-select": "", "aria-label": "Thinking level" },
	});
	modelPill.append(modelBadge, modelSelect, thinkingSelect);
	toolbar.append(modes, modelPill);
	return { toolbar, teachBtn, practiceBtn, modelBadgeText, modelSelect, thinkingSelect };
}

function buildNodePickerNodes(doc, life, send, onFilterInput) {
	const picker = el(doc, "div", {
		className: "peer-new-session-picker",
		attrs: { "data-peer-node-picker": "", hidden: true },
	});
	const head = el(doc, "div", { className: "peer-new-session-picker-head" });
	const searchInput = input(doc, {
		type: "search",
		label: "Filter propositions",
		placeholder: "Filter propositions…",
		signal: life.signal,
		onInput: (val) => onFilterInput(val),
		attrs: { "data-peer-node-search": "" },
	});
	const clearBtn = button(doc, {
		label: "Clear picks",
		signal: life.signal,
		onClick: () => send?.({ type: "clear-picks" }),
		attrs: { "data-peer-action": "clear-picks", hidden: true },
	});
	head.append(searchInput, clearBtn);
	const emptyEl = el(doc, "div", { className: "peer-new-session-picker-empty", attrs: { hidden: true } });
	const emptyText = textNode(doc, emptyEl, "No propositions in your knowledge map yet.");
	const listEl = el(doc, "div", { className: "peer-new-session-picker-list" });
	picker.append(head, emptyEl, listEl);
	return { picker, searchInput, clearBtn, emptyEl, emptyText, listEl };
}

function buildDraftAttachGroup(doc, life, handlers) {
	const leftActions = el(doc, "div", { className: "peer-new-session-attach-group" });
	const pickFilesBtn = typeof handlers.onPickFiles === "function"
		? button(doc, { label: "Files", ariaLabel: "Attach files", signal: life.signal, onClick: () => handlers.pickFiles(), attrs: { "data-peer-action": "pick-files" } })
		: null;
	const pickDirBtn = typeof handlers.onPickDirectory === "function"
		? button(doc, { label: "Folder", ariaLabel: "Attach folder", signal: life.signal, onClick: () => handlers.pickDirectory(), attrs: { "data-peer-action": "pick-directory" } })
		: null;
	if (pickFilesBtn) leftActions.append(pickFilesBtn);
	if (pickDirBtn) leftActions.append(pickDirBtn);
	leftActions.append(el(doc, "span", { className: "peer-new-session-hint", text: "Enter to start · Shift+Enter for newline" }));
	return { leftActions, pickFilesBtn, pickDirBtn };
}

function buildComposerCardNodes(doc, life, handlers) {
	const card = el(doc, "div", { className: "peer-new-session-card" });
	const setupCta = button(doc, {
		className: "peer-new-session-setup-cta",
		label: "Configure a model provider to start a session",
		signal: life.signal,
		onClick: () => handlers.onOpenSetup(),
		attrs: { "data-peer-setup-cta": "", "data-peer-action": "open-setup", hidden: true },
	});
	const chipsRow = el(doc, "div", { className: "peer-new-session-chips", attrs: { "data-peer-path-chips": "", hidden: true } });
	const draftInput = input(doc, {
		type: "textarea",
		label: "Session prompt",
		placeholder: "What do you want to understand deeply?",
		className: "peer-new-session-draft",
		attrs: { "data-peer-draft-input": "", rows: "4" },
	});
	const errorEl = el(doc, "div", { className: "peer-new-session-error", attrs: { "data-peer-start-error": "", hidden: true } });
	const errorText = textNode(doc, errorEl, "");
	const actions = el(doc, "div", { className: "peer-new-session-actions" });
	const attach = buildDraftAttachGroup(doc, life, handlers);
	const startBtn = button(doc, {
		className: "peer-new-session-start is-primary",
		label: "Start lesson",
		signal: life.signal,
		onClick: () => handlers.onStart(),
		attrs: { "data-peer-action": "start-session" },
	});
	const startBtnText = startBtn.firstChild;
	actions.append(attach.leftActions, startBtn);
	card.append(setupCta, chipsRow, draftInput, errorEl, actions);
	return { card, setupCta, chipsRow, draftInput, errorEl, errorText, pickFilesBtn: attach.pickFilesBtn, pickDirBtn: attach.pickDirBtn, startBtn, startBtnText };
}

function renderPropositionList(doc, pickerNodes, vm, send) {
	const showPicker = vm.sessionMode === "practice" || vm.pickedNodeIds.length > 0;
	pickerNodes.picker.hidden = !showPicker;
	pickerNodes.clearBtn.hidden = vm.pickedNodeIds.length === 0;
	if (pickerNodes.searchInput.value !== vm.nodeFilter) {
		pickerNodes.searchInput.value = vm.nodeFilter;
	}
	if (!showPicker) return;
	if (vm.propositions.length === 0) {
		pickerNodes.listEl.replaceChildren();
		pickerNodes.emptyEl.hidden = false;
		const msg = vm.totalPropositions === 0
			? "No propositions in your knowledge map yet."
			: "No propositions match your filter.";
		writeText(pickerNodes.emptyText, msg);
		return;
	}
	pickerNodes.emptyEl.hidden = true;
	const rows = vm.propositions.map((prop) => {
		const btn = button(doc, {
			className: prop.picked ? "peer-new-session-prop is-picked" : "peer-new-session-prop",
			label: prop.name,
			onClick: () => send?.({ type: "toggle-pick-node", nodeId: prop.id }),
			attrs: { "data-peer-node-id": prop.id, "aria-pressed": String(prop.picked) },
		});
		if (prop.statement) {
			btn.append(el(doc, "span", { className: "peer-new-session-prop-statement", text: prop.statement }));
		}
		return btn;
	});
	pickerNodes.listEl.replaceChildren(...rows);
}

function createDraftChipNode(doc, tok, onRemoveRaw) {
	const chip = el(doc, "span", { className: "peer-new-session-chip", attrs: { "data-peer-path-chip": tok.path } });
	const rm = button(doc, {
		label: "×",
		ariaLabel: `Remove ${tok.path}`,
		onClick: () => onRemoveRaw(tok.raw),
	});
	chip.append(el(doc, "span", { text: tok.label }), rm);
	return chip;
}

function syncDraftChipsAndButton(doc, state) {
	const { composerNodes, vm } = state;
	const tokens = extractPathTokens(composerNodes.draftInput.value);
	composerNodes.chipsRow.hidden = tokens.length === 0;
	if (tokens.length === 0) {
		composerNodes.chipsRow.replaceChildren();
	} else {
		const onRemoveRaw = (raw) => {
			composerNodes.draftInput.value = removePathTokenFromText(composerNodes.draftInput.value, raw);
			syncDraftChipsAndButton(doc, state);
		};
		const chips = tokens.map((tok) => createDraftChipNode(doc, tok, onRemoveRaw));
		composerNodes.chipsRow.replaceChildren(...chips);
	}
	if (!vm) return;
	const hasText = composerNodes.draftInput.value.trim().length > 0;
	const canStart = hasText || (vm.sessionMode === "practice" && vm.pickedNodeIds.length > 0);
	composerNodes.startBtn.disabled = !vm.configured || vm.starting || !canStart;
}

function applyNewSessionVm(doc, state) {
	const vm = deriveNewSessionViewModel(state.rawModel, state.fallbackFilter);
	state.vm = vm;
	state.topBar.update(vm.topBar);
	state.toolbarNodes.teachBtn.classList.toggle("is-active", vm.sessionMode === "teach");
	state.toolbarNodes.teachBtn.setAttribute("aria-pressed", String(vm.sessionMode === "teach"));
	state.toolbarNodes.practiceBtn.classList.toggle("is-active", vm.sessionMode === "practice");
	state.toolbarNodes.practiceBtn.setAttribute("aria-pressed", String(vm.sessionMode === "practice"));
	writeText(state.toolbarNodes.modelBadgeText, vm.modelPillLabel);

	const modelOpts = vm.catalog.length > 0
		? vm.catalog.map((item) => ({ value: item.key, label: item.label }))
		: [{ value: "", label: "No models configured" }];
	state.modelSig = syncSelectNodes(doc, state.toolbarNodes.modelSelect, modelOpts, state.modelSig, vm.activeModelKey);
	state.toolbarNodes.modelSelect.disabled = vm.catalog.length === 0;

	const thinkOpts = vm.thinkingLevels.map((lvl) => ({ value: lvl, label: formatDraftThinkingLabel(lvl) }));
	state.thinkSig = syncSelectNodes(doc, state.toolbarNodes.thinkingSelect, thinkOpts, state.thinkSig, vm.thinkingLevel);
	state.toolbarNodes.thinkingSelect.disabled = vm.catalog.length === 0;

	renderPropositionList(doc, state.pickerNodes, vm, state.send);
	const disabled = !vm.configured || vm.starting;
	state.composerNodes.setupCta.hidden = vm.configured;
	state.composerNodes.draftInput.disabled = disabled;
	if (state.composerNodes.pickFilesBtn) state.composerNodes.pickFilesBtn.disabled = disabled;
	if (state.composerNodes.pickDirBtn) state.composerNodes.pickDirBtn.disabled = disabled;
	state.composerNodes.draftInput.placeholder = vm.placeholder;
	writeText(state.composerNodes.startBtnText, vm.startLabel);
	writeText(state.composerNodes.errorText, vm.error);
	state.composerNodes.errorEl.hidden = vm.error === "";
	syncDraftChipsAndButton(doc, state);
}

function bindNewSessionEvents(doc, life, state, submitStart) {
	const { toolbarNodes, composerNodes, send } = state;
	life.on(composerNodes.draftInput, "input", () => syncDraftChipsAndButton(doc, state));
	life.on(composerNodes.draftInput, "keydown", (event) => {
		if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
		event.preventDefault();
		submitStart();
	});
	life.on(toolbarNodes.modelSelect, "change", () => {
		const entry = state.vm?.catalog.find((item) => item.key === toolbarNodes.modelSelect.value);
		if (!entry) return;
		const thinkingLevel = state.vm?.thinkingLevel ?? resolveDraftDefaultThinking(entry.supportedThinkingLevels);
		send?.({ type: "select-default-model", provider: entry.provider, id: entry.id, thinkingLevel });
	});
	life.on(toolbarNodes.thinkingSelect, "change", () => {
		const entry = state.vm?.catalog.find((item) => item.key === state.vm?.activeModelKey);
		if (!entry || !toolbarNodes.thinkingSelect.value) return;
		send?.({
			type: "select-default-model",
			provider: entry.provider,
			id: entry.id,
			thinkingLevel: toolbarNodes.thinkingSelect.value,
		});
	});
}

function executeNewSessionCommand(state, action) {
	if (state.life.dead) return false;
	if (action === "focus-composer") {
		state.composerNodes.draftInput.focus();
		return true;
	}
	if (action === "open-model-picker" && !state.toolbarNodes.modelSelect.disabled) {
		state.toolbarNodes.modelSelect.focus();
		return true;
	}
	if (action === "cycle-thinking" && state.vm?.thinkingLevels.length) {
		const entry = state.vm.catalog.find((item) => item.key === state.vm.activeModelKey);
		if (!entry) return false;
		const idx = state.vm.thinkingLevels.indexOf(state.vm.thinkingLevel);
		const next = state.vm.thinkingLevels[(idx + 1) % state.vm.thinkingLevels.length];
		state.send?.({ type: "select-default-model", provider: entry.provider, id: entry.id, thinkingLevel: next });
		return true;
	}
	return false;
}

function appendPickedDraftPaths(doc, state, picked) {
	if (state.life.dead || !picked) return;
	const list = Array.isArray(picked) ? picked : [picked];
	let changed = false;
	for (const entry of list) {
		const rawPath = typeof entry === "string" ? entry : entry?.path;
		if (typeof rawPath === "string" && rawPath.trim()) {
			state.composerNodes.draftInput.value = appendPathTokenToText(state.composerNodes.draftInput.value, rawPath);
			changed = true;
		}
	}
	if (changed) syncDraftChipsAndButton(doc, state);
}

function submitDraftStart(state) {
	if (!state.vm || !state.vm.configured || state.vm.starting) return;
	const prompt = state.composerNodes.draftInput.value.trim();
	if (!prompt && !(state.vm.sessionMode === "practice" && state.vm.pickedNodeIds.length > 0)) return;
	state.send?.({ type: "start-session", prompt });
}

function handleNodeFilterChange(doc, state, send, query) {
	if (typeof send === "function") { send({ type: "set-node-filter", query }); return; }
	state.fallbackFilter = query;
	applyNewSessionVm(doc, state);
}

export function createNewSessionView(host, opts = {}) {
	const { send, navigate, onToggleSidebar, onPickDirectory, onPickFiles } = opts;
	const doc = documentOf(host);
	injectUiStyles(doc);
	injectNewSessionStyles(doc);
	const life = createLife();
	const root = el(doc, "section", { className: "peer-new-session", attrs: { "data-peer-screen": "new-session" } });
	const topBarHost = el(doc, "div", { className: "peer-new-session-header" });
	const topBar = createTopBar(topBarHost, {
		onToggleSidebar,
		onNavigateHome: navigate ? () => navigate({ name: "home" }) : undefined,
		onOpenSettings: send ? () => send({ type: "open-settings" }) : undefined,
	});
	const body = el(doc, "div", { className: "peer-new-session-body" });
	const state = {
		life, send, topBar, rawModel: {}, fallbackFilter: "", vm: null, modelSig: "", thinkSig: "",
		toolbarNodes: null, pickerNodes: null, composerNodes: null,
	};
	const submitStart = () => submitDraftStart(state);
	state.toolbarNodes = buildToolbarNodes(doc, life, send);
	state.pickerNodes = buildNodePickerNodes(doc, life, send, (q) => handleNodeFilterChange(doc, state, send, q));
	state.composerNodes = buildComposerCardNodes(doc, life, {
		onOpenSetup: () => send?.({ type: "open-setup" }),
		onStart: submitStart,
		onPickFiles,
		onPickDirectory,
		pickFiles: () => void Promise.resolve(onPickFiles?.()).then((res) => appendPickedDraftPaths(doc, state, res)),
		pickDirectory: () => void Promise.resolve(onPickDirectory?.()).then((res) => appendPickedDraftPaths(doc, state, res)),
	});
	body.append(state.toolbarNodes.toolbar, state.pickerNodes.picker, state.composerNodes.card);
	root.append(topBarHost, body);
	bindNewSessionEvents(doc, life, state, submitStart);
	host.append(root);
	return {
		update: (model = {}) => { if (!life.dead) { state.rawModel = model; applyNewSessionVm(doc, state); } },
		command: (action) => executeNewSessionCommand(state, action),
		destroy: () => { if (life.destroy()) { topBar.destroy(); root.remove(); } },
	};
}
