"use client";

import { useCallback, useEffect, useLayoutEffect, type RefObject } from "react";
import {
	clearDockHeightStyles,
	DOCK_HEIGHT_REGION,
	syncDockHeight,
} from "../src/client/engine/dom/dock-height.ts";

export * from "../src/client/engine/dom/dock-height.ts";

const useIsoLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

interface DockHeightRefs {
	scrollRef: RefObject<HTMLElement | null>;
	blockRef: RefObject<HTMLDivElement | null>;
	viewportRef: RefObject<HTMLDivElement | null>;
	bodyRef: RefObject<HTMLDivElement | null>;
	shellRef: RefObject<HTMLDivElement | null>;
	contentRef: RefObject<HTMLDivElement | null>;
}

export function useDockHeight({
	scrollRef, blockRef, viewportRef, bodyRef, shellRef, contentRef,
	expanded, enabled, mode, onScrollbarInset, onHeight, onLayout,
}: DockHeightRefs & {
	expanded: boolean;
	enabled: boolean;
	mode: string;
	onScrollbarInset: (inset: number) => void;
	onHeight: (height: number) => void;
	onLayout?: () => void;
}) {
	const measure = useCallback(() => {
		const column = scrollRef.current;
		const block = blockRef.current;
		const viewport = viewportRef.current;
		const body = bodyRef.current;
		const shell = shellRef.current;
		const content = contentRef.current;
		if (!column || !block || !viewport || !body || !shell || !content) return;
		onScrollbarInset(Math.round((column.offsetWidth - column.clientWidth) / 2));
		if (enabled) syncDockHeight({ column, block, viewport, body, shell, content }, expanded);
		else clearDockHeightStyles({ block, viewport, shell });
		onLayout?.();
		if (shell.getAnimations().length === 0) onHeight(block.getBoundingClientRect().height);
	}, [scrollRef, blockRef, viewportRef, bodyRef, shellRef, contentRef, expanded, enabled, onScrollbarInset, onHeight, onLayout]);

	useIsoLayoutEffect(measure);
	useIsoLayoutEffect(() => {
		let active = true;
		const observedMeasure = () => { if (active) measure(); };
		const observer = new ResizeObserver(observedMeasure);
		for (const el of [scrollRef.current, blockRef.current, viewportRef.current, bodyRef.current, contentRef.current]) {
			if (el) observer.observe(el);
		}
		const question = expanded ? contentRef.current?.querySelector(DOCK_HEIGHT_REGION) : null;
		if (question) observer.observe(question);
		window.addEventListener("resize", observedMeasure);
		return () => {
			active = false;
			observer.disconnect();
			window.removeEventListener("resize", observedMeasure);
		};
	}, [measure, mode, expanded, scrollRef, blockRef, viewportRef, bodyRef, contentRef]);
}
