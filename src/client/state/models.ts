/**
 * Model catalog store (`c2a-frozen-contracts §3.3`).
 * Fetches `GET /api/models`, supports explicit `POST /api/models` remote catalog
 * refresh, and refetches on SSE `onResync`, `subscriptions-changed`, or `reload`.
 */

import { isAbortError, type ApiClient } from "./api.ts";
import type { Events } from "./events.ts";
import {
	assertNeverIntent,
	createCell,
	createStoreFromCell,
	type Cell,
	type LoadState,
	type Store,
} from "./store.ts";

export interface CatalogModelEntry {
	readonly provider: string;
	readonly id: string;
	readonly name: string;
	readonly reasoning?: boolean;
	readonly supportedThinkingLevels?: readonly string[];
	readonly contextWindow?: number;
	readonly inputModality?: readonly string[];
	readonly cost?: { readonly input: number; readonly output: number };
}

export interface ModelSlotView {
	readonly model?: { readonly provider: string; readonly id: string };
	readonly thinkingLevel?: string;
}

export type ModelRefreshStatus =
	| "idle"
	| "pending"
	| "updated"
	| "unchanged"
	| "no-providers"
	| "failed";

export interface ModelsStoreModel {
	readonly load: LoadState;
	readonly error: string | null;
	readonly models: readonly CatalogModelEntry[];
	readonly providers: readonly string[];
	readonly slots: Readonly<Record<string, ModelSlotView>>;
	readonly refreshStatus: ModelRefreshStatus;
}

export type ModelsIntent =
	| { readonly type: "reload" }
	| { readonly type: "refresh-catalog" };

export interface CreateModelsStoreOptions {
	api: ApiClient;
	events: Events;
}

interface RawModelsPayload {
	models?: unknown;
	providers?: unknown;
	slots?: unknown;
}

interface ModelsContext {
	readonly api: ApiClient;
	readonly cell: Cell<ModelsStoreModel>;
	disposed: boolean;
	loadTicket: number;
	activeLoad: AbortController | null;
}

function toStringList(raw: unknown): readonly string[] | undefined {
	if (!Array.isArray(raw)) return undefined;
	const items = raw.filter((item): item is string => typeof item === "string");
	return Object.freeze(items);
}

function normalizeCost(raw: unknown): { readonly input: number; readonly output: number } | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const c = raw as { input?: unknown; output?: unknown };
	if (typeof c.input !== "number" || typeof c.output !== "number") return undefined;
	if (!Number.isFinite(c.input) || !Number.isFinite(c.output)) return undefined;
	return Object.freeze({ input: c.input, output: c.output });
}

function normalizeCatalogEntry(raw: unknown): CatalogModelEntry | null {
	if (!raw || typeof raw !== "object") return null;
	const r = raw as Record<string, unknown>;
	if (typeof r.provider !== "string" || !r.provider || typeof r.id !== "string" || !r.id) {
		return null;
	}
	const levels = toStringList(r.supportedThinkingLevels) ?? toStringList(r.supportedLevels);
	const modality = toStringList(r.inputModality) ?? toStringList(r.input);
	const cost = normalizeCost(r.cost);
	const cw = typeof r.contextWindow === "number" && Number.isFinite(r.contextWindow) ? r.contextWindow : undefined;
	return Object.freeze({
		provider: r.provider,
		id: r.id,
		name: typeof r.name === "string" && r.name ? r.name : r.id,
		...(typeof r.reasoning === "boolean" ? { reasoning: r.reasoning } : {}),
		...(levels !== undefined ? { supportedThinkingLevels: levels } : {}),
		...(cw !== undefined ? { contextWindow: cw } : {}),
		...(modality !== undefined ? { inputModality: modality } : {}),
		...(cost !== undefined ? { cost } : {}),
	});
}

function normalizeSlotEntry(raw: unknown): ModelSlotView | null {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
	const rec = raw as Record<string, unknown>;
	const rawModel = rec.model as { provider?: unknown; id?: unknown } | null | undefined;
	const model =
		rawModel && typeof rawModel === "object" && typeof rawModel.provider === "string" && typeof rawModel.id === "string"
			? Object.freeze({ provider: rawModel.provider, id: rawModel.id })
			: undefined;
	const thinkingLevel = typeof rec.thinkingLevel === "string" && rec.thinkingLevel ? rec.thinkingLevel : undefined;
	return Object.freeze({
		...(model ? { model } : {}),
		...(thinkingLevel ? { thinkingLevel } : {}),
	});
}

