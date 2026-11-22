/**
 * Background sub-agent dispatch card (`dispatch-card.js`).
 * Matches `job = (ctx?.getJobs?.() ?? []).find((j) => j.toolCallId === part.toolCallId) ?? null`
 * and renders running/pending `[data-testid="dispatch-card"]`, BYOK/key refusal
 * `[data-testid="dispatch-refused"]`, or settled `[data-testid="dispatch-settled"]`.
 */
import { createLife, el, textNode, writeText } from "cloudcanvas-lib/ui";
import { createSpinner } from "peer-kit";
import { isModelsRefusal, isProviderKeyRefusal } from "peer-engine";

const KIND_LABEL = Object.freeze({
	research: "Research agent",
	demo: "Demo agent",
	visual: "Figure agent",
	pdf: "PDF reader",
	plugin: "Plugin worker",
});

function resolveJobLabel(kind, job) {
	if (kind === "plugin") {
		return job?.plugin?.label || job?.plugin?.toolName || KIND_LABEL.plugin;
	}
	return KIND_LABEL[kind] || "Sub-agent";
}

function computeElapsedSeconds(createdAt) {
	if (!createdAt) return null;
	const ms = Date.parse(String(createdAt));
	if (!Number.isFinite(ms)) return null;
	return Math.max(0, Math.round((Date.now() - ms) / 1000));
}

function classifyDispatchVariant(job) {
	if (!job || job.status === "running") return "running";
	if (isModelsRefusal(job.error)) return "refused-models";
	if (isProviderKeyRefusal(job.error)) return "refused-key";
	return job.status === "error" ? "settled-error" : "settled-done";
}

function buildRunningView(doc, label, job) {
	const root = el(doc, "div", {
		className: "peer-dispatch-card",
		attrs: { "data-testid": "dispatch-card" },
	});
	const head = el(doc, "div", { className: "peer-dispatch-head" });
	const spinnerHost = el(doc, "span", { className: "peer-dispatch-spinner" });
	const spinner = createSpinner(spinnerHost);
	spinner.update({ label: `${label} running`, size: 14 });
	const labelEl = el(doc, "span", { className: "peer-dispatch-label" });
	const labelText = textNode(doc, labelEl, label);
	const elapsedEl = el(doc, "span", { className: "peer-dispatch-elapsed", attrs: { hidden: true } });
	const elapsedText = textNode(doc, elapsedEl, "");
	head.append(spinnerHost, labelEl, elapsedEl);
	const subSlot = el(doc, "div", { className: "peer-dispatch-sub" });
	root.append(head, subSlot);

	const syncElapsed = (createdAt) => {
		const sec = computeElapsedSeconds(createdAt);
		elapsedEl.hidden = sec === null;
		writeText(elapsedText, sec !== null ? `· ${sec}s` : "");
	};
	const syncJob = (nextLabel, nextJob) => {
		writeText(labelText, nextLabel);
		spinner.update({ label: `${nextLabel} running`, size: 14 });
		syncElapsed(nextJob?.createdAt);
		if (nextJob?.activity) {
			subSlot.replaceChildren(el(doc, "div", {
				className: "peer-dispatch-activity",
				text: String(nextJob.activity),
				attrs: { "data-testid": "dispatch-activity-line" },
			}));
		} else if (!nextJob) {
			subSlot.replaceChildren(el(doc, "div", {
				className: "peer-dispatch-pending",
				text: "Dispatched…",
				attrs: { "data-testid": "dispatch-pending" },
			}));
		} else {
			subSlot.replaceChildren();
		}
	};
	syncJob(label, job);
	return { root, syncJob, syncElapsed, destroySpinner: () => spinner.destroy() };
}

