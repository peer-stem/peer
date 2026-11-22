/**
 * Home screen projection store (`c2a-frozen-contracts §3.7`).
 * Projects `GraphStore`, `SettingsStore`, `AppearanceStore`, `PrefsStore`, and
 * `SessionStarter` into `HomeScreenModel` for `views/home/home-view.js`.
 */

import {
	effectiveColors,
	graphFolderIds,
	toggleGraphFolder,
	type SourceDirectory,
	type SourceOrganization,
} from "../../../core/index.ts";
import { OPENING_PROMPT_FAILURE, SessionStarter } from "../../engine/index.ts";
import type { ApiClient } from "../api.ts";
import type { AppearanceIntent, AppearanceModel } from "../appearance.ts";
import type { GraphIntent, GraphStoreModel } from "../graph.ts";
import type { GraphCamera, PrefsIntent, PrefsModel } from "../prefs.ts";
import type { RouterStore } from "../router.ts";
import type { SettingsIntent, SettingsModel } from "../settings.ts";
import type { ShellIntent, ShellModel } from "../shell.ts";
import {
	createCell,
	createStoreFromCell,
	type Store,
	type Unsubscribe,
} from "../store.ts";

export interface HomeThemeColors {
	readonly node: string;
	readonly edge: string;
	readonly label: string;
	readonly hoverText: string;
}

export interface HomeScreenModel {
	readonly route: { readonly name: "home" };
	readonly configured: boolean;
	readonly mode: "dark" | "light";
	readonly graphEnabled: boolean;
	readonly viewTab: "graph" | "chains";
	readonly sessionMode: "teach" | "practice";
	readonly selectedNodeId: string | null;
	readonly searchQuery: string;
	readonly pickedNodeIds: readonly string[];
	readonly selectedFolderIds: readonly string[];
	readonly sources: SourceDirectory | null;
	readonly camera: GraphCamera | null;
	readonly graph: GraphStoreModel;
	readonly themeColors: HomeThemeColors;
	readonly fontFamily: string;
	readonly startError: string | null;
	readonly starting: boolean;
}

export type HomeScreenIntent =
	| GraphIntent
	| { readonly type: "set-view-tab"; readonly tab: "graph" | "chains" }
	| { readonly type: "set-session-mode"; readonly mode: "teach" | "practice" }
	| { readonly type: "select-node"; readonly nodeId: string | null }
	| { readonly type: "set-search"; readonly query: string }
	| { readonly type: "toggle-pick-node"; readonly nodeId: string }
	| { readonly type: "clear-picks" }
	| { readonly type: "toggle-graph-folder"; readonly folderId: string; readonly checked: boolean }
	| { readonly type: "clear-graph-folders" }
	| { readonly type: "set-camera"; readonly camera: GraphCamera | null }
	| {
			readonly type: "start-session";
			readonly prompt: string;
			readonly kind?: "teach" | "practice";
			readonly nodeIds?: readonly string[];
	  }
	| { readonly type: "open-setup" }
	| { readonly type: "open-settings"; readonly section?: string };

export interface CreateHomeScreenStoreOptions {
	api: ApiClient;
	router: RouterStore;
	graph: Store<GraphStoreModel, GraphIntent>;
	settings: Store<SettingsModel, SettingsIntent>;
	appearance: Store<AppearanceModel, AppearanceIntent>;
	prefs: Store<PrefsModel, PrefsIntent>;
	shell: Store<ShellModel, ShellIntent>;
}

interface HomeLocalState {
	viewTab: "graph" | "chains";
	sessionMode: "teach" | "practice";
	selectedNodeId: string | null;
	searchQuery: string;
	pickedNodeIds: readonly string[];
	startError: string | null;
	starting: boolean;
	disposed: boolean;
}

const HOME_ROUTE = Object.freeze({ name: "home" as const });
const DEFAULT_FONT_STACK = '"Source Sans 3", ui-sans-serif, system-ui, sans-serif';

function matchesNodeSearch(node: { name: string; statement: string }, query: string): boolean {
	const q = query.trim().toLowerCase();
	if (!q) return true;
	return node.name.toLowerCase().includes(q) || node.statement.toLowerCase().includes(q);
}

function resolveValidSelection(
	selectedNodeId: string | null,
	graph: GraphStoreModel,
	searchQuery: string,
): string | null {
	if (!selectedNodeId || !graph.snapshot) return selectedNodeId;
	const found = graph.snapshot.nodes.find((n) => n.id === selectedNodeId);
	if (!found || !matchesNodeSearch(found, searchQuery)) return null;
	return selectedNodeId;
}

