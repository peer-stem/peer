/**
 * `PluginUi` pickers & composers (`mountModelPicker`, `mountThinkingPicker`,
 * `mountKnowledgePicker`, `mountDictation`, `mountComposer`, `mountStandardComposer`).
 */
import { FIELD_CLASS, button, el, input, show } from "cloudcanvas-lib/ui";
import { claimPluginInputFocus, defaultThinkingLevel, joinDictation, shortModelName, thinkingLevelLabel } from "peer-engine";
import { createDictationControl } from "../voice/dictation-control.js";
import { createInertHandle, invokePluginCallback } from "./plugin-widgets-basic.js";

const FALLBACK_LEVELS = ["off", "low", "medium", "high"];

export function mountPluginModelPicker(doc, container, initialProps, signal, deps) {
	if (!initialProps || typeof initialProps.onChange !== "function") throw new Error("Model picker requires onChange");
	if (signal?.aborted) return createInertHandle();
	let current = { ...initialProps };
	let disposed = false;
	const sel = el(doc, "select", {
		className: `${FIELD_CLASS} peer-model-select`,
		attrs: { "aria-label": "Plugin model", "data-testid": "plugin-model-picker" },
	});
	const paint = () => {
		const catalog = deps.getModels?.() ?? [];
		const opts = catalog.map((m) => ({ key: `${m.provider}:${m.id}`, provider: m.provider, id: m.id, label: `${shortModelName(m.name || m.id)} · ${m.provider}` }));
		if (current.value && !opts.some((o) => o.provider === current.value.provider && o.id === current.value.id)) {
			opts.unshift({ key: `${current.value.provider}:${current.value.id}`, provider: current.value.provider, id: current.value.id, label: `${shortModelName(current.value.id)} · ${current.value.provider}` });
		}
		if (opts.length === 0) opts.push({ key: "", provider: "", id: "", label: "No models configured" });
		sel.replaceChildren(...opts.map((o) => el(doc, "option", { text: o.label, attrs: { value: o.key } })));
		if (current.value) sel.value = `${current.value.provider}:${current.value.id}`;
		sel.disabled = Boolean(current.disabled) || catalog.length === 0;
	};
	sel.addEventListener("change", () => {
		const [provider, ...rest] = sel.value.split(":");
		const id = rest.join(":");
		if (provider && id) invokePluginCallback(current.onChange, { provider, id }, deps.onError);
	});
	const unsub = deps.subscribeModels?.(() => { if (!disposed) paint(); });
	paint();
	container.replaceChildren(sel);
	const dispose = () => { if (!disposed) { disposed = true; unsub?.(); sel.remove(); } };
	signal?.addEventListener("abort", dispose, { once: true });
	return {
		focus: () => sel.focus(),
		update(patch) { if (!disposed) { current = { ...current, ...patch }; paint(); } },
		dispose,
	};
}

export function mountPluginThinkingPicker(doc, container, initialProps, signal, deps) {
	if (!initialProps || typeof initialProps.onChange !== "function") throw new Error("Thinking picker requires onChange");
	if (signal?.aborted) return createInertHandle();
	let current = { ...initialProps };
	let disposed = false;
	const sel = el(doc, "select", {
		className: `${FIELD_CLASS} peer-thinking-select`,
		attrs: { "aria-label": "Plugin thinking level", "data-testid": "plugin-thinking-picker" },
	});
	const getLevels = () => {
		const catalog = deps.getModels?.() ?? [];
		const hit = current.model ? catalog.find((m) => m.provider === current.model.provider && m.id === current.model.id) : null;
		const levels = hit?.supportedThinkingLevels?.length ? [...hit.supportedThinkingLevels] : [...FALLBACK_LEVELS];
		if (current.value && !levels.includes(current.value)) levels.push(current.value);
		return levels;
	};
	const paint = () => {
		const levels = getLevels();
		sel.replaceChildren(...levels.map((lvl) => el(doc, "option", { text: thinkingLevelLabel(lvl), attrs: { value: lvl } })));
		sel.value = current.value ?? defaultThinkingLevel(levels);
		sel.disabled = Boolean(current.disabled);
	};
	sel.addEventListener("change", () => invokePluginCallback(current.onChange, sel.value, deps.onError));
	const unsub = deps.subscribeModels?.(() => { if (!disposed) paint(); });
	paint();
	container.replaceChildren(sel);
	const dispose = () => { if (!disposed) { disposed = true; unsub?.(); sel.remove(); } };
	signal?.addEventListener("abort", dispose, { once: true });
	return {
		cycle() {
			const levels = getLevels();
			const idx = levels.indexOf(sel.value);
			const next = levels[(idx + 1) % levels.length];
			if (next) invokePluginCallback(current.onChange, next, deps.onError);
		},
		update(patch) { if (!disposed) { current = { ...current, ...patch }; paint(); } },
		dispose,
	};
}

