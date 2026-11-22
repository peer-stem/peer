/**
 * Background activity feed store (`f3-c2b §2`).
 * Push-driven `GET /api/activity` with 250ms trailing debounce on
 * `activity-changed` and `jobs-changed`, immediate on boot and `onResync`,
 * and uniform `POST /api/activity/abort` control.
 */

import {
	isModelsRefusal,
	isProviderKeyRefusal,
	type CallUsage,
	type JobKind,
	type JobRecord,
} from "../../core/index.ts";
import { ApiError, isAbortError, type ApiClient } from "./api.ts";
import type { Events } from "./events.ts";
import {
	assertNeverIntent,
	createCell,
	createStoreFromCell,
	type Cell,
	type Store,
	type Unsubscribe,
} from "./store.ts";

export interface FeedUsage extends NonNullable<JobRecord["usage"]> {
	readonly lastStep?: CallUsage;
}

export interface FeedJob extends JobRecord {
	readonly costUsd?: number | null;
	readonly title: string;
	readonly usage?: FeedUsage;
	readonly contextLimit: number | null;
}

export interface FeedExtraction {
	readonly id: string;
	readonly chatId: string;
	readonly part?: { readonly i: number; readonly n: number };
	readonly title: string;
	readonly phase: string;
	readonly startedAt: number;
}

export interface FeedPluginWorker {
	readonly id: string;
	readonly taskId: string;
	readonly pluginId: string;
	readonly definitionId: string;
	readonly status: "queued" | "running";
	readonly title: string;
	readonly createdAt: string;
	readonly updatedAt: string;
	readonly activity?: string;
	readonly model: { readonly provider: string; readonly id: string };
	readonly usage?: FeedUsage;
	readonly costUsd: number | null;
	readonly contextLimit: number | null;
}

export interface ActivityFeed {
	readonly jobs: readonly FeedJob[];
	readonly pluginWorkers?: readonly FeedPluginWorker[];
	readonly extractions: readonly FeedExtraction[];
}

export interface ActivityBlob {
	readonly id: string;
	readonly process: "job" | "plugin-worker" | "extraction";
	readonly jobKind?: JobKind;
	readonly phase?: string;
	readonly title: string;
	readonly chatId?: string;
	readonly startedAt: number;
	readonly cost: number | null;
	readonly context: { readonly used: number; readonly limit: number } | null;
	readonly activity: string;
	readonly model?: string;
	readonly steps?: number;
}

export type ActivityAbortKind = "job" | "plugin-worker" | "extraction" | "turn";

export interface ActivityStoreModel {
	readonly feed: ActivityFeed;
	readonly blobs: readonly ActivityBlob[];
	readonly abortErrors: Readonly<Record<string, string>>;
}

export type ActivityIntent =
	| { readonly type: "refresh" }
	| { readonly type: "abort"; readonly kind: ActivityAbortKind; readonly id: string };

export interface CreateActivityStoreOptions {
	api: ApiClient;
	events: Events;
	debounceMs?: number;
}

interface ActivityContext {
	readonly api: ApiClient;
	readonly cell: Cell<ActivityStoreModel>;
	readonly debounceMs: number;
	disposed: boolean;
	feed: ActivityFeed;
	blobs: readonly ActivityBlob[];
	abortErrors: Readonly<Record<string, string>>;
	debounceTimer: ReturnType<typeof setTimeout> | null;
	activeLoad: AbortController | null;
	inFlight: Promise<void> | null;
	pendingReload: boolean;
}

const DEFAULT_ACTIVITY_DEBOUNCE_MS = 250;

const EMPTY_FEED: ActivityFeed = Object.freeze({
	jobs: Object.freeze([]),
	pluginWorkers: Object.freeze([]),
	extractions: Object.freeze([]),
});

function computeStepContext(
	lastStep: CallUsage | undefined,
	limit: number | null,
): ActivityBlob["context"] {
	if (limit === null || !lastStep || lastStep.inputTokens === undefined) return null;
	const used =
		lastStep.inputTokens +
		(lastStep.outputTokens ?? 0) +
		(lastStep.cacheReadTokens ?? 0) +
		(lastStep.cacheWriteTokens ?? 0);
	return Object.freeze({ used, limit });
}

