/**
 * Core `PluginUi` leaf widgets: `mountButton`, `mountBadge`, `mountMarkdown`,
 * `mountWorkerResult`, and `mountPluginContent` (`src/core/plugin-ui.ts` contract).
 */
import { SR_ONLY_CLASS, el, textNode, writeText } from "cloudcanvas-lib/ui";
import { createMarkdown } from "../../blocks/markdown.js";
import { injectPluginStyles } from "./plugin.css.js";

const BUTTON_VARIANTS = new Set(["default", "destructive", "outline", "secondary", "ghost", "link", "custom"]);
const BUTTON_SIZES = new Set(["default", "xs", "sm", "lg", "icon", "icon-xs", "icon-sm", "icon-lg"]);
const WORKER_STATUSES = new Set(["succeeded", "failed", "cancelled", "interrupted"]);
const WORKER_PRESENTATIONS = new Set(["collapsed", "card", "plain"]);

export function createInertHandle() {
	return { update() {}, dispose() {} };
}

export function combineSignals(a, b) {
	if (!a) return b;
	if (!b) return a;
	return AbortSignal.any([a, b]);
}

export function invokePluginCallback(fn, arg, onError) {
	try {
		const out = fn(arg);
		if (out && typeof out.then === "function") out.catch((err) => onError?.(err));
	} catch (err) {
		onError?.(err);
	}
}

function runCleanupFn(fn, onError) {
	try {
		const res = fn();
		if (res && typeof res.then === "function") res.catch((e) => onError?.(e));
	} catch (e) {
		onError?.(e);
	}
}

function adoptAsyncCleanup(promise, isDisposed, setCleanup, onError) {
	promise.then(
		(fn) => {
			if (typeof fn !== "function") return;
			if (isDisposed()) runCleanupFn(fn, onError);
			else setCleanup(fn);
		},
		(err) => onError?.(err),
	);
}

export function mountPluginContent(doc, container, content, parentSignal, onError) {
	const ctrl = new AbortController();
	const signal = combineSignals(parentSignal, ctrl.signal);
	let cleanup = null;
	let disposed = false;
	const dispose = () => {
		if (disposed) return;
		disposed = true;
		ctrl.abort();
		if (typeof cleanup === "function") {
			const fn = cleanup;
			cleanup = null;
			runCleanupFn(fn, onError);
		}
		container.replaceChildren();
	};
	if (signal?.aborted) return { dispose };
	signal?.addEventListener("abort", dispose, { once: true });
	if (content && typeof content === "object" && "nodeType" in content) {
		container.replaceChildren(content);
		return { dispose };
	}
	if (typeof content === "function") {
		try {
			const ret = content(container, signal);
			if (typeof ret === "function") cleanup = ret;
			else if (ret && typeof ret.then === "function") adoptAsyncCleanup(ret, () => disposed, (fn) => { cleanup = fn; }, onError);
		} catch (err) { onError?.(err); }
	}
	return { dispose };
}

function validateCssColor(doc, value, label) {
	if (value === undefined) return;
	if (typeof value !== "string" || !value.trim()) throw new Error(`Invalid ${label} color`);
	const probe = doc.createElement("span");
	probe.style.color = value.trim();
	if (!probe.style.color) throw new Error(`Invalid CSS color for ${label}: ${value}`);
}

function validateButtonColors(doc, colors) {
	if (colors === undefined) return;
	if (!colors || typeof colors !== "object") throw new Error("Button colors must be an object");
	for (const key of ["background", "text", "border"]) validateCssColor(doc, colors[key], key);
	for (const stateKey of ["hover", "active", "disabled", "focusVisible"]) {
		const sub = colors[stateKey];
		if (sub === undefined) continue;
		if (!sub || typeof sub !== "object") throw new Error(`Invalid button ${stateKey} colors`);
		for (const k of ["background", "text", "border"]) validateCssColor(doc, sub[k], `${stateKey}.${k}`);
		if (stateKey === "focusVisible") validateCssColor(doc, sub.ring, "focusVisible.ring");
	}
}

