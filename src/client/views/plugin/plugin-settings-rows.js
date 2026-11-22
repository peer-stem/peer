/**
 * `PluginUi.mountSettingsRows` implementation (`src/core/plugin-ui.ts`).
 * Supports `toggle`, `text`, `dropdown`, `number`, and `slider` rows with inline
 * range/custom validation and async save pending/failure feedback.
 */
import { el, show, textNode, writeText } from "cloudcanvas-lib/ui";
import { createInertHandle } from "./plugin-widgets-basic.js";

const ROW_TYPES = new Set(["toggle", "text", "dropdown", "number", "slider"]);

function validateRowsSchema(schema) {
	if (!schema || !Array.isArray(schema.rows)) throw new Error("Plugin settings schema requires a rows array");
	const seen = new Set();
	for (const row of schema.rows) {
		if (!row || typeof row.key !== "string" || !row.key.trim()) throw new Error("Settings row key must be nonempty");
		if (seen.has(row.key)) throw new Error(`Duplicate settings row key: ${row.key}`);
		seen.add(row.key);
		if (typeof row.label !== "string" || !row.label.trim()) throw new Error(`Settings row "${row.key}" requires a label`);
		if (!ROW_TYPES.has(row.type)) throw new Error(`Invalid settings row type: ${String(row.type)}`);
		if (typeof row.onChange !== "function") throw new Error(`Settings row "${row.key}" requires onChange`);
		if (row.type === "dropdown" && (!Array.isArray(row.options) || row.options.length === 0)) {
			throw new Error(`Dropdown row "${row.key}" requires options`);
		}
	}
}

function validateCandidateValue(row, val) {
	if (row.type === "number" || row.type === "slider") {
		if (typeof val !== "number" || !Number.isFinite(val)) return "Enter a valid number.";
		if (typeof row.min === "number" && val < row.min) return `Minimum is ${row.min}.`;
		if (typeof row.max === "number" && val > row.max) return `Maximum is ${row.max}.`;
	}
	if (typeof row.validate === "function") {
		const msg = row.validate(val);
		if (typeof msg === "string" && msg.trim()) return msg.trim();
	}
	return null;
}

function buildRowControl(doc, row, onCandidate) {
	if (row.type === "toggle") {
		const chk = el(doc, "input", { attrs: { type: "checkbox", "aria-label": row.label, "data-testid": `plugin-setting-${row.key}` } });
		chk.checked = Boolean(row.value);
		chk.addEventListener("change", () => onCandidate(chk.checked));
		return { node: chk, sync: (r, busy) => { chk.checked = Boolean(r.value); chk.disabled = Boolean(r.disabled) || busy; } };
	}
	if (row.type === "dropdown") {
		const sel = el(doc, "select", { className: "peer-settings-select", attrs: { "aria-label": row.label, "data-testid": `plugin-setting-${row.key}` } });
		const sync = (r, busy) => {
			sel.replaceChildren(...r.options.map((o) => el(doc, "option", { text: o.label, attrs: { value: o.value } })));
			sel.value = String(r.value ?? "");
			sel.disabled = Boolean(r.disabled) || busy;
		};
		sync(row, false);
		sel.addEventListener("change", () => onCandidate(sel.value));
		return { node: sel, sync };
	}
	const inputType = row.type === "slider" ? "range" : row.type === "number" ? "number" : "text";
	const inp = el(doc, "input", {
		className: "peer-settings-input",
		attrs: {
			type: inputType,
			"aria-label": row.label,
			"data-testid": `plugin-setting-${row.key}`,
			...(typeof row.min === "number" ? { min: String(row.min) } : {}),
			...(typeof row.max === "number" ? { max: String(row.max) } : {}),
			...(typeof row.step === "number" ? { step: String(row.step) } : {}),
		},
	});
	inp.value = String(row.value ?? "");
	const evt = row.type === "slider" ? "change" : "change";
	inp.addEventListener(evt, () => {
		const parsed = row.type === "text" ? inp.value : Number(inp.value);
		onCandidate(parsed);
	});
	return {
		node: inp,
		sync: (r, busy) => {
			if (doc.activeElement !== inp) inp.value = String(r.value ?? "");
			inp.disabled = Boolean(r.disabled) || busy;
		},
	};
}

