/**
 * Interactive session composer (`views §2.5`, `C2a §3.6`, `§4.1`).
 * Supports `@path` token chips, PNG/JPEG paste + file input + drag-drop,
 * optional desktop folder/file pickers (`onPickDirectory` / `onPickFiles`),
 * Enter-to-send / Shift+Enter newline, Send vs Steer vs Stop, queued-steers
 * strip, Setup CTA, and one-shot `openingDraft` seeding per chat.
 */
import { button, createLife, documentOf, el, input } from "cloudcanvas-lib/ui";
import {
	appendPathTokenToText,
	extractClipboardImageFiles,
	extractPathTokens,
	readDroppedOrPickedFiles,
	removePathTokenFromText,
	toAttachedImageInputs,
} from "./composer-tokens.js";

function renderQueuedSteers(doc, container, queuedSteers) {
	const list = Array.isArray(queuedSteers) ? queuedSteers : [];
	container.hidden = list.length === 0;
	if (list.length === 0) {
		container.replaceChildren();
		return;
	}
	const rows = list.map((item) => {
		const row = el(doc, "div", {
			className: "peer-composer-steer-item",
			attrs: { "data-peer-steer-id": String(item?.id ?? "") },
		});
		row.append(
			el(doc, "span", { className: "peer-composer-steer-badge", text: "Queued" }),
			el(doc, "span", { className: "peer-composer-steer-text", text: String(item?.text ?? "") }),
		);
		return row;
	});
	container.replaceChildren(...rows);
}

function buildPathChip(doc, tok, onRemove) {
	const chip = el(doc, "span", {
		className: "peer-composer-chip",
		attrs: { "data-peer-path-chip": tok.path, title: tok.path },
	});
	const rm = button(doc, {
		className: "peer-composer-chip-remove",
		label: "×",
		ariaLabel: `Remove ${tok.path}`,
		onClick: () => onRemove(tok.raw),
		attrs: { "data-peer-remove-chip": tok.raw },
	});
	chip.append(el(doc, "span", { text: tok.label }), rm);
	return chip;
}

function buildImageChip(doc, img, onRemove) {
	const chip = el(doc, "span", {
		className: "peer-composer-chip peer-composer-image-chip",
		attrs: { "data-peer-attached-image": img.name },
	});
	const preview = el(doc, "img", {
		className: "peer-composer-thumb",
		attrs: { src: `data:${img.mimeType};base64,${img.data}`, alt: img.name },
	});
	const rm = button(doc, {
		className: "peer-composer-chip-remove",
		label: "×",
		ariaLabel: `Remove image ${img.name}`,
		onClick: () => onRemove(img.id),
		attrs: { "data-peer-remove-image": img.id },
	});
	chip.append(preview, el(doc, "span", { text: img.name }), rm);
	return chip;
}

function renderTokenAndImageChips(doc, state, syncDraftUi) {
	const pathTokens = extractPathTokens(state.nodes.textarea.value);
	const hasAny = pathTokens.length > 0 || state.images.length > 0;
	state.nodes.chipsRow.hidden = !hasAny;
	if (!hasAny) {
		state.nodes.chipsRow.replaceChildren();
		return;
	}
	const removePath = (raw) => {
		state.nodes.textarea.value = removePathTokenFromText(state.nodes.textarea.value, raw);
		syncDraftUi();
	};
	const removeImage = (id) => {
		state.images = state.images.filter((entry) => entry.id !== id);
		syncDraftUi();
	};
	const children = [
		...pathTokens.map((tok) => buildPathChip(doc, tok, removePath)),
		...state.images.map((img) => buildImageChip(doc, img, removeImage)),
	];
	state.nodes.chipsRow.replaceChildren(...children);
}

function buildAttachGroup(doc, life, handlers) {
	const group = el(doc, "div", { className: "peer-composer-attach-group" });
	const fileInput = el(doc, "input", {
		attrs: { type: "file", accept: "image/png,image/jpeg", multiple: true, "data-peer-file-input": "", hidden: true },
	});
	const attachBtn = button(doc, {
		className: "peer-composer-attach",
		label: "Attach",
		ariaLabel: "Attach image",
		signal: life.signal,
		onClick: () => fileInput.click(),
		attrs: { "data-peer-action": "attach-image" },
	});
	const pickFilesBtn = typeof handlers.onPickFiles === "function"
		? button(doc, {
			className: "peer-composer-pick-files",
			label: "Files",
			ariaLabel: "Attach files",
			signal: life.signal,
			onClick: () => handlers.pickFiles(),
			attrs: { "data-peer-action": "pick-files" },
		})
		: null;
	const pickDirBtn = typeof handlers.onPickDirectory === "function"
		? button(doc, {
			className: "peer-composer-pick-dir",
			label: "Folder",
			ariaLabel: "Attach folder",
			signal: life.signal,
			onClick: () => handlers.pickDirectory(),
			attrs: { "data-peer-action": "pick-directory" },
		})
		: null;
	group.append(fileInput, attachBtn);
	if (pickFilesBtn) group.append(pickFilesBtn);
	if (pickDirBtn) group.append(pickDirBtn);
	return { group, fileInput, attachBtn, pickFilesBtn, pickDirBtn };
}

