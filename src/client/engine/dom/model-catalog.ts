import type { ModelCatalogRefreshResponse, ModelCatalogResponse } from "../../../core/index.ts";
import { onSettingsSaved, type SettingsSection } from "./settings-signal.ts";

let catalogCache: ModelCatalogResponse | undefined;
let catalogError = false;
let catalogInflight: Promise<void> | undefined;
let catalogGeneration = 0;
let stopCatalogSignals: (() => void) | undefined;
const catalogReaders = new Set<() => void>();

const publishCatalog = () => {
	for (const reader of catalogReaders) reader();
};

function handleCatalogResponse(generation: number, catalog: ModelCatalogResponse): void {
	if (generation !== catalogGeneration) return;
	catalogCache = catalog;
	catalogError = false;
	publishCatalog();
}

function handleCatalogFailure(generation: number): void {
	if (generation !== catalogGeneration) return;
	catalogError = true;
	publishCatalog();
}

export function refreshModelCatalog(revalidate = false): void {
	if (revalidate) {
		catalogGeneration++;
		catalogInflight = undefined;
	}
	if (catalogInflight) return;
	const generation = catalogGeneration;
	catalogError = false;
	publishCatalog();
	catalogInflight = fetch("/api/models")
		.then((r) => {
			if (!r.ok) throw new Error(`catalog request failed: ${r.status}`);
			return r.json() as Promise<ModelCatalogResponse>;
		})
		.then((c) => handleCatalogResponse(generation, c))
		.catch(() => handleCatalogFailure(generation))
		.finally(() => {
			if (generation === catalogGeneration) catalogInflight = undefined;
		});
}

/** Explicit settings action, separate from ordinary reads/rereads. */
export async function refreshRemoteModelCatalog() {
	const generation = catalogGeneration;
	const response = await fetch("/api/models", { method: "POST" });
	if (!response.ok) throw new Error("Model catalog refresh failed");
	const { outcome, catalog } = (await response.json()) as ModelCatalogRefreshResponse;
	if (generation === catalogGeneration) {
		catalogGeneration++;
		catalogInflight = undefined;
		catalogCache = catalog;
		catalogError = false;
		publishCatalog();
	} else {
		refreshModelCatalog(true);
	}
	return outcome;
}

export function getModelCatalogSnapshot(): { catalog: ModelCatalogResponse | undefined; failed: boolean } {
	return { catalog: catalogCache, failed: catalogError };
}

function onCatalogSettingsSaved(section: SettingsSection): void {
	if (section === "keys" || section === "claudeCode" || section === "externalCli") {
		catalogGeneration++;
		catalogInflight = undefined;
		catalogCache = undefined;
		refreshModelCatalog();
	} else if (section === "models") {
		refreshModelCatalog(true);
	}
}

export function subscribeModelCatalog(read: () => void): () => void {
	const first = catalogReaders.size === 0;
	catalogReaders.add(read);
	if (first) {
		stopCatalogSignals = onSettingsSaved(onCatalogSettingsSaved);
		refreshModelCatalog(true);
	} else {
		refreshModelCatalog();
	}
	read();
	return () => {
		catalogReaders.delete(read);
		if (!catalogReaders.size) {
			stopCatalogSignals?.();
			stopCatalogSignals = undefined;
		}
	};
}
