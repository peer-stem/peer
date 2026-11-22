/**
 * Controlled collapsible disclosure (`L-6`) with `aria-expanded` and `aria-controls`.
 */
import { createLife, documentOf, el, textNode, uniqueId, writeText } from "cloudcanvas-lib/ui";
import { injectKitStyles } from "./styles.js";

const CLASS = "cloudcanvas-ui-disclosure";

/**
 * @param {HTMLElement} host
 * @param {{onToggle?: (open: boolean) => void}} [callbacks]
 */
export function createDisclosure(host, { onToggle } = {}) {
	const doc = documentOf(host);
	injectKitStyles(doc);
	const life = createLife();
	const bodyId = uniqueId(`${CLASS}-body`);
	const root = el(doc, "div", { className: CLASS });
	const header = el(doc, "button", {
		className: `${CLASS}-header`,
		attrs: { type: "button", "aria-expanded": "false", "aria-controls": bodyId },
	});
	const chevron = el(doc, "span", { className: `${CLASS}-chevron`, text: "▸", attrs: { "aria-hidden": "true" } });
	const titleWrap = el(doc, "span", { className: `${CLASS}-title` });
	const titleText = textNode(doc, titleWrap, "");
	const metaWrap = el(doc, "span", { className: `${CLASS}-meta`, attrs: { hidden: true } });
	const metaText = textNode(doc, metaWrap, "");
	header.append(chevron, titleWrap, metaWrap);
	const body = el(doc, "div", { className: `${CLASS}-body`, attrs: { id: bodyId, hidden: true } });
	root.append(header, body);
	host.append(root);

	let open = false;
	life.on(header, "click", () => {
		if (!life.dead) onToggle?.(!open);
	});

	return {
		root,
		header,
		body,
		update(model = {}) {
			if (life.dead) return;
			open = Boolean(model.open);
			root.classList.toggle("is-open", open);
			header.setAttribute("aria-expanded", open ? "true" : "false");
			header.disabled = Boolean(model.disabled);
			writeText(titleText, model.title ?? "");
			const meta = model.meta ? String(model.meta) : "";
			metaWrap.hidden = meta === "";
			writeText(metaText, meta);
			body.hidden = !open;
			if (model.content && body.firstChild !== model.content) body.replaceChildren(model.content);
		},
		destroy() {
			if (life.destroy()) root.remove();
		},
	};
}