function validateButtonProps(doc, props) {
	if (!props || typeof props !== "object") throw new Error("Button props must be an object");
	if (typeof props.label !== "string" || !props.label.trim()) throw new Error("Button label must be a nonempty string");
	if (typeof props.onClick !== "function") throw new Error("Button onClick must be a function");
	if (props.iconOnly && (typeof props.icon !== "string" || !props.icon.trim())) {
		throw new Error("iconOnly button requires a nonempty SVG icon");
	}
	if (props.variant !== undefined && !BUTTON_VARIANTS.has(props.variant)) throw new Error(`Invalid button variant: ${props.variant}`);
	if (props.size !== undefined && !BUTTON_SIZES.has(props.size)) throw new Error(`Invalid button size: ${props.size}`);
	validateButtonColors(doc, props.colors);
}

export function mountPluginButton(doc, container, initialProps, signal, onError) {
	validateButtonProps(doc, initialProps);
	if (signal?.aborted) return createInertHandle();
	injectPluginStyles(doc);
	let current = { ...initialProps };
	let disposed = false;
	const btn = el(doc, "button", { className: "peer-plugin-btn", attrs: { type: "button", "data-testid": "plugin-ui-button" } });
	const iconSpan = el(doc, "span", { className: "peer-plugin-btn-icon", attrs: { "aria-hidden": "true", hidden: true } });
	const labelSpan = el(doc, "span");
	btn.append(iconSpan, labelSpan);

	const paint = () => {
		btn.setAttribute("data-variant", current.variant ?? "secondary");
		btn.setAttribute("data-size", current.size ?? "default");
		btn.disabled = Boolean(current.disabled);
		if (current.title) btn.title = current.title;
		else btn.removeAttribute("title");
		if (current.icon) { iconSpan.innerHTML = current.icon; iconSpan.hidden = false; }
		else { iconSpan.replaceChildren(); iconSpan.hidden = true; }
		labelSpan.textContent = current.label;
		labelSpan.className = current.iconOnly ? SR_ONLY_CLASS : "";
		btn.setAttribute("aria-label", current.label);
		const custom = current.variant === "custom" ? current.colors : null;
		btn.style.background = custom?.background ?? "";
		btn.style.color = custom?.text ?? "";
		btn.style.borderColor = custom?.border ?? "";
	};
	btn.addEventListener("click", () => { if (!disposed && !btn.disabled) invokePluginCallback(current.onClick, undefined, onError); });
	paint();
	container.replaceChildren(btn);
	const dispose = () => { if (!disposed) { disposed = true; btn.remove(); } };
	signal?.addEventListener("abort", dispose, { once: true });
	return {
		update(patch) {
			if (disposed) return;
			const merged = { ...current, ...patch };
			validateButtonProps(doc, merged);
			current = merged;
			paint();
		},
		dispose,
	};
}

export function mountPluginBadge(doc, container, initialProps, signal) {
	const validate = (p) => {
		if (!p || typeof p.text !== "string" || !p.text.trim()) throw new Error("Badge text must be a nonempty string");
		validateCssColor(doc, p.color, "badge");
	};
	validate(initialProps);
	if (signal?.aborted) return createInertHandle();
	injectPluginStyles(doc);
	let current = { ...initialProps };
	let disposed = false;
	const badge = el(doc, "span", { className: "peer-plugin-badge", attrs: { "data-testid": "plugin-ui-badge" } });
	const txt = textNode(doc, badge, current.text);
	const paint = () => {
		writeText(txt, current.text);
		badge.style.color = current.color ?? "";
		badge.style.background = current.color ? `color-mix(in srgb, ${current.color} 15%, transparent)` : "";
	};
	paint();
	container.replaceChildren(badge);
	const dispose = () => { if (!disposed) { disposed = true; badge.remove(); } };
	signal?.addEventListener("abort", dispose, { once: true });
	return {
		update(patch) {
			if (disposed) return;
			const merged = { ...current, ...patch };
			validate(merged);
			current = merged;
			paint();
		},
		dispose,
	};
}