function buildRefusedNode(doc, life, label, isKeyRefusal, getCtx) {
	const line = isKeyRefusal ? "needs a provider key" : "needs model setup";
	const btnLabel = isKeyRefusal ? "Add a key" : "Set up models";
	const root = el(doc, "div", {
		className: "peer-dispatch-refused",
		attrs: { "data-testid": "dispatch-refused" },
	});
	const setupBtn = el(doc, "button", {
		className: "peer-dispatch-setup-btn",
		text: btnLabel,
		attrs: { type: "button", "data-testid": "dispatch-setup-link" },
	});
	life.on(setupBtn, "click", () => getCtx()?.onOpenSetup?.());
	root.append(
		el(doc, "span", { text: "⚙", attrs: { "aria-hidden": "true" } }),
		el(doc, "span", { className: "peer-dispatch-label", text: label }),
		el(doc, "span", { text: line }),
		setupBtn,
	);
	return root;
}

function buildSettledNode(doc, label, failed) {
	const root = el(doc, "div", {
		className: "peer-dispatch-settled",
		attrs: { "data-testid": "dispatch-settled" },
	});
	root.append(
		el(doc, "span", {
			className: failed ? "peer-dispatch-glyph is-error" : "peer-dispatch-glyph",
			text: failed ? "✕" : "✓",
			attrs: { "aria-hidden": "true" },
		}),
		el(doc, "span", { className: "peer-dispatch-label", text: label }),
		el(doc, "span", { text: failed ? "failed" : "finished" }),
	);
	return root;
}

function mountDispatchVariant(doc, viewLife, variant, label, job, getCtx) {
	if (variant === "running") {
		const runningView = buildRunningView(doc, label, job);
		return { runningView, node: runningView.root };
	}
	if (variant === "refused-models" || variant === "refused-key") {
		return { runningView: null, node: buildRefusedNode(doc, viewLife, label, variant === "refused-key", getCtx) };
	}
	return { runningView: null, node: buildSettledNode(doc, label, variant === "settled-error") };
}

export function createDispatchCardHandle(doc, part, ctx) {
	const st = { ctx, part, variant: "", viewLife: null, runningView: null, timerId: null };
	const stopTimer = () => {
		if (st.timerId !== null) clearInterval(st.timerId);
		st.timerId = null;
	};
	const syncTimer = (job) => {
		stopTimer();
		if (!job?.createdAt || !st.runningView) return;
		st.timerId = setInterval(() => st.runningView?.syncElapsed(job.createdAt), 1000);
		st.timerId.unref?.();
	};
	const teardown = () => {
		stopTimer();
		st.runningView?.destroySpinner();
		st.runningView = null;
		st.viewLife?.destroy();
		st.viewLife = null;
	};
	const handle = {
		key: `dispatch-card:${part.id}`,
		node: el(doc, "div"),
		update(nextPart, nextCtx) {
			st.part = nextPart ?? st.part;
			if (nextCtx !== undefined) st.ctx = nextCtx;
			const kind = st.part.dispatchKind || st.part.kindName || "research";
			const jobs = st.ctx?.getJobs?.() ?? st.part?.jobs ?? [];
			const job = Array.isArray(jobs) ? jobs.find((j) => j && j.toolCallId === st.part.toolCallId) ?? null : null;
			const label = resolveJobLabel(kind, job);
			const nextVariant = classifyDispatchVariant(job);
			if (nextVariant === "running" && st.variant === "running" && st.runningView) {
				st.runningView.syncJob(label, job);
				syncTimer(job);
				return;
			}
			teardown();
			st.variant = nextVariant;
			st.viewLife = createLife();
			const mounted = mountDispatchVariant(doc, st.viewLife, nextVariant, label, job, () => st.ctx);
			st.runningView = mounted.runningView;
			if (st.runningView) syncTimer(job);
			if (st.part.partType) mounted.node.setAttribute("data-peer-part-type", st.part.partType);
			handle.node.replaceWith(mounted.node);
			handle.node = mounted.node;
		},
		destroy: () => { teardown(); handle.node.remove(); },
	};
	handle.update(part, ctx);
	return handle;
}
