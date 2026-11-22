/**
 * Sub-agent result delivery & abort steer cards (`steer-card.js`).
 * Handles `data-subagent-artifact` (`demo`, `visual`, `research`, `pdf`, `plugin`)
 * and `data-subagent-aborted` (`job-delivery-failure` vs `job-aborted-badge`).
 */
import { SR_ONLY_CLASS, el } from "cloudcanvas-lib/ui";
import { isSubagentFailure } from "peer-engine";
import { createMarkdown } from "../../blocks/markdown.js";
import { createDemoOutputHandle } from "./demo-card.js";
import {
	createPdfBriefDom,
	createPdfCompleteBadge,
	createResearchBriefDom,
	createResearchCompleteBadge,
} from "./job-card.js";
import { createVisualOutputHandle } from "./visual-card.js";

function buildDeliveryFailureDom(doc, failureText) {
	const root = el(doc, "div", {
		className: "peer-job-delivery-failure",
		attrs: { "data-testid": "job-delivery-failure", role: "alert" },
	});
	root.append(
		el(doc, "p", { text: "Background job recovery/delivery failed" }),
		el(doc, "p", { className: "peer-artifact-note", text: failureText }),
	);
	return { node: root, update: () => {}, destroy: () => root.remove() };
}

function buildAbortedBadgeDom(doc, kind) {
	const root = el(doc, "div", {
		className: "peer-job-aborted",
		attrs: { "data-testid": "job-aborted-badge" },
	});
	root.append(
		el(doc, "span", { text: "⊗", attrs: { "aria-hidden": "true" } }),
		el(doc, "span", { className: "peer-dispatch-label", text: String(kind || "job") }),
		el(doc, "span", { text: "aborted by the learner" }),
	);
	return { node: root, update: () => {}, destroy: () => root.remove() };
}

function buildPluginWorkerSummary(doc, result) {
	const status = String(result.outcome?.status ?? "succeeded");
	const label = String(result.toolName ?? "plugin");
	const glyph = status === "succeeded" ? "✓" : status === "failed" ? "✕" : "⊗";
	const summary = el(doc, "summary", {
		className: "peer-worker-summary",
		attrs: { "data-testid": "plugin-worker-header", title: `${label}: ${status}` },
	});
	summary.append(
		el(doc, "span", { className: status === "failed" ? "peer-dispatch-glyph is-error" : "peer-dispatch-glyph", text: glyph, attrs: { "aria-hidden": "true" } }),
		el(doc, "span", { className: "peer-demo-title", text: label }),
		el(doc, "span", { className: SR_ONLY_CLASS, text: ` ${status}` }),
	);
	return summary;
}

function buildPluginTaskDetails(doc, result) {
	const taskDetails = el(doc, "details");
	const payload = {
		input: result.input,
		outcome: result.outcome,
		...(Object.hasOwn(result, "data") ? { data: result.data } : {}),
	};
	taskDetails.append(
		el(doc, "summary", { className: "peer-worker-summary", text: "Task details" }),
		el(doc, "pre", { className: "peer-tool-pre", text: JSON.stringify(payload, null, 2) }),
	);
	return taskDetails;
}

