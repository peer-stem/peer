/**
 * In-session `Mod+F` Find bar (`session-find.js`).
 * Uses `sessionFindRanges`, `sameSessionRange`, `sessionRangeIdentity`,
 * `stepSessionMatch`, and `scrollSessionTarget` from `'peer-engine'`, and
 * publishes Custom Highlight API ranges (`lh-session-find`, `lh-session-find-active`).
 */
import { createLife, documentOf, el, textNode, writeText } from "cloudcanvas-lib/ui";
import {
	sameSessionRange,
	scrollSessionTarget,
	sessionFindRanges,
	sessionRangeIdentity,
	stepSessionMatch,
} from "peer-engine";

export const SESSION_FIND_HIGHLIGHT = "lh-session-find";
export const SESSION_FIND_ACTIVE_HIGHLIGHT = "lh-session-find-active";
const FIND_STYLE_ID = "lh-session-find-style";

export function injectSessionFindStyles(doc = globalThis.document) {
	if (!doc?.createElement || !doc.head || doc.getElementById(FIND_STYLE_ID)) return;
	const style = doc.createElement("style");
	style.id = FIND_STYLE_ID;
	style.textContent = `
::highlight(${SESSION_FIND_HIGHLIGHT}) { background-color: color-mix(in oklab, var(--cc-accent, #38bdf8) 28%, transparent); }
::highlight(${SESSION_FIND_ACTIVE_HIGHLIGHT}) { background-color: var(--cc-accent, #38bdf8); color: var(--cc-ui-on-accent, #0f172a); }`;
	doc.head.append(style);
}

export function clearSessionFindHighlights() {
	const cssObj = globalThis.CSS;
	if (!cssObj?.highlights) return;
	cssObj.highlights.delete(SESSION_FIND_HIGHLIGHT);
	cssObj.highlights.delete(SESSION_FIND_ACTIVE_HIGHLIGHT);
}

function publishFindHighlights(ranges, activeIndex) {
	const cssObj = globalThis.CSS;
	const HighlightCtor = globalThis.Highlight;
	if (!cssObj?.highlights || typeof HighlightCtor !== "function") return;
	const all = new HighlightCtor();
	for (const r of ranges) all.add?.(r);
	cssObj.highlights.set(SESSION_FIND_HIGHLIGHT, all);
	const active = new HighlightCtor();
	active.priority = 1;
	if (ranges[activeIndex]) active.add?.(ranges[activeIndex]);
	cssObj.highlights.set(SESSION_FIND_ACTIVE_HIGHLIGHT, active);
}

function buildFindBarDom(doc, life, actions) {
	const root = el(doc, "div", {
		className: "peer-session-find",
		attrs: { role: "search", "aria-label": "Session Find", "data-testid": "session-find", hidden: true },
	});
	const queryInput = el(doc, "input", {
		className: "cloudcanvas-ui-input peer-session-find-input",
		attrs: {
			type: "text",
			"aria-label": "Find in session",
			placeholder: "Find in session…",
			spellcheck: "false",
		},
	});
	const countEl = el(doc, "output", {
		className: "peer-session-find-count",
		attrs: { "aria-live": "polite", "data-testid": "session-find-count" },
	});
	const countText = textNode(doc, countEl, "");

	const prevBtn = el(doc, "button", {
		className: "peer-artifact-icon-btn",
		text: "↑",
		attrs: { type: "button", "aria-label": "Previous match", title: "Previous match (Shift+Enter)" },
	});
	const nextBtn = el(doc, "button", {
		className: "peer-artifact-icon-btn",
		text: "↓",
		attrs: { type: "button", "aria-label": "Next match", title: "Next match (Enter)" },
	});
	const closeBtn = el(doc, "button", {
		className: "peer-artifact-icon-btn",
		text: "✕",
		attrs: { type: "button", "aria-label": "Close Find", title: "Close Find (Esc)" },
	});
	prevBtn.addEventListener("mousedown", (ev) => ev.preventDefault());
	nextBtn.addEventListener("mousedown", (ev) => ev.preventDefault());
	life.on(prevBtn, "click", () => actions.step(-1));
	life.on(nextBtn, "click", () => actions.step(1));
	life.on(closeBtn, "click", () => actions.close());

	root.append(queryInput, countEl, prevBtn, nextBtn, closeBtn);
	return { root, queryInput, countText, prevBtn, nextBtn };
}

