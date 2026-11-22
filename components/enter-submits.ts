"use client";

import { useEffect, useRef, type RefObject } from "react";
import { bindEnterSubmits } from "../src/client/engine/dom/enter-submits.ts";
import { useOptionalInteractionLayers } from "./interaction-layers";

export * from "../src/client/engine/dom/enter-submits.ts";

export function useEnterSubmits(submit: () => void, scopeRef?: RefObject<HTMLElement | null>): void {
	const controller = useOptionalInteractionLayers();
	const submitRef = useRef(submit);
	submitRef.current = submit;
	useEffect(() => bindEnterSubmits({
		submit: () => submitRef.current(),
		getScope: () => (scopeRef ? scopeRef.current : document.body),
		controller,
	}), [controller, scopeRef]);
}