function buildPluginWorkerDom(doc, result, ctx) {
	if (!result || typeof result !== "object") {
		const fallback = el(doc, "div", { className: "peer-artifact-fallback", text: "Plugin worker finished, but its result could not be displayed." });
		return { node: fallback, update: () => {}, destroy: () => fallback.remove() };
	}
	const section = el(doc, "section", { className: "peer-plugin-worker", attrs: { "data-testid": "plugin-worker-card" } });
	if (result.formatError) {
		section.append(el(doc, "p", { className: "peer-session-card-error", text: `Result formatting failed: ${result.formatError}`, attrs: { role: "alert" } }));
	}
	const details = el(doc, "details", { className: "peer-worker-details", attrs: { "data-testid": "plugin-worker-result" } });
	const fallback = el(doc, "div", { className: "peer-plugin-worker-fallback", attrs: { "data-testid": "plugin-worker-fallback" } });
	const customSlot = el(doc, "div", { attrs: { "data-testid": "plugin-worker-custom", hidden: true } });
	const mdSlot = el(doc, "div");
	const fenceFor = ctx?.blocks ? (lang) => ctx.blocks.fenceFor(lang) : undefined;
	const md = createMarkdown(mdSlot, { fenceFor, onExpand: ctx?.onExpand });
	md.update({ source: String(result.text ?? ""), streaming: false, mode: ctx?.getMode?.() ?? "dark", displayOnly: true });
	fallback.append(mdSlot, buildPluginTaskDetails(doc, result));
	const bodyWrap = el(doc, "div", { className: "peer-worker-body" });
	bodyWrap.append(customSlot, fallback);
	details.append(buildPluginWorkerSummary(doc, result), bodyWrap);
	section.append(details);
	let releaseCustom = null;
	const syncCustom = (res, activeCtx) => {
		const mgr = activeCtx?.getPluginManager?.();
		const reg = res?.toolName ? mgr?.getToolRenderer?.(res.toolName) : null;
		if (!reg || !mgr) {
			releaseCustom?.(); releaseCustom = null; customSlot.hidden = true; fallback.hidden = false;
			return;
		}
		if (releaseCustom) return;
		customSlot.hidden = false;
		fallback.hidden = true;
		releaseCustom = mgr.mountRenderer(
			reg,
			(child, signal) => reg.renderer.mount(child, {
				toolName: res.toolName, toolCallId: res.taskId ?? "", state: "output-available",
				input: res.input, output: res.data ?? res.outcome, signal,
			}),
			customSlot,
			() => { customSlot.hidden = true; fallback.hidden = false; },
		);
	};
	syncCustom(result, ctx);
	return {
		node: section,
		update(nextResult, nextCtx) {
			if (!nextResult || typeof nextResult !== "object") return;
			md.update({ source: String(nextResult.text ?? ""), streaming: false, mode: (nextCtx ?? ctx)?.getMode?.() ?? "dark", displayOnly: true });
			syncCustom(nextResult, nextCtx ?? ctx);
		},
		destroy: () => { releaseCustom?.(); md.destroy(); section.remove(); },
	};
}

function classifySteerBranch(part) {
	if (part.subagentType === "aborted" || part.partType === "data-subagent-aborted") {
		return typeof part.failure === "string" ? `failure:${part.failure}` : `aborted:${part.subKind || "job"}`;
	}
	if (!part.hasArtifactData && !part.result) return "missing";
	const kind = String(part.subKind ?? "");
	if (kind === "research") return isSubagentFailure("research", part.result) ? "research-fail" : "research-ok";
	if (kind === "pdf") return isSubagentFailure("pdf", part.result) ? "pdf-fail" : "pdf-ok";
	if (kind === "demo" || kind === "visual" || kind === "plugin") return kind;
	return "missing";
}

function mountSteerBranch(doc, branch, part, ctx) {
	if (branch.startsWith("failure:")) return buildDeliveryFailureDom(doc, part.failure);
	if (branch.startsWith("aborted:")) return buildAbortedBadgeDom(doc, part.subKind || "job");
	if (branch === "demo") return createDemoOutputHandle(doc, part, ctx);
	if (branch === "visual") return createVisualOutputHandle(doc, part, ctx);
	if (branch === "research-fail") return createResearchBriefDom(doc, part.result, ctx);
	if (branch === "research-ok") return createResearchCompleteBadge(doc, part.result, ctx);
	if (branch === "pdf-fail") return createPdfBriefDom(doc, part.result, ctx);
	if (branch === "pdf-ok") return createPdfCompleteBadge(doc, part.result, ctx);
	if (branch === "plugin") return buildPluginWorkerDom(doc, part.result, ctx);
	const fallback = el(doc, "div", {
		className: "peer-artifact-fallback",
		text: "A sub-agent finished, but its result could not be displayed.",
	});
	return { node: fallback, update: () => {}, destroy: () => fallback.remove() };
}

export function createSteerCardHandle(doc, part, ctx) {
	let branch = "";
	let inner = null;

	const handle = {
		key: `steer-card:${part.id}`,
		node: el(doc, "div"),
		update(nextPart, nextCtx) {
			const nextBranch = classifySteerBranch(nextPart);
			if (nextBranch === branch && inner) {
				if (branch === "demo" || branch === "visual") inner.update(nextPart, nextCtx);
				else inner.update(nextPart.result, nextCtx);
				handle.node = inner.node;
				return;
			}
			const prevNode = handle.node;
			const prevInner = inner;
			branch = nextBranch;
			inner = mountSteerBranch(doc, nextBranch, nextPart, nextCtx);
			prevNode.replaceWith(inner.node);
			prevInner?.destroy();
			handle.node = inner.node;
		},
		destroy() {
			if (inner) {
				inner.destroy();
				inner = null;
				return;
			}
			handle.node.remove();
		},
	};
	handle.update(part, ctx);
	return handle;
}
