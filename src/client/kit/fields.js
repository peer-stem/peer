/**
 * Bounded numeric stepper (`L-9`) and range slider (`L-11`) controls.
 */
import { FIELD_CLASS, clamp, createLife, documentOf, el, textNode, writeText } from "cloudcanvas-lib/ui";
import { injectKitStyles } from "./styles.js";

function normalizeNumeric(raw, min, max, step) {
	const num = Number(raw);
	if (!Number.isFinite(num)) return null;
	const lo = Number.isFinite(min) ? min : -Infinity;
	const hi = Number.isFinite(max) ? max : Infinity;
	const clamped = clamp(num, lo, hi);
	if (!Number.isFinite(step) || step <= 0) return clamped;
	const base = Number.isFinite(min) ? min : 0;
	const snapped = base + Math.round((clamped - base) / step) * step;
	return clamp(Number(snapped.toFixed(6)), lo, hi);
}

function applyNumberFieldModel(doc, field, model = {}) {
	const value = Number.isFinite(model.value) ? model.value : 0;
	const state = { value, min: model.min, max: model.max, step: model.step };
	if (model.label) field.setAttribute("aria-label", String(model.label));
	if (model.min !== undefined) field.min = String(model.min); else field.removeAttribute("min");
	if (model.max !== undefined) field.max = String(model.max); else field.removeAttribute("max");
	if (model.step !== undefined) field.step = String(model.step); else field.removeAttribute("step");
	field.disabled = Boolean(model.disabled);
	if (doc.activeElement !== field) field.value = String(state.value);
	return state;
}

/**
 * @param {HTMLElement} host
 * @param {{onChange?: (value: number) => void}} [callbacks]
 */
export function createNumberField(host, { onChange } = {}) {
	const doc = documentOf(host);
	injectKitStyles(doc);
	const life = createLife();
	const root = el(doc, "div", { className: "cloudcanvas-ui-number-field" });
	const field = el(doc, "input", { className: FIELD_CLASS, attrs: { type: "number" } });
	root.append(field);
	host.append(root);

	let state = { value: 0, min: undefined, max: undefined, step: undefined };
	const commit = () => {
		const next = normalizeNumeric(field.value, state.min, state.max, state.step);
		if (next === null) { field.value = String(state.value); return; }
		field.value = String(next);
		if (next !== state.value) { state.value = next; onChange?.(next); }
	};

	life.on(field, "change", commit);
	life.on(field, "blur", commit);
	life.on(field, "keydown", (event) => {
		if (event.key === "Enter") { event.preventDefault(); commit(); }
	});

	return {
		root,
		input: field,
		update(model = {}) {
			if (!life.dead) state = applyNumberFieldModel(doc, field, model);
		},
		destroy() {
			if (life.destroy()) root.remove();
		},
	};
}

function applySliderModel(slider, readout, readoutText, formatValue, model = {}) {
	const fmt = typeof model.format === "function" ? model.format : formatValue;
	const min = Number.isFinite(model.min) ? model.min : 0;
	const max = Number.isFinite(model.max) ? model.max : 100;
	const step = Number.isFinite(model.step) ? model.step : 1;
	const value = clamp(Number.isFinite(model.value) ? model.value : min, min, max);
	slider.min = String(min);
	slider.max = String(max);
	slider.step = String(step);
	slider.value = String(value);
	slider.disabled = Boolean(model.disabled);
	if (model.label) slider.setAttribute("aria-label", String(model.label));
	readout.hidden = model.showValue === false;
	writeText(readoutText, fmt(value));
	return fmt;
}

/**
 * @param {HTMLElement} host
 * @param {{onInput?: (value: number) => void, onChange?: (value: number) => void}} [callbacks]
 */
export function createSliderField(host, { onInput, onChange } = {}) {
	const doc = documentOf(host);
	injectKitStyles(doc);
	const life = createLife();
	const root = el(doc, "div", { className: "cloudcanvas-ui-slider-field" });
	const slider = el(doc, "input", { className: "cloudcanvas-ui-slider-input", attrs: { type: "range" } });
	const readout = el(doc, "span", { className: "cloudcanvas-ui-slider-readout" });
	const readoutText = textNode(doc, readout, "");
	root.append(slider, readout);
	host.append(root);

	let formatValue = (v) => String(v);
	life.on(slider, "input", () => {
		const v = Number(slider.value);
		writeText(readoutText, formatValue(v));
		onInput?.(v);
	});
	life.on(slider, "change", () => onChange?.(Number(slider.value)));

	return {
		root,
		input: slider,
		update(model = {}) {
			if (!life.dead) formatValue = applySliderModel(slider, readout, readoutText, formatValue, model);
		},
		destroy() {
			if (life.destroy()) root.remove();
		},
	};
}