function buildComposerRow(doc, life, handlers) {
	const row = el(doc, "div", { className: "peer-composer-row" });
	const attach = buildAttachGroup(doc, life, handlers);
	const textarea = input(doc, {
		type: "textarea",
		label: "Message",
		placeholder: "Ask, answer, or steer the lesson…",
		className: "peer-composer-input",
		attrs: { "data-peer-composer-input": "", rows: "2" },
	});
	const actions = el(doc, "div", { className: "peer-composer-actions" });
	const sendBtn = button(doc, {
		className: "peer-composer-send is-primary",
		label: "Send",
		signal: life.signal,
		onClick: () => handlers.submit("send"),
		attrs: { "data-peer-action": "send-turn" },
	});
	const steerBtn = button(doc, {
		className: "peer-composer-steer",
		label: "Steer",
		signal: life.signal,
		onClick: () => handlers.submit("steer"),
		attrs: { "data-peer-action": "steer-turn", hidden: true },
	});
	const stopBtn = button(doc, {
		className: "peer-composer-stop",
		label: "Stop",
		signal: life.signal,
		onClick: () => handlers.onStop?.(),
		attrs: { "data-peer-action": "stop-turn", hidden: true },
	});
	actions.append(sendBtn, steerBtn, stopBtn);
	row.append(attach.group, textarea, actions);
	return {
		row,
		fileInput: attach.fileInput,
		attachBtn: attach.attachBtn,
		pickFilesBtn: attach.pickFilesBtn,
		pickDirBtn: attach.pickDirBtn,
		textarea,
		sendBtn,
		steerBtn,
		stopBtn,
	};
}

function buildComposerNodes(doc, life, handlers) {
	const root = el(doc, "div", { className: "peer-composer", attrs: { "data-peer-composer": "" } });
	const setupCta = button(doc, {
		className: "peer-composer-setup-cta",
		label: "Configure a model provider to start chatting",
		signal: life.signal,
		onClick: () => handlers.onOpenSetup?.(),
		attrs: { "data-peer-setup-cta": "", "data-peer-action": "open-setup", hidden: true },
	});
	const steersEl = el(doc, "div", {
		className: "peer-composer-steers",
		attrs: { "data-peer-queued-steers": "", hidden: true },
	});
	const chipsRow = el(doc, "div", {
		className: "peer-composer-chips",
		attrs: { "data-peer-path-chips": "", hidden: true },
	});
	const rowNodes = buildComposerRow(doc, life, handlers);
	root.append(setupCta, steersEl, chipsRow, rowNodes.row);
	return { root, setupCta, steersEl, chipsRow, ...rowNodes };
}

function paintComposerControls(state) {
	const { nodes } = state;
	const hasPayload = nodes.textarea.value.trim().length > 0 || state.images.length > 0;
	const disabled = state.configured === false;
	nodes.setupCta.hidden = !disabled;
	nodes.textarea.disabled = disabled;
	nodes.attachBtn.disabled = disabled;
	if (nodes.pickFilesBtn) nodes.pickFilesBtn.disabled = disabled;
	if (nodes.pickDirBtn) nodes.pickDirBtn.disabled = disabled;
	nodes.sendBtn.hidden = state.isBusy;
	nodes.steerBtn.hidden = !state.isBusy;
	nodes.stopBtn.hidden = !state.isBusy;
	nodes.sendBtn.disabled = disabled || state.compacting || !hasPayload;
	nodes.steerBtn.disabled = disabled || !hasPayload;
	nodes.stopBtn.disabled = false;
}

function ingestSelectedFiles(state, fileList, syncDraftUi) {
	void readDroppedOrPickedFiles(fileList).then(({ images, paths }) => {
		if (state.life.dead) return;
		if (images.length > 0) state.images = [...state.images, ...images];
		for (const p of paths) {
			state.nodes.textarea.value = appendPathTokenToText(state.nodes.textarea.value, p);
		}
		if (images.length > 0 || paths.length > 0) syncDraftUi();
	});
}

function ingestPickedPaths(state, picked, syncDraftUi) {
	if (state.life.dead || !picked) return;
	const list = Array.isArray(picked) ? picked : [picked];
	let changed = false;
	for (const entry of list) {
		const rawPath = typeof entry === "string" ? entry : entry?.path;
		if (typeof rawPath === "string" && rawPath.trim()) {
			state.nodes.textarea.value = appendPathTokenToText(state.nodes.textarea.value, rawPath);
			changed = true;
		}
	}
	if (changed) syncDraftUi();
}

