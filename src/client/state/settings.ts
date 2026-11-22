/**
 * Settings store (`c2a-frozen-contracts §3.5`, `client-contract-state §2.3, §5`).
 * Boot fetches ONLY `GET /api/settings` (preserving C1 boot isolation);
 * `{ type: "load-aux" }` hydrates keys, prompts, search, CLI, subscriptions, and custom provider.
 */

import {
	resolveSettings,
	sanitizeUserSettings,
	slotsConfigured,
	type EffectiveSettings,
	type LearnHarnessImportReport,
	type PromptSegmentInfo,
	type UserSettings,
} from "../../core/index.ts";
import { apiPath, isAbortError, type ApiClient } from "./api.ts";
import type { Events } from "./events.ts";
import {
	loadAllAuxIntoCell,
	mutateCustomProvider,
	mutateKeyEntry,
	mutatePromptOverride,
	mutateSubscriptionAction,
	mutateThemeEntry,
	refreshCliChannels,
	refreshPromptsChannel,
	refreshSearchChannel,
	refreshSubscriptionsChannel,
	runTrackedMutation,
	type SettingsAuxContext,
} from "./settings-helpers.ts";
import {
	assertNeverIntent,
	createCell,
	createStoreFromCell,
	type Cell,
	type LoadState,
	type Store,
} from "./store.ts";

export type { LearnHarnessImportReport };

export interface KeyStatusRow {
	readonly id: string;
	readonly label?: string;
	readonly present: boolean;
	readonly masked?: string;
	readonly source?: "env" | "file" | null;
	readonly shadowedByEnv?: boolean;
}

export interface ProviderKeyOption {
	readonly id: string;
	readonly envVar: string;
	readonly label: string;
}

export interface PromptSegmentsMap {
	readonly prober: readonly PromptSegmentInfo[];
	readonly teacher: readonly PromptSegmentInfo[];
	readonly practice: readonly PromptSegmentInfo[];
}

export interface SearchStatusView {
	readonly available: boolean;
	readonly engine: string | null;
	readonly reason: string;
}

export interface SettingsModel {
	readonly load: LoadState;
	readonly error: string | null;
	readonly saving: boolean;
	readonly record: UserSettings | null;
	readonly fileAccessError?: string;
	readonly effective: EffectiveSettings;
	readonly configured: boolean;
	readonly lastImport: LearnHarnessImportReport | null;
	readonly keys: readonly KeyStatusRow[];
	readonly providerKeys: readonly ProviderKeyOption[];
	readonly prompts: PromptSegmentsMap | null;
	readonly searchStatus: SearchStatusView | null;
	readonly claudeCode: Readonly<Record<string, unknown>> | null;
	readonly externalCli: Readonly<Record<string, unknown>> | null;
	readonly subscriptions: Readonly<Record<string, unknown>> | null;
	readonly customProvider: Readonly<Record<string, unknown>> | null;
}

export type SettingsIntent =
	| { readonly type: "reload" }
	| { readonly type: "load-aux" }
	| { readonly type: "save-section"; readonly section: string; readonly value: unknown }
	| { readonly type: "save-key"; readonly id: string; readonly value: string }
	| { readonly type: "delete-key"; readonly id: string }
	| { readonly type: "save-prompt"; readonly path: string; readonly text: string }
	| { readonly type: "delete-prompt"; readonly path: string }
	| { readonly type: "create-theme"; readonly theme: unknown }
	| { readonly type: "delete-theme"; readonly id: string }
	| { readonly type: "save-custom-provider"; readonly value: unknown }
	| { readonly type: "delete-custom-provider" }
	| { readonly type: "subscription-action"; readonly method: "POST" | "DELETE"; readonly body: unknown }
	| { readonly type: "import-learnharness"; readonly sourceDirectory: string };

export interface CreateSettingsStoreOptions {
	api: ApiClient;
	events: Events;
	onModelsMayChange?: () => void;
	onThemesMayChange?: () => void;
}

interface RawSettingsPayload {
	settings?: unknown;
	fileAccessError?: unknown;
}

interface SettingsContext extends SettingsAuxContext {
	loadTicket: number;
	activeLoad: AbortController | null;
}

function applyRawSettingsPayload(prev: SettingsModel, payload: RawSettingsPayload): SettingsModel {
	const record = sanitizeUserSettings(payload.settings ?? null);
	const effective = resolveSettings(record);
	const configured = slotsConfigured(record?.models);
	const next: SettingsModel = {
		...prev,
		load: "ready",
		error: null,
		record,
		effective,
		configured,
	};
	if (typeof payload.fileAccessError === "string" && payload.fileAccessError.length > 0) {
		return { ...next, fileAccessError: payload.fileAccessError };
	}
	const { fileAccessError: _removed, ...withoutFileErr } = next;
	return withoutFileErr;
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
		ctx.cell.set(applyRawSettingsPayload(ctx.cell.get(), res));
	} catch (err) {
		if (ctx.disposed || ticket !== ctx.loadTicket || isAbortError(err)) return;
		const msg = err instanceof Error ? err.message : String(err);
		ctx.cell.set({ ...ctx.cell.get(), load: "error", error: msg });
	}
}

