/**
 * Auxiliary fetchers and mutation helpers for `SettingsStore` (`c2a-frozen-contracts §3.5`).
 */

import {
	ADDED_CLI_IDS,
	type PromptSegmentInfo,
	type UserSettings,
} from "../../core/index.ts";
import { ApiError, apiPath, isAbortError, type ApiClient, type ApiPath } from "./api.ts";
import type {
	KeyStatusRow,
	PromptSegmentsMap,
	ProviderKeyOption,
	SearchStatusView,
	SettingsModel,
} from "./settings.ts";
import type { Cell } from "./store.ts";

export interface SettingsAuxContext {
	readonly api: ApiClient;
	readonly cell: Cell<SettingsModel>;
	readonly controllers: Set<AbortController>;
	readonly onModelsMayChange?: () => void;
	readonly onThemesMayChange?: () => void;
	disposed: boolean;
	auxLoaded: boolean;
	customProviderEtag: string | null;
	reloadSettings: () => Promise<void>;
}

function isPlainObject(val: unknown): val is Record<string, unknown> {
	return typeof val === "object" && val !== null && !Array.isArray(val);
}

function isDesktopWithoutWebSubs(): boolean {
	try {
		const win = globalThis.window as (Window & { lh?: { subscriptionTransport?: string } }) | undefined;
		if (!win?.lh) return false;
		return win.lh.subscriptionTransport !== "web";
	} catch {
		return false;
	}
}

function normalizeKeyRow(raw: unknown): KeyStatusRow | null {
	if (!isPlainObject(raw) || typeof raw.id !== "string" || !raw.id) return null;
	const info = isPlainObject(raw.info) ? raw.info : null;
	const label = typeof raw.label === "string" ? raw.label : typeof info?.label === "string" ? info.label : undefined;
	const src = raw.source === "env" || raw.source === "file" ? raw.source : null;
	return Object.freeze({
		id: raw.id,
		...(label ? { label } : {}),
		present: Boolean(raw.present),
		...(typeof raw.masked === "string" ? { masked: raw.masked } : {}),
		source: src,
		...(typeof raw.shadowedByEnv === "boolean" ? { shadowedByEnv: raw.shadowedByEnv } : {}),
	});
}

function normalizeProviderOption(raw: unknown): ProviderKeyOption | null {
	if (!isPlainObject(raw)) return null;
	if (typeof raw.id !== "string" || typeof raw.envVar !== "string" || typeof raw.label !== "string") {
		return null;
	}
	return Object.freeze({ id: raw.id, envVar: raw.envVar, label: raw.label });
}

export async function refreshKeysChannel(ctx: SettingsAuxContext, signal?: AbortSignal): Promise<void> {
	try {
		const res = await ctx.api.json<{ keys?: unknown[]; providers?: unknown[] }>("/api/keys", { signal });
		if (ctx.disposed || signal?.aborted) return;
		const keys = (Array.isArray(res.keys) ? res.keys : [])
			.map(normalizeKeyRow)
			.filter((r): r is KeyStatusRow => r !== null);
		const providerKeys = (Array.isArray(res.providers) ? res.providers : [])
			.map(normalizeProviderOption)
			.filter((p): p is ProviderKeyOption => p !== null);
		ctx.cell.set({
			...ctx.cell.get(),
			keys: Object.freeze(keys),
			providerKeys: Object.freeze(providerKeys),
		});
	} catch {
		/* optional aux channel */
	}
}

export async function refreshPromptsChannel(ctx: SettingsAuxContext, signal?: AbortSignal): Promise<void> {
	try {
		const res = await ctx.api.json<Partial<PromptSegmentsMap>>("/api/settings/prompts", { signal });
		if (ctx.disposed || signal?.aborted) return;
		const prompts: PromptSegmentsMap = Object.freeze({
			prober: Object.freeze(Array.isArray(res.prober) ? (res.prober as PromptSegmentInfo[]) : []),
			teacher: Object.freeze(Array.isArray(res.teacher) ? (res.teacher as PromptSegmentInfo[]) : []),
			practice: Object.freeze(Array.isArray(res.practice) ? (res.practice as PromptSegmentInfo[]) : []),
		});
		ctx.cell.set({ ...ctx.cell.get(), prompts });
	} catch {
		/* optional aux channel */
	}
}

