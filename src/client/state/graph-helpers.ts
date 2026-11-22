/**
 * Normalization, fetch, and mutation helpers for `GraphStore` (`c2a-frozen-contracts §3.7`).
 */

import {
	sanitizeRenderSettings,
	type GraphCostSummary,
	type GraphRenderSettings,
	type GraphSnapshot,
	type SourceDirectory,
} from "../../core/index.ts";
import { ApiError, apiPath, isAbortError, type ApiClient } from "./api.ts";
import type {
	GraphImportResultItem,
	GraphPipelineRun,
	GraphStoreModel,
} from "./graph.ts";
import type { Cell } from "./store.ts";

export interface GraphContext {
	readonly api: ApiClient;
	readonly cell: Cell<GraphStoreModel>;
	readonly controllers: Set<AbortController>;
	readonly seenRunIds: Set<string>;
	disposed: boolean;
	userTouchedRenderSettings: boolean;
	loadTicket: number;
	activeLoad: AbortController | null;
	inFlightSnapshot: Promise<void> | null;
	pendingSnapshotReload: boolean;
}

export function sanitizePositionsMap(
	raw: Readonly<Record<string, { readonly x: number; readonly y: number }>> | null | undefined,
): Readonly<Record<string, { readonly x: number; readonly y: number }>> {
	const out: Record<string, { readonly x: number; readonly y: number }> = {};
	if (!raw || typeof raw !== "object") return Object.freeze(out);
	for (const [id, pt] of Object.entries(raw)) {
		if (!pt || typeof pt.x !== "number" || typeof pt.y !== "number") continue;
		if (!Number.isFinite(pt.x) || !Number.isFinite(pt.y)) continue;
		out[id] = Object.freeze({ x: pt.x, y: pt.y });
	}
	return Object.freeze(out);
}

function normalizeSourceDirectory(raw: unknown): SourceDirectory | null {
	if (!raw || typeof raw !== "object") return null;
	const r = raw as Record<string, unknown>;
	const org = r.organization as Record<string, unknown> | undefined;
	if (!org || typeof org !== "object" || !Array.isArray(org.folders) || !Array.isArray(r.sources)) {
		return null;
	}
	const placements =
		org.placements && typeof org.placements === "object" && !Array.isArray(org.placements)
			? (org.placements as SourceDirectory["organization"]["placements"])
			: {};
	return {
		organization: {
			version: 1,
			folders: org.folders as SourceDirectory["organization"]["folders"],
			placements,
		},
		sources: r.sources as SourceDirectory["sources"],
	};
}

function formatRunStartedAt(value: unknown): string {
	if (typeof value === "number" && Number.isFinite(value)) return new Date(value).toISOString();
	if (typeof value === "string") return value;
	return "";
}

function normalizePipelineRun(raw: unknown): GraphPipelineRun | null {
	if (!raw || typeof raw !== "object") return null;
	const r = raw as Record<string, unknown>;
	if (typeof r.id !== "string" || typeof r.chatId !== "string") return null;
	return Object.freeze({
		id: r.id,
		chatId: r.chatId,
		title: typeof r.title === "string" ? r.title : r.chatId,
		phase: typeof r.phase === "string" ? r.phase : "running",
		startedAt: formatRunStartedAt(r.startedAt),
	});
}

function normalizeImportResult(raw: unknown): GraphImportResultItem | null {
	if (!raw || typeof raw !== "object") return null;
	const r = raw as Record<string, unknown>;
	if (typeof r.filePath !== "string" || typeof r.ok !== "boolean") return null;
	return Object.freeze({
		filePath: r.filePath,
		ok: r.ok,
		...(typeof r.error === "string" ? { error: r.error } : {}),
		...(typeof r.notice === "string" ? { notice: r.notice } : {}),
	});
}

