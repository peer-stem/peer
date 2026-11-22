/**
 * Dictation control view (`[data-testid="dictation-toggle"]`, `[data-testid="dictation-bar"]`,
 * `[data-testid="dictation-meter"]`, `components/dictation.tsx` parity).
 */
import { button, createLife, documentOf, el, injectUiStyles, show, textNode, uniqueId, writeText } from "cloudcanvas-lib/ui";
import { injectVoiceStyles } from "./voice.css.js";

function buildDictationNodes(doc, life, actions) {
	const root = el(doc, "div", { className: "peer-dictation-wrap", attrs: { "data-peer-dictation": "" } });
	const toggleBtn = el(doc, "button", {
		className: "peer-dictation-toggle",
		attrs: { type: "button", "data-testid": "dictation-toggle", "aria-label": "Start dictation", "aria-pressed": "false" },
	});
	const toggleLabel = textNode(doc, toggleBtn, "Dictate");
	life.on(toggleBtn, "pointerenter", () => actions.warm());
	life.on(toggleBtn, "focus", () => actions.warm());
	life.on(toggleBtn, "click", () => actions.toggle());

	const bar = el(doc, "div", { className: "peer-dictation-bar", attrs: { "data-testid": "dictation-bar", hidden: true } });
	const meter = el(doc, "span", {
		className: "peer-dictation-meter",
		attrs: { "data-testid": "dictation-meter", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": "0" },
	});
	const meterFill = el(doc, "span", { className: "peer-dictation-meter-fill" });
	meterFill.style.width = "0%";
	meter.append(meterFill);
	bar.append(meter, button(doc, {
		label: "Cancel", ariaLabel: "Cancel dictation", signal: life.signal,
		onClick: () => actions.cancel(), attrs: { "data-testid": "dictation-cancel" },
	}));

	const errBtn = el(doc, "button", { className: "peer-dictation-error", attrs: { type: "button", "data-testid": "dictation-error", hidden: true } });
	const errText = textNode(doc, errBtn, "");
	life.on(errBtn, "click", () => actions.onErrorClick());
	root.append(toggleBtn, bar, errBtn);
	return { root, toggleBtn, toggleLabel, bar, meter, meterFill, errBtn, errText };
}

function paintDictationNodes(nodes, state) {
	const snap = state.store?.get?.() ?? null;
	const mine = Boolean(snap && snap.activeTargetId === state.targetId);
	const phase = mine ? snap.phase : "idle";
	const active = phase === "connecting" || phase === "recording" || phase === "stopping";
	nodes.toggleBtn.disabled = Boolean(state.disabled) || phase === "stopping";
	nodes.toggleBtn.classList.toggle("is-recording", active);
	nodes.toggleBtn.setAttribute("aria-pressed", String(active));
	nodes.toggleBtn.setAttribute("aria-label", active ? "Stop dictation" : "Start dictation");
	const label = phase === "connecting" ? "Starting…" : phase === "recording" ? "Stop" : phase === "stopping" ? "Finishing…" : "Dictate";
	writeText(nodes.toggleLabel, label);

	show(nodes.bar, phase === "recording" || phase === "connecting");
	const pct = mine ? Math.round(Math.max(0, Math.min(1, snap?.level ?? 0)) * 100) : 0;
	nodes.meterFill.style.width = `${pct}%`;
	nodes.meter.setAttribute("aria-valuenow", String(pct));

	const err = mine && snap?.error ? String(snap.error) : "";
	show(nodes.errBtn, err !== "");
	writeText(nodes.errText, err);
	nodes.errBtn.setAttribute("data-missing-key", String(Boolean(mine && snap?.missingKey)));
}

function createDictationActions(life, state) {
	const isMineActive = () => {
		const snap = state.store?.get?.();
		return Boolean(snap && snap.activeTargetId === state.targetId && snap.phase !== "idle");
	};
	const toggle = () => {
		if (life.dead || state.disabled || !state.store) return false;
		if (isMineActive()) { void state.store.finish(state.targetId); return true; }
		void state.store.start({ targetId: state.targetId, onTranscript: (c) => { if (!life.dead) state.onTranscript?.(c); } });
		return true;
	};
	return {
		isMineActive,
		toggle,
		finish: async () => { if (isMineActive()) await state.store?.finish?.(state.targetId); },
		cancel: () => { if (isMineActive()) state.store?.cancel?.(state.targetId); },
		warm: () => { if (!state.disabled) state.store?.warmToken?.(); },
		onErrorClick: () => {
			const snap = state.store?.get?.();
			if (snap?.activeTargetId === state.targetId && snap?.missingKey) state.onOpenDeepgramKey?.();
		},
	};
}

export function createDictationControl(host, opts = {}) {
	const doc = documentOf(host);
	injectUiStyles(doc);
	injectVoiceStyles(doc);
	const life = createLife();
	const state = {
		targetId: opts.targetId || uniqueId("peer-dict"),
		store: null, unsub: null, disabled: Boolean(opts.disabled),
		onTranscript: opts.onTranscript, onOpenDeepgramKey: opts.onOpenDeepgramKey,
	};
	const actions = createDictationActions(life, state);
	const nodes = buildDictationNodes(doc, life, actions);
	const bindStore = (nextStore) => {
		if (nextStore === state.store) return;
		state.unsub?.();
		state.store = nextStore ?? null;
		state.unsub = state.store?.subscribe ? state.store.subscribe(() => { if (!life.dead) paintDictationNodes(nodes, state); }) : null;
	};
	bindStore(opts.dictation ?? null);
	paintDictationNodes(nodes, state);
	host.append(nodes.root);

	const update = (next = {}) => {
		if (life.dead) return;
		if ("dictation" in next) bindStore(next.dictation);
		if ("disabled" in next) state.disabled = Boolean(next.disabled);
		if ("onTranscript" in next) state.onTranscript = next.onTranscript;
		if ("onOpenDeepgramKey" in next) state.onOpenDeepgramKey = next.onOpenDeepgramKey;
		paintDictationNodes(nodes, state);
	};
	const destroy = () => { if (life.destroy()) { actions.cancel(); state.unsub?.(); nodes.root.remove(); } };
	return { node: nodes.root, toggle: actions.toggle, finish: actions.finish, cancel: actions.cancel, warm: actions.warm, isActive: actions.isMineActive, update, destroy };
}
