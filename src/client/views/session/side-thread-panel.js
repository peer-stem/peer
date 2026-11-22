/**
 * Floating (`[data-testid="side-thread-popover"]`) and docked (`[data-testid="side-thread-panel"]`)
 * side-question companion (`side-thread-panel.js`).
 * Uses `placeSideThread`, `fitResizableSideThreadFrame`, `resizeSideThread`,
 * `sideSegmentId`, and `sideThreadReducer` from `'peer-engine'`.
 */
import { createLife, documentOf, el } from "cloudcanvas-lib/ui";
import {
	fitResizableSideThreadFrame,
	placeSideThread,
	resizeSideThread,
	sideSegmentId,
	sideThreadReducer,
} from "peer-engine";
import { createSideThreadBody } from "./side-thread-body.js";

const RESIZE_EDGES = Object.freeze(["n", "s", "w", "e", "nw", "ne", "sw", "se"]);

function readViewport(win) {
	return { width: win?.innerWidth || 1280, height: win?.innerHeight || 800 };
}

function resolveAnchorRect(anchor, getComposer, win) {
	if (anchor?.kind === "range" && typeof anchor.range?.getClientRects === "function") {
		const lines = Array.from(anchor.range.getClientRects()).filter((r) => r.width || r.height);
		if (lines.length > 0) return lines.at(-1);
	}
	const elTarget = anchor?.kind === "element" ? anchor.element : getComposer?.();
	if (elTarget?.isConnected && typeof elTarget.getBoundingClientRect === "function") {
		return elTarget.getBoundingClientRect();
	}
	const w = win?.innerWidth || 1280;
	return { left: Math.max(8, w - 440), right: Math.max(408, w - 40), top: 80, bottom: 80, width: 400, height: 0 };
}

function attachResizeHandles(doc, life, popoverEl, getFrame, applyFrame, win) {
	for (const edge of RESIZE_EDGES) {
		const handle = el(doc, "div", {
			className: `peer-side-resize peer-side-resize-${edge}`,
			attrs: {
				"aria-hidden": "true",
				"data-side-resize": edge,
				"data-testid": edge === "s" ? "side-thread-resize" : `side-thread-resize-${edge}`,
			},
		});
		life.on(handle, "pointerdown", (ev) => {
			if (ev.button !== 0) return;
			ev.preventDefault();
			const start = getFrame();
			const origin = { x: ev.clientX, y: ev.clientY };
			try { handle.setPointerCapture?.(ev.pointerId); } catch { /* optional */ }
			const onMove = (move) => {
				const delta = { x: move.clientX - origin.x, y: move.clientY - origin.y };
				applyFrame(resizeSideThread(start, edge, delta, readViewport(win)));
			};
			const onEnd = () => {
				handle.removeEventListener("pointermove", onMove);
				handle.removeEventListener("pointerup", onEnd);
				handle.removeEventListener("pointercancel", onEnd);
			};
			handle.addEventListener("pointermove", onMove);
			handle.addEventListener("pointerup", onEnd);
			handle.addEventListener("pointercancel", onEnd);
		});
		popoverEl.append(handle);
	}
}

function placePopoverBox(box, st, getComposer, win, applyCustomFrame) {
	if (st.customFrame) {
		applyCustomFrame(fitResizableSideThreadFrame(st.customFrame, readViewport(win)));
		return;
	}
	const vp = readViewport(win);
	const rect = resolveAnchorRect(st.currentAnchor, getComposer, win);
	const placed = placeSideThread({
		kind: st.currentAnchor?.kind === "composer" ? "composer" : "rect",
		rect,
		viewport: vp,
		contentHeight: (box.scrollHeight || 240) + 24,
	});
	box.style.left = `${placed.style.left}px`;
	box.style.width = `${placed.style.width}px`;
	box.style.top = placed.style.top !== undefined ? `${placed.style.top}px` : "";
	box.style.bottom = placed.style.bottom !== undefined ? `${placed.style.bottom}px` : "";
	box.style.height = "";
	box.style.maxHeight = `${placed.maxHeight}px`;
}