function renderKnowledgePropRow(doc, p, picked, getValue, getOnChange, onError) {
	const row = el(doc, "label", { className: "peer-settings-row" });
	const chk = el(doc, "input", { attrs: { type: "checkbox" } });
	chk.checked = picked.has(p.id);
	chk.addEventListener("change", () => {
		const next = new Set(getValue());
		if (chk.checked) next.add(p.id);
		else next.delete(p.id);
		invokePluginCallback(getOnChange(), Object.freeze([...next]), onError);
	});
	row.append(chk, el(doc, "span", { text: p.name || p.id }));
	return row;
}

export function mountPluginKnowledgePicker(doc, container, initialProps, signal, deps) {
	if (!initialProps || !Array.isArray(initialProps.value) || typeof initialProps.onChange !== "function") {
		throw new Error("Knowledge picker requires value array and onChange");
	}
	if (signal?.aborted) return createInertHandle();
	let current = { ...initialProps };
	let open = false;
	let disposed = false;
	const wrap = el(doc, "div", { className: "peer-plugin-knowledge-picker", attrs: { "data-testid": "plugin-knowledge-picker" } });
	const trigger = button(doc, { label: "Knowledge", onClick: () => { open = !open; paint(); } });
	const pop = el(doc, "div", { className: "peer-settings-group", attrs: { hidden: true } });
	wrap.append(trigger, pop);

	const paint = () => {
		const count = current.value.length;
		trigger.textContent = count > 0 ? `${count} selected` : "Select knowledge";
		trigger.disabled = Boolean(current.disabled);
		show(pop, open && !current.disabled);
		if (!open) return;
		const props = deps.getPropositions?.() ?? [];
		const picked = new Set(current.value);
		const items = props.map((p) => renderKnowledgePropRow(doc, p, picked, () => current.value, () => current.onChange, deps.onError));
		pop.replaceChildren(...(items.length ? items : [el(doc, "span", { className: "peer-settings-hint", text: "No propositions yet." })]));
	};
	const unsub = deps.subscribeGraph?.(() => { if (!disposed && open) paint(); });
	paint();
	container.replaceChildren(wrap);
	const dispose = () => { if (!disposed) { disposed = true; unsub?.(); wrap.remove(); } };
	signal?.addEventListener("abort", dispose, { once: true });
	return {
		update(patch) { if (!disposed) { current = { ...current, ...patch }; paint(); } },
		dispose,
	};
}

export function mountPluginDictation(doc, container, initialProps, signal, deps) {
	if (!initialProps || typeof initialProps.onTranscript !== "function") throw new Error("Dictation requires onTranscript");
	if (signal?.aborted) return { update() {}, dispose() {}, toggle() {}, finish: async () => {}, cancel() {} };
	let current = { ...initialProps };
	let disposed = false;
	const host = el(doc, "div");
	container.replaceChildren(host);
	const ctl = createDictationControl(host, {
		dictation: deps.getDictation?.() ?? null,
		disabled: Boolean(current.disabled),
		onTranscript: (text) => invokePluginCallback(current.onTranscript, text, deps.onError),
		onOpenDeepgramKey: deps.onOpenDeepgramKey,
	});
	const dispose = () => { if (!disposed) { disposed = true; ctl.destroy(); host.remove(); } };
	signal?.addEventListener("abort", dispose, { once: true });
	return {
		toggle: () => { ctl.toggle(); },
		finish: () => ctl.finish(),
		cancel: () => ctl.cancel(),
		update(patch) {
			if (disposed) return;
			current = { ...current, ...patch };
			const onTranscript = (text) => invokePluginCallback(current.onTranscript, text, deps.onError);
			ctl.update({ disabled: Boolean(current.disabled), onTranscript });
		},
		dispose,
	};
}