async function saveSettingsSection(
	ctx: SettingsContext,
	section: string,
	value: unknown,
	signal: AbortSignal,
): Promise<void> {
	const res = await ctx.api.json<RawSettingsPayload>(apiPath`/api/settings/${section}`, {
		method: "PUT",
		json: value,
		signal,
	});
	if (ctx.disposed) return;
	ctx.cell.set(applyRawSettingsPayload(ctx.cell.get(), res));
	if (section === "models" || section === "claudeCode" || section === "externalCli") {
		ctx.onModelsMayChange?.();
	}
	if (ctx.auxLoaded && (section === "claudeCode" || section === "externalCli")) {
		await refreshCliChannels(ctx, ctx.cell.get().record, signal);
	}
	if (section === "agent") {
		await Promise.all([
			ctx.auxLoaded ? refreshPromptsChannel(ctx, signal) : Promise.resolve(),
			refreshSearchChannel(ctx, signal),
		]);
	}
}

async function importLearnHarnessData(
	ctx: SettingsContext,
	sourceDirectory: string,
	signal: AbortSignal,
): Promise<void> {
	const report = await ctx.api.json<LearnHarnessImportReport>(
		"/api/settings/import-learnharness",
		{ method: "POST", json: { sourceDirectory }, signal },
	);
	if (ctx.disposed) return;
	ctx.cell.set({ ...ctx.cell.get(), lastImport: report });
	await fetchSettingsIntoCell(ctx);
	ctx.onModelsMayChange?.();
	ctx.onThemesMayChange?.();
}

async function handleSettingsIntent(ctx: SettingsContext, intent: SettingsIntent): Promise<void> {
	switch (intent.type) {
		case "reload":
			return fetchSettingsIntoCell(ctx);
		case "load-aux":
			return loadAllAuxIntoCell(ctx);
		case "save-section":
			return runTrackedMutation(ctx, (s) => saveSettingsSection(ctx, intent.section, intent.value, s));
		case "save-key":
			return runTrackedMutation(ctx, (s) => mutateKeyEntry(ctx, intent.id, intent.value, s));
		case "delete-key":
			return runTrackedMutation(ctx, (s) => mutateKeyEntry(ctx, intent.id, null, s));
		case "save-prompt":
			return runTrackedMutation(ctx, (s) => mutatePromptOverride(ctx, intent.path, intent.text, s));
		case "delete-prompt":
			return runTrackedMutation(ctx, (s) => mutatePromptOverride(ctx, intent.path, null, s));
		case "create-theme":
			return runTrackedMutation(ctx, (s) => mutateThemeEntry(ctx, { kind: "create", theme: intent.theme }, s));
		case "delete-theme":
			return runTrackedMutation(ctx, (s) => mutateThemeEntry(ctx, { kind: "delete", id: intent.id }, s));
		case "save-custom-provider":
			return runTrackedMutation(ctx, (s) => mutateCustomProvider(ctx, "save", intent.value, s));
		case "delete-custom-provider":
			return runTrackedMutation(ctx, (s) => mutateCustomProvider(ctx, "delete", undefined, s));
		case "subscription-action":
			return runTrackedMutation(ctx, (s) => mutateSubscriptionAction(ctx, intent.method, intent.body, s));
		case "import-learnharness":
			return runTrackedMutation(ctx, (s) => importLearnHarnessData(ctx, intent.sourceDirectory, s));
		default:
			return assertNeverIntent(intent);
	}
}

function buildInitialSettingsCell(): Cell<SettingsModel> {
	return createCell<SettingsModel>({
		load: "loading",
		error: null,
		saving: false,
		record: null,
		effective: resolveSettings(null),
		configured: false,
		lastImport: null,
		keys: Object.freeze([]),
		providerKeys: Object.freeze([]),
		prompts: null,
		searchStatus: null,
		claudeCode: null,
		externalCli: null,
		subscriptions: null,
		customProvider: null,
	});
}

export function createSettingsStore({
	api,
	events,
	onModelsMayChange,
	onThemesMayChange,
}: CreateSettingsStoreOptions): Store<SettingsModel, SettingsIntent> {
	const cell = buildInitialSettingsCell();
	const ctx: SettingsContext = {
		api,
		cell,
		controllers: new Set(),
		onModelsMayChange,
		onThemesMayChange,
		disposed: false,
		auxLoaded: false,
		customProviderEtag: null,
		loadTicket: 0,
		activeLoad: null,
		reloadSettings: () => fetchSettingsIntoCell(ctx),
	};
	const offResync = events.onResync(() => {
		void fetchSettingsIntoCell(ctx);
		if (ctx.auxLoaded) void loadAllAuxIntoCell(ctx);
	});
	const offSubs = events.on("subscriptions-changed", () => {
		if (ctx.auxLoaded) void refreshSubscriptionsChannel(ctx);
	});
	void fetchSettingsIntoCell(ctx);

	return createStoreFromCell<SettingsModel, SettingsIntent>(cell, {
		onSend: (intent) => handleSettingsIntent(ctx, intent),
		onDispose() {
			ctx.disposed = true;
			offResync();
			offSubs();
			ctx.activeLoad?.abort();
			for (const c of ctx.controllers) c.abort();
			ctx.controllers.clear();
		},
	});
}
