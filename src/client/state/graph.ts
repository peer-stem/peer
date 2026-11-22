/**
 * Knowledge-graph store (`c2a-frozen-contracts §3.7`).
 * Hydrates `/api/graph`, `/api/graph/sources`, `/api/graph/render-settings`,
 * `/api/graph/costs`, and `/api/graph/status`, and handles graph/source mutations.
 */

import {
	sanitizeRenderSettings,
	type GraphCostSummary,
	type GraphRenderSettings,
	type GraphSnapshot,
	type SourceDirectory,
} from "../../core/index.ts";
import type { ApiClient } from "./api.ts";
import type { Events } from "./events.ts";
import {
	deleteGraphFolderAction,
	deleteGraphNodeAction,
	deleteGraphNodesAction,
	fetchGraphCostsAux,
	fetchGraphRunsAux,
	fetchGraphSnapshot,
	fetchGraphSourcesAux,
	fetchRenderSettingsAux,
	mergeRenderSettingsPatch,
	refreshGraphAfterMutation,
	runGraphTracked,
	sanitizePositionsMap,
	triggerSessionExtract,
	uploadNotesFiles,
	type GraphContext,
} from "./graph-helpers.ts";
import {
	assertNeverIntent,
	createCell,
	createStoreFromCell,
	type LoadState,
	type Store,
	type Unsubscribe,
} from "./store.ts";

export interface GraphPipelineRun {
	readonly id: string;
	readonly chatId: string;
	readonly title: string;
	readonly phase: string;
	readonly startedAt: string;
}

export interface GraphImportResultItem {
	readonly filePath: string;
	readonly ok: boolean;
	readonly error?: string;
	readonly notice?: string;
}

export interface GraphStoreModel {
	readonly load: LoadState;
	readonly error: string | null;
	readonly snapshot: GraphSnapshot | null;
	readonly sources: SourceDirectory | null;
	readonly positions: Readonly<Record<string, { readonly x: number; readonly y: number }>>;
	readonly renderSettings: GraphRenderSettings;
	readonly costs: GraphCostSummary | null;
	readonly runs: readonly GraphPipelineRun[];
	readonly importing: boolean;
	readonly importResults: readonly GraphImportResultItem[];
}

export type GraphIntent =
	| { readonly type: "reload" }
	| { readonly type: "commit-positions"; readonly positions: Record<string, { x: number; y: number }> }
	| { readonly type: "save-render-settings"; readonly settings: Partial<GraphRenderSettings> }
	| { readonly type: "delete-node"; readonly nodeId: string }
	| { readonly type: "delete-nodes"; readonly nodeIds: readonly string[]; readonly folderIds?: readonly string[] }
	| { readonly type: "delete-folder"; readonly folderId: string; readonly deleteSessions?: boolean }
	| { readonly type: "import-notes"; readonly files: readonly File[] }
	| { readonly type: "source-action"; readonly method: "POST" | "DELETE"; readonly body: unknown }
	| { readonly type: "extract-session"; readonly chatId: string };

export interface CreateGraphStoreOptions {
	api: ApiClient;
	events: Events;
}

async function reloadAllGraphChannels(ctx: GraphContext): Promise<void> {
	await Promise.all([
		fetchGraphSnapshot(ctx),
		fetchGraphSourcesAux(ctx),
		fetchRenderSettingsAux(ctx),
		fetchGraphCostsAux(ctx),
		fetchGraphRunsAux(ctx),
	]);
}

async function commitGraphPositions(
	ctx: GraphContext,
	positions: Record<string, { x: number; y: number }>,
	signal: AbortSignal,
): Promise<void> {
	const merged = sanitizePositionsMap({ ...ctx.cell.get().positions, ...positions });
	ctx.cell.set({ ...ctx.cell.get(), positions: merged });
	const res = await ctx.api.json<{ positions?: Record<string, { x: number; y: number }> }>(
		"/api/graph/positions",
		{ method: "PUT", json: positions, signal },
	);
	if (ctx.disposed || !res.positions) return;
	ctx.cell.set({
		...ctx.cell.get(),
		positions: sanitizePositionsMap({ ...ctx.cell.get().positions, ...res.positions }),
	});
}