function resolveSelectedFolderIds(prefs: PrefsModel, graph: GraphStoreModel): readonly string[] {
	const org = graph.sources?.organization;
	if (!org) return prefs.graphFolderFilter;
	const existing = new Set(org.folders.map((f) => f.id));
	const filtered = prefs.graphFolderFilter.filter((id) => existing.has(id));
	return filtered.length === prefs.graphFolderFilter.length ? prefs.graphFolderFilter : Object.freeze(filtered);
}

function collectGraphSourceIds(graph: GraphStoreModel): Set<string> {
	const out = new Set<string>();
	const snap = graph.snapshot;
	if (!snap) return out;
	for (const node of snap.propositions) {
		const linked = snap.nodeSessions[node.id];
		if (linked && linked.length > 0) {
			for (const id of linked) out.add(id);
			continue;
		}
		for (const pt of node.provenance) {
			if (pt.chatId) out.add(pt.chatId);
		}
	}
	return out;
}

async function applyToggleGraphFolder(
	opts: CreateHomeScreenStoreOptions,
	folderId: string,
	checked: boolean,
): Promise<void> {
	const org: SourceOrganization | undefined = opts.graph.get().sources?.organization;
	if (!org) return;
	const existing = new Set(org.folders.map((f) => f.id));
	const current = new Set(opts.prefs.get().graphFolderFilter.filter((id) => existing.has(id)));
	const listed = graphFolderIds(org, collectGraphSourceIds(opts.graph.get()));
	const next = toggleGraphFolder(org, current, folderId, checked, listed);
	await opts.prefs.send({ type: "set-graph-folder-filter", folderIds: [...next] });
}

function deriveThemeColors(appearance: AppearanceModel, settings: SettingsModel): HomeThemeColors {
	const c = effectiveColors(appearance.theme, settings.effective.appearance);
	return Object.freeze({
		node: c.accent,
		edge: c.textMuted,
		label: c.textMuted,
		hoverText: c.text,
	});
}

function projectHomeScreen(
	local: HomeLocalState,
	opts: CreateHomeScreenStoreOptions,
): HomeScreenModel {
	const settings = opts.settings.get();
	const appearance = opts.appearance.get();
	const graph = opts.graph.get();
	const prefs = opts.prefs.get();
	const graphEnabled = settings.effective.graph.enabled && settings.effective.graph.rendering;
	return {
		route: HOME_ROUTE,
		configured: settings.configured,
		mode: appearance.theme.mode,
		graphEnabled,
		viewTab: local.viewTab,
		sessionMode: local.sessionMode,
		selectedNodeId: resolveValidSelection(local.selectedNodeId, graph, local.searchQuery),
		searchQuery: local.searchQuery,
		pickedNodeIds: local.pickedNodeIds,
		selectedFolderIds: resolveSelectedFolderIds(prefs, graph),
		sources: graph.sources,
		camera: prefs.graphCamera,
		graph,
		themeColors: deriveThemeColors(appearance, settings),
		fontFamily: appearance.tokens.peer["--peer-font-prose"] ?? DEFAULT_FONT_STACK,
		startError: local.startError,
		starting: local.starting,
	};
}

function collectPickedPropositions(
	graph: GraphStoreModel,
	ids: readonly string[],
): { id: string; name: string; statement: string }[] {
	if (ids.length === 0 || !graph.snapshot) return [];
	const pool = graph.snapshot.propositions.length > 0 ? graph.snapshot.propositions : graph.snapshot.nodes;
	const byId = new Map(pool.map((n) => [n.id, n]));
	const out: { id: string; name: string; statement: string }[] = [];
	for (const id of ids) {
		const n = byId.get(id);
		if (n) out.push({ id: n.id, name: n.name, statement: n.statement });
	}
	return out;
}

async function launchHomeSession(
	local: HomeLocalState,
	starter: SessionStarter,
	opts: CreateHomeScreenStoreOptions,
	intent: Extract<HomeScreenIntent, { type: "start-session" }>,
	publish: () => void,
): Promise<void> {
	const effectiveKind = intent.kind ?? local.sessionMode;
	const targetIds = intent.nodeIds ?? local.pickedNodeIds;
	const trimmed = intent.prompt.trim();
	const title =
		trimmed || (effectiveKind === "practice" && targetIds.length > 0 ? "Practice selected propositions" : "");
	if (!title || local.starting) return;
	if (!opts.settings.get().configured) {
		await opts.shell.send({ type: "open-setup" });
		return;
	}
	const propositions = collectPickedPropositions(opts.graph.get(), targetIds);
	local.starting = true;
	local.startError = null;
	publish();
	try {
		const settingsId = JSON.stringify(opts.settings.get().effective.models.strong);
		const body = {
			title,
			...(effectiveKind === "practice" ? { kind: "practice" as const } : {}),
			...(propositions.length > 0 ? { graphContext: { propositions } } : {}),
		};
		const path = await starter.start(body, opts.api.fetch, settingsId);
		if (local.disposed) return;
		local.starting = false;
		publish();
		await opts.router.send({ type: "navigate", to: path });
	} catch (err) {
		if (local.disposed) return;
		local.starting = false;
		local.startError = err instanceof Error ? err.message : OPENING_PROMPT_FAILURE;
		publish();
	}
}

