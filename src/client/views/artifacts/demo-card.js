/**
 * Sandboxed interactive HTML demo artifact card (`demo-card.js`).
 * Exports `DEMO_BRIDGE_SCRIPT`, `buildDemoSrcDoc`, `INITIAL_DEMO_BRIDGE_STATE`,
 * `reduceDemoBridgeState`, and `createDemoOutputHandle(doc, part, ctx)`.
 */
import { createLife, el, textNode, writeText } from "cloudcanvas-lib/ui";
import { downloadFile, slugFilename } from "./download.js";

export const DEMO_BRIDGE_SCRIPT = `<script>(function(){
var send=function(m){try{parent.postMessage(m,"*")}catch(e){}};
var post=function(){
var b=document.body;
if(!b){send({type:"demo-resize",height:document.documentElement.scrollHeight});return}
var h=Math.max(b.scrollHeight,b.getBoundingClientRect().height);
var cs=getComputedStyle(b);
h+=(parseFloat(cs.marginTop)||0)+(parseFloat(cs.marginBottom)||0);
send({type:"demo-resize",height:Math.ceil(h)})
};
if(typeof ResizeObserver!=="undefined"){new ResizeObserver(post).observe(document.documentElement)}
window.addEventListener("resize",post);
window.addEventListener("load",post);
window.addEventListener("error",function(e){send({type:"demo-error",message:e.message||String(e)})});
setTimeout(post,50);
setTimeout(post,400);
})();</script>`;

export function buildDemoSrcDoc(html) {
	const raw = String(html ?? "");
	if (/<\/body>/i.test(raw)) return raw.replace(/<\/body>/i, `${DEMO_BRIDGE_SCRIPT}</body>`);
	return `${raw}${DEMO_BRIDGE_SCRIPT}`;
}

export const INITIAL_DEMO_BRIDGE_STATE = Object.freeze({ height: null, error: null });

const MIN_HEIGHT = 80;
const MAX_HEIGHT = 2400;

export function reduceDemoBridgeState(state, data) {
	if (typeof data !== "object" || data === null) return state;
	if (data.type === "demo-resize") {
		if (typeof data.height !== "number" || !Number.isFinite(data.height) || data.height <= 0) return state;
		const height = Math.min(Math.max(Math.round(data.height), MIN_HEIGHT), MAX_HEIGHT);
		return height === state.height ? state : { ...state, height };
	}
	if (data.type === "demo-error") {
		const text = typeof data.message === "string" && data.message.trim() ? data.message : "unknown error";
		return text === state.error ? state : { ...state, error: text };
	}
	return state;
}

function extractDemoProps(part) {
	const raw = part?.result ?? part?.output ?? null;
	const res = raw && typeof raw === "object" ? raw : null;
	const valid = res && typeof res.html === "string" && typeof res.title === "string" && res.html.length > 0;
	return {
		valid: Boolean(valid),
		res,
		title: valid ? res.title : "",
		html: valid ? res.html : "",
		messageId: part?.messageId,
		inverted: Boolean(part?.inverted ?? part?.initialInverted ?? false),
	};
}

function buildFailedDemoNode(doc, result) {
	if (!result || typeof result.html !== "string" || typeof result.title !== "string") {
		return el(doc, "div", {
			className: "peer-artifact-fallback",
			text: "Demo completed, but the result could not be displayed.",
		});
	}
	const root = el(doc, "div", { className: "peer-demo-card", attrs: { "data-testid": "demo-card-failed" } });
	const head = el(doc, "div", { className: "peer-brief-head" });
	head.append(
		el(doc, "span", { className: "peer-demo-eyebrow", text: "Interactive demo" }),
		el(doc, "span", { className: "peer-artifact-badge-error", text: "failed" }),
	);
	root.append(head, el(doc, "p", { className: "peer-artifact-note", text: result.notes ?? "The demo could not be built." }));
	return root;
}

function buildErrorChipDom(doc, life, message, onSendError) {
	const chip = el(doc, "div", { className: "peer-demo-error-chip", attrs: { "data-testid": "demo-error-chip" } });
	const msgEl = el(doc, "span", { className: "peer-demo-error-msg", text: message, attrs: { title: message } });
	const sendBtn = el(doc, "button", {
		className: "peer-demo-error-send",
		text: "Send to teacher",
		attrs: { type: "button", "data-testid": "demo-error-send" },
	});
	life.on(sendBtn, "click", () => onSendError());
	chip.append(el(doc, "span", { text: "This demo threw an error" }), msgEl, sendBtn);
	return chip;
}

function buildDemoCardDom(doc, initialTitle, initialInverted) {
	const root = el(doc, "div", { className: "peer-demo-card", attrs: { "data-testid": "demo-card" } });
	const header = el(doc, "div", { className: "peer-demo-header" });
	const titleGroup = el(doc, "div", { className: "peer-demo-title-group" });
	const titleEl = el(doc, "span", { className: "peer-demo-title" });
	const titleText = textNode(doc, titleEl, initialTitle);
	titleGroup.append(el(doc, "span", { className: "peer-demo-eyebrow", text: "interactive demo" }), titleEl);
	const actions = el(doc, "div", { className: "peer-demo-actions" });
	const invertBtn = el(doc, "button", {
		className: "peer-artifact-icon-btn",
		text: "◐",
		attrs: {
			type: "button",
			"data-testid": "demo-invert",
			"aria-label": "Invert demo brightness",
			"aria-pressed": String(initialInverted),
			title: "Invert colors",
		},
	});
	const downloadBtn = el(doc, "button", {
		className: "peer-artifact-icon-btn",
		text: "↓",
		attrs: { type: "button", "data-testid": "demo-download", "aria-label": "Download demo as HTML", title: "Download as HTML" },
	});
	actions.append(invertBtn, downloadBtn);
	header.append(titleGroup, actions);
	const errorSlot = el(doc, "div", { className: "peer-demo-error-slot", attrs: { hidden: true } });
	const iframe = el(doc, "iframe", {
		className: "peer-demo-iframe",
		attrs: { title: initialTitle, sandbox: "allow-scripts", scrolling: "no", "data-testid": "demo-iframe" },
	});
	iframe.style.boxSizing = "content-box";
	root.append(header, errorSlot, iframe);
	return { root, titleText, invertBtn, downloadBtn, errorSlot, iframe };
}