export async function refreshSearchChannel(ctx: SettingsAuxContext, signal?: AbortSignal): Promise<void> {
	try {
		const res = await ctx.api.json<Record<string, unknown>>("/api/search", { signal });
		if (ctx.disposed || signal?.aborted || !isPlainObject(res) || typeof res.available !== "boolean") return;
		const searchStatus: SearchStatusView = Object.freeze({
			available: res.available,
			engine: typeof res.engine === "string" ? res.engine : null,
			reason: typeof res.reason === "string" ? res.reason : "",
		});
		ctx.cell.set({ ...ctx.cell.get(), searchStatus });
	} catch {
		/* optional aux channel */
	}
}

export async function refreshCustomProviderChannel(
	ctx: SettingsAuxContext,
	signal?: AbortSignal,
): Promise<void> {
	try {
		const res = await ctx.api.request("/api/custom-provider", { signal });
		if (ctx.disposed || signal?.aborted || !res.ok) return;
		const etag = res.headers.get("etag");
		if (etag) ctx.customProviderEtag = etag;
		const parsed: unknown = await res.json();
		if (ctx.disposed || signal?.aborted || !isPlainObject(parsed)) return;
		ctx.cell.set({ ...ctx.cell.get(), customProvider: Object.freeze({ ...parsed }) });
	} catch {
		/* optional aux channel */
	}
}

export async function refreshSubscriptionsChannel(
	ctx: SettingsAuxContext,
	signal?: AbortSignal,
): Promise<void> {
	if (isDesktopWithoutWebSubs()) return;
	try {
		const res = await ctx.api.json<Record<string, unknown>>("/api/subscriptions", {
			headers: { "x-learnharness-subscriptions": "1" },
			signal,
		});
		if (ctx.disposed || signal?.aborted || !isPlainObject(res)) return;
		ctx.cell.set({ ...ctx.cell.get(), subscriptions: Object.freeze({ ...res }) });
	} catch {
		/* optional aux channel */
	}
}

async function fetchClaudeCodeStatus(
	ctx: SettingsAuxContext,
	enabled: boolean,
	signal?: AbortSignal,
): Promise<Readonly<Record<string, unknown>>> {
	if (!enabled) return Object.freeze({ enabled: false });
	try {
		const cc = await ctx.api.json<Record<string, unknown>>("/api/claude-code", {
			headers: { "x-learnharness-claude-code": "1" },
			signal,
		});
		return isPlainObject(cc) ? Object.freeze({ enabled: true, ...cc }) : Object.freeze({ enabled: true });
	} catch {
		return Object.freeze({ enabled: true, state: "unavailable" });
	}
}

async function fetchOneExternalCliStatus(
	ctx: SettingsAuxContext,
	id: string,
	signal?: AbortSignal,
): Promise<Record<string, unknown>> {
	try {
		const status = await ctx.api.json<Record<string, unknown>>("/api/external-cli", {
			query: { id },
			headers: { "x-learnharness-external-cli": "1" },
			signal,
		});
		return isPlainObject(status) ? status : { id, state: "unavailable" };
	} catch {
		return { id, state: "unavailable" };
	}
}

export async function refreshCliChannels(
	ctx: SettingsAuxContext,
	record: UserSettings | null,
	signal?: AbortSignal,
): Promise<void> {
	const claudeCode = await fetchClaudeCodeStatus(ctx, record?.claudeCode?.enabled === true, signal);
	const cliMap: Record<string, unknown> = {};
	for (const id of ADDED_CLI_IDS) {
		if (record?.externalCli?.[id]?.enabled !== true) continue;
		cliMap[id] = await fetchOneExternalCliStatus(ctx, id, signal);
	}
	if (ctx.disposed || signal?.aborted) return;
	ctx.cell.set({
		...ctx.cell.get(),
		claudeCode,
		externalCli: Object.freeze(cliMap),
	});
}

export async function loadAllAuxIntoCell(ctx: SettingsAuxContext): Promise<void> {
	if (ctx.disposed) return;
	ctx.auxLoaded = true;
	const controller = new AbortController();
	ctx.controllers.add(controller);
	const sig = controller.signal;
	try {
		await Promise.all([
			refreshKeysChannel(ctx, sig),
			refreshPromptsChannel(ctx, sig),
			refreshSearchChannel(ctx, sig),
			refreshCustomProviderChannel(ctx, sig),
			refreshSubscriptionsChannel(ctx, sig),
			refreshCliChannels(ctx, ctx.cell.get().record, sig),
		]);
	} finally {
		ctx.controllers.delete(controller);
	}
}