export function mountPluginMarkdown(doc, container, initialProps, signal) {
	if (!initialProps || typeof initialProps.text !== "string") throw new Error("Markdown text must be a string");
	if (signal?.aborted) return createInertHandle();
	let current = { ...initialProps };
	let disposed = false;
	const host = el(doc, "div", { className: "peer-plugin-markdown", attrs: { "data-testid": "plugin-ui-markdown" } });
	container.replaceChildren(host);
	const md = createMarkdown(host, { displayOnly: true });
	const mode = () => (doc.documentElement?.classList?.contains("light") ? "light" : "dark");
	md.update({ source: current.text, streaming: false, mode: mode(), displayOnly: true });
	const dispose = () => { if (!disposed) { disposed = true; md.destroy(); host.remove(); } };
	signal?.addEventListener("abort", dispose, { once: true });
	return {
		update(patch) {
			if (disposed) return;
			const merged = { ...current, ...patch };
			if (typeof merged.text !== "string") throw new Error("Markdown text must be a string");
			current = merged;
			md.update({ source: current.text, streaming: false, mode: mode(), displayOnly: true });
		},
		dispose,
	};
}

function validateWorkerResultProps(p) {
	if (!p || typeof p.label !== "string" || !p.label.trim()) throw new Error("Worker result label must be nonempty");
	if (!WORKER_STATUSES.has(p.status)) throw new Error(`Invalid worker status: ${String(p.status)}`);
	if (typeof p.text !== "string") throw new Error("Worker result text must be a string");
	if (p.presentation !== undefined && !WORKER_PRESENTATIONS.has(p.presentation)) {
		throw new Error(`Invalid worker presentation: ${String(p.presentation)}`);
	}
}

export function mountPluginWorkerResult(doc, container, initialProps, signal, onError) {
	validateWorkerResultProps(initialProps);
	if (signal?.aborted) return createInertHandle();
	let current = { ...initialProps };
	let disposed = false;
	let contentLease = null;
	const root = el(doc, "div", { className: "peer-plugin-worker-ui", attrs: { "data-testid": "plugin-ui-worker-result" } });
	const mdHost = el(doc, "div");
	const md = createMarkdown(mdHost, { displayOnly: true });
	const customHost = el(doc, "div");
	container.replaceChildren(root);

	const paint = () => {
		contentLease?.dispose();
		contentLease = null;
		const mode = doc.documentElement?.classList?.contains("light") ? "light" : "dark";
		md.update({ source: current.text, streaming: false, mode, displayOnly: true });
		const pres = current.presentation ?? "collapsed";
		root.setAttribute("data-presentation", pres);
		root.setAttribute("data-status", current.status);
		const body = el(doc, "div", { className: "peer-worker-body" });
		body.append(mdHost);
		if (current.content !== undefined) {
			body.append(customHost);
			contentLease = mountPluginContent(doc, customHost, current.content, signal, onError);
		}
		if (pres === "collapsed") {
			const details = el(doc, "details", { className: "peer-worker-details" });
			details.append(el(doc, "summary", { className: "peer-worker-summary", text: `${current.label} · ${current.status}` }), body);
			root.replaceChildren(details);
			return;
		}
		const head = el(doc, "div", { className: "peer-session-card-head" });
		head.append(el(doc, "span", { className: "peer-session-card-title", text: current.label }), el(doc, "span", { className: "peer-session-card-meta", text: current.status }));
		root.replaceChildren(head, body);
	};
	paint();
	const dispose = () => { if (!disposed) { disposed = true; contentLease?.dispose(); md.destroy(); root.remove(); } };
	signal?.addEventListener("abort", dispose, { once: true });
	return {
		update(patch) {
			if (disposed) return;
			const merged = { ...current, ...patch };
			validateWorkerResultProps(merged);
			current = merged;
			paint();
		},
		dispose,
	};
}
