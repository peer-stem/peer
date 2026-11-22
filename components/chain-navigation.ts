"use client";

import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import {
	handleChainKeyDown,
	handleChainPointerDown,
	highlightChainDomRow,
	readChainDomRows,
} from "../src/client/engine/dom/chain-navigation.ts";
import { isInteractionScopeEligible } from "../src/client/engine/plugins/plugin-input-focus.ts";
import { useOptionalInteractionLayers } from "./interaction-layers";

export * from "../src/client/engine/dom/chain-navigation.ts";

export function useChainNavigation(
	rootRef: RefObject<HTMLDivElement | null>,
	searchRef: RefObject<HTMLInputElement | null>,
	enabled: boolean,
) {
	const controller = useOptionalInteractionLayers();
	const active = useRef<string | null>(null);
	const pendingEnter = useRef<string | null>(null);
	const pendingFocus = useRef<string | null>(null);
	const highlight = (key: string | null, focus = false) => {
		active.current = highlightChainDomRow(rootRef.current, key, focus, controller);
	};
	useLayoutEffect(() => {
		const rows = readChainDomRows(rootRef.current);
		if (pendingFocus.current !== null && rows.some((row) => row.key === pendingFocus.current)) {
			const key = pendingFocus.current;
			pendingFocus.current = null;
			highlight(key, true);
		} else if (pendingEnter.current !== null) {
			const index = rows.findIndex((row) => row.key === pendingEnter.current);
			const parent = rows[index], candidate = index >= 0 ? rows[index + 1] : undefined;
			const child = parent && candidate && candidate.depth > parent.depth ? candidate : undefined;
			const key = child?.key ?? pendingEnter.current;
			pendingEnter.current = null;
			highlight(key, true);
		} else {
			highlight(active.current);
		}
	});
	useEffect(() => {
		if (!enabled) return;
		const root = rootRef.current;
		const onFind = () => {
			if (!isInteractionScopeEligible(rootRef.current, controller)) return;
			searchRef.current?.focus({ preventScroll: true });
			searchRef.current?.select();
		};
		const onPointer = (event: PointerEvent) => handleChainPointerDown(
			event, root, (key) => highlight(key), () => { pendingEnter.current = null; pendingFocus.current = null; },
		);
		const onKey = (event: KeyboardEvent) => handleChainKeyDown({
			event, root, searchInput: searchRef.current, activeKey: active.current, controller,
			onHighlight: highlight, onPendingEnter: (key) => { pendingEnter.current = key; },
		});
		window.addEventListener("lh:kbd-find", onFind);
		document.addEventListener("keydown", onKey);
		root?.addEventListener("pointerdown", onPointer);
		return () => {
			window.removeEventListener("lh:kbd-find", onFind);
			document.removeEventListener("keydown", onKey);
			root?.removeEventListener("pointerdown", onPointer);
		};
	});
	useEffect(() => {
		if (enabled && isInteractionScopeEligible(rootRef.current, controller)) {
			rootRef.current?.focus({ preventScroll: true });
		}
	}, [enabled, rootRef, controller]);
	return {
		focusRow(parts: string[]) {
			const key = JSON.stringify(parts);
			if (readChainDomRows(rootRef.current).some((row) => row.key === key)) highlight(key, true);
			else pendingFocus.current = key;
		},
	};
}
