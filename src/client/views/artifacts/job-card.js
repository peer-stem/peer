/**
 * Research & PDF reading brief cards and collapsed completion badges (`job-card.js`).
 * Exports `createResearchBriefDom`, `createPdfBriefDom`, `createResearchCompleteBadge`,
 * and `createPdfCompleteBadge`.
 */
import { el, textNode, writeText } from "cloudcanvas-lib/ui";
import { isWebSourceUrl } from "peer-engine";
import { createMarkdown } from "../../blocks/markdown.js";

function buildBriefMarkdown(bodySlot, ctx) {
	const fenceFor = ctx?.blocks ? (lang) => ctx.blocks.fenceFor(lang) : undefined;
	return createMarkdown(bodySlot, { fenceFor, onExpand: ctx?.onExpand });
}

function renderSourcesList(doc, sourcesSlot, sources) {
	const list = Array.isArray(sources) ? sources : [];
	sourcesSlot.hidden = list.length === 0;
	if (list.length === 0) {
		sourcesSlot.replaceChildren();
		return;
	}
	const heading = el(doc, "div", { className: "peer-brief-eyebrow", text: "Sources" });
	const ul = el(doc, "ul", { className: "peer-brief-source-list" });
	for (const source of list) {
		const url = String(source?.url ?? "");
		const title = String(source?.title || url);
		const li = el(doc, "li");
		if (isWebSourceUrl(url)) {
			li.append(el(doc, "a", {
				className: "peer-brief-source-link",
				text: title,
				attrs: { href: url, target: "_blank", rel: "noopener noreferrer" },
			}));
		} else {
			li.append(el(doc, "span", { text: title }));
		}
		ul.append(li);
	}
	sourcesSlot.replaceChildren(heading, ul);
}

export function createResearchBriefDom(doc, output, ctx) {
	if (!output || typeof output !== "object" || typeof output.brief !== "string") {
		const fallback = el(doc, "div", {
			className: "peer-artifact-fallback",
			text: "Research completed, but the result could not be displayed.",
		});
		return { node: fallback, update: () => {}, destroy: () => fallback.remove() };
	}
	const root = el(doc, "div", {
		className: "peer-brief-card",
		attrs: { "data-testid": "research-brief-card" },
	});
	const head = el(doc, "div", { className: "peer-brief-head" });
	const failBadge = el(doc, "span", { className: "peer-artifact-badge-error", text: "failed", attrs: { hidden: true } });
	head.append(el(doc, "span", { className: "peer-brief-eyebrow", text: "Research brief" }), failBadge);
	const bodySlot = el(doc, "div", { className: "peer-brief-body" });
	const sourcesSlot = el(doc, "div", { className: "peer-brief-sources", attrs: { hidden: true } });
	root.append(head, bodySlot, sourcesSlot);
	const md = buildBriefMarkdown(bodySlot, ctx);

	const update = (nextOutput, nextCtx) => {
		if (!nextOutput || typeof nextOutput.brief !== "string") return;
		failBadge.hidden = !nextOutput.brief.startsWith("Research failed");
		md.update({
			source: nextOutput.brief,
			streaming: false,
			mode: (nextCtx ?? ctx)?.getMode?.() ?? "dark",
			displayOnly: true,
		});
		renderSourcesList(doc, sourcesSlot, nextOutput.sources);
	};
	update(output, ctx);

	return {
		node: root,
		update,
		destroy: () => {
			md.destroy();
			root.remove();
		},
	};
}

