/**
 * Persistence, fetch coalescing, search ranking, and mutation helpers
 * for `SessionsStore` (`f3-c2b §1`).
 */

import {
	emptySourceOrganization,
	folderAndDescendants,
	folderDeletionScope,
	fuzzyScore,
	placementOf,
	type ChatDeleteMode,
	type ChatListItem,
	type FolderDeletionScope,
	type OrganizationAction,
	type SourceDirectory,
	type SourceOrganization,
} from "../../core/index.ts";
import { ApiError, apiPath, isAbortError, type ApiClient, type ApiPath } from "./api.ts";
import type { SessionsExportResult, SessionsModel } from "./sessions.ts";
import type { Cell, LoadState } from "./store.ts";

export const OPEN_FOLDERS_STORAGE_KEY = "lh.sidebar.open-folders.v1";

export interface SessionsContext {
	readonly api: ApiClient;
	readonly storage: Storage | null;
	readonly cell: Cell<SessionsModel>;
	disposed: boolean;
	hasLoadedChats: boolean;
	load: LoadState;
	error: string | null;
	chats: readonly ChatListItem[];
	organization: SourceOrganization;
	sources: SourceDirectory | null;
	searchQuery: string;
	openFolderIds: readonly string[];
	lastExport: SessionsExportResult | null;
	activeChatsLoad: AbortController | null;
	inFlightChats: Promise<void> | null;
	pendingChatsReload: boolean;
	activeSourcesLoad: AbortController | null;
	inFlightSources: Promise<void> | null;
	pendingSourcesReload: boolean;
	publish: () => void;
}

export function getSafeSessionsStorage(override?: Storage | null): Storage | null {
	if (override !== undefined) return override;
	try {
		return globalThis.localStorage ?? null;
	} catch {
		return null;
	}
}

export function sanitizeOpenFolderIds(raw: unknown): readonly string[] {
	if (!Array.isArray(raw)) return Object.freeze([]);
	const seen = new Set<string>();
	for (const item of raw) {
		if (typeof item === "string" && item.length > 0) seen.add(item);
	}
	return Object.freeze([...seen]);
}

export function readStoredOpenFolders(storage: Storage | null): readonly string[] {
	if (!storage) return Object.freeze([]);
	try {
		const raw = storage.getItem(OPEN_FOLDERS_STORAGE_KEY);
		if (!raw) return Object.freeze([]);
		return sanitizeOpenFolderIds(JSON.parse(raw));
	} catch {
		return Object.freeze([]);
	}
}

export function writeStoredOpenFolders(storage: Storage | null, ids: readonly string[]): void {
	if (!storage) return;
	try {
		storage.setItem(OPEN_FOLDERS_STORAGE_KEY, JSON.stringify([...ids]));
	} catch {
		/* storage quota or sandbox error: best-effort */
	}
}

export function filterChatsByQuery(
	chats: readonly ChatListItem[],
	searchQuery: string,
): readonly ChatListItem[] {
	const trimmed = searchQuery.trim();
	if (!trimmed) return chats;
	const scored: Array<{ chat: ChatListItem; score: number; idx: number }> = [];
	for (let i = 0; i < chats.length; i++) {
		const chat = chats[i]!;
		const score = fuzzyScore(trimmed, chat.title);
		if (score !== null) scored.push({ chat, score, idx: i });
	}
	scored.sort((a, b) => b.score - a.score || a.idx - b.idx);
	return Object.freeze(scored.map((entry) => entry.chat));
}

function extractChatsList(raw: unknown): readonly ChatListItem[] {
	if (Array.isArray(raw)) return Object.freeze([...(raw as ChatListItem[])]);
	if (raw && typeof raw === "object") {
		const chats = (raw as { chats?: unknown }).chats;
		if (Array.isArray(chats)) return Object.freeze([...(chats as ChatListItem[])]);
	}
	return Object.freeze([]);
}

export function normalizeSessionsSourceDirectory(raw: unknown): SourceDirectory | null {
	if (!raw || typeof raw !== "object") return null;
	const r = raw as Record<string, unknown>;
	const org = r.organization as Record<string, unknown> | undefined;
	if (!org || typeof org !== "object" || !Array.isArray(org.folders) || !Array.isArray(r.sources)) {
		return null;
	}
	const placements =
		org.placements && typeof org.placements === "object" && !Array.isArray(org.placements)
			? (org.placements as SourceOrganization["placements"])
			: {};
	return {
		organization: {
			version: 1,
			folders: org.folders as SourceOrganization["folders"],
			placements,
		},
		sources: r.sources as SourceDirectory["sources"],
	};
}

