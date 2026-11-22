"use client";

import { useEffect } from "react";
import { bindFieldCycle } from "../src/client/engine/dom/field-cycle.ts";
import { useOptionalInteractionLayers } from "./interaction-layers";

export * from "../src/client/engine/dom/field-cycle.ts";

export function useFieldCycle(fields: () => readonly HTMLElement[]): void {
	const controller = useOptionalInteractionLayers();
	useEffect(() => bindFieldCycle(fields, controller), [fields, controller]);
}
