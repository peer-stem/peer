import type { CompactionDetails } from "./compaction.ts";
import type { PlanBlockData } from "./contracts/chat.ts";
import type { SubagentArtifactData, SubagentResultMeta } from "./contracts/jobs.ts";
import type { LhMarkerMessage } from "./native-messages.ts";
import type { LhViewMessage, LhViewPart } from "./view.ts";

function markerTextPart(text: string): LhViewPart {
	return { type: "text", text, state: "done" };
}

function lastSuccessfulPlanInit(parts: LhViewPart[]): number {
	let idx = -1;
	parts.forEach((p, i) => {
		if (p.type !== "tool-plan_init") return;
		const ok = (p.output as { ok?: unknown } | undefined)?.ok;
		if (ok === true) idx = i;
	});
	return idx;
}

function pushUserDataMarker(out: LhViewMessage[], id: string, type: string, partId: string, data: unknown): void {
	out.push({ id, role: "user", parts: [{ type, id: partId, data }] });
}

function projectSubagentMarker(marker: LhMarkerMessage, out: LhViewMessage[]): void {
	if (marker.customType === "subagent-abort") {
		const meta = marker.details as SubagentResultMeta & { aborted: true };
		out.push({
			id: marker.id,
			role: "user",
			metadata: { subagentResult: meta },
			parts: [markerTextPart(marker.content), { type: "data-subagent-aborted", id: `sa_${marker.id}`, data: meta }],
		});
		return;
	}
	const meta = marker.details as SubagentResultMeta;
	const artifact = marker.details as {
		kind: SubagentArtifactData["kind"];
		result: SubagentArtifactData["result"];
		ui?: SubagentArtifactData["ui"];
	};
	out.push({
		id: marker.id,
		role: "user",
		metadata: { subagentResult: meta },
		parts: [
			markerTextPart(marker.content),
			{
				type: "data-subagent-artifact",
				id: `sa_${marker.id}`,
				data: { kind: artifact.kind, result: artifact.result, ui: artifact.ui },
			},
		],
	});
}

function splicePlanBlockMarker(marker: LhMarkerMessage, out: LhViewMessage[]): void {
	const group = out[out.length - 1];
	if (!group || group.role !== "assistant") return;
	const idx = lastSuccessfulPlanInit(group.parts);
	if (idx === -1) return;
	const { block } = marker.details as { planCallId: string; block: PlanBlockData };
	group.parts.splice(idx + 1, 0, { type: "data-plan-block", id: marker.id, data: block });
}

/** A marker's projected message (handoff/steers) or splice (plan block). */
export function projectMarker(marker: LhMarkerMessage, out: LhViewMessage[]): void {
	switch (marker.customType) {
		case "graph-context": {
			const details = marker.details as { source?: unknown } | null | undefined;
			if (marker.display === false || details?.source === "mfn") return;
			pushUserDataMarker(out, marker.id, "data-graph-context", `gc_${marker.id}`, marker.details);
			return;
		}
		case "probe-handoff":
			pushUserDataMarker(out, marker.id, "data-probe-handoff", `ph_${marker.id}`, marker.details);
			return;
		case "subagent-steer":
		case "subagent-abort":
			projectSubagentMarker(marker, out);
			return;
		case "plugin-problem-submission":
			pushUserDataMarker(out, marker.id, "data-plugin-problem-submission", `ps_${marker.id}`, marker.details);
			return;
		case "practice-thinking":
			pushUserDataMarker(out, marker.id, "data-practice-thinking", `pt_${marker.id}`, marker.details);
			return;
		case "practice-next":
			pushUserDataMarker(out, marker.id, "data-practice-next", `pn_${marker.id}`, null);
			return;
		case "side-question":
		case "side-question-told":
		case "problem-dismissed":
			return;
		case "compaction":
			pushUserDataMarker(out, marker.id, "data-compaction", `cm_${marker.id}`, {
				content: marker.content,
				details: marker.details as CompactionDetails,
			});
			return;
		case "plan-block":
			splicePlanBlockMarker(marker, out);
			return;
	}
}