async function saveGraphRenderSettings(
	ctx: GraphContext,
	patch: Partial<GraphRenderSettings>,
	signal: AbortSignal,
): Promise<void> {
	ctx.userTouchedRenderSettings = true;
	const next = mergeRenderSettingsPatch(ctx.cell.get().renderSettings, patch);
	ctx.cell.set({ ...ctx.cell.get(), renderSettings: next });
	await ctx.api.json("/api/graph/render-settings", { method: "PUT", json: next, signal });
}

async function runSourceOrganizationAction(
	ctx: GraphContext,
	method: "POST" | "DELETE",
	body: unknown,
	signal: AbortSignal,
): Promise<void> {
	await ctx.api.json("/api/graph/sources", { method, json: body, signal });
	await refreshGraphAfterMutation(ctx);
}

async function handleGraphIntent(ctx: GraphContext, intent: GraphIntent): Promise<void> {
	switch (intent.type) {
		case "reload":
			return reloadAllGraphChannels(ctx);
		case "commit-positions":
			return runGraphTracked(ctx, (s) => commitGraphPositions(ctx, intent.positions, s));
		case "save-render-settings":
			return runGraphTracked(ctx, (s) => saveGraphRenderSettings(ctx, intent.settings, s));
		case "delete-node":
			return runGraphTracked(ctx, (s) => deleteGraphNodeAction(ctx, intent.nodeId, s));
		case "delete-nodes":
			return runGraphTracked(ctx, (s) => deleteGraphNodesAction(ctx, intent.nodeIds, intent.folderIds, s));
		case "delete-folder":
			return runGraphTracked(ctx, (s) => deleteGraphFolderAction(ctx, intent.folderId, intent.deleteSessions, s));
		case "import-notes":
			return uploadNotesFiles(ctx, intent.files);
		case "source-action":
			return runGraphTracked(ctx, (s) => runSourceOrganizationAction(ctx, intent.method, intent.body, s));
		case "extract-session":
			return runGraphTracked(ctx, (s) => triggerSessionExtract(ctx, intent.chatId, s));
		default:
			return assertNeverIntent(intent);
	}
}

function wireGraphEvents(ctx: GraphContext, events: Events): Unsubscribe {
	const offs: Unsubscribe[] = [
		events.on("activity-changed", () => {
			void fetchGraphRunsAux(ctx);
		}),
		events.on("sources-changed", () => {
			void fetchGraphSnapshot(ctx);
			void fetchGraphSourcesAux(ctx);
			void fetchGraphCostsAux(ctx);
		}),
		events.on("chats-changed", () => {
			void fetchGraphSnapshot(ctx);
			void fetchGraphSourcesAux(ctx);
		}),
		events.onResync(() => {
			void reloadAllGraphChannels(ctx);
		}),
	];
	return () => {
		for (const off of offs) off();
	};
}

export function createGraphStore({
	api,
	events,
}: CreateGraphStoreOptions): Store<GraphStoreModel, GraphIntent> {
	const cell = createCell<GraphStoreModel>({
		load: "loading",
		error: null,
		snapshot: null,
		sources: null,
		positions: Object.freeze({}),
		renderSettings: sanitizeRenderSettings(null),
		costs: null,
		runs: Object.freeze([]),
		importing: false,
		importResults: Object.freeze([]),
	});
	const ctx: GraphContext = {
		api,
		cell,
		controllers: new Set(),
		seenRunIds: new Set(),
		disposed: false,
		userTouchedRenderSettings: false,
		loadTicket: 0,
		activeLoad: null,
		inFlightSnapshot: null,
		pendingSnapshotReload: false,
	};
	const offEvents = wireGraphEvents(ctx, events);
	void reloadAllGraphChannels(ctx);

	return createStoreFromCell<GraphStoreModel, GraphIntent>(cell, {
		onSend: (intent) => handleGraphIntent(ctx, intent),
		onDispose() {
			ctx.disposed = true;
			offEvents();
			ctx.activeLoad?.abort();
			for (const c of ctx.controllers) c.abort();
			ctx.controllers.clear();
		},
	});
}
