/**
 * Settings store (`client-contract-state §2.3, §5`).
 * Reads `GET /api/settings`, resolves `EffectiveSettings` + `slotsConfigured`,
 * refetches on SSE `onResync`, and runs `POST /api/settings/import-learnharness`.
 */

import {
	sanitizeUserSettings,
	slotsConfigured,
	type UserSettings,
} from "../../core/settings.ts";
import {
	resolveSettings,
	type EffectiveSettings,
} from "../../core/settings-resolution.ts";
import type { LearnHarnessImportReport } from "../../core/contracts.ts";
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

export type { LearnHarnessImportReport };

export interface SettingsModel {
	readonly load: LoadState;
	readonly error: string | null;
	readonly record: UserSettings | null;
	readonly fileAccessError?: string;
	readonly effective: EffectiveSettings;
	readonly configured: boolean;
	readonly lastImport: LearnHarnessImportReport | null;
}

export type SettingsIntent =
	| { readonly type: "reload" }
	| { readonly type: "import-learnharness"; readonly sourceDirectory: string };

export interface CreateSettingsStoreOptions {
	api: ApiClient;
	events: Events;
}

interface RawSettingsPayload {
	settings?: unknown;
	fileAccessError?: unknown;
}

interface SettingsContext {
	readonly api: ApiClient;
	readonly cell: Cell<SettingsModel>;
	readonly importControllers: Set<AbortController>;
	disposed: boolean;
	loadTicket: number;
	activeLoad: AbortController | null;
}

function buildReadySettingsModel(
	payload: RawSettingsPayload,
	lastImport: LearnHarnessImportReport | null,
): SettingsModel {
	const record = sanitizeUserSettings(payload.settings ?? null);
	const effective = resolveSettings(record);
	const configured = slotsConfigured(record?.models);
	return {
		load: "ready",
		error: null,
		record,
		...(typeof payload.fileAccessError === "string" && payload.fileAccessError.length > 0
			? { fileAccessError: payload.fileAccessError }
			: {}),
		effective,
		configured,
		lastImport,
	};
}

async function fetchSettingsIntoCell(ctx: SettingsContext): Promise<void> {
	if (ctx.disposed) return;
	const ticket = ++ctx.loadTicket;
	ctx.activeLoad?.abort();
	const controller = new AbortController();
	ctx.activeLoad = controller;
	try {
		const res = await ctx.api.json<RawSettingsPayload>("/api/settings", {
			signal: controller.signal,
		});
		if (ctx.disposed || ticket !== ctx.loadTicket) return;
		ctx.cell.set(buildReadySettingsModel(res, ctx.cell.get().lastImport));
	} catch (err) {
		if (ctx.disposed || ticket !== ctx.loadTicket || isAbortError(err)) return;
		const msg = err instanceof Error ? err.message : String(err);
		ctx.cell.set({ ...ctx.cell.get(), load: "error", error: msg });
	}
}

async function importLearnHarnessIntoCell(
	ctx: SettingsContext,
	sourceDirectory: string,
): Promise<void> {
	const controller = new AbortController();
	ctx.importControllers.add(controller);
	try {
		const report = await ctx.api.json<LearnHarnessImportReport>(
			"/api/settings/import-learnharness",
			{ method: "POST", json: { sourceDirectory }, signal: controller.signal },
		);
		if (ctx.disposed) return;
		ctx.cell.set({ ...ctx.cell.get(), error: null, lastImport: report });
		await fetchSettingsIntoCell(ctx);
	} catch (err) {
		if (ctx.disposed || isAbortError(err)) return;
		const msg = err instanceof Error ? err.message : String(err);
		ctx.cell.set({ ...ctx.cell.get(), error: msg });
	} finally {
		ctx.importControllers.delete(controller);
	}
}

export function createSettingsStore({
	api,
	events,
}: CreateSettingsStoreOptions): Store<SettingsModel, SettingsIntent> {
	const cell = createCell<SettingsModel>({
		load: "loading",
		error: null,
		record: null,
		effective: resolveSettings(null),
		configured: false,
		lastImport: null,
	});
	const ctx: SettingsContext = {
		api,
		cell,
		importControllers: new Set(),
		disposed: false,
		loadTicket: 0,
		activeLoad: null,
	};
	const offResync = events.onResync(() => {
		void fetchSettingsIntoCell(ctx);
	});
	void fetchSettingsIntoCell(ctx);

	return createStoreFromCell<SettingsModel, SettingsIntent>(cell, {
		async onSend(intent) {
			if (intent.type === "reload") return fetchSettingsIntoCell(ctx);
			if (intent.type === "import-learnharness") {
				return importLearnHarnessIntoCell(ctx, intent.sourceDirectory);
			}
			assertNeverIntent(intent);
		},
		onDispose() {
			ctx.disposed = true;
			offResync();
			ctx.activeLoad?.abort();
			for (const c of ctx.importControllers) c.abort();
			ctx.importControllers.clear();
		},
	});
}