function jobBlobOf(job: FeedJob): ActivityBlob {
	const activity = isModelsRefusal(job.error)
		? "needs model setup"
		: isProviderKeyRefusal(job.error)
			? "needs a provider key"
			: (job.activity ?? "");
	const title =
		job.kind === "plugin"
			? job.plugin?.label || job.plugin?.toolName || "Plugin worker"
			: job.title;
	return Object.freeze({
		id: job.id,
		process: "job",
		jobKind: job.kind,
		title,
		chatId: job.chatId,
		startedAt: Date.parse(job.createdAt) || 0,
		cost: job.costUsd ?? null,
		context: job.usage ? computeStepContext(job.usage.lastStep, job.contextLimit) : null,
		activity,
		...(job.usage?.model !== undefined ? { model: job.usage.model } : {}),
		...(job.usage?.steps !== undefined ? { steps: job.usage.steps } : {}),
	});
}

function pluginWorkerBlobOf(task: FeedPluginWorker): ActivityBlob {
	const model = task.usage?.model ?? `${task.model.provider}:${task.model.id}`;
	return Object.freeze({
		id: task.id,
		process: "plugin-worker",
		jobKind: "plugin",
		title: task.title,
		startedAt: Date.parse(task.createdAt) || 0,
		cost: task.costUsd ?? null,
		context: computeStepContext(task.usage?.lastStep, task.contextLimit),
		activity: task.activity ?? task.status,
		model,
		...(task.usage?.steps !== undefined ? { steps: task.usage.steps } : {}),
	});
}

function extractionBlobOf(run: FeedExtraction): ActivityBlob {
	return Object.freeze({
		id: run.id,
		process: "extraction",
		phase: run.phase,
		title: run.title,
		chatId: run.chatId,
		startedAt: run.startedAt,
		cost: null,
		context: null,
		activity: "",
	});
}

export function toActivityBlobs(feed: ActivityFeed): readonly ActivityBlob[] {
	const blobs: ActivityBlob[] = [];
	for (const job of feed.jobs ?? []) blobs.push(jobBlobOf(job));
	for (const task of feed.pluginWorkers ?? []) blobs.push(pluginWorkerBlobOf(task));
	for (const run of feed.extractions ?? []) blobs.push(extractionBlobOf(run));
	blobs.sort((a, b) => a.startedAt - b.startedAt);
	return Object.freeze(blobs);
}

