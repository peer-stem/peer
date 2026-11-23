/**
 * Transcript handles for plugin-rendered parts (`f4-c2c`):
 * - `plugin-question-part` (`[data-testid="plugin-question-answered"]` / preview)
 * - `plugin-problem-submitted` (`[data-testid="plugin-problem-submitted"]`)
 * - `plugin-tool-card` (custom `PluginToolRenderer` via `manager.mountRenderer`)
 */
import { el, show, textNode, writeText } from "cloudcanvas-lib/ui";
import { readPluginProblemSubmission, readPluginQuestionAnswer, readPluginQuestionCancellation, readPluginQuestionSnapshot } from "peer-engine";
import { createMarkdown } from "../../blocks/markdown.js";

function findQuestionReg(plugins, snap) {
	return (plugins?.questionRenderers ?? []).find(
		(r) => r.pluginId === snap.pluginId
			&& r.renderer.id === snap.rendererId
			&& r.renderer.supportedContractVersions.includes(snap.contractVersion),
	) ?? null;
}

function findProblemReg(plugins, snap) {
	return (plugins?.problemRenderers ?? []).find(
		(r) => r.pluginId === snap.pluginId
			&& r.renderer.id === snap.rendererId
			&& r.renderer.supportedContractVersions.includes(snap.contractVersion),
	) ?? null;
}

function syncAnsweredMount(state, customSlot, fallbackEl, reg, snap, ans) {
	const sig = reg?.renderer.mountAnswered ? `${snap.questionId}:${JSON.stringify(ans.answer)}` : "";
	if (!sig) {
		state.cleanupCustom();
		state.mountedSig = "";
		show(fallbackEl, Boolean(ans));
		if (ans) fallbackEl.textContent = JSON.stringify(ans.answer, null, 2);
		return;
	}
	if (sig === state.mountedSig) return;
	state.cleanupCustom();
	state.mountedSig = sig;
	const ctrl = new AbortController();
	try {
		const clean = reg.renderer.mountAnswered(customSlot, {
			questionId: snap.questionId, prompt: snap.prompt, payload: snap.payload, answer: ans.answer, signal: ctrl.signal,
		});
		state.unmount = () => { ctrl.abort(); if (typeof clean === "function") clean(); };
		show(fallbackEl, false);
	} catch {
		show(fallbackEl, true);
		fallbackEl.textContent = JSON.stringify(ans.answer, null, 2);
	}
}

export function createPluginQuestionPartHandle(doc, part, ctx) {
	const card = el(doc, "div", { className: "peer-session-card", attrs: { "data-testid": part.isAnswered ? "plugin-question-answered" : "plugin-question-preview" } });
	const head = el(doc, "div", { className: "peer-session-card-head" });
	const titleEl = el(doc, "span", { className: "peer-session-card-title" });
	const titleText = textNode(doc, titleEl, "");
	const metaEl = el(doc, "span", { className: "peer-session-card-meta" });
	const metaText = textNode(doc, metaEl, "");
	head.append(titleEl, metaEl);
	const promptSlot = el(doc, "div");
	const promptMd = createMarkdown(promptSlot, { displayOnly: true });
	const customSlot = el(doc, "div");
	const fallbackEl = el(doc, "pre", { className: "peer-tool-pre", attrs: { hidden: true } });
	card.append(head, promptSlot, customSlot, fallbackEl);

	const state = {
		unmount: null, mountedSig: "",
		cleanupCustom() { state.unmount?.(); state.unmount = null; customSlot.replaceChildren(); },
	};
	const update = (next, nextCtx) => {
		const activeCtx = nextCtx ?? ctx;
		const snap = readPluginQuestionSnapshot(next.pluginQuestion);
		writeText(titleText, snap?.label || next.toolName || "Plugin question");
		const cancelled = snap ? readPluginQuestionCancellation(next.output, snap) : null;
		const ans = snap && !cancelled ? readPluginQuestionAnswer(next.output, snap) : null;
		writeText(metaText, cancelled ? "Dismissed" : ans ? "Answered" : "Pending");
		promptMd.update({ source: snap?.prompt ?? "", streaming: false, mode: activeCtx?.getMode?.() ?? "dark", displayOnly: true });
		const reg = snap && ans ? findQuestionReg(activeCtx?.getPlugins?.(), snap) : null;
		syncAnsweredMount(state, customSlot, fallbackEl, reg, snap, ans);
	};
	update(part, ctx);
	return { key: `plugin-question:${part.id}`, node: card, update, destroy: () => { state.cleanupCustom(); promptMd.destroy(); card.remove(); } };
}