function togglePickedId(current: readonly string[], nodeId: string): readonly string[] {
	const set = new Set(current);
	if (set.has(nodeId)) set.delete(nodeId);
	else set.add(nodeId);
	return Object.freeze([...set]);
}

type HomeLocalMutationIntent = Extract<
	HomeScreenIntent,
	{
		type:
			| "set-view-tab"
			| "set-session-mode"
			| "select-node"
			| "set-search"
			| "toggle-pick-node"
			| "clear-picks";
	}
>;

function applyHomeLocalMutation(
	intent: HomeLocalMutationIntent,
	local: HomeLocalState,
	publish: () => void,
): void {
	if (intent.type === "set-view-tab") local.viewTab = intent.tab;
	else if (intent.type === "set-session-mode") local.sessionMode = intent.mode;
	else if (intent.type === "select-node") local.selectedNodeId = intent.nodeId;
	else if (intent.type === "set-search") local.searchQuery = intent.query;
	else if (intent.type === "toggle-pick-node") {
		local.pickedNodeIds = togglePickedId(local.pickedNodeIds, intent.nodeId);
	} else local.pickedNodeIds = Object.freeze([]);
	publish();
}

function pruneLocalNodeReferences(local: HomeLocalState, removedIds: readonly string[], publish: () => void): void {
	const drop = new Set(removedIds);
	if (local.selectedNodeId && drop.has(local.selectedNodeId)) local.selectedNodeId = null;
	local.pickedNodeIds = Object.freeze(local.pickedNodeIds.filter((id) => !drop.has(id)));
	publish();
}

async function handleHomeScreenIntent(
	intent: HomeScreenIntent,
	local: HomeLocalState,
	starter: SessionStarter,
	opts: CreateHomeScreenStoreOptions,
	publish: () => void,
): Promise<void> {
	switch (intent.type) {
		case "set-view-tab":
		case "set-session-mode":
		case "select-node":
		case "set-search":
		case "toggle-pick-node":
		case "clear-picks":
			applyHomeLocalMutation(intent, local, publish);
			return;
		case "toggle-graph-folder":
			return applyToggleGraphFolder(opts, intent.folderId, intent.checked);
		case "clear-graph-folders":
			return opts.prefs.send({ type: "set-graph-folder-filter", folderIds: [] });
		case "set-camera":
			return opts.prefs.send({ type: "set-graph-camera", camera: intent.camera });
		case "start-session":
			return launchHomeSession(local, starter, opts, intent, publish);
		case "open-setup":
			return opts.shell.send({ type: "open-setup" });
		case "open-settings":
			return opts.shell.send({ type: "open-settings", section: intent.section ?? null });
		case "delete-node":
			pruneLocalNodeReferences(local, [intent.nodeId], publish);
			return opts.graph.send(intent);
		case "delete-nodes":
			pruneLocalNodeReferences(local, intent.nodeIds, publish);
			return opts.graph.send(intent);
		default:
			return opts.graph.send(intent);
	}
}

export function createHomeScreenStore(
	options: CreateHomeScreenStoreOptions,
): Store<HomeScreenModel, HomeScreenIntent> {
	const starter = new SessionStarter();
	const local: HomeLocalState = {
		viewTab: "graph",
		sessionMode: "teach",
		selectedNodeId: null,
		searchQuery: "",
		pickedNodeIds: Object.freeze([]),
		startError: null,
		starting: false,
		disposed: false,
	};
	const compute = () => projectHomeScreen(local, options);
	const cell = createCell<HomeScreenModel>(compute());
	const publish = () => {
		if (!local.disposed) cell.set(compute());
	};
	const offs: Unsubscribe[] = [
		options.graph.subscribe(publish),
		options.settings.subscribe(publish),
		options.appearance.subscribe(publish),
		options.prefs.subscribe(publish),
	];

	return createStoreFromCell<HomeScreenModel, HomeScreenIntent>(cell, {
		onSend: (intent) => handleHomeScreenIntent(intent, local, starter, options, publish),
		onDispose() {
			local.disposed = true;
			for (const off of offs) off();
		},
	});
}
