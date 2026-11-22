"use client";

import { useCallback, useEffect, useState } from "react";
import type { ModelCatalogResponse } from "@/src/core";
import {
	getModelCatalogSnapshot,
	refreshModelCatalog,
	subscribeModelCatalog,
} from "../src/client/engine/dom/model-catalog.ts";

export * from "../src/client/engine/dom/model-catalog.ts";

export function useModelCatalog(): { catalog: ModelCatalogResponse | undefined; failed: boolean; refresh: () => void } {
	const [snapshot, setSnapshot] = useState(getModelCatalogSnapshot);
	useEffect(() => subscribeModelCatalog(() => setSnapshot(getModelCatalogSnapshot())), []);
	const refresh = useCallback(() => refreshModelCatalog(true), []);
	return { ...snapshot, refresh };
}
