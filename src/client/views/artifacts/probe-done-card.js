/**
 * Probe conclusion assessment card (`probe-done-card.js`).
 * Uses `parseProbeDoneInput` from `'peer-engine'` to validate model-authored
 * assessment strands before rendering `[data-testid="probe-done-card"]`.
 */
import { el, textNode, writeText } from "cloudcanvas-lib/ui";
import { parseProbeDoneInput } from "peer-engine";
import { createMarkdown } from "../../blocks/markdown.js";

function deriveProbeDoneState(part) {
	const parsed = parseProbeDoneInput(part?.input);
	const assessment = parsed?.assessment ?? null;
	const strands = assessment && Array.isArray(assessment.strands) ? assessment.strands : null;
	const output = part?.output && typeof part.output === "object" ? part.output : null;
	const state = typeof part?.state === "string" ? part.state : "";
	let note = null;
	if (output && output.ok === false) {
		note = `The prober retried: ${String(output.error ?? "")}`;
	} else if (state === "output-error") {
		note = "The assessment was malformed — the prober retried with a corrected one.";
	} else if (!strands) {
		note = "Writing the assessment…";
	}
	return { note, strands, summary: assessment?.summary ? String(assessment.summary) : "" };
}

function buildProbeNoteView(doc, note) {
	const root = el(doc, "div", {
		className: "peer-probe-done-box",
		attrs: { "data-testid": "probe-done-card", "data-peer-part-type": "tool-probe_done" },
	});
	const head = el(doc, "div", { className: "peer-brief-head" });
	head.append(el(doc, "span", { className: "peer-brief-eyebrow", text: "Probe assessment" }));
	const noteEl = el(doc, "p", { className: "peer-artifact-note" });
	const noteText = textNode(doc, noteEl, note);
	root.append(head, noteEl);
	return {
		node: root,
		update: (nextNote) => writeText(noteText, nextNote),
		destroy: () => root.remove(),
	};
}

function renderProbeStrandRows(doc, state, mountMd, nextCtx) {
	const rows = state.strands.map((item) => {
		const row = el(doc, "div", { className: "peer-probe-done-strand" });
		const titleBox = el(doc, "div", { className: "peer-probe-done-strand-title" });
		const bodyBox = el(doc, "div", { className: "peer-probe-done-strand-body" });
		mountMd(titleBox, String(item.strand ?? ""), nextCtx);
		mountMd(bodyBox, String(item.assessment ?? ""), nextCtx);
		row.append(titleBox, bodyBox);
		return row;
	});
	if (state.summary) {
		const sumRow = el(doc, "div", { className: "peer-probe-done-strand" });
		const sumBox = el(doc, "div", { className: "peer-probe-done-strand-body" });
		mountMd(sumBox, state.summary, nextCtx);
		sumRow.append(sumBox);
		rows.push(sumRow);
	}
	return rows;
}

function buildProbeDetailsView(doc, state, ctx) {
	const details = el(doc, "details", {
		className: "peer-probe-done",
		attrs: { "data-testid": "probe-done-card", "data-peer-part-type": "tool-probe_done" },
	});
	const summaryEl = el(doc, "summary");
	const countEl = el(doc, "span", { className: "peer-probe-done-count" });
	const countText = textNode(doc, countEl, "");
	summaryEl.append(el(doc, "span", { text: "Probe assessment" }), countEl);
	const listWrap = el(doc, "div", { className: "peer-probe-done-strands" });
	details.append(summaryEl, listWrap);

	let mdHandles = [];
	let prevSig = "";
	const clearMarkdown = () => {
		for (const m of mdHandles) m.destroy();
		mdHandles = [];
	};
	const mountMd = (hostEl, source, nextCtx) => {
		const activeCtx = nextCtx ?? ctx;
		const fenceFor = activeCtx?.blocks ? (lang) => activeCtx.blocks.fenceFor(lang) : undefined;
		const md = createMarkdown(hostEl, { fenceFor, onExpand: activeCtx?.onExpand });
		md.update({ source, streaming: false, mode: activeCtx?.getMode?.() ?? "dark", displayOnly: true });
		mdHandles.push(md);
	};
	const update = (nextState, nextCtx) => {
		const n = nextState.strands.length;
		writeText(countText, `${n} strand${n === 1 ? "" : "s"}`);
		const sig = JSON.stringify({ s: nextState.strands, sum: nextState.summary });
		if (sig === prevSig) return;
		prevSig = sig;
		clearMarkdown();
		listWrap.replaceChildren(...renderProbeStrandRows(doc, nextState, mountMd, nextCtx));
	};
	update(state, ctx);
	return { node: details, update, destroy: () => { clearMarkdown(); details.remove(); } };
}

export function createProbeDoneHandle(doc, part, ctx) {
	let mode = "";
	let inner = null;

	const handle = {
		key: `probe-done-card:${part.id}`,
		node: el(doc, "div"),
		update(nextPart, nextCtx) {
			const derived = deriveProbeDoneState(nextPart);
			const nextMode = derived.note || !derived.strands ? "note" : "details";
			if (nextMode === mode && inner) {
				if (nextMode === "note") inner.update(derived.note ?? "");
				else inner.update(derived, nextCtx);
				return;
			}
			const prevNode = handle.node;
			const prevInner = inner;
			mode = nextMode;
			inner = nextMode === "note"
				? buildProbeNoteView(doc, derived.note ?? "")
				: buildProbeDetailsView(doc, derived, nextCtx ?? ctx);
			prevNode.replaceWith(inner.node);
			prevInner?.destroy();
			handle.node = inner.node;
		},
		destroy() {
			if (inner) {
				inner.destroy();
				inner = null;
				return;
			}
			handle.node.remove();
		},
	};
	handle.update(part, ctx);
	return handle;
}