export function mountPluginComposer(doc, container, initialProps, signal, deps, beforeSend) {
	if (!initialProps || typeof initialProps.value !== "string" || typeof initialProps.onChange !== "function" || typeof initialProps.onSend !== "function") {
		throw new Error("Plugin composer requires value, onChange, and onSend");
	}
	if (signal?.aborted) return createInertHandle();
	let current = { ...initialProps };
	let disposed = false;
	const wrap = el(doc, "div", { className: "peer-composer-row", attrs: { "data-testid": "plugin-composer" } });
	const ta = input(doc, {
		type: "textarea", label: "Plugin input", placeholder: current.placeholder ?? "Write…",
		className: "peer-composer-input", attrs: { rows: "2", "data-testid": "plugin-composer-input" },
	});
	ta.value = current.value;
	const sendBtn = button(doc, { className: "is-primary", label: "Send", onClick: () => triggerSend(), attrs: { "data-testid": "plugin-composer-send" } });
	const stopBtn = button(doc, { label: "Stop", onClick: () => { if (current.onStop) invokePluginCallback(current.onStop, undefined, deps.onError); }, attrs: { "data-testid": "plugin-composer-stop", hidden: true } });
	wrap.append(ta, sendBtn, stopBtn);

	const triggerSend = () => {
		if (disposed || current.busy) return;
		const allow = current.canSend !== undefined ? current.canSend : current.value.trim().length > 0;
		if (!allow) return;
		const run = async () => {
			if (beforeSend) await beforeSend();
			await current.onSend();
		};
		run().catch((err) => deps.onError?.(err));
	};
	ta.addEventListener("input", () => invokePluginCallback(current.onChange, ta.value, deps.onError));
	ta.addEventListener("keydown", (ev) => {
		if (ev.key === "Enter" && !ev.shiftKey && !ev.isComposing) { ev.preventDefault(); triggerSend(); }
	});
	const paint = () => {
		if (ta.value !== current.value) ta.value = current.value;
		ta.placeholder = current.placeholder ?? "Write…";
		const busy = Boolean(current.busy);
		const allow = current.canSend !== undefined ? current.canSend : current.value.trim().length > 0;
		sendBtn.hidden = busy && Boolean(current.onStop);
		sendBtn.disabled = busy || !allow;
		stopBtn.hidden = !(busy && Boolean(current.onStop));
	};
	paint();
	container.replaceChildren(wrap);
	if (current.autoFocus) queueMicrotask(() => { if (!disposed) ta.focus(); });
	const dispose = () => { if (!disposed) { disposed = true; wrap.remove(); } };
	signal?.addEventListener("abort", dispose, { once: true });
	return {
		update(patch) { if (!disposed) { current = { ...current, ...patch }; paint(); } },
		dispose,
	};
}

export function mountPluginStandardComposer(doc, container, initialProps, signal, deps) {
	if (!initialProps?.composer || !initialProps?.model || !initialProps?.thinking || !initialProps?.dictation) {
		throw new Error("Standard composer requires composer, model, thinking, and dictation props");
	}
	if (signal?.aborted) return createInertHandle();
	let current = { ...initialProps };
	let disposed = false;
	const root = el(doc, "div", { className: "peer-composer", attrs: { "data-testid": "plugin-standard-composer" } });
	const compSlot = el(doc, "div");
	const bar = el(doc, "div", { className: "peer-stats-bar" });
	const modelSlot = el(doc, "div");
	const thinkSlot = el(doc, "div");
	const dictSlot = el(doc, "div");
	bar.append(modelSlot, thinkSlot, dictSlot);
	root.append(compSlot, bar);
	container.replaceChildren(root);

	const wrapDictProps = (dp) => ({
		...dp,
		onTranscript: (chunk) => {
			const joined = joinDictation(current.composer.value ?? "", chunk);
			invokePluginCallback(current.composer.onChange, joined, deps.onError);
			return dp.onTranscript(chunk);
		},
	});
	const dictH = mountPluginDictation(doc, dictSlot, wrapDictProps(current.dictation), signal, deps);
	const compH = mountPluginComposer(doc, compSlot, current.composer, signal, deps, () => dictH.finish());
	const modelH = mountPluginModelPicker(doc, modelSlot, current.model, signal, deps);
	const thinkH = mountPluginThinkingPicker(doc, thinkSlot, current.thinking, signal, deps);
	const releaseFocus = claimPluginInputFocus(root, {
		toggleDictation: () => dictH.toggle(),
		cycleModel: () => modelH.focus?.(),
		cycleThinking: () => thinkH.cycle?.(),
	});
	const dispose = () => {
		if (disposed) return;
		disposed = true;
		releaseFocus();
		dictH.dispose(); compH.dispose(); modelH.dispose(); thinkH.dispose();
		root.remove();
	};
	signal?.addEventListener("abort", dispose, { once: true });
	return {
		update(patch) {
			if (disposed) return;
			current = { ...current, ...patch };
			if (patch.composer) compH.update(patch.composer);
			if (patch.model) modelH.update(patch.model);
			if (patch.thinking) thinkH.update(patch.thinking);
			if (patch.dictation) dictH.update(wrapDictProps(patch.dictation));
		},
		dispose,
	};
}
