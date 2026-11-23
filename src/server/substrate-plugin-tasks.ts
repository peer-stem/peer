import fs from "node:fs";
import { listSourceSegments } from "../agent/prompt-segments.ts";
import type { PluginTaskRecord } from "../core/plugin-workers.ts";
import type { PromptAgent, PromptSegmentInfo } from "../core/prompt-segments.ts";
import type { LumberJackStoreBundle } from "../store/lumberjack/index.ts";

export interface CorePluginDataLocation {
	directory: string;
	ids: readonly string[];
}

const SAFE_TASK_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export function readPluginTaskFromBundle(
	bundle: LumberJackStoreBundle,
	pluginId: string,
	taskId?: string,
	requestId?: string,
): PluginTaskRecord | null {
	if (taskId !== undefined && !SAFE_TASK_ID_RE.test(taskId)) throw new Error("Invalid plugin task id");
	if (requestId !== undefined && (typeof requestId !== "string" || !requestId.length)) {
		throw new Error("Invalid plugin task request id");
	}
	if (taskId === undefined && requestId === undefined) throw new Error("A task id or request id is required");
	const store = bundle.pluginTaskStore(pluginId);
	if (taskId !== undefined) {
		const record = store.get(taskId);
		if (record && requestId !== undefined && record.requestId !== requestId) {
			throw new Error("Plugin task/request identity mismatch");
		}
		return record;
	}
	const matching = store.list().filter((record) => record.requestId === requestId);
	if (matching.length > 1) throw new Error("Duplicate plugin task request identity");
	return matching[0] ?? null;
}

function recoverOneLumberJackPluginScope(bundle: LumberJackStoreBundle, pluginId: string): void {
	const store = bundle.pluginTaskStore(pluginId);
	const records = store.list();
	const requests = new Set<string>();
	for (const record of records) {
		if (requests.has(record.requestId)) throw new Error("Duplicate plugin task request identity");
		requests.add(record.requestId);
	}
	for (const record of records) {
		if (record.status !== "queued" && record.status !== "running") continue;
		const now = new Date().toISOString();
		store.save({
			...record,
			status: "interrupted",
			completedAt: now,
			updatedAt: now,
			error: { code: "interrupted", message: "Task interrupted by server restart; no work was replayed" },
		});
	}
}

export function recoverPluginTasksInBundle(bundle: LumberJackStoreBundle): Record<string, string> {
	const errors: Record<string, string> = Object.create(null);
	for (const node of bundle.forest.listChildren("config/plugins")) {
		const pluginId = Buffer.from(node.name, "hex").toString("utf8");
		try {
			recoverOneLumberJackPluginScope(bundle, pluginId);
		} catch (error) {
			errors[pluginId] = error instanceof Error ? error.message : String(error);
		}
	}
	return { ...errors };
}

export function effectiveLumberJackPromptSegments(
	bundle: LumberJackStoreBundle,
	agent: PromptAgent,
	switches: Record<string, boolean>,
): PromptSegmentInfo[] {
	return listSourceSegments(agent).map((segment) => {
		let sourceText = "";
		try {
			sourceText = fs.readFileSync(segment.file, "utf8");
		} catch {
			sourceText = "";
		}
		const overrideText = bundle.promptOverrides.readOverride(segment.path);
		return {
			path: segment.path,
			sourceText,
			overrideText,
			enabled: switches[segment.path] === true && overrideText !== null,
			shared: segment.shared,
		};
	});
}