function syncSubmittedMount(state, customSlot, fallbackEl, reg, snap, sub, rawData) {
	const sig = reg?.renderer.mountSubmitted ? `${sub.problemId}:${JSON.stringify(sub.submission)}` : "";
	if (!sig) {
		state.cleanupCustom();
		state.mountedSig = "";
		show(fallbackEl, true);
		fallbackEl.textContent = JSON.stringify(sub?.submission ?? rawData, null, 2);
		return;
	}
	if (sig === state.mountedSig) return;
	state.cleanupCustom();
	state.mountedSig = sig;
	const ctrl = new AbortController();
	try {
		const clean = reg.renderer.mountSubmitted(customSlot, {
			problemId: snap.problemId, prompt: snap.prompt, payload: snap.payload, submission: sub.submission, signal: ctrl.signal,
		});
		state.unmount = () => { ctrl.abort(); if (typeof clean === "function") clean(); };
		show(fallbackEl, false);
	} catch {
		show(fallbackEl, true);
		fallbackEl.textContent = JSON.stringify(sub?.submission ?? rawData, null, 2);
	}
}

export function createPluginProblemSubmittedHandle(doc, part, ctx) {
	const card = el(doc, "div", { className: "peer-session-card", attrs: { "data-testid": "plugin-problem-submitted" } });
	const head = el(doc, "div", { className: "peer-session-card-head" });
	head.append(el(doc, "span", { className: "peer-session-card-title", text: "Submitted solution" }));
	const customSlot = el(doc, "div");
	const fallbackEl = el(doc, "pre", { className: "peer-tool-pre", attrs: { hidden: true } });
	const thinkingSlot = el(doc, "div", { attrs: { hidden: true } });
	const thinkingMd = createMarkdown(thinkingSlot, { displayOnly: true });
	card.append(head, customSlot, fallbackEl, thinkingSlot);

	const state = {
		unmount: null, mountedSig: "",
		cleanupCustom() { state.unmount?.(); state.unmount = null; customSlot.replaceChildren(); },
	};
	const update = (next, nextCtx) => {
		const activeCtx = nextCtx ?? ctx;
		const sub = readPluginProblemSubmission(next.data);
		const snap = next.problemSnapshot ?? null;
		const reg = sub && snap ? findProblemReg(activeCtx?.getPlugins?.(), snap) : null;
		syncSubmittedMount(state, customSlot, fallbackEl, reg, snap, sub, next.data);
		const thk = String(sub?.thinking ?? "").trim();
		show(thinkingSlot, thk !== "");
		if (thk) thinkingMd.update({ source: thk, streaming: false, mode: activeCtx?.getMode?.() ?? "dark", displayOnly: true });
	};
	update(part, ctx);
	return { key: `plugin-problem-submitted:${part.id}`, node: card, update, destroy: () => { state.cleanupCustom(); thinkingMd.destroy(); card.remove(); } };
}

export function createPluginToolRendererHandle(doc, part, ctx) {
	const wrap = el(doc, "div", { className: "peer-session-card", attrs: { "data-testid": "plugin-tool-card", "data-tool-name": part.toolName } });
	const mountSlot = el(doc, "div");
	const errEl = el(doc, "p", { className: "peer-settings-error", attrs: { hidden: true } });
	const errText = textNode(doc, errEl, "");
	wrap.append(mountSlot, errEl);
	let release = null;
	let mountedSig = "";

	const update = (next, nextCtx) => {
		const manager = (nextCtx ?? ctx)?.getPluginManager?.();
		const reg = manager?.getToolRenderer?.(next.toolName);
		const sig = reg ? `${reg.pluginId}:${next.toolCallId}:${next.state}:${JSON.stringify(next.output ?? null)}` : "";
		if (!reg || !manager) {
			release?.(); release = null; mountedSig = "";
			mountSlot.replaceChildren(el(doc, "div", { className: "peer-session-card-title", text: `Tool: ${next.toolName}` }));
			return;
		}
		if (sig === mountedSig) return;
		release?.(); mountedSig = sig; mountSlot.replaceChildren(); show(errEl, false);
		release = manager.mountRenderer(
			reg,
			(child, signal) => reg.renderer.mount(child, { toolName: next.toolName, toolCallId: next.toolCallId, state: next.state, input: next.input, output: next.output, errorText: next.errorText, signal }),
			mountSlot,
			(msg) => { show(errEl, true); writeText(errText, msg); },
		);
	};
	update(part, ctx);
	return { key: `plugin-tool-card:${part.id}`, node: wrap, update, destroy: () => { release?.(); wrap.remove(); } };
}