export function formatActivityElapsed(ms: number): string {
	const s = Math.max(0, Math.floor(ms / 1000));
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
	return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

function publishActivity(ctx: ActivityContext): void {
	if (ctx.disposed) return;
	ctx.cell.set({
		feed: ctx.feed,
		blobs: ctx.blobs,
		abortErrors: ctx.abortErrors,
	});
}

function normalizeActivityFeed(raw: unknown): ActivityFeed | null {
	if (!raw || typeof raw !== "object") return null;
	const r = raw as Partial<ActivityFeed>;
	if (!Array.isArray(r.jobs) && !Array.isArray(r.extractions) && !Array.isArray(r.pluginWorkers)) {
		return null;
	}
	return Object.freeze({
		jobs: Object.freeze(Array.isArray(r.jobs) ? [...r.jobs] : []),
		pluginWorkers: Object.freeze(Array.isArray(r.pluginWorkers) ? [...r.pluginWorkers] : []),
		extractions: Object.freeze(Array.isArray(r.extractions) ? [...r.extractions] : []),
	});
}

async function runSingleActivityFetch(ctx: ActivityContext): Promise<void> {
	const controller = new AbortController();
	ctx.activeLoad = controller;
	try {
		const raw = await ctx.api.json<unknown>("/api/activity", { signal: controller.signal });
		if (ctx.disposed || controller.signal.aborted) return;
		const feed = normalizeActivityFeed(raw);
		if (!feed) return;
		ctx.feed = feed;
		ctx.blobs = toActivityBlobs(feed);
		publishActivity(ctx);
	} catch (err) {
		if (ctx.disposed || controller.signal.aborted || isAbortError(err)) return;
		/* transient transport error: keep last feed */
	} finally {
		if (ctx.activeLoad === controller) ctx.activeLoad = null;
	}
}

function clearActivityDebounce(ctx: ActivityContext): void {
	if (!ctx.debounceTimer) return;
	clearTimeout(ctx.debounceTimer);
	ctx.debounceTimer = null;
}

function fetchActivityFeed(ctx: ActivityContext): Promise<void> {
	if (ctx.disposed) return Promise.resolve();
	clearActivityDebounce(ctx);
	if (ctx.inFlight) {
		ctx.pendingReload = true;
		return ctx.inFlight;
	}
	const drain = async (): Promise<void> => {
		do {
			ctx.pendingReload = false;
			await runSingleActivityFetch(ctx);
		} while (!ctx.disposed && ctx.pendingReload);
	};
	ctx.inFlight = drain().finally(() => {
		ctx.inFlight = null;
	});
	return ctx.inFlight;
}

function scheduleDebouncedActivityFetch(ctx: ActivityContext): void {
	if (ctx.disposed) return;
	clearActivityDebounce(ctx);
	ctx.debounceTimer = setTimeout(() => {
		ctx.debounceTimer = null;
		void fetchActivityFeed(ctx);
	}, ctx.debounceMs);
}

function clearAbortErrorForId(ctx: ActivityContext, id: string): void {
	if (!Object.hasOwn(ctx.abortErrors, id)) return;
	const copy = { ...ctx.abortErrors };
	delete copy[id];
	ctx.abortErrors = Object.freeze(copy);
	publishActivity(ctx);
}

async function abortActivityProcess(
	ctx: ActivityContext,
	kind: ActivityAbortKind,
	id: string,
): Promise<void> {
	try {
		await ctx.api.json("/api/activity/abort", {
			method: "POST",
			json: { kind, id },
		});
		if (ctx.disposed) return;
		clearAbortErrorForId(ctx, id);
		await fetchActivityFeed(ctx);
	} catch (err) {
		if (ctx.disposed || isAbortError(err)) return;
		if (err instanceof ApiError && (err.status === 404 || err.status === 409)) {
			clearAbortErrorForId(ctx, id);
			await fetchActivityFeed(ctx);
			return;
		}
		ctx.abortErrors = Object.freeze({ ...ctx.abortErrors, [id]: "Abort failed" });
		publishActivity(ctx);
	}
}

function wireActivityEvents(ctx: ActivityContext, events: Events): Unsubscribe {
	const offs: Unsubscribe[] = [
		events.on("activity-changed", () => scheduleDebouncedActivityFetch(ctx)),
		events.on("jobs-changed", () => scheduleDebouncedActivityFetch(ctx)),
		events.onResync(() => {
			void fetchActivityFeed(ctx);
		}),
	];
	return () => {
		for (const off of offs) off();
	};
}

export function createActivityStore(
	options: CreateActivityStoreOptions,
): Store<ActivityStoreModel, ActivityIntent> {
	const emptyBlobs: readonly ActivityBlob[] = Object.freeze([]);
	const emptyErrors: Readonly<Record<string, string>> = Object.freeze({});
	const cell = createCell<ActivityStoreModel>({
		feed: EMPTY_FEED,
		blobs: emptyBlobs,
		abortErrors: emptyErrors,
	});
	const ctx: ActivityContext = {
		api: options.api,
		cell,
		debounceMs: options.debounceMs ?? DEFAULT_ACTIVITY_DEBOUNCE_MS,
		disposed: false,
		feed: EMPTY_FEED,
		blobs: emptyBlobs,
		abortErrors: emptyErrors,
		debounceTimer: null,
		activeLoad: null,
		inFlight: null,
		pendingReload: false,
	};
	const offEvents = wireActivityEvents(ctx, options.events);
	void fetchActivityFeed(ctx);

	return createStoreFromCell<ActivityStoreModel, ActivityIntent>(cell, {
		onSend(intent) {
			if (intent.type === "refresh") return fetchActivityFeed(ctx);
			if (intent.type === "abort") return abortActivityProcess(ctx, intent.kind, intent.id);
			return assertNeverIntent(intent);
		},
		onDispose() {
			ctx.disposed = true;
			clearActivityDebounce(ctx);
			offEvents();
			ctx.activeLoad?.abort();
		},
	});
}