export function createPdfBriefDom(doc, output, ctx) {
	if (!output || typeof output !== "object" || typeof output.brief !== "string") {
		const fallback = el(doc, "div", {
			className: "peer-artifact-fallback",
			text: "PDF reading completed, but the result could not be displayed.",
		});
		return { node: fallback, update: () => {}, destroy: () => fallback.remove() };
	}
	const root = el(doc, "div", {
		className: "peer-brief-card",
		attrs: { "data-testid": "pdf-brief-card" },
	});
	const head = el(doc, "div", { className: "peer-brief-head" });
	const failBadge = el(doc, "span", { className: "peer-artifact-badge-error", text: "failed", attrs: { hidden: true } });
	head.append(el(doc, "span", { className: "peer-brief-eyebrow", text: "PDF brief" }), failBadge);
	const bodySlot = el(doc, "div", { className: "peer-brief-body" });
	const readEl = el(doc, "div", { className: "peer-brief-meta", attrs: { hidden: true } });
	const readText = textNode(doc, readEl, "");
	const consultedEl = el(doc, "div", { className: "peer-brief-meta", attrs: { hidden: true } });
	const consultedText = textNode(doc, consultedEl, "");
	root.append(head, bodySlot, readEl, consultedEl);
	const md = buildBriefMarkdown(bodySlot, ctx);

	const update = (nextOutput, nextCtx) => {
		if (!nextOutput || typeof nextOutput.brief !== "string") return;
		const failed = nextOutput.brief.startsWith("PDF failed");
		failBadge.hidden = !failed;
		md.update({
			source: nextOutput.brief,
			streaming: false,
			mode: (nextCtx ?? ctx)?.getMode?.() ?? "dark",
			displayOnly: true,
		});
		const readList = Array.isArray(nextOutput.pagesRead)
			? nextOutput.pagesRead
			: Array.isArray(nextOutput.pagesConsulted) ? nextOutput.pagesConsulted : [];
		const consultedList = Array.isArray(nextOutput.pagesConsulted) ? nextOutput.pagesConsulted : [];
		readEl.hidden = failed || readList.length === 0;
		writeText(readText, readList.length > 0 ? `Pages read: ${readList.join(", ")}` : "");
		const showConsulted = !failed && consultedList.length > readList.length;
		consultedEl.hidden = !showConsulted;
		writeText(consultedText, showConsulted ? `Pages consulted: ${consultedList.join(", ")}` : "");
	};
	update(output, ctx);

	return {
		node: root,
		update,
		destroy: () => {
			md.destroy();
			root.remove();
		},
	};
}

function buildWorkerDetailsShell(doc, testId, kindTitle, statusWord) {
	const details = el(doc, "details", {
		className: "peer-worker-details",
		attrs: { "data-testid": testId },
	});
	const summary = el(doc, "summary", { className: "peer-worker-summary" });
	const countEl = el(doc, "span", { attrs: { hidden: true } });
	const countText = textNode(doc, countEl, "");
	summary.append(
		el(doc, "span", { text: "✓", attrs: { "aria-hidden": "true" } }),
		el(doc, "span", { className: "peer-dispatch-label", text: kindTitle }),
		el(doc, "span", { text: statusWord }),
		countEl,
		el(doc, "span", { className: "peer-worker-view-label", text: "view brief" }),
		el(doc, "span", { className: "peer-worker-hide-label", text: "hide brief" }),
	);
	const bodyWrap = el(doc, "div", { className: "peer-worker-body" });
	details.append(summary, bodyWrap);
	return { details, countEl, countText, bodyWrap };
}

export function createResearchCompleteBadge(doc, result, ctx) {
	const shell = buildWorkerDetailsShell(doc, "research-complete-badge", "Research", "complete");
	const brief = createResearchBriefDom(doc, result, ctx);
	shell.bodyWrap.append(brief.node);
	const update = (nextResult, nextCtx) => {
		const n = Array.isArray(nextResult?.sources) ? nextResult.sources.length : 0;
		shell.countEl.hidden = n === 0;
		writeText(shell.countText, n > 0 ? `· ${n} sources` : "");
		brief.update(nextResult, nextCtx);
	};
	update(result, ctx);
	return {
		node: shell.details,
		update,
		destroy: () => {
			brief.destroy();
			shell.details.remove();
		},
	};
}

export function createPdfCompleteBadge(doc, result, ctx) {
	const shell = buildWorkerDetailsShell(doc, "pdf-complete-badge", "PDF", "reading complete");
	const brief = createPdfBriefDom(doc, result, ctx);
	shell.bodyWrap.append(brief.node);
	const update = (nextResult, nextCtx) => {
		const pages = Array.isArray(nextResult?.pagesRead)
			? nextResult.pagesRead
			: Array.isArray(nextResult?.pagesConsulted) ? nextResult.pagesConsulted : [];
		shell.countEl.hidden = pages.length === 0;
		writeText(shell.countText, pages.length > 0 ? `· read ${pages.length} page${pages.length === 1 ? "" : "s"}` : "");
		brief.update(nextResult, nextCtx);
	};
	update(result, ctx);
	return {
		node: shell.details,
		update,
		destroy: () => {
			brief.destroy();
			shell.details.remove();
		},
	};
}