function runAsyncRowChange(promise, setBusy, setErr, onError) {
	setBusy(true);
	promise.then(
		() => setBusy(false),
		(err) => { setBusy(false); setErr(err instanceof Error ? err.message : String(err)); onError?.(err); },
	);
}

function createMountedRow(doc, initialRow, onError) {
	let current = initialRow;
	let busy = false;
	const wrap = el(doc, "div", { className: "peer-settings-group", attrs: { "data-plugin-setting-row": current.key } });
	const top = el(doc, "div", { className: "peer-settings-row" });
	const labelCol = el(doc, "div");
	const titleEl = el(doc, "div", { className: "peer-settings-row-label" });
	const titleTxt = textNode(doc, titleEl, current.label);
	const descEl = el(doc, "div", { className: "peer-settings-hint", attrs: { hidden: !current.description } });
	const descTxt = textNode(doc, descEl, current.description ?? "");
	labelCol.append(titleEl, descEl);

	const errEl = el(doc, "p", { className: "peer-settings-error", attrs: { role: "alert", hidden: true } });
	const errTxt = textNode(doc, errEl, "");
	const setErr = (msg) => { show(errEl, Boolean(msg)); writeText(errTxt, msg ?? ""); };
	const handleRowCandidate = (val) => {
		const vErr = validateCandidateValue(current, val);
		if (vErr) { setErr(vErr); return; }
		setErr(null);
		try {
			const res = current.onChange(val);
			if (res && typeof res.then === "function") runAsyncRowChange(res, (b) => { busy = b; ctl.sync(current, b); }, setErr, onError);
		} catch (err) {
			setErr(err instanceof Error ? err.message : String(err));
			onError?.(err);
		}
	};
	const ctl = buildRowControl(doc, current, handleRowCandidate);
	top.append(labelCol, ctl.node);
	wrap.append(top, errEl);
	return {
		key: current.key,
		type: current.type,
		node: wrap,
		update(nextRow) {
			current = nextRow;
			writeText(titleTxt, nextRow.label);
			show(descEl, Boolean(nextRow.description));
			writeText(descTxt, nextRow.description ?? "");
			ctl.sync(nextRow, busy);
		},
	};
}

function reconcileMountedRows(doc, mounted, rows, onError) {
	const nextMap = new Map();
	const nodes = [];
	for (const row of rows) {
		const existing = mounted.get(row.key);
		const entry = existing && existing.type === row.type ? (existing.update(row), existing) : createMountedRow(doc, row, onError);
		nextMap.set(row.key, entry);
		nodes.push(entry.node);
	}
	return { nextMap, nodes };
}

export function mountPluginSettingsRows(doc, container, initialSchema, signal, onError) {
	validateRowsSchema(initialSchema);
	if (signal?.aborted) return createInertHandle();
	let disposed = false;
	const root = el(doc, "div", { className: "peer-settings-group", attrs: { "data-testid": "plugin-settings-rows" } });
	let mounted = new Map();

	const reconcile = (rows) => {
		const res = reconcileMountedRows(doc, mounted, rows, onError);
		mounted = res.nextMap;
		root.replaceChildren(...res.nodes);
	};
	reconcile(initialSchema.rows);
	container.replaceChildren(root);

	const dispose = () => { if (!disposed) { disposed = true; mounted.clear(); root.remove(); } };
	signal?.addEventListener("abort", dispose, { once: true });
	return {
		update(patch) {
			if (disposed) return;
			const nextSchema = { rows: patch?.rows ?? [] };
			validateRowsSchema(nextSchema);
			reconcile(nextSchema.rows);
		},
		dispose,
	};
}