async function runSingleChatsFetch(ctx: SessionsContext): Promise<void> {
	const controller = new AbortController();
	ctx.activeChatsLoad = controller;
	try {
		const raw = await ctx.api.json<unknown>("/api/chats", { signal: controller.signal });
		if (ctx.disposed || controller.signal.aborted) return;
		ctx.chats = extractChatsList(raw);
		ctx.hasLoadedChats = true;
		ctx.load = "ready";
		ctx.error = null;
		ctx.publish();
	} catch (err) {
		if (ctx.disposed || controller.signal.aborted || isAbortError(err)) return;
		const msg = err instanceof Error ? err.message : String(err);
		if (!ctx.hasLoadedChats) ctx.load = "error";
		ctx.error = msg;
		ctx.publish();
	} finally {
		if (ctx.activeChatsLoad === controller) ctx.activeChatsLoad = null;
	}
}

export function fetchSessionsChats(ctx: SessionsContext): Promise<void> {
	if (ctx.disposed) return Promise.resolve();
	if (ctx.inFlightChats) {
		ctx.pendingChatsReload = true;
		return ctx.inFlightChats;
	}
	const drain = async (): Promise<void> => {
		do {
			ctx.pendingChatsReload = false;
			await runSingleChatsFetch(ctx);
		} while (!ctx.disposed && ctx.pendingChatsReload);
	};
	ctx.inFlightChats = drain().finally(() => {
		ctx.inFlightChats = null;
	});
	return ctx.inFlightChats;
}

async function runSingleSourcesFetch(ctx: SessionsContext): Promise<void> {
	const controller = new AbortController();
	ctx.activeSourcesLoad = controller;
	try {
		const raw = await ctx.api.json<unknown>("/api/graph/sources", { signal: controller.signal });
		if (ctx.disposed || controller.signal.aborted) return;
		const dir = normalizeSessionsSourceDirectory(raw);
		if (!dir) return;
		ctx.sources = dir;
		ctx.organization = dir.organization;
		ctx.publish();
	} catch {
		/* optional or transiently unavailable aux directory: preserve previous state */
	} finally {
		if (ctx.activeSourcesLoad === controller) ctx.activeSourcesLoad = null;
	}
}

export function fetchSessionsSources(ctx: SessionsContext): Promise<void> {
	if (ctx.disposed) return Promise.resolve();
	if (ctx.inFlightSources) {
		ctx.pendingSourcesReload = true;
		return ctx.inFlightSources;
	}
	const drain = async (): Promise<void> => {
		do {
			ctx.pendingSourcesReload = false;
			await runSingleSourcesFetch(ctx);
		} while (!ctx.disposed && ctx.pendingSourcesReload);
	};
	ctx.inFlightSources = drain().finally(() => {
		ctx.inFlightSources = null;
	});
	return ctx.inFlightSources;
}

export async function reloadSessionsAll(ctx: SessionsContext): Promise<void> {
	await Promise.all([fetchSessionsChats(ctx), fetchSessionsSources(ctx)]);
}

function parseContentDispositionFilename(header: string | null, fallback: string): string {
	if (!header) return fallback;
	const utf8Match = /filename\*=UTF-8''([^;\r\n]+)/i.exec(header);
	if (utf8Match?.[1]) {
		try {
			const decoded = decodeURIComponent(utf8Match[1].trim());
			if (decoded) return decoded;
		} catch {
			/* fall through */
		}
	}
	const quotedMatch = /filename="([^"\r\n]+)"/i.exec(header);
	if (quotedMatch?.[1]?.trim()) return quotedMatch[1].trim();
	const bareMatch = /filename=([^;\s\r\n]+)/i.exec(header);
	if (bareMatch?.[1]?.trim()) return bareMatch[1].trim();
	return fallback;
}

function throwMarkdownExportError(res: Response, text: string, path: ApiPath): never {
	let parsed: unknown = text;
	let message = text.trim() || `HTTP ${res.status} GET ${path}`;
	let code: string | undefined;
	try {
		const obj = JSON.parse(text) as Record<string, unknown>;
		parsed = obj;
		if (typeof obj?.error === "string" && obj.error) message = obj.error;
		if (typeof obj?.code === "string") code = obj.code;
	} catch {
		/* plain-text error body */
	}
	throw new ApiError({ message, status: res.status, method: "GET", path, body: parsed, code });
}

