/**
 * New-session draft screen projection store (`c2a-frozen-contracts §3.7`).
 * Composes `RouterStore`, `GraphStore`, `SettingsStore`, `ModelsStore`, `AppearanceStore`,
 * `ShellStore`, and `SessionStarter` for `views/new-session/`.
 */

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
	OPENING_PROMPT_FAILURE,
	SessionStarter,
	type PluginFrontendManager,
	type PluginSnapshot,
} from "../../engine/index.ts";
import type { ApiClient } from "../api.ts";
import type { AppearanceIntent, AppearanceModel } from "../appearance.ts";
import type { DictationStore } from "../dictation.ts";
import type { GraphIntent, GraphStoreModel } from "../graph.ts";
import type { CatalogModelEntry, ModelsIntent, ModelsStoreModel } from "../models.ts";
import type { PluginsStore } from "../plugins.ts";
import type { RouteModel, RouterStore } from "../router.ts";
import type { SettingsIntent, SettingsModel } from "../settings.ts";
import type { ShellIntent, ShellModel } from "../shell.ts";
import {
	assertNeverIntent,
	createCell,
	createStoreFromCell,
	type Store,
	type Unsubscribe,
} from "../store.ts";

export interface NewSessionScreenModel {
	readonly route: { readonly name: "new-session"; readonly mode: "teach" | "practice" };
	readonly configured: boolean;
	readonly mode: "dark" | "light";
	readonly sessionMode: "teach" | "practice";
	readonly nodeFilter: string;
	readonly pickedNodeIds: readonly string[];
	readonly propositions: readonly { readonly id: string; readonly name: string; readonly statement: string }[];
	readonly effectiveModel: { readonly provider: string; readonly id: string; readonly thinkingLevel?: string } | null;
	readonly availableModels: readonly CatalogModelEntry[];
	readonly starting: boolean;
	readonly error: string | null;
	readonly plugins?: PluginSnapshot | null;
	readonly pluginManager?: PluginFrontendManager | null;
	readonly dictation?: DictationStore | null;
}

export type NewSessionScreenIntent =
	| { readonly type: "sync-route"; readonly routeModel: RouteModel }
	| { readonly type: "set-mode"; readonly mode: "teach" | "practice" }
	| { readonly type: "set-node-filter"; readonly query: string }
	| { readonly type: "toggle-pick-node"; readonly nodeId: string }
	| { readonly type: "clear-picks" }
	| {
			readonly type: "select-default-model";
			readonly provider: string;
			readonly id: string;
			readonly thinkingLevel?: string;
	  }
	| { readonly type: "start-session"; readonly prompt: string }
	| { readonly type: "open-setup" }
	| { readonly type: "open-settings"; readonly section?: string };

export interface CreateNewSessionScreenStoreOptions {
	api: ApiClient;
	router: RouterStore;
	graph: Store<GraphStoreModel, GraphIntent>;
	settings: Store<SettingsModel, SettingsIntent>;
	models: Store<ModelsStoreModel, ModelsIntent>;
	appearance: Store<AppearanceModel, AppearanceIntent>;
	shell: Store<ShellModel, ShellIntent>;
	routeModel?: RouteModel;
	plugins?: PluginsStore;
	dictation?: DictationStore;
}

interface NewSessionLocalState {
	sessionMode: "teach" | "practice";
	nodeFilter: string;
	pickedNodeIds: readonly string[];
	starting: boolean;
	error: string | null;
	disposed: boolean;
}

function resolveRouteMode(rm?: RouteModel): "teach" | "practice" {
	if (rm?.route.name === "new-session") return rm.route.mode;
	return "teach";
}

function toEffectiveModel(
	strong: SettingsModel["effective"]["models"]["strong"],
): NewSessionScreenModel["effectiveModel"] {
	if (!strong) return null;
	return {
		provider: strong.provider,
		id: strong.id,
		...(strong.thinkingLevel !== undefined ? { thinkingLevel: strong.thinkingLevel } : {}),
	};
}

function projectNewSessionScreen(
	local: NewSessionLocalState,
	opts: CreateNewSessionScreenStoreOptions,
): NewSessionScreenModel {
	const settings = opts.settings.get();
	const appearance = opts.appearance.get();
	const models = opts.models.get();
	const rawProps = opts.graph.get().snapshot?.propositions ?? [];
	const propositions = Object.freeze(
		rawProps.map((p) => Object.freeze({ id: p.id, name: p.name, statement: p.statement })),
	);
	return {
		route: { name: "new-session", mode: local.sessionMode },
		configured: settings.configured,
		mode: appearance.theme.mode,
		sessionMode: local.sessionMode,
		nodeFilter: local.nodeFilter,
		pickedNodeIds: local.pickedNodeIds,
		propositions,
		effectiveModel: toEffectiveModel(settings.effective.models.strong),
		availableModels: models.models,
		starting: local.starting,
		error: local.error,
		plugins: opts.plugins ? opts.plugins.get() : null,
		pluginManager: opts.plugins ? opts.plugins.manager : null,
		dictation: opts.dictation ?? null,
	};
}

async function selectDefaultStrongModel(
	opts: CreateNewSessionScreenStoreOptions,
	provider: string,
	id: string,
	thinkingLevel?: string,
): Promise<void> {
	const prevModels = opts.settings.get().record?.models ?? {};
	const nextStrong = {
		...(prevModels.strong ?? {}),
		model: { provider, id },
		...(thinkingLevel !== undefined ? { thinkingLevel: thinkingLevel as ThinkingLevel } : {}),
	};
	await opts.settings.send({
		type: "save-section",
		section: "models",
		value: { ...prevModels, strong: nextStrong },
	});
}