function submitComposerPayload(state, mode, callbacks, syncDraftUi) {
	if (state.configured === false) return false;
	const text = state.nodes.textarea.value.trim();
	const images = toAttachedImageInputs(state.images);
	if (!text && images.length === 0) return false;
	const targetMode = mode ?? (state.isBusy ? "steer" : "send");
	if (targetMode === "send" && state.compacting) return false;
	const payload = images.length > 0 ? { text, images } : { text };
	state.nodes.textarea.value = "";
	state.images = [];
	syncDraftUi();
	if (targetMode === "steer") callbacks.onSteer?.(payload);
	else callbacks.onSend?.(payload);
	return true;
}

function bindComposerEvents(state, callbacks, syncDraftUi) {
	const { life, nodes } = state;
	life.on(nodes.textarea, "input", () => syncDraftUi());
	life.on(nodes.textarea, "compositionstart", () => { state.composing = true; });
	life.on(nodes.textarea, "compositionend", () => { state.composing = false; });
	life.on(nodes.textarea, "keydown", (event) => {
		if (event.key !== "Enter" || event.shiftKey || event.isComposing || state.composing) return;
		event.preventDefault();
		submitComposerPayload(state, null, callbacks, syncDraftUi);
	});
	life.on(nodes.textarea, "paste", (event) => {
		const files = extractClipboardImageFiles(event.clipboardData);
		if (files.length === 0) return;
		if (!event.clipboardData?.getData?.("text/plain")) event.preventDefault();
		ingestSelectedFiles(state, files, syncDraftUi);
	});
	life.on(nodes.fileInput, "change", () => {
		ingestSelectedFiles(state, nodes.fileInput.files, syncDraftUi);
		nodes.fileInput.value = "";
	});
	life.on(nodes.root, "dragover", (event) => {
		if (event.dataTransfer?.types?.includes?.("Files")) event.preventDefault();
	});
	life.on(nodes.root, "drop", (event) => {
		if (!event.dataTransfer?.files?.length) return;
		event.preventDefault();
		ingestSelectedFiles(state, event.dataTransfer.files, syncDraftUi);
	});
}

function applyComposerUpdate(doc, state, syncDraftUi, model = {}) {
	if (state.life.dead) return;
	const nextChatId = String(model.chatId ?? "");
	if (nextChatId !== state.chatId) {
		state.chatId = nextChatId;
		state.seededOpening = false;
		state.nodes.textarea.value = "";
		state.images = [];
	}
	if (!state.seededOpening && typeof model.openingDraft === "string" && model.openingDraft.length > 0) {
		state.seededOpening = true;
		if (state.nodes.textarea.value === "") state.nodes.textarea.value = model.openingDraft;
	}
	state.configured = model.configured !== false;
	const status = String(model.status ?? "ready");
	state.isBusy = status === "submitted" || status === "streaming";
	state.compacting = Boolean(model.compacting);
	state.nodes.root.hidden = Boolean(model.hidden);
	renderQueuedSteers(doc, state.nodes.steersEl, model.queuedSteers);
	syncDraftUi();
}

export function createSessionComposer(host, callbacks = {}) {
	const doc = documentOf(host);
	const life = createLife();
	const state = {
		doc, life, nodes: null, images: [], chatId: "", seededOpening: false,
		configured: true, isBusy: false, compacting: false, composing: false,
	};
	const syncDraftUi = () => {
		if (life.dead) return;
		renderTokenAndImageChips(doc, state, syncDraftUi);
		paintComposerControls(state);
	};
	state.nodes = buildComposerNodes(doc, life, {
		submit: (mode) => submitComposerPayload(state, mode, callbacks, syncDraftUi),
		onStop: callbacks.onStop,
		onOpenSetup: callbacks.onOpenSetup,
		onPickFiles: callbacks.onPickFiles,
		onPickDirectory: callbacks.onPickDirectory,
		pickFiles: () => void Promise.resolve(callbacks.onPickFiles?.()).then((res) => ingestPickedPaths(state, res, syncDraftUi)),
		pickDirectory: () => void Promise.resolve(callbacks.onPickDirectory?.()).then((res) => ingestPickedPaths(state, res, syncDraftUi)),
	});
	bindComposerEvents(state, callbacks, syncDraftUi);
	host.append(state.nodes.root);

	return {
		update: (model) => applyComposerUpdate(doc, state, syncDraftUi, model),
		focus: () => { if (!life.dead) state.nodes.textarea.focus(); },
		destroy: () => { if (life.destroy()) state.nodes.root.remove(); },
	};
}