async function runSingleGraphSnapshot(ctx: GraphContext): Promise<void> {
	const ticket = ++ctx.loadTicket;
	const controller = new AbortController();
	ctx.activeLoad = controller;
	try {
		const snapshot = await ctx.api.json<GraphSnapshot>("/api/graph", { signal: controller.signal });
		if (ctx.disposed || ticket !== ctx.loadTicket) return;
		const positions = sanitizePositionsMap(snapshot?.positions);
		ctx.cell.set({
			...ctx.cell.get(),
			load: "ready",
			error: null,
			snapshot,
			positions,
		});
	} catch (err) {
		if (ctx.disposed || ticket !== ctx.loadTicket || isAbortError(err)) return;
		const msg = err instanceof Error ? err.message : String(err);
		ctx.cell.set({ ...ctx.cell.get(), load: "error", error: msg });
	} finally {
		if (ctx.activeLoad === controller) ctx.activeLoad = null;
	}
}

export async function fetchGraphSnapshot(ctx: GraphContext): Promise<void> {
	if (ctx.disposed) return;
	if (ctx.inFlightSnapshot) {
		ctx.pendingSnapshotReload = true;
		return ctx.inFlightSnapshot;
	}
	const drain = async (): Promise<void> => {
		do {
			ctx.pendingSnapshotReload = false;
			await runSingleGraphSnapshot(ctx);
		} while (!ctx.disposed && ctx.pendingSnapshotReload);
	};
	ctx.inFlightSnapshot = drain().finally(() => {
		ctx.inFlightSnapshot = null;
	});
	return ctx.inFlightSnapshot;
}

export async function fetchGraphSourcesAux(ctx: GraphContext): Promise<void> {
	if (ctx.disposed) return;
	try {
		const raw = await ctx.api.json<unknown>("/api/graph/sources");
		if (ctx.disposed) return;
		const sources = normalizeSourceDirectory(raw);
		if (sources) ctx.cell.set({ ...ctx.cell.get(), sources });
	} catch {
		/* optional aux endpoint */
	}
}

export async function fetchRenderSettingsAux(ctx: GraphContext): Promise<void> {
	if (ctx.disposed) return;
	try {
		const raw = await ctx.api.json<unknown>("/api/graph/render-settings");
		if (ctx.disposed || raw === null || ctx.userTouchedRenderSettings) return;
		ctx.cell.set({ ...ctx.cell.get(), renderSettings: sanitizeRenderSettings(raw) });
	} catch {
		/* optional aux endpoint */
	}
}

export async function fetchGraphCostsAux(ctx: GraphContext): Promise<void> {
	if (ctx.disposed) return;
	try {
		const costs = await ctx.api.json<GraphCostSummary>("/api/graph/costs");
		if (ctx.disposed || !costs || typeof costs !== "object") return;
		ctx.cell.set({ ...ctx.cell.get(), costs });
	} catch {
		/* optional aux endpoint */
	}
}

export async function refreshGraphAfterMutation(ctx: GraphContext): Promise<void> {
	await Promise.all([
		fetchGraphSnapshot(ctx),
		fetchGraphSourcesAux(ctx),
		fetchGraphCostsAux(ctx),
	]);
}

export async function fetchGraphRunsAux(ctx: GraphContext): Promise<void> {
	if (ctx.disposed) return;
	try {
		const res = await ctx.api.json<{ runs?: unknown[] }>("/api/graph/status");
		if (ctx.disposed) return;
		const runs = (Array.isArray(res?.runs) ? res.runs : [])
			.map(normalizePipelineRun)
			.filter((r): r is GraphPipelineRun => r !== null);
		const nextIds = new Set(runs.map((r) => r.id));
		const anyFinished = [...ctx.seenRunIds].some((id) => !nextIds.has(id));
		ctx.seenRunIds.clear();
		for (const id of nextIds) ctx.seenRunIds.add(id);
		ctx.cell.set({ ...ctx.cell.get(), runs: Object.freeze(runs) });
		if (anyFinished) void refreshGraphAfterMutation(ctx);
	} catch {
		/* optional aux endpoint */
	}
}

