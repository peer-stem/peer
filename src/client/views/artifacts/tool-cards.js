/**
 * Live streaming tool card (`[data-testid="live-tool-card"]`) and collapsed
 * synchronous tool-call card (`[data-testid="tool-call-card"]`) (`tool-cards.js`).
 */
import { el, textNode, writeText } from "cloudcanvas-lib/ui";
import { createSpinner } from "peer-kit";
import { toolActivityLabel } from "peer-engine";

export const TOOL_CALL_NAMES = new Set([
	"read",
	"ls",
	"find",
	"grep",
	"show_image",
	"list_propositions",
	"list_sessions",
]);

export function liveHeadlineArg(input) {
	const inp = input && typeof input === "object" ? input : {};
	if (typeof inp.path === "string" && inp.path) return inp.path;
	if (typeof inp.pattern === "string" && inp.pattern) return inp.pattern;
	if (typeof inp.session === "string" && inp.session) return inp.session;
	return "";
}

export function headlineToolArg(tool, input) {
	const inp = input && typeof input === "object" ? input : {};
	if (tool === "read" || tool === "ls" || tool === "show_image") {
		return typeof inp.path === "string" && inp.path.length > 0 ? inp.path : "~";
	}
	if (typeof inp.pattern === "string") return inp.pattern;
	if (tool === "list_propositions" && typeof inp.session === "string" && inp.session.length > 0) {
		return inp.session;
	}
	return "";
}

export function formatToolOutputText(output) {
	if (output == null) return null;
	if (typeof output === "string") return output;
	if (typeof output === "object" && "text" in output) {
		const text = typeof output.text === "string" ? output.text : null;
		const count = Array.isArray(output.images) ? output.images.length : 0;
		if (count > 0) {
			return `${text ?? ""}\n[${count} image${count > 1 ? "s" : ""} attached to the model]`.trim();
		}
		return text;
	}
	try {
		return JSON.stringify(output, null, 2);
	} catch {
		return String(output);
	}
}

export function createLiveToolHandle(doc, part) {
	const initialTool = String(part.toolName || String(part.partType ?? "").replace(/^tool-/, ""));
	const details = el(doc, "details", {
		className: "peer-live-tool-card",
		attrs: {
			"data-testid": "live-tool-card",
			"data-tool": initialTool,
			"data-peer-part-type": part.partType || `tool-${initialTool}`,
		},
	});
	const summary = el(doc, "summary", { className: "peer-tool-summary" });
	const spinnerHost = el(doc, "span");
	const spinner = createSpinner(spinnerHost);
	const labelEl = el(doc, "span", { className: "peer-live-tool-activity" });
	const labelText = textNode(doc, labelEl, "");
	const argEl = el(doc, "span", { className: "peer-tool-arg", attrs: { hidden: true } });
	const argText = textNode(doc, argEl, "");
	summary.append(spinnerHost, labelEl, argEl);

	const body = el(doc, "div", { className: "peer-tool-body" });
	const preEl = el(doc, "pre", { className: "peer-tool-pre" });
	const preText = textNode(doc, preEl, "…");
	body.append(el(doc, "div", { className: "peer-brief-eyebrow", text: "Input (streaming)" }), preEl);
	details.append(summary, body);

	const update = (next) => {
		const tool = String(next.toolName || String(next.partType ?? "").replace(/^tool-/, ""));
		const actLabel = toolActivityLabel(tool);
		details.setAttribute("data-tool", tool);
		spinner.update({ label: `${actLabel} — live`, size: 12 });
		writeText(labelText, actLabel);
		const arg = liveHeadlineArg(next.input);
		argEl.hidden = arg === "";
		writeText(argText, arg);
		const hasInput = next.input != null && typeof next.input === "object" && Object.keys(next.input).length > 0;
		writeText(preText, hasInput ? JSON.stringify(next.input, null, 2) : "…");
	};
	update(part);

	return {
		key: `live-tool-card:${part.id}`,
		node: details,
		update,
		destroy: () => {
			spinner.destroy();
			details.remove();
		},
	};
}

function populateToolCallBody(doc, body, part, out, failed) {
	const sections = [];
	if (part.input != null) {
		const sec = el(doc, "div");
		sec.append(
			el(doc, "div", { className: "peer-brief-eyebrow", text: "Input" }),
			el(doc, "pre", { className: "peer-tool-pre", text: JSON.stringify(part.input, null, 2) }),
		);
		sections.push(sec);
	}
	if (typeof part.errorText === "string" && part.errorText) {
		const sec = el(doc, "div");
		sec.append(
			el(doc, "div", { className: "peer-brief-eyebrow", text: "Error" }),
			el(doc, "pre", { className: "peer-tool-pre is-error", text: part.errorText }),
		);
		sections.push(sec);
	} else if (out != null) {
		const sec = el(doc, "div");
		sec.append(
			el(doc, "div", { className: "peer-brief-eyebrow", text: "Output" }),
			el(doc, "pre", { className: "peer-tool-pre", text: out }),
		);
		sections.push(sec);
	} else if (!failed && part.state !== "output-available") {
		sections.push(el(doc, "div", { className: "peer-artifact-note", text: "running…" }));
	}
	body.replaceChildren(...sections);
}

export function createToolCallHandle(doc, part) {
	const initialTool = String(part.toolName || String(part.partType ?? "").replace(/^tool-/, ""));
	const details = el(doc, "details", {
		className: "peer-tool-call-card",
		attrs: {
			"data-testid": "tool-call-card",
			"data-tool": initialTool,
			"data-peer-part-type": part.partType || `tool-${initialTool}`,
		},
	});
	const summary = el(doc, "summary", { className: "peer-tool-summary" });
	const labelEl = el(doc, "span", { className: "peer-tool-label" });
	const labelText = textNode(doc, labelEl, initialTool);
	const argEl = el(doc, "span", { className: "peer-tool-arg", attrs: { hidden: true } });
	const argText = textNode(doc, argEl, "");
	summary.append(labelEl, argEl);
	const body = el(doc, "div", { className: "peer-tool-body" });
	details.append(summary, body);

	let prevSig = "";
	const update = (next) => {
		const tool = String(next.toolName || String(next.partType ?? "").replace(/^tool-/, ""));
		const arg = headlineToolArg(tool, next.input);
		const out = formatToolOutputText(next.output);
		const failed = next.state === "output-error" || Boolean(next.errorText);
		details.setAttribute("data-tool", tool);
		labelEl.classList.toggle("is-error", failed);
		writeText(labelText, tool);
		argEl.hidden = arg === "";
		writeText(argText, arg);
		const sig = JSON.stringify({ i: next.input, o: out, e: next.errorText, s: next.state });
		if (sig === prevSig) return;
		prevSig = sig;
		populateToolCallBody(doc, body, next, out, failed);
	};
	update(part);

	return {
		key: `tool-call-card:${part.id}`,
		node: details,
		update,
		destroy: () => details.remove(),
	};
}
