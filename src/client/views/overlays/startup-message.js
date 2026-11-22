/**
 * Desktop `v0.7.0` startup announcement dialog (`[data-testid="startup-message-dialog"]`).
 * Built on `createModal` + `createKitMarkdown` from `'peer-kit'` (`displayOnly: true`,
 * `allowRelative: false`), allowing strictly credential-free `https://` links and
 * calling `onDismiss?.(message.id)` on Close, backdrop click, or Escape.
 */
import { button, createLife, documentOf, el, injectUiStyles, textNode, writeText } from "cloudcanvas-lib/ui";
import { createKitMarkdown, createModal, renderKitInline } from "peer-kit";
import { injectOverlaysStyles } from "./overlays.css.js";

export function toSafeHttpsUrl(rawHref) {
	const value = String(rawHref ?? "").trim();
	if (!value.startsWith("https://")) return null;
	try {
		const url = new URL(value);
		if (url.protocol === "https:" && !url.username && !url.password) return url.href;
	} catch { /* reject invalid URLs */ }
	return null;
}

function readBracketSpan(text, openIndex, openChar, closeChar) {
	if (text[openIndex] !== openChar) return null;
	let depth = 1;
	let i = openIndex + 1;
	while (i < text.length && depth > 0) {
		if (text[i] === "\\") { i += 2; continue; }
		if (text[i] === openChar) depth += 1;
		else if (text[i] === closeChar) depth -= 1;
		i += 1;
	}
	return depth === 0 ? { value: text.slice(openIndex + 1, i - 1), next: i } : null;
}