function createFindObserver(win, getScope, onRefresh) {
	let observer = null;
	let rafId = null;
	const disconnect = () => {
		observer?.disconnect();
		observer = null;
		if (rafId !== null && win?.cancelAnimationFrame) win.cancelAnimationFrame(rafId);
		rafId = null;
	};
	const start = () => {
		disconnect();
		const scope = getScope?.() ?? null;
		if (!scope || typeof MutationObserver !== "function") return;
		const schedule = () => {
			if (rafId !== null) return;
			if (typeof win?.requestAnimationFrame === "function") {
				rafId = win.requestAnimationFrame(() => { rafId = null; onRefresh(); });
			} else {
				onRefresh();
			}
		};
		observer = new MutationObserver(schedule);
		observer.observe(scope, {
			subtree: true,
			childList: true,
			characterData: true,
			attributes: true,
			attributeFilter: ["hidden", "style", "class", "aria-expanded"],
		});
	};
	return { start, disconnect };
}

function paintFindState(st, dom) {
	writeText(dom.countText, st.query ? `${st.currentIndex + 1}/${st.ranges.length}` : "");
	dom.prevBtn.disabled = st.ranges.length === 0;
	dom.nextBtn.disabled = st.ranges.length === 0;
	publishFindHighlights(st.ranges, st.currentIndex);
}

function refreshFindMatches(st, dom, getScope, getScrollContext, selectFirst) {
	const scope = getScope?.() ?? null;
	if (!st.open || !scope) return;
	st.ranges = sessionFindRanges(scope, st.query);
	let idx = selectFirst ? 0 : st.ranges.findIndex((r) => sameSessionRange(r, st.currentIdentity));
	if (idx < 0) idx = Math.max(0, Math.min(st.currentIndex, st.ranges.length - 1));
	if (st.ranges.length === 0) idx = -1;
	st.currentIndex = idx;
	st.currentIdentity = st.ranges[idx] ? sessionRangeIdentity(st.ranges[idx]) : null;
	paintFindState(st, dom);
	if (selectFirst && st.ranges[idx]) scrollSessionTarget(st.ranges[idx], scope, getScrollContext?.() ?? null);
}

function bindFindKeyboard(life, st, dom, refresh, step, close) {
	life.on(dom.queryInput, "input", () => {
		st.query = dom.queryInput.value;
		const isNewQuery = st.lastQuery !== st.query;
		st.lastQuery = st.query;
		refresh(isNewQuery);
	});
	life.on(dom.root, "keydown", (ev) => {
		if (ev.key === "Enter") {
			ev.stopPropagation();
			if (ev.target === dom.queryInput && !ev.isComposing) {
				ev.preventDefault();
				step(ev.shiftKey ? -1 : 1);
			}
		} else if (ev.key === "Escape") {
			ev.preventDefault();
			ev.stopPropagation();
			close();
		}
	});
}

function openFindBar(doc, st, dom, obs, refresh) {
	if (!st.open) {
		st.previousFocus = doc.activeElement;
		st.open = true;
		dom.root.hidden = false;
		obs.start();
		refresh(st.lastQuery !== st.query);
		st.lastQuery = st.query;
	}
	dom.queryInput.focus?.({ preventScroll: true });
	dom.queryInput.select?.();
	return true;
}

export function createSessionFind(host, { getScope, getScrollContext } = {}) {
	const doc = documentOf(host);
	const win = doc.defaultView ?? globalThis.window;
	injectSessionFindStyles(doc);
	const life = createLife();
	const st = {
		open: false, query: "", lastQuery: null, ranges: [],
		currentIndex: -1, currentIdentity: null, previousFocus: null,
	};
	let dom = null;
	const refresh = (first) => refreshFindMatches(st, dom, getScope, getScrollContext, first);
	const obs = createFindObserver(win, getScope, () => refresh(false));
	const step = (direction) => {
		if (st.ranges.length === 0) return;
		st.currentIndex = stepSessionMatch(st.currentIndex, st.ranges.length, direction);
		st.currentIdentity = st.ranges[st.currentIndex] ? sessionRangeIdentity(st.ranges[st.currentIndex]) : null;
		paintFindState(st, dom);
		const scope = getScope?.() ?? null;
		if (st.ranges[st.currentIndex] && scope) scrollSessionTarget(st.ranges[st.currentIndex], scope, getScrollContext?.() ?? null);
	};
	const close = () => {
		if (!st.open) return false;
		st.open = false;
		obs.disconnect();
		clearSessionFindHighlights();
		dom.root.hidden = true;
		st.previousFocus?.focus?.({ preventScroll: true });
		return true;
	};
	dom = buildFindBarDom(doc, life, { step, close });
	host.append(dom.root);
	bindFindKeyboard(life, st, dom, refresh, step, close);
	return {
		open: () => (life.dead ? false : openFindBar(doc, st, dom, obs, refresh)),
		close,
		isOpen: () => st.open,
		resetSession: () => {
			st.query = ""; st.lastQuery = null; st.ranges = []; st.currentIndex = -1; st.currentIdentity = null;
			dom.queryInput.value = ""; close();
		},
		destroy: () => { if (!life.destroy()) return; obs.disconnect(); clearSessionFindHighlights(); dom.root.remove(); },
	};
}