function normalizeSlotsMap(raw: unknown): Readonly<Record<string, ModelSlotView>> {
	const out: Record<string, ModelSlotView> = {};
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return Object.freeze(out);
	for (const [slotName, value] of Object.entries(raw)) {
		const normalized = normalizeSlotEntry(value);
		if (normalized) out[slotName] = normalized;
	}
	return Object.freeze(out);
}

function addProviderEntry(set: Set<string>, item: unknown): void {
	if (typeof item === "string" && item) {
		set.add(item);
		return;
	}
	const rec = item && typeof item === "object" ? (item as { id?: unknown; keyPresent?: unknown }) : null;
	if (typeof rec?.id === "string" && rec.id && rec.keyPresent !== false) {
		set.add(rec.id);
	}
}

function normalizeProvidersList(raw: unknown, models: readonly CatalogModelEntry[]): readonly string[] {
	const set = new Set<string>();
	if (Array.isArray(raw)) {
		for (const item of raw) addProviderEntry(set, item);
	}
	for (const model of models) set.add(model.provider);
	return Object.freeze([...set]);
}

async function fetchModelsCatalog(ctx: ModelsContext): Promise<void> {
	if (ctx.disposed) return;
	const ticket = ++ctx.loadTicket;
	ctx.activeLoad?.abort();
	const controller = new AbortController();
	ctx.activeLoad = controller;
	try {
		const res = await ctx.api.json<RawModelsPayload>("/api/models", { signal: controller.signal });
		if (ctx.disposed || ticket !== ctx.loadTicket) return;
		const rawList = Array.isArray(res?.models) ? res.models : [];
		const models = Object.freeze(
			rawList.map(normalizeCatalogEntry).filter((entry): entry is CatalogModelEntry => entry !== null),
		);
		const providers = normalizeProvidersList(res?.providers, models);
		const slots = normalizeSlotsMap(res?.slots);
		ctx.cell.set({
			load: "ready",
			error: null,
			models,
			providers,
			slots,
			refreshStatus: ctx.cell.get().refreshStatus,
		});
	} catch (err) {
		if (ctx.disposed || ticket !== ctx.loadTicket || isAbortError(err)) return;
		const msg = err instanceof Error ? err.message : String(err);
		ctx.cell.set({ ...ctx.cell.get(), load: "error", error: msg });
	}
}

async function refreshModelsCatalog(ctx: ModelsContext): Promise<void> {
	if (ctx.disposed) return;
	ctx.cell.set({ ...ctx.cell.get(), refreshStatus: "pending" });
	try {
		const res = await ctx.api.json<{ outcome?: string }>("/api/models", { method: "POST" });
		if (ctx.disposed) return;
		const o = res?.outcome;
		const status: ModelRefreshStatus =
			o === "updated" || o === "unchanged" || o === "no-providers" ? o : "failed";
		ctx.cell.set({ ...ctx.cell.get(), refreshStatus: status });
		if (status === "updated") await fetchModelsCatalog(ctx);
	} catch (err) {
		if (ctx.disposed || isAbortError(err)) return;
		ctx.cell.set({ ...ctx.cell.get(), refreshStatus: "failed" });
	}
}

export function createModelsStore({
	api,
	events,
}: CreateModelsStoreOptions): Store<ModelsStoreModel, ModelsIntent> {
	const cell = createCell<ModelsStoreModel>({
		load: "loading",
		error: null,
		models: Object.freeze([]),
		providers: Object.freeze([]),
		slots: Object.freeze({}),
		refreshStatus: "idle",
	});
	const ctx: ModelsContext = {
		api,
		cell,
		disposed: false,
		loadTicket: 0,
		activeLoad: null,
	};
	const offResync = events.onResync(() => {
		void fetchModelsCatalog(ctx);
	});
	const offSubs = events.on("subscriptions-changed", () => {
		void fetchModelsCatalog(ctx);
	});
	void fetchModelsCatalog(ctx);

	return createStoreFromCell<ModelsStoreModel, ModelsIntent>(cell, {
		async onSend(intent) {
			if (intent.type === "reload") return fetchModelsCatalog(ctx);
			if (intent.type === "refresh-catalog") return refreshModelsCatalog(ctx);
			assertNeverIntent(intent);
		},
		onDispose() {
			ctx.disposed = true;
			offResync();
			offSubs();
			ctx.activeLoad?.abort();
		},
	});
}
