/**
 * Keyed transcript message item subview (`views §2.5`, Finding #6 fix, `C2b`).
 * Reconciles mounted part handles in place by `${part.kind}:${part.id}` with zero
 * `clearChildren()` teardown on streaming updates, stamps `[data-source-message-id]`
 * and `[data-session-find-root]`, and mounts artifact/tool cards + citation chips.
 */
import { createLife, documentOf, el } from "cloudcanvas-lib/ui";
import { collectCitations } from "peer-engine";
import { createMarkdown } from "../../blocks/markdown.js";
import { injectArtifactsStyles } from "../artifacts/artifacts.css.js";
import { createDispatchCardHandle } from "../artifacts/dispatch-card.js";
import { createProbeDoneHandle } from "../artifacts/probe-done-card.js";
import { createSteerCardHandle } from "../artifacts/steer-card.js";
import { createLiveToolHandle, createToolCallHandle } from "../artifacts/tool-cards.js";
import {
	createPluginProblemSubmittedHandle,
	createPluginQuestionPartHandle,
	createPluginToolRendererHandle,
} from "../plugin/plugin-transcript-parts.js";
import { createSpeakButton } from "../voice/speak-button.js";
import { createAnsweredCardHandle } from "./answered-card.js";
import { renderUserCitationsStrip, stripCitationLinksFromDisplay } from "./citation-popover.js";
import {
	createConcludeCardHandle,
	createMalformedQuestionHandle,
	createProblemCardHandle,
	createQuestionPreviewHandle,
	createThinkingCardHandle,
} from "./practice-cards.js";
import {
	createCompactionHandle,
	createGenericCardHandle,
	createGraphContextHandle,
	createInlineImageHandle,
	createReasoningHandle,
	createSnapshotImageHandle,
} from "./transcript-parts.js";

function syncUserCitationsHost(doc, citationsHost, rawSource, hasCitations, activeCtx) {
	const strip = hasCitations
		? renderUserCitationsStrip(doc, rawSource, {
			currentChatId: activeCtx?.getChatId?.(),
			getTranscript: activeCtx?.getTranscript,
			getScrollContext: activeCtx?.getScrollContext,
			onNavigate: activeCtx?.onNavigate,
		})
		: null;
	citationsHost.hidden = !strip;
	citationsHost.replaceChildren(...(strip ? [strip] : []));
}

function createTextHandle(doc, part, ctx) {
	const slot = el(doc, "div", { className: "peer-session-markdown", attrs: { "data-peer-part-type": "text" } });
	const citationsHost = el(doc, "div", { className: "peer-session-citations-host", attrs: { hidden: true } });
	const mdHost = el(doc, "div", { className: "peer-session-markdown-body" });
	const speakHost = el(doc, "div", { className: "peer-session-speak-host", attrs: { hidden: part.role !== "assistant" } });
	slot.append(citationsHost, mdHost, speakHost);
	const fenceFor = ctx?.blocks ? (lang) => ctx.blocks.fenceFor(lang) : undefined;
	const md = createMarkdown(mdHost, { fenceFor, onExpand: ctx?.onExpand });
	let currentText = String(part.source ?? "");
	const speakBtn = part.role === "assistant"
		? createSpeakButton(speakHost, {
			id: `part:${part.id}`,
			getText: () => currentText,
			onSpeak: ctx?.onSpeak,
			onStop: ctx?.onStopSpeak,
		})
		: null;
	let prevCitationSig = "";

	const update = (nextPart, nextCtx) => {
		const activeCtx = nextCtx ?? ctx;
		const rawSource = String(nextPart.source ?? "");
		currentText = rawSource;
		const hasCitations = nextPart.role === "user" && collectCitations(rawSource).length > 0;
		const citationSig = hasCitations ? rawSource : "";
		if (citationSig !== prevCitationSig) {
			prevCitationSig = citationSig;
			syncUserCitationsHost(doc, citationsHost, rawSource, hasCitations, activeCtx);
		}
		const displaySource = hasCitations ? stripCitationLinksFromDisplay(rawSource) : rawSource;
		md.update({ source: displaySource, streaming: Boolean(nextPart.streaming), mode: nextPart.mode, displayOnly: false });
		speakBtn?.update({ id: `part:${nextPart.id}`, speech: activeCtx?.getSpeech?.() ?? null });
	};
	update(part, ctx);
	return {
		key: `text:${part.id}`,
		node: slot,
		update,
		destroy: () => { speakBtn?.destroy(); md.destroy(); slot.remove(); },
	};
}