function parseMarkdownDest(rawInner) {
	const trimmed = rawInner.trim();
	if (!trimmed) return { href: "", title: "" };
	if (trimmed.startsWith("<")) {
		const close = trimmed.indexOf(">");
		if (close > 0) return { href: trimmed.slice(1, close).trim(), title: "" };
	}
	const parts = /^(\S+)(?:\s+["'](.*)["'])?$/.exec(trimmed);
	return parts ? { href: parts[1], title: parts[2] ?? "" } : { href: trimmed, title: "" };
}

function readStartupInlineLink(text, index) {
	if (text[index] !== "[" || (index > 0 && text[index - 1] === "!")) return null;
	const label = readBracketSpan(text, index, "[", "]");
	if (!label || text[label.next] !== "(") return null;
	const dest = readBracketSpan(text, label.next, "(", ")");
	if (!dest) return null;
	const parsed = parseMarkdownDest(dest.value);
	return { token: { label: label.value, safeHref: toSafeHttpsUrl(parsed.href), title: parsed.title }, next: dest.next };
}

function renderStartupInlineLink(doc, token) {
	const innerFrag = renderKitInline(token.label, {
		doc, allowRelative: false, readInline: readStartupInlineLink, renderInline: renderStartupInlineLink,
	});
	if (!token.safeHref) {
		const span = el(doc, "span", { className: "peer-overlays-startup-plain-link" });
		span.append(innerFrag);
		return span;
	}
	const anchor = el(doc, "a", {
		className: "peer-overlays-startup-link",
		attrs: { href: token.safeHref, target: "_blank", rel: "noopener noreferrer", ...(token.title ? { title: token.title } : {}) },
	});
	anchor.append(innerFrag);
	return anchor;
}

function sanitizeStartupAnchors(doc, root) {
	for (const anchor of Array.from(root.querySelectorAll("a"))) {
		const safe = toSafeHttpsUrl(anchor.getAttribute("href"));
		if (!safe) {
			const span = el(doc, "span", { className: "peer-overlays-startup-plain-link" });
			span.append(...Array.from(anchor.childNodes));
			anchor.replaceWith(span);
			continue;
		}
		anchor.setAttribute("href", safe);
		anchor.setAttribute("target", "_blank");
		anchor.setAttribute("rel", "noopener noreferrer");
	}
}

function syncStartupDialogAttrs(dialogEl, isOpen) {
	if (!dialogEl) return;
	dialogEl.classList.add("peer-overlays-startup-dialog");
	const titleEl = dialogEl.querySelector(".cloudcanvas-ui-dialog-title");
	const closeBtn = dialogEl.querySelector(".cloudcanvas-ui-dialog-close");
	closeBtn?.setAttribute("aria-label", "Close announcement");
	closeBtn?.setAttribute("data-testid", "startup-message-header-close");
	if (isOpen) {
		dialogEl.setAttribute("data-testid", "startup-message-dialog");
		dialogEl.setAttribute("data-peer-layer", "startup-message");
		titleEl?.setAttribute("data-testid", "startup-message-title");
	} else {
		dialogEl.removeAttribute("data-testid");
		dialogEl.removeAttribute("data-peer-layer");
		titleEl?.removeAttribute("data-testid");
	}
}

function buildStartupBodyDom(doc, life, onClose) {
	const contentWrap = el(doc, "div", { className: "peer-overlays-startup-content" });
	const dateEl = el(doc, "div", {
		className: "peer-overlays-startup-date",
		attrs: { "data-testid": "startup-message-date", hidden: true },
	});
	const dateText = textNode(doc, dateEl, "");
	const mdHost = el(doc, "div", { className: "peer-overlays-startup-body" });
	const footer = el(doc, "footer", { className: "peer-overlays-startup-footer" });
	footer.append(button(doc, {
		label: "Close",
		signal: life.signal,
		onClick: onClose,
		attrs: { "data-testid": "startup-message-close", "data-peer-action": "dismiss-startup-message" },
	}));
	contentWrap.append(dateEl, mdHost, footer);
	return { contentWrap, dateEl, dateText, mdHost };
}

function bindStartupEscape(life, win, hasActiveId, triggerDismiss) {
	if (!win || typeof win.addEventListener !== "function") return;
	life.on(win, "keydown", (event) => {
		if (!hasActiveId() || event.key !== "Escape" || event.defaultPrevented) return;
		event.preventDefault();
		triggerDismiss();
	});
}

function applyStartupUpdate(state, rawMessage = null) {
	if (state.life.dead) return;
	const message = rawMessage && typeof rawMessage === "object" && rawMessage.message ? rawMessage.message : rawMessage;
	if (!message || typeof message !== "object" || !message.id) {
		state.activeId = null;
		state.modal.update({ open: false, closeButton: true, content: state.nodes.contentWrap });
		syncStartupDialogAttrs(state.dialogEl, false);
		return;
	}
	state.activeId = String(message.id);
	const published = String(message.publishedAt ?? "").trim();
	state.nodes.dateEl.hidden = published === "";
	writeText(state.nodes.dateText, published);
	state.md.update({ source: String(message.bodyMarkdown ?? ""), streaming: false, displayOnly: true });
	sanitizeStartupAnchors(state.doc, state.md.root);
	state.modal.update({
		open: true,
		title: String(message.title ?? "Announcement"),
		closeLabel: "Close announcement",
		closeButton: true,
		content: state.nodes.contentWrap,
	});
	syncStartupDialogAttrs(state.dialogEl, true);
}

export function createStartupMessageDialog(host, { onDismiss } = {}) {
	const doc = documentOf(host);
	injectUiStyles(doc);
	injectOverlaysStyles(doc);
	const life = createLife();
	const state = { doc, life, activeId: null, modal: null, dialogEl: null, nodes: null, md: null };
	const triggerDismiss = () => { if (state.activeId) onDismiss?.(state.activeId); };

	state.modal = createModal(host, { onClose: () => triggerDismiss() });
	state.dialogEl = state.modal.body.closest("dialog");
	state.nodes = buildStartupBodyDom(doc, life, triggerDismiss);
	state.md = createKitMarkdown(state.nodes.mdHost, {
		rootClassName: "peer-overlays-startup-markdown",
		allowRelative: false,
		externalTarget: true,
		readInline: readStartupInlineLink,
		renderInline: renderStartupInlineLink,
	});
	bindStartupEscape(life, doc.defaultView, () => Boolean(state.activeId), triggerDismiss);

	const destroy = () => {
		if (!life.destroy()) return;
		state.activeId = null;
		state.md.destroy();
		state.modal.destroy();
	};
	return { node: state.dialogEl, update: (msg) => applyStartupUpdate(state, msg), destroy };
}