function bindDemoEvents(doc, life, st, dom, getCtx, helpers) {
	life.on(dom.invertBtn, "click", () => {
		st.inverted = !st.inverted;
		helpers.syncFrameStyle();
		getCtx()?.onInvertArtifact?.(st.messageId, st.inverted);
	});
	life.on(dom.downloadBtn, "click", () => downloadFile(`${slugFilename(st.title)}.html`, st.html, "text/html", doc));
	const win = doc.defaultView ?? globalThis.window;
	if (!win || typeof win.addEventListener !== "function") return;
	life.on(win, "message", (event) => {
		if (!dom.iframe.contentWindow || event.source !== dom.iframe.contentWindow) return;
		const next = reduceDemoBridgeState(st.bridge, event.data);
		if (next === st.bridge) return;
		const errChanged = next.error !== st.bridge.error;
		st.bridge = next;
		helpers.syncFrameStyle();
		if (errChanged) helpers.syncErrorChip();
	});
}

function buildHealthyDemoView(doc, initial, getCtx) {
	const life = createLife();
	const st = {
		errorLife: createLife(),
		bridge: INITIAL_DEMO_BRIDGE_STATE,
		title: initial.title,
		html: initial.html,
		messageId: initial.messageId,
		inverted: Boolean(initial.inverted),
		propInverted: Boolean(initial.inverted),
	};
	const dom = buildDemoCardDom(doc, st.title, st.inverted);
	const syncFrameStyle = () => {
		dom.iframe.style.height = `${st.bridge.height ?? 360}px`;
		dom.iframe.style.filter = st.inverted ? "invert(1) hue-rotate(180deg)" : "";
		dom.invertBtn.setAttribute("aria-pressed", String(st.inverted));
	};
	const syncSrcDoc = (nextHtml) => {
		const docStr = buildDemoSrcDoc(nextHtml);
		dom.iframe.srcdoc = docStr;
		dom.iframe.setAttribute("srcdoc", docStr);
	};
	const syncErrorChip = () => {
		st.errorLife.destroy();
		st.errorLife = createLife();
		dom.errorSlot.hidden = !st.bridge.error;
		if (!st.bridge.error) { dom.errorSlot.replaceChildren(); return; }
		const sendErr = () => getCtx()?.onSendText?.(`The demo "${st.title}" threw an error: ${st.bridge.error}`);
		dom.errorSlot.replaceChildren(buildErrorChipDom(doc, st.errorLife, st.bridge.error, sendErr));
	};
	bindDemoEvents(doc, life, st, dom, getCtx, { syncFrameStyle, syncErrorChip });
	syncSrcDoc(st.html);
	syncFrameStyle();
	return {
		root: dom.root,
		update: (next) => applyHealthyDemoUpdate(st, dom, next, { syncSrcDoc, syncErrorChip, syncFrameStyle }),
		destroy: () => { st.errorLife.destroy(); life.destroy(); dom.root.remove(); },
	};
}

function applyHealthyDemoUpdate(st, dom, next, helpers) {
	if (next.title !== st.title) {
		st.title = next.title;
		writeText(dom.titleText, st.title);
		dom.iframe.title = st.title;
	}
	if (next.html !== st.html) {
		st.html = next.html;
		st.bridge = INITIAL_DEMO_BRIDGE_STATE;
		helpers.syncSrcDoc(st.html);
		helpers.syncErrorChip();
	}
	st.messageId = next.messageId;
	if (Boolean(next.inverted) !== st.propInverted) {
		st.propInverted = Boolean(next.inverted);
		st.inverted = st.propInverted;
	}
	helpers.syncFrameStyle();
}

export function createDemoOutputHandle(doc, part, ctx) {
	let currentCtx = ctx;
	let healthy = null;
	const handle = {
		key: `demo-output:${part?.id ?? "demo"}`,
		node: el(doc, "div"),
		update(nextPart, nextCtx) {
			if (nextCtx !== undefined) currentCtx = nextCtx;
			const props = extractDemoProps(nextPart);
			if (!props.valid) {
				const prevHealthy = healthy;
				healthy = null;
				const fallback = buildFailedDemoNode(doc, props.res);
				handle.node.replaceWith(fallback);
				prevHealthy?.destroy();
				handle.node = fallback;
				return;
			}
			if (healthy) { healthy.update(props); return; }
			healthy = buildHealthyDemoView(doc, props, () => currentCtx);
			handle.node.replaceWith(healthy.root);
			handle.node = healthy.root;
		},
		destroy() {
			if (healthy) { healthy.destroy(); healthy = null; return; }
			handle.node.remove();
		},
	};
	handle.update(part, ctx);
	return handle;
}
