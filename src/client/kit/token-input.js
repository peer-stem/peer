/**
 * Rich inline-token composer field (`L-13`) supporting atomic inline chips
 * (`@path`, citations, mentions) interleaved with plain text, `Enter` submit
 * vs `Shift+Enter` newline, plain-text paste sanitization, and file/image paste.
 */
import { createLife, documentOf, el } from "cloudcanvas-lib/ui";
import { injectKitStyles } from "./styles.js";

const CLASS = "cloudcanvas-ui-token-input";
const CHIP_CLASS = "cloudcanvas-ui-token-chip";

function buildChipNode(doc, token, onRemove) {
	const chip = el(doc, "span", {
		className: CHIP_CLASS,
		attrs: {
			contenteditable: "false",
			"data-token-id": token.id,
			"data-token-kind": token.kind ?? "ref",
			"data-token-value": token.value ?? token.label ?? token.id,
		},
	});
	chip.append(el(doc, "span", { text: token.label ?? token.value ?? token.id }));
	const remove = el(doc, "button", {
		text: "×",
		attrs: { type: "button", "aria-label": `Remove ${token.label ?? token.id}`, tabindex: "-1" },
	});
	remove.style.cssText = "border:0;background:transparent;color:inherit;cursor:pointer;padding:0 2px;";
	remove.addEventListener("click", (e) => {
		e.preventDefault();
		e.stopPropagation();
		chip.remove();
		onRemove();
	});
	chip.append(remove);
	return chip;
}

function walkSurfaceNode(node, tokens, parts) {
	if (node.nodeType === 3) {
		parts.push(node.data);
		return;
	}
	if (node.nodeType !== 1) return;
	if (node.hasAttribute("data-token-id")) {
		const id = node.getAttribute("data-token-id");
		const kind = node.getAttribute("data-token-kind") ?? "ref";
		const value = node.getAttribute("data-token-value") ?? "";
		tokens.push({ id, kind, value });
		parts.push(value);
		return;
	}
	const tag = node.tagName.toUpperCase();
	if (tag === "BR") { parts.push("\n"); return; }
	const block = tag === "DIV" || tag === "P";
	if (block && parts.length > 0 && !parts[parts.length - 1].endsWith("\n")) parts.push("\n");
	for (const child of node.childNodes) walkSurfaceNode(child, tokens, parts);
}

function serializeSurface(surface) {
	const tokens = [];
	const parts = [];
	for (const child of surface.childNodes) walkSurfaceNode(child, tokens, parts);
	return { text: parts.join("").replace(/\u00a0/g, " "), tokens };
}

function handleSurfaceBackspace(doc, surface, event, syncEmptyAndEmit) {
	const sel = doc.getSelection?.();
	if (!sel || !sel.isCollapsed || sel.anchorNode !== surface || sel.anchorOffset <= 0) return;
	const prev = surface.childNodes[sel.anchorOffset - 1];
	if (prev?.nodeType !== 1 || !prev.hasAttribute("data-token-id")) return;
	event.preventDefault();
	prev.remove();
	syncEmptyAndEmit(true);
}

function handleSurfacePaste(doc, surface, event, callbacks, syncEmptyAndEmit) {
	const files = Array.from(event.clipboardData?.files ?? []);
	if (files.length > 0 && callbacks.onPasteFiles) {
		event.preventDefault();
		callbacks.onPasteFiles(files);
		return;
	}
	const plain = event.clipboardData?.getData("text/plain");
	if (plain === undefined) return;
	event.preventDefault();
	const sel = doc.getSelection?.();
	if (sel && sel.rangeCount > 0 && surface.contains(sel.anchorNode)) {
		const range = sel.getRangeAt(0);
		range.deleteContents();
		range.insertNode(doc.createTextNode(plain));
		range.collapse(false);
	} else {
		surface.append(doc.createTextNode(plain));
	}
	syncEmptyAndEmit(true);
}

function applyTokenInputModel(doc, surface, syncEmptyAndEmit, model = {}) {
	if (model.placeholder !== undefined) surface.setAttribute("data-placeholder", String(model.placeholder));
	if (model.ariaLabel) surface.setAttribute("aria-label", String(model.ariaLabel));
	const disabled = Boolean(model.disabled);
	surface.setAttribute("contenteditable", disabled ? "false" : "true");
	surface.setAttribute("aria-disabled", disabled ? "true" : "false");
	if (model.value === undefined) return;
	const current = serializeSurface(surface).text;
	if (String(model.value) === current || doc.activeElement === surface) return;
	surface.replaceChildren();
	if (model.value) surface.append(doc.createTextNode(String(model.value)));
	if (Array.isArray(model.tokens)) {
		for (const tok of model.tokens) {
			surface.append(buildChipNode(doc, tok, () => syncEmptyAndEmit(true)), doc.createTextNode(" "));
		}
	}
	syncEmptyAndEmit(false);
}

const TOKEN_SURFACE_ATTRS = {
	role: "textbox",
	"aria-multiline": "true",
	contenteditable: "true",
	"data-empty": "true",
	"data-placeholder": "",
};

/**
 * @param {HTMLElement} host
 * @param {{onChange?: (payload: {text: string, tokens: Array<object>}) => void, onSubmit?: (payload: {text: string, tokens: Array<object>}) => void, onPasteFiles?: (files: File[]) => void, onTrigger?: (trigger: string) => void}} [callbacks]
 */
export function createTokenInput(host, callbacks = {}) {
	const doc = documentOf(host);
	injectKitStyles(doc);
	const life = createLife();
	const surface = el(doc, "div", { className: CLASS, attrs: TOKEN_SURFACE_ATTRS });
	host.append(surface);

	const syncEmptyAndEmit = (emit = true) => {
		const payload = serializeSurface(surface);
		const isEmpty = payload.text.trim() === "" && payload.tokens.length === 0;
		surface.setAttribute("data-empty", isEmpty ? "true" : "false");
		if (emit) callbacks.onChange?.(payload);
		return payload;
	};
	const insertToken = (token) => {
		if (life.dead) return;
		surface.append(buildChipNode(doc, token, () => syncEmptyAndEmit(true)), doc.createTextNode(" "));
		syncEmptyAndEmit(true);
	};

	life.on(surface, "input", () => {
		if (syncEmptyAndEmit(true).text.endsWith("@")) callbacks.onTrigger?.("@");
	});
	life.on(surface, "keydown", (event) => {
		if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
			event.preventDefault();
			callbacks.onSubmit?.(serializeSurface(surface));
		} else if (event.key === "Backspace") {
			handleSurfaceBackspace(doc, surface, event, syncEmptyAndEmit);
		}
	});
	life.on(surface, "paste", (event) => handleSurfacePaste(doc, surface, event, callbacks, syncEmptyAndEmit));

	return {
		root: surface,
		focus: () => surface.focus(),
		serialize: () => serializeSurface(surface),
		insertToken,
		clear: () => { surface.replaceChildren(); syncEmptyAndEmit(true); },
		update: (model = {}) => { if (!life.dead) applyTokenInputModel(doc, surface, syncEmptyAndEmit, model); },
		destroy: () => { if (life.destroy()) surface.remove(); },
	};
}