function createHeaderDragHandler(readFrame, applyFrame, win) {
	return (ev) => {
		if (ev.button !== 0 || ev.target?.closest?.("button")) return;
		ev.preventDefault();
		const start = readFrame();
		const dx = ev.clientX - start.x;
		const dy = ev.clientY - start.y;
		applyFrame(start);
		const headerEl = ev.currentTarget;
		try { headerEl.setPointerCapture?.(ev.pointerId); } catch { /* optional */ }
		const onMove = (move) => {
			applyFrame(fitResizableSideThreadFrame({ ...start, x: move.clientX - dx, y: move.clientY - dy }, readViewport(win)));
		};
		const onEnd = () => {
			headerEl.removeEventListener("pointermove", onMove);
			headerEl.removeEventListener("pointerup", onEnd);
			headerEl.removeEventListener("pointercancel", onEnd);
		};
		headerEl.addEventListener("pointermove", onMove);
		headerEl.addEventListener("pointerup", onEnd);
		headerEl.addEventListener("pointercancel", onEnd);
	};
}

function mountPopoverSurface(popoverHost, callbacks) {
	const doc = documentOf(popoverHost);
	const win = doc.defaultView ?? globalThis.window;
	const life = createLife();
	const st = { customFrame: null, currentAnchor: { kind: "composer" } };
	const box = el(doc, "div", {
		className: "peer-side-popover",
		attrs: { role: "dialog", "aria-label": "Side question", "data-testid": "side-thread-popover" },
	});
	const readCurrentFrame = () => {
		if (st.customFrame) return st.customFrame;
		const r = box.getBoundingClientRect();
		return { x: r.left || 40, y: r.top || 80, width: r.width || 416, height: r.height || 260 };
	};
	const applyCustomFrame = (frame) => {
		st.customFrame = frame;
		box.style.left = `${frame.x}px`;
		box.style.top = `${frame.y}px`;
		box.style.bottom = "";
		box.style.width = `${frame.width}px`;
		box.style.height = `${frame.height}px`;
		box.style.maxHeight = "";
	};
	const placeAuto = () => placePopoverBox(box, st, callbacks.getComposer, win, applyCustomFrame);
	const onDragStart = createHeaderDragHandler(readCurrentFrame, applyCustomFrame, win);
	const body = createSideThreadBody(box, { ...callbacks, onDragStart });
	attachResizeHandles(doc, life, box, readCurrentFrame, applyCustomFrame, win);
	popoverHost.append(box);
	if (win?.addEventListener) life.on(win, "resize", placeAuto);

	return {
		update(payload) {
			st.currentAnchor = payload.state?.anchor ?? { kind: "composer" };
			body.update(payload);
			placeAuto();
		},
		focusInput: () => body.focusInput(),
		destroy: () => { if (!life.destroy()) return; body.destroy(); box.remove(); },
	};
}

function mountPanelSurface(panelHost, callbacks) {
	const doc = documentOf(panelHost);
	const aside = el(doc, "aside", {
		className: "peer-side-panel",
		attrs: { "aria-label": "Side question", "data-testid": "side-thread-panel" },
	});
	const body = createSideThreadBody(aside, callbacks);
	panelHost.append(aside);
	return {
		update: (payload) => body.update(payload),
		focusInput: () => body.focusInput(),
		destroy: () => { body.destroy(); aside.remove(); },
	};
}

function resolveSegmentFallback(messages, sourceMessageId) {
	const msgs = Array.isArray(messages) ? messages : [];
	if (msgs.length > 0 && msgs.every((m) => Array.isArray(m?.content))) {
		const fromCore = sideSegmentId(msgs, sourceMessageId);
		if (fromCore) return fromCore;
	}
	const assist = [...msgs].reverse().find((m) => m?.role === "assistant");
	return String(sourceMessageId ?? assist?.id ?? msgs.at(-1)?.id ?? "seg_default");
}

function applyFallbackIntent(st, intent) {
	if (intent.type === "open") {
		const seg = resolveSegmentFallback(st.latestModel.messages, intent.args?.sourceMessageId ?? intent.args?.passage?.sourceMessageId);
		st.fallbackState = sideThreadReducer(st.fallbackState, {
			type: "open",
			segmentId: seg,
			anchor: intent.args?.anchor ?? { kind: "composer" },
			passage: intent.args?.passage,
		});
	} else if (intent.type === "close") {
		st.fallbackState = sideThreadReducer(st.fallbackState, { type: "close" });
	} else if (intent.type === "set-mode") {
		st.fallbackState = sideThreadReducer(st.fallbackState, { type: "mode", mode: intent.mode });
	} else if (intent.type === "set-draft") {
		st.fallbackDrafts.set(intent.threadId, intent.text);
	}
}