function resolvePickedPropositions(
	graph: GraphStoreModel,
	pickedIds: readonly string[],
): { id: string; name: string; statement: string }[] {
	const snapProps = graph.snapshot?.propositions ?? [];
	const byId = new Map(snapProps.map((p) => [p.id, p]));
	const out: { id: string; name: string; statement: string }[] = [];
	for (const id of pickedIds) {
		const found = byId.get(id);
		if (found) out.push({ id: found.id, name: found.name, statement: found.statement });
	}
	return out;
}

async function startNewDraftSession(
	local: NewSessionLocalState,
	starter: SessionStarter,
	opts: CreateNewSessionScreenStoreOptions,
	prompt: string,
	publish: () => void,
): Promise<void> {
	const pickedProps = resolvePickedPropositions(opts.graph.get(), local.pickedNodeIds);
	const trimmed = prompt.trim();
	const canFallbackPractice = local.sessionMode === "practice" && local.pickedNodeIds.length > 0;
	const names = pickedProps.length > 0 ? pickedProps.map((p) => p.name).join(", ") : local.pickedNodeIds.join(", ");
	const title = trimmed || (canFallbackPractice ? `Practice: ${names}` : "");
	if (!title || local.starting) return;
	if (!opts.settings.get().configured) {
		await opts.shell.send({ type: "open-setup" });
		return;
	}
	local.starting = true;
	local.error = null;
	publish();
	try {
		const settingsId = JSON.stringify(opts.settings.get().effective.models.strong);
		const body = {
			title,
			...(local.sessionMode === "practice" ? { kind: "practice" as const } : {}),
			...(pickedProps.length > 0 ? { graphContext: { propositions: pickedProps } } : {}),
		};
		const path = await starter.start(body, opts.api.fetch, settingsId);
		if (local.disposed) return;
		local.starting = false;
		publish();
		await opts.router.send({ type: "navigate", to: path });
	} catch (err) {
		if (local.disposed) return;
		local.starting = false;
		local.error = err instanceof Error ? err.message : OPENING_PROMPT_FAILURE;
		publish();
	}
}

function toggleNewSessionPick(current: readonly string[], nodeId: string): readonly string[] {
	const set = new Set(current);
	if (set.has(nodeId)) set.delete(nodeId);
	else set.add(nodeId);
	return Object.freeze([...set]);
}

function syncNewSessionRoute(
	rm: RouteModel,
	local: NewSessionLocalState,
	publish: () => void,
): void {
	if (rm.route.name !== "new-session" || rm.route.mode === local.sessionMode) return;
	local.sessionMode = rm.route.mode;
	publish();
}

async function handleNewSessionIntent(
	intent: NewSessionScreenIntent,
	local: NewSessionLocalState,
	starter: SessionStarter,
	opts: CreateNewSessionScreenStoreOptions,
	publish: () => void,
): Promise<void> {
	switch (intent.type) {
		case "sync-route":
			syncNewSessionRoute(intent.routeModel, local, publish);
			return;
		case "set-mode":
			local.sessionMode = intent.mode;
			publish();
			return opts.router.send({ type: "navigate", to: { name: "new-session", mode: intent.mode }, replace: true });
		case "set-node-filter":
			local.nodeFilter = intent.query;
			publish();
			return;
		case "toggle-pick-node":
			local.pickedNodeIds = toggleNewSessionPick(local.pickedNodeIds, intent.nodeId);
			publish();
			return;
		case "clear-picks":
			local.pickedNodeIds = Object.freeze([]);
			publish();
			return;
		case "select-default-model":
			return selectDefaultStrongModel(opts, intent.provider, intent.id, intent.thinkingLevel);
		case "start-session":
			return startNewDraftSession(local, starter, opts, intent.prompt, publish);
		case "open-setup":
			return opts.shell.send({ type: "open-setup" });
		case "open-settings":
			return opts.shell.send({ type: "open-settings", section: intent.section ?? null });
		default:
			return assertNeverIntent(intent);
	}
}

export function createNewSessionScreenStore(
	options: CreateNewSessionScreenStoreOptions,
): Store<NewSessionScreenModel, NewSessionScreenIntent> {
	const starter = new SessionStarter();
	const local: NewSessionLocalState = {
		sessionMode: resolveRouteMode(options.routeModel ?? options.router.get()),
		nodeFilter: "",
		pickedNodeIds: Object.freeze([]),
		starting: false,
		error: null,
		disposed: false,
	};
	const compute = () => projectNewSessionScreen(local, options);
	const cell = createCell<NewSessionScreenModel>(compute());
	const publish = () => {
		if (!local.disposed) cell.set(compute());
	};
	const offs: Unsubscribe[] = [
		options.graph.subscribe(publish),
		options.settings.subscribe(publish),
		options.models.subscribe(publish),
		options.appearance.subscribe(publish),
		options.router.subscribe((rm) => syncNewSessionRoute(rm, local, publish)),
		options.plugins ? options.plugins.subscribe(publish) : () => {},
	];

	return createStoreFromCell<NewSessionScreenModel, NewSessionScreenIntent>(cell, {
		onSend: (intent) => handleNewSessionIntent(intent, local, starter, options, publish),
		onDispose() {
			local.disposed = true;
			for (const off of offs) off();
		},
	});
}