export function mergeRenderSettingsPatch(
	current: GraphRenderSettings,
	patch: Partial<GraphRenderSettings>,
): GraphRenderSettings {
	return sanitizeRenderSettings({
		...current,
		...patch,
		regions: patch.regions ? { ...current.regions, ...patch.regions } : current.regions,
		physics: patch.physics ? { ...current.physics, ...patch.physics } : current.physics,
	});
}

export async function runGraphTracked(
	ctx: GraphContext,
	fn: (signal: AbortSignal) => Promise<void>,
): Promise<void> {
	if (ctx.disposed) return;
	const controller = new AbortController();
	ctx.controllers.add(controller);
	try {
		await fn(controller.signal);
	} catch (err) {
		if (ctx.disposed || isAbortError(err)) return;
		const msg = err instanceof Error ? err.message : String(err);
		ctx.cell.set({ ...ctx.cell.get(), error: msg });
	} finally {
		ctx.controllers.delete(controller);
	}
}

export async function uploadNotesFiles(
	ctx: GraphContext,
	files: readonly File[],
): Promise<void> {
	if (files.length === 0 || ctx.disposed) return;
	const controller = new AbortController();
	ctx.controllers.add(controller);
	ctx.cell.set({ ...ctx.cell.get(), importing: true, error: null });
	try {
		const form = new FormData();
		for (const file of files) form.append("files", file);
		const res = await ctx.api.json<{ results?: unknown[]; error?: string }>("/api/graph/import", {
			method: "POST",
			body: form,
			signal: controller.signal,
		});
		if (ctx.disposed) return;
		const importResults = (Array.isArray(res.results) ? res.results : [])
			.map(normalizeImportResult)
			.filter((item): item is GraphImportResultItem => item !== null);
		ctx.cell.set({
			...ctx.cell.get(),
			importing: false,
			error: typeof res.error === "string" && res.error ? res.error : null,
			importResults: Object.freeze(importResults),
		});
		await refreshGraphAfterMutation(ctx);
	} catch (err) {
		if (ctx.disposed || isAbortError(err)) return;
		const msg = err instanceof Error ? err.message : String(err);
		ctx.cell.set({ ...ctx.cell.get(), importing: false, error: msg });
	} finally {
		ctx.controllers.delete(controller);
	}
}

export async function triggerSessionExtract(ctx: GraphContext, chatId: string, signal: AbortSignal): Promise<void> {
	try {
		await ctx.api.json("/api/graph/coverage/extract", {
			method: "POST",
			json: { chatId },
			signal,
		});
	} catch (err) {
		if (!(err instanceof ApiError) || err.status !== 409) throw err;
	}
	await fetchGraphRunsAux(ctx);
}

export async function deleteGraphNodeAction(ctx: GraphContext, nodeId: string, signal: AbortSignal): Promise<void> {
	await ctx.api.json(apiPath`/api/graph/nodes/${nodeId}`, { method: "DELETE", signal });
	await refreshGraphAfterMutation(ctx);
}

export async function deleteGraphNodesAction(
	ctx: GraphContext,
	nodeIds: readonly string[],
	folderIds: readonly string[] | undefined,
	signal: AbortSignal,
): Promise<void> {
	for (const id of nodeIds) {
		await ctx.api.json(apiPath`/api/graph/nodes/${id}`, { method: "DELETE", signal });
	}
	for (const fid of folderIds ?? []) {
		await ctx.api.json(apiPath`/api/graph/sources/folders/${fid}`, { method: "DELETE", signal });
	}
	await refreshGraphAfterMutation(ctx);
}

export async function deleteGraphFolderAction(
	ctx: GraphContext,
	folderId: string,
	deleteSessions: boolean | undefined,
	signal: AbortSignal,
): Promise<void> {
	await ctx.api.json(apiPath`/api/graph/sources/folders/${folderId}`, {
		method: "DELETE",
		json: { deleteSessions: Boolean(deleteSessions) },
		signal,
	});
	await refreshGraphAfterMutation(ctx);
}