function createPartHandle(doc, part, ctx) {
	if (part.kind === "graph-context") return createGraphContextHandle(doc, part);
	if (part.kind === "compaction-cut" || part.kind === "compaction") return createCompactionHandle(doc, part);
	if (part.kind === "step-anchor") {
		const span = el(doc, "span", { attrs: { "data-peer-step-message-id": part.sourceMessageId, hidden: true } });
		const update = (next) => span.setAttribute("data-peer-step-message-id", next.sourceMessageId);
		return { key: `step-anchor:${part.id}`, node: span, update, destroy: () => span.remove() };
	}
	if (part.kind === "reasoning") return createReasoningHandle(doc, part, ctx);
	if (part.kind === "text") return createTextHandle(doc, part, ctx);
	if (part.kind === "inline-image") return createInlineImageHandle(doc, part, ctx);
	if (part.kind === "snapshot-image") return createSnapshotImageHandle(doc, part, ctx);
	if (part.kind === "answered-card") return createAnsweredCardHandle(doc, part, ctx);
	if (part.kind === "problem-card") return createProblemCardHandle(doc, part, ctx);
	if (part.kind === "conclude-card") return createConcludeCardHandle(doc, part, ctx);
	if (part.kind === "thinking-card") return createThinkingCardHandle(doc, part, ctx);
	if (part.kind === "question-preview") return createQuestionPreviewHandle(doc, part, ctx);
	if (part.kind === "malformed-question") return createMalformedQuestionHandle(doc, part, ctx);
	if (part.kind === "steer-card") return createSteerCardHandle(doc, part, ctx);
	if (part.kind === "dispatch-card") return createDispatchCardHandle(doc, part, ctx);
	if (part.kind === "probe-done-card") return createProbeDoneHandle(doc, part, ctx);
	if (part.kind === "live-tool-card") return createLiveToolHandle(doc, part);
	if (part.kind === "tool-call-card") return createToolCallHandle(doc, part);
	if (part.kind === "plugin-question-part") return createPluginQuestionPartHandle(doc, part, ctx);
	if (part.kind === "plugin-problem-submitted") return createPluginProblemSubmittedHandle(doc, part, ctx);
	if (part.kind === "plugin-tool-card") return createPluginToolRendererHandle(doc, part, ctx);
	return createGenericCardHandle(doc, part);
}

function syncSideTriggerButton(doc, life, itemHost, state, item, ctx) {
	const wantBtn = !item.standalone && item.role === "assistant" && typeof ctx?.onOpenSideThread === "function";
	if (!wantBtn) {
		state.actionsBar?.remove();
		state.actionsBar = null;
		return;
	}
	if (!state.actionsBar) {
		const bar = el(doc, "div", { className: "peer-session-message-actions" });
		const btn = el(doc, "button", {
			className: "peer-artifact-icon-btn peer-side-trigger-btn",
			text: "💬",
			attrs: {
				type: "button",
				"data-testid": "side-conversation-button",
				"aria-label": "Ask a side question",
				title: "Ask a side question",
			},
		});
		life.on(btn, "click", () => {
			ctx.onOpenSideThread({ anchor: { kind: "element", element: btn }, sourceMessageId: state.currentId });
		});
		bar.append(btn);
		state.actionsBar = bar;
	}
	if (state.actionsBar.parentNode !== itemHost) itemHost.append(state.actionsBar);
}

function ensureContainer(doc, life, itemHost, state, item, ctx) {
	const wantStandalone = Boolean(item.standalone);
	state.currentId = String(item.id);
	if (!state.container || state.standalone !== wantStandalone) {
		for (let i = state.mountedParts.length - 1; i >= 0; i -= 1) state.mountedParts[i].destroy();
		state.mountedParts = [];
		state.actionsBar?.remove();
		state.actionsBar = null;
		state.container?.remove();
		state.standalone = wantStandalone;
		state.container = wantStandalone
			? el(doc, "div", { className: "peer-session-standalone" })
			: el(doc, "article", { className: "peer-session-message" });
		itemHost.append(state.container);
	}
	state.container.setAttribute("data-peer-message-id", item.id);
	if (!wantStandalone) {
		state.container.id = `msg-${item.id}`;
		state.container.setAttribute("data-peer-role", item.role);
		state.container.setAttribute("data-source-message-id", item.id);
		state.container.setAttribute("data-session-find-root", "");
	}
	syncSideTriggerButton(doc, life, itemHost, state, item, ctx);
	return state.container;
}

function reconcileParts(doc, container, mountedParts, nextParts, ctx) {
	const unusedByKey = new Map();
	for (const entry of mountedParts) unusedByKey.set(entry.key, entry);
	const nextMounted = [];

	for (let i = 0; i < nextParts.length; i += 1) {
		const part = nextParts[i];
		const key = `${part.kind}:${part.id}`;
		const sameSlot = i < mountedParts.length && mountedParts[i].key === key && unusedByKey.has(key);
		if (sameSlot) {
			const entry = mountedParts[i];
			unusedByKey.delete(key);
			entry.update(part, ctx);
			nextMounted.push(entry);
			continue;
		}
		const reused = unusedByKey.get(key);
		if (reused) {
			unusedByKey.delete(key);
			reused.update(part, ctx);
			if (container.children[i] !== reused.node) container.insertBefore(reused.node, container.children[i] ?? null);
			nextMounted.push(reused);
			continue;
		}
		const created = createPartHandle(doc, part, ctx);
		created.key = key;
		container.insertBefore(created.node, container.children[i] ?? null);
		nextMounted.push(created);
	}
	for (const leftover of unusedByKey.values()) leftover.destroy();
	return nextMounted;
}

export function createTranscriptItemView(itemHost, ctx) {
	const doc = documentOf(itemHost);
	injectArtifactsStyles(doc);
	const life = createLife();
	const state = { container: null, actionsBar: null, currentId: "", standalone: null, mountedParts: [] };

	const update = (item) => {
		if (life.dead || !item) return;
		const container = ensureContainer(doc, life, itemHost, state, item, ctx);
		state.mountedParts = reconcileParts(doc, container, state.mountedParts, item.parts ?? [], ctx);
	};

	const setThinkingOpen = (open) => {
		for (const part of state.mountedParts) part.setThinkingOpen?.(open);
	};

	const destroy = () => {
		if (!life.destroy()) return;
		for (let i = state.mountedParts.length - 1; i >= 0; i -= 1) state.mountedParts[i].destroy();
		state.mountedParts = [];
		state.actionsBar?.remove();
		state.actionsBar = null;
		state.container?.remove();
		state.container = null;
	};

	return { update, setThinkingOpen, destroy };
}