export async function exportSessionMarkdown(ctx: SessionsContext, chatId: string): Promise<void> {
	const path = apiPath`/api/chats/${chatId}/markdown`;
	const res = await ctx.api.request(path, { method: "GET" });
	const text = await res.text();
	if (!res.ok) throwMarkdownExportError(res, text, path);
	if (ctx.disposed) return;
	const filename = parseContentDispositionFilename(
		res.headers.get("content-disposition"),
		`${chatId}.md`,
	);
	ctx.lastExport = Object.freeze({ chatId, filename, markdown: text });
	ctx.publish();
}

export async function executeRenameSession(
	ctx: SessionsContext,
	chatId: string,
	rawTitle: string,
): Promise<void> {
	const trimmed = rawTitle.trim();
	if (!trimmed) return;
	const res = await ctx.api.json<{ title?: string }>(apiPath`/api/chats/${chatId}`, {
		method: "PUT",
		json: { title: trimmed },
	});
	if (ctx.disposed) return;
	const nextTitle = typeof res?.title === "string" && res.title.trim() ? res.title : trimmed;
	ctx.chats = Object.freeze(ctx.chats.map((c) => (c.id === chatId ? { ...c, title: nextTitle } : c)));
	if (ctx.sources) {
		ctx.sources = {
			...ctx.sources,
			sources: ctx.sources.sources.map((s) => (s.id === chatId ? { ...s, label: nextTitle } : s)),
		};
	}
	ctx.publish();
}

export async function executeDeleteSession(
	ctx: SessionsContext,
	chatId: string,
	mode: ChatDeleteMode,
): Promise<void> {
	await ctx.api.json(apiPath`/api/chats/${chatId}`, {
		method: "DELETE",
		query: { mode },
	});
	if (ctx.disposed) return;
	ctx.chats = Object.freeze(ctx.chats.filter((c) => c.id !== chatId));
	ctx.publish();
	void reloadSessionsAll(ctx);
}

export async function executeSourceAction(
	ctx: SessionsContext,
	action: OrganizationAction | Record<string, unknown>,
): Promise<void> {
	const raw = await ctx.api.json<unknown>("/api/graph/sources", {
		method: "POST",
		json: action,
	});
	if (ctx.disposed) return;
	const dir = normalizeSessionsSourceDirectory(raw);
	if (dir) {
		ctx.sources = dir;
		ctx.organization = dir.organization;
		ctx.publish();
	} else {
		await fetchSessionsSources(ctx);
	}
	if ((action as { action?: unknown }).action === "rename-source") {
		await fetchSessionsChats(ctx);
	}
}

function resolveDeleteFolderScope(ctx: SessionsContext, folderId: string): FolderDeletionScope {
	if (ctx.sources) {
		const computed = folderDeletionScope(ctx.sources, folderId);
		if (computed) return computed;
	}
	const org = ctx.organization ?? emptySourceOrganization();
	const folder = org.folders.find((f) => f.id === folderId);
	const folderIds = folder ? folderAndDescendants(org, folderId).sort() : [folderId];
	const inside = new Set(folderIds);
	const chatIds = ctx.chats
		.filter((c) => {
			const placed = placementOf(org, c.id)?.folderId ?? null;
			return placed !== null && inside.has(placed);
		})
		.map((c) => c.id)
		.sort();
	return { parentId: folder?.parentId ?? null, folderIds, chatIds, noteIds: [] };
}

export async function executeDeleteFolder(
	ctx: SessionsContext,
	folderId: string,
	mode: ChatDeleteMode,
	explicitScope?: FolderDeletionScope,
): Promise<void> {
	const scope = explicitScope ?? resolveDeleteFolderScope(ctx, folderId);
	const raw = await ctx.api.json<Record<string, unknown>>(
		apiPath`/api/graph/sources/folders/${folderId}`,
		{ method: "DELETE", query: { mode }, json: scope },
	);
	if (ctx.disposed) return;
	const removedFolders = new Set(scope.folderIds);
	const nextOpen = Object.freeze(ctx.openFolderIds.filter((id) => !removedFolders.has(id)));
	if (nextOpen.length !== ctx.openFolderIds.length) {
		ctx.openFolderIds = nextOpen;
		writeStoredOpenFolders(ctx.storage, nextOpen);
	}
	const rawDeleted = Array.isArray(raw?.deletedChatIds) ? raw.deletedChatIds : scope.chatIds;
	const goneChats = new Set(rawDeleted.filter((id): id is string => typeof id === "string"));
	if (goneChats.size > 0) {
		ctx.chats = Object.freeze(ctx.chats.filter((c) => !goneChats.has(c.id)));
	}
	const dir = normalizeSessionsSourceDirectory(raw);
	if (dir) {
		ctx.sources = dir;
		ctx.organization = dir.organization;
		ctx.publish();
		return;
	}
	ctx.publish();
	await reloadSessionsAll(ctx);
}
