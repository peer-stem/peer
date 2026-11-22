/**
 * Sidebar sessions & folder organization store (`f3-c2b §1`).
 * Hydrates `GET /api/chats` and `GET /api/graph/sources`, coalesces rapid SSE
 * bursts, ranks search via `fuzzyScore`, persists open folders, and runs
 * session/folder CRUD + markdown export.
 */

import {
	emptySourceOrganization,
	type ChatDeleteMode,
	type ChatListItem,
	type FolderDeletionScope,
	type OrganizationAction,
	type SourceDirectory,
	type SourceOrganization,
} from "../../core/index.ts";
import type { ApiClient } from "./api.ts";
import type { Events } from "./events.ts";
import {
	executeDeleteFolder,
	executeDeleteSession,
	executeRenameSession,
	executeSourceAction,
	exportSessionMarkdown,
	fetchSessionsChats,
	fetchSessionsSources,
	filterChatsByQuery,
	getSafeSessionsStorage,
	OPEN_FOLDERS_STORAGE_KEY,
	readStoredOpenFolders,
	reloadSessionsAll,
	writeStoredOpenFolders,
	type SessionsContext,
} from "./sessions-helpers.ts";
import {
	assertNeverIntent,
	createCell,
	createStoreFromCell,
	type LoadState,
	type Store,
	type Unsubscribe,
} from "./store.ts";

export { OPEN_FOLDERS_STORAGE_KEY };

export interface SessionsExportResult {
	readonly chatId: string;
	readonly filename: string;
	readonly markdown: string;
}

export interface SessionsModel {
	readonly load: LoadState;
	readonly error: string | null;
	readonly chats: readonly ChatListItem[];
	readonly organization: SourceOrganization;
	readonly sources: SourceDirectory | null;
	readonly searchQuery: string;
	readonly filteredChats: readonly ChatListItem[];
	readonly openFolderIds: readonly string[];
	readonly lastExport: SessionsExportResult | null;
}

export type SessionsIntent =
	| { readonly type: "reload" }
	| { readonly type: "set-search"; readonly query: string }
	| { readonly type: "toggle-folder-open"; readonly folderId: string }
	| { readonly type: "set-folder-open"; readonly folderId: string; readonly open: boolean }
	| { readonly type: "rename-session"; readonly chatId: string; readonly title: string }
	| { readonly type: "delete-session"; readonly chatId: string; readonly mode: ChatDeleteMode }
	| { readonly type: "export-markdown"; readonly chatId: string }
	| { readonly type: "source-action"; readonly action: OrganizationAction | Record<string, unknown> }
	| {
			readonly type: "delete-folder";
			readonly folderId: string;
			readonly mode: ChatDeleteMode;
			readonly scope?: FolderDeletionScope;
	  };

export interface CreateSessionsStoreOptions {
	api: ApiClient;
	events: Events;
	storage?: Storage | null;
}

function publishSessions(ctx: SessionsContext): void {
	if (ctx.disposed) return;
	ctx.cell.set({
		load: ctx.load,
		error: ctx.error,
		chats: ctx.chats,
		organization: ctx.organization,
		sources: ctx.sources,
		searchQuery: ctx.searchQuery,
		filteredChats: filterChatsByQuery(ctx.chats, ctx.searchQuery),
		openFolderIds: ctx.openFolderIds,
		lastExport: ctx.lastExport,
	});
}

function updateFolderOpenState(ctx: SessionsContext, folderId: string, open: boolean): void {
	if (!folderId) return;
	const set = new Set(ctx.openFolderIds);
	if (set.has(folderId) === open) return;
	if (open) set.add(folderId);
	else set.delete(folderId);
	const next = Object.freeze([...set]);
	ctx.openFolderIds = next;
	writeStoredOpenFolders(ctx.storage, next);
	publishSessions(ctx);
}

async function handleSessionsIntent(ctx: SessionsContext, intent: SessionsIntent): Promise<void> {
	switch (intent.type) {
		case "reload":
			return reloadSessionsAll(ctx);
		case "set-search":
			if (ctx.searchQuery === intent.query) return;
			ctx.searchQuery = intent.query;
			publishSessions(ctx);
			return;
		case "toggle-folder-open":
			updateFolderOpenState(ctx, intent.folderId, !ctx.openFolderIds.includes(intent.folderId));
			return;
		case "set-folder-open":
			updateFolderOpenState(ctx, intent.folderId, intent.open);
			return;
		case "rename-session":
			return executeRenameSession(ctx, intent.chatId, intent.title);
		case "delete-session":
			return executeDeleteSession(ctx, intent.chatId, intent.mode);
		case "export-markdown":
			return exportSessionMarkdown(ctx, intent.chatId);
		case "source-action":
			return executeSourceAction(ctx, intent.action);
		case "delete-folder":
			return executeDeleteFolder(ctx, intent.folderId, intent.mode, intent.scope);
		default:
			return assertNeverIntent(intent);
	}
}

function wireSessionsEvents(ctx: SessionsContext, events: Events): Unsubscribe {
	const offs: Unsubscribe[] = [
		events.on("chats-changed", () => {
			void fetchSessionsChats(ctx);
		}),
		events.on("sources-changed", () => {
			void fetchSessionsSources(ctx);
		}),
		events.onResync(() => {
			void reloadSessionsAll(ctx);
		}),
	];
	return () => {
		for (const off of offs) off();
	};
}

function createSessionsContext(options: CreateSessionsStoreOptions): SessionsContext {
	const storage = getSafeSessionsStorage(options.storage);
	const openFolderIds = readStoredOpenFolders(storage);
	const emptyChats: readonly ChatListItem[] = Object.freeze([]);
	const initialOrg = emptySourceOrganization();
	const cell = createCell<SessionsModel>({
		load: "loading", error: null, chats: emptyChats, organization: initialOrg,
		sources: null, searchQuery: "", filteredChats: emptyChats, openFolderIds, lastExport: null,
	});
	const ctx: SessionsContext = {
		api: options.api, storage, cell, disposed: false, hasLoadedChats: false,
		load: "loading", error: null, chats: emptyChats, organization: initialOrg,
		sources: null, searchQuery: "", openFolderIds, lastExport: null,
		activeChatsLoad: null, inFlightChats: null, pendingChatsReload: false,
		activeSourcesLoad: null, inFlightSources: null, pendingSourcesReload: false,
		publish: () => publishSessions(ctx),
	};
	return ctx;
}

export function createSessionsStore(
	options: CreateSessionsStoreOptions,
): Store<SessionsModel, SessionsIntent> {
	const ctx = createSessionsContext(options);
	const offEvents = wireSessionsEvents(ctx, options.events);
	void reloadSessionsAll(ctx);

	return createStoreFromCell<SessionsModel, SessionsIntent>(ctx.cell, {
		onSend: (intent) => handleSessionsIntent(ctx, intent),
		onDispose() {
			ctx.disposed = true;
			offEvents();
			ctx.activeChatsLoad?.abort();
			ctx.activeSourcesLoad?.abort();
		},
	});
}