function syncCompanionSurface(st, hosts, callbacks) {
	const active = st.controlled ? (st.latestModel.sideThread?.active ?? null) : st.fallbackState;
	if (!active) {
		st.surface?.destroy();
		st.surface = null;
		st.mountedMode = "";
		if (hosts.panelHost) hosts.panelHost.hidden = true;
		return;
	}
	const targetMode = active.mode === "panel" ? "panel" : "popover";
	if (targetMode !== st.mountedMode || !st.surface) {
		st.surface?.destroy();
		st.surface = null;
		st.mountedMode = targetMode;
		if (targetMode === "panel" && hosts.panelHost) {
			hosts.panelHost.hidden = false;
			st.surface = mountPanelSurface(hosts.panelHost, callbacks);
		} else if (hosts.popoverHost) {
			if (hosts.panelHost) hosts.panelHost.hidden = true;
			st.surface = mountPopoverSurface(hosts.popoverHost, callbacks);
		}
		st.surface?.focusInput?.();
	}
	const currentSeg = st.latestModel.sideThread?.currentSegmentId ?? resolveSegmentFallback(st.latestModel.messages);
	const draft = st.controlled
		? (st.latestModel.sideThread?.drafts?.[active.threadId] ?? "")
		: (st.fallbackDrafts.get(active.threadId) ?? "");
	st.surface?.update({
		state: active,
		chatId: st.latestModel.chatId,
		mode: st.latestModel.mode,
		draft,
		canJumpCurrentStep: Boolean(currentSeg && active.segmentId && currentSeg !== active.segmentId),
	});
}

export function createSideThreadCompanion(opts = {}) {
	const { popoverHost, panelHost, getComposer, blocks, onExpand, onSideIntent, onRevealCitation } = opts;
	const st = {
		controlled: false, fallbackState: null, fallbackDrafts: new Map(),
		latestModel: { chatId: "", sideThread: undefined, messages: [], mode: "dark" },
		mountedMode: "", surface: null,
	};
	const resolveActive = () => (st.controlled ? (st.latestModel.sideThread?.active ?? null) : st.fallbackState);
	const hosts = { popoverHost, panelHost };
	let callbacks = null;
	const dispatch = (intent) => {
		if (st.controlled && typeof onSideIntent === "function") return onSideIntent(intent);
		applyFallbackIntent(st, intent);
		syncCompanionSurface(st, hosts, callbacks);
		return onSideIntent?.(intent);
	};
	callbacks = {
		getComposer, blocks, onExpand, onRevealCitation,
		onSetMode: (mode) => dispatch({ type: "set-mode", mode }),
		onClose: () => dispatch({ type: "close" }),
		onDraftChange: (text) => { const cur = resolveActive(); if (cur) dispatch({ type: "set-draft", threadId: cur.threadId, text }); },
		onAsk: (text, retry) => { const cur = resolveActive(); return cur ? dispatch({ type: "ask", text, retry, expectedThreadId: cur.threadId }) : false; },
		onStop: () => dispatch({ type: "stop" }),
		onCurrentStep: () => dispatch({ type: "open", args: { anchor: { kind: "composer" } } }),
	};
	return {
		update(next = {}) {
			st.latestModel = next;
			st.controlled = next.sideThread !== undefined && next.sideThread !== null;
			syncCompanionSurface(st, hosts, callbacks);
		},
		open: (args) => { dispatch({ type: "open", args }); st.surface?.focusInput?.(); },
		toggleCurrent: () => {
			if (resolveActive()) { dispatch({ type: "close" }); return true; }
			dispatch({ type: "open", args: { anchor: { kind: "composer" } } });
			st.surface?.focusInput?.();
			return true;
		},
		isOpen: () => Boolean(resolveActive()),
		close: () => { if (!resolveActive()) return false; dispatch({ type: "close" }); return true; },
		destroy: () => { st.surface?.destroy(); st.surface = null; st.mountedMode = ""; if (panelHost) panelHost.hidden = true; },
	};
}
