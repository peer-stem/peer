/**
 * Pure view-model derivation for the `/chat/new` draft screen (`C2a §3.7`, `§4.2`).
 * Imports `shortModelName`, `thinkingLevelLabel`, and `defaultThinkingLevel` from `'peer-engine'`.
 */
import { defaultThinkingLevel, shortModelName, thinkingLevelLabel } from "peer-engine";

const FALLBACK_THINKING_LEVELS = ["off", "low", "medium", "high"];

function formatModelShort(raw) {
	const str = String(raw ?? "").trim();
	if (!str) return "Default model";
	return shortModelName(str) || str;
}

export function formatDraftThinkingLabel(level) {
	return thinkingLevelLabel(String(level ?? "off"));
}

export function resolveDraftDefaultThinking(supported) {
	const list = Array.isArray(supported) && supported.length > 0 ? supported : FALLBACK_THINKING_LEVELS;
	return defaultThinkingLevel(list);
}

export function deriveModelCatalogOptions(availableModels, effectiveModel) {
	const raw = Array.isArray(availableModels) ? availableModels : [];
	const items = raw
		.filter((entry) => entry && entry.provider && entry.id)
		.map((entry) => ({
			key: `${entry.provider}:${entry.id}`,
			provider: String(entry.provider),
			id: String(entry.id),
			label: `${formatModelShort(entry.name || entry.id)} · ${entry.provider}`,
			shortLabel: formatModelShort(entry.name || entry.id),
			supportedThinkingLevels: Array.isArray(entry.supportedThinkingLevels) ? entry.supportedThinkingLevels : null,
		}));
	if (effectiveModel?.provider && effectiveModel?.id) {
		const key = `${effectiveModel.provider}:${effectiveModel.id}`;
		if (!items.some((item) => item.key === key)) items.unshift(buildFallbackModelEntry(key, effectiveModel));
	}
	return items;
}

function buildFallbackModelEntry(key, effectiveModel) {
	return {
		key,
		provider: String(effectiveModel.provider),
		id: String(effectiveModel.id),
		label: `${formatModelShort(effectiveModel.id)} · ${effectiveModel.provider}`,
		shortLabel: formatModelShort(effectiveModel.id),
		supportedThinkingLevels: null,
	};
}

export function filterDraftPropositions(propositions, pickedNodeIds, nodeFilter = "") {
	const pickedSet = new Set(Array.isArray(pickedNodeIds) ? pickedNodeIds.map(String) : []);
	const needle = String(nodeFilter ?? "").trim().toLowerCase();
	const raw = Array.isArray(propositions) ? propositions : [];
	const list = [];
	for (const item of raw) {
		const id = String(item?.id ?? "");
		if (!id) continue;
		const name = String(item?.name ?? id);
		const statement = String(item?.statement ?? "");
		if (needle && !name.toLowerCase().includes(needle) && !statement.toLowerCase().includes(needle)) {
			continue;
		}
		list.push({ id, name, statement, picked: pickedSet.has(id) });
	}
	return list;
}

function readEffectiveCoords(raw) {
	if (!raw || !raw.provider || !raw.id) return null;
	return {
		provider: String(raw.provider),
		id: String(raw.id),
		thinkingLevel: raw.thinkingLevel ? String(raw.thinkingLevel) : undefined,
	};
}

export function deriveNewSessionViewModel(screenModel = {}, fallbackFilter = "") {
	const rawMode = screenModel?.sessionMode ?? screenModel?.route?.mode;
	const sessionMode = rawMode === "practice" ? "practice" : "teach";
	const configured = screenModel?.configured !== false;
	const starting = Boolean(screenModel?.starting);
	const error = screenModel?.error ? String(screenModel.error) : "";
	const nodeFilter = typeof screenModel?.nodeFilter === "string"
		? screenModel.nodeFilter
		: String(fallbackFilter ?? "");
	const pickedNodeIds = Array.isArray(screenModel?.pickedNodeIds) ? screenModel.pickedNodeIds.map(String) : [];
	const effectiveModel = readEffectiveCoords(screenModel?.effectiveModel);
	const catalog = deriveModelCatalogOptions(screenModel?.availableModels, effectiveModel);
	const activeKey = effectiveModel ? `${effectiveModel.provider}:${effectiveModel.id}` : (catalog[0]?.key ?? "");
	const matched = catalog.find((item) => item.key === activeKey) ?? null;
	const baseLevels = matched?.supportedThinkingLevels?.length
		? [...matched.supportedThinkingLevels]
		: [...FALLBACK_THINKING_LEVELS];
	const thinkingLevel = effectiveModel?.thinkingLevel ?? resolveDraftDefaultThinking(baseLevels);
	if (thinkingLevel && !baseLevels.includes(thinkingLevel)) baseLevels.push(thinkingLevel);

	return {
		sessionMode,
		configured,
		starting,
		error,
		nodeFilter,
		pickedNodeIds,
		propositions: filterDraftPropositions(screenModel?.propositions, pickedNodeIds, nodeFilter),
		totalPropositions: Array.isArray(screenModel?.propositions) ? screenModel.propositions.length : 0,
		topBar: {
			title: sessionMode === "practice" ? "New practice session" : "New lesson",
			kind: sessionMode,
			subtitle: starting ? "Starting session…" : "",
			badge: pickedNodeIds.length > 0 ? `${pickedNodeIds.length} picked` : "",
		},
		placeholder: sessionMode === "practice"
			? "Describe what you want to practice (or pick propositions above)…"
			: "What do you want to understand deeply?",
		startLabel: starting ? "Starting…" : (sessionMode === "practice" ? "Start practice" : "Start lesson"),
		modelPillLabel: matched ? matched.shortLabel : (configured ? "Default model" : "Not configured"),
		catalog,
		activeModelKey: activeKey,
		thinkingLevel,
		thinkingLevels: baseLevels,
	};
}