export function buildPromptSegmentApiPath(segmentPath: string): ApiPath {
	const encoded = segmentPath
		.split("/")
		.filter((part) => part.length > 0)
		.map((part) => encodeURIComponent(part))
		.join("/");
	return `/api/settings/prompts/${encoded}`;
}

export async function runTrackedMutation(
	ctx: SettingsAuxContext,
	work: (signal: AbortSignal) => Promise<void>,
): Promise<void> {
	if (ctx.disposed) return;
	const controller = new AbortController();
	ctx.controllers.add(controller);
	ctx.cell.set({ ...ctx.cell.get(), saving: true, error: null });
	try {
		await work(controller.signal);
		if (!ctx.disposed) ctx.cell.set({ ...ctx.cell.get(), saving: false });
	} catch (err) {
		if (ctx.disposed || isAbortError(err)) return;
		const msg = err instanceof Error ? err.message : String(err);
		ctx.cell.set({ ...ctx.cell.get(), saving: false, error: msg });
	} finally {
		ctx.controllers.delete(controller);
	}
}

export async function mutateCustomProvider(
	ctx: SettingsAuxContext,
	mode: "save" | "delete",
	value?: unknown,
	signal?: AbortSignal,
): Promise<void> {
	if (!ctx.customProviderEtag) await refreshCustomProviderChannel(ctx, signal);
	const headers = ctx.customProviderEtag ? { "If-Match": ctx.customProviderEtag } : undefined;
	if (mode === "delete") {
		await ctx.api.json("/api/custom-provider", { method: "DELETE", json: {}, headers, signal });
	} else {
		try {
			await ctx.api.json("/api/custom-provider", { method: "POST", json: value, headers, signal });
		} catch (err) {
			if (!(err instanceof ApiError) || (err.status !== 404 && err.status !== 405)) throw err;
			await ctx.api.json("/api/custom-provider", { method: "PUT", json: value, headers, signal });
		}
	}
	await Promise.all([ctx.reloadSettings(), refreshCustomProviderChannel(ctx, signal)]);
	ctx.onModelsMayChange?.();
}

export async function mutateKeyEntry(
	ctx: SettingsAuxContext,
	id: string,
	value: string | null,
	signal?: AbortSignal,
): Promise<void> {
	const path = apiPath`/api/keys/${id}`;
	if (value === null) await ctx.api.json(path, { method: "DELETE", signal });
	else await ctx.api.json(path, { method: "PUT", json: { value }, signal });
	await Promise.all([refreshKeysChannel(ctx, signal), refreshSearchChannel(ctx, signal)]);
	ctx.onModelsMayChange?.();
}

export async function mutateSubscriptionAction(
	ctx: SettingsAuxContext,
	method: "POST" | "DELETE",
	body: unknown,
	signal: AbortSignal,
): Promise<void> {
	await ctx.api.json("/api/subscriptions", {
		method,
		json: body,
		headers: { "x-learnharness-subscriptions": "1" },
		signal,
	});
	await refreshSubscriptionsChannel(ctx, signal);
	ctx.onModelsMayChange?.();
}

export async function mutatePromptOverride(
	ctx: SettingsAuxContext,
	segmentPath: string,
	text: string | null,
	signal: AbortSignal,
): Promise<void> {
	const target = buildPromptSegmentApiPath(segmentPath);
	if (text === null) {
		await ctx.api.json(target, { method: "DELETE", signal });
		await Promise.all([ctx.reloadSettings(), refreshPromptsChannel(ctx, signal)]);
		return;
	}
	await ctx.api.json(target, { method: "PUT", json: { text }, signal });
	await refreshPromptsChannel(ctx, signal);
}

export async function mutateThemeEntry(
	ctx: SettingsAuxContext,
	action: { kind: "create"; theme: unknown } | { kind: "delete"; id: string },
	signal: AbortSignal,
): Promise<void> {
	if (action.kind === "create") {
		await ctx.api.json("/api/themes", { method: "POST", json: action.theme, signal });
	} else {
		await ctx.api.json(apiPath`/api/themes/${action.id}`, { method: "DELETE", signal });
		await ctx.reloadSettings();
	}
	ctx.onThemesMayChange?.();
}
