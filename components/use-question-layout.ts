"use client";

import { useEffect, useLayoutEffect, useReducer, useRef, useState } from "react";
import {
	createProbeHost,
	getCachedQuestionMeasure,
	measureQuestionLayout,
	onFontsLoaded,
	questionContentFingerprint,
	questionContentReady,
	rememberQuestionMeasure,
	sameLayout,
	solveMeasured,
	type LiveQuestion,
	type QuestionLayout,
	type QuestionLayoutRequest,
	type QuestionParts,
	type UseQuestionLayout,
} from "../src/client/engine/session/question-layout.ts";

export { sameLayout, type LiveQuestion, type QuestionLayoutRequest, type UseQuestionLayout };

const useIsoLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;
const arrangement = (l: QuestionLayout | null) => (l?.kind === "columns" ? "columns" : "stacked");

export function useQuestionLayout({ cacheId, request, identity, live, parts, onLayout, onSwitch }: UseQuestionLayout): QuestionLayout | null {
	const [layout, setLayout] = useState<QuestionLayout | null>(null);
	const [contentVersion, bumpContent] = useReducer((n: number) => n + 1, 0);
	const onLayoutRef = useRef(onLayout);
	onLayoutRef.current = onLayout;
	const onSwitchRef = useRef(onSwitch);
	onSwitchRef.current = onSwitch;
	const liveRef = useRef(live);
	liveRef.current = live;
	const partsRef = useRef(parts);
	partsRef.current = parts;
	const layoutRef = useRef<QuestionLayout | null>(null);
	const seenVersionRef = useRef(contentVersion);
	const staleRef = useRef(false);
	const hostRef = useRef<HTMLElement | null>(null);
	const deferredRef = useRef(false);
	const enabled = Boolean(request);
	useIsoLayoutEffect(() => {
		let next: QuestionLayout | null = null;
		const now = liveRef.current();
		if (request && now) {
			const key = `${cacheId}|${request.base}|${request.floor}|${request.key}`;
			if (contentVersion !== seenVersionRef.current) {
				seenVersionRef.current = contentVersion;
				staleRef.current = true;
			}
			const host = () => {
				if (!hostRef.current || hostRef.current.parentNode !== now.root) hostRef.current = createProbeHost(now.root);
				return hostRef.current;
			};
			const content = questionContentFingerprint(now);
			const known = getCachedQuestionMeasure(key);
			if (!staleRef.current && known && known.content === content) {
				deferredRef.current = false;
				next = solveMeasured(known.measure, request);
			} else if (!questionContentReady(now)) {
				deferredRef.current = true;
				const current = layoutRef.current;
				if (known) next = solveMeasured(known.measure, request);
				else if (current && current.kind === "columns" && current.width > request.available + 0.5) {
					next = { kind: "stacked", width: Math.max(request.base, Math.min(current.width, request.available)), binding: true };
				} else return;
			} else {
				deferredRef.current = false;
				const result = measureQuestionLayout(partsRef.current(now) as QuestionParts, request, host());
				next = result.layout;
				staleRef.current = false;
				rememberQuestionMeasure(key, { measure: result.measure, content });
			}
		}
		if (sameLayout(layoutRef.current, next)) return;
		if (arrangement(layoutRef.current) !== arrangement(next)) onSwitchRef.current?.(layoutRef.current, next);
		layoutRef.current = next;
		setLayout(next);
		onLayoutRef.current?.(next);
	}, [identity, cacheId, enabled, request?.available, request?.base, request?.floor, request?.key, contentVersion]);
	useEffect(() => () => {
		onLayoutRef.current?.(null);
		hostRef.current?.remove();
		hostRef.current = null;
	}, []);
	useEffect(() => {
		if (!enabled) return;
		const now = liveRef.current();
		if (!now) return;
		const seen = new Map<Element, { w: number; h: number }>();
		let frame = 0;
		const schedule = () => {
			if (frame) return;
			frame = requestAnimationFrame(() => { frame = 0; bumpContent(); });
		};
		const ro = new ResizeObserver((entries) => {
			for (const entry of entries) {
				const { width: w, height: h } = entry.contentRect;
				const last = seen.get(entry.target);
				seen.set(entry.target, { w, h });
				if (last && Math.abs(last.w - w) < 0.5 && Math.abs(last.h - h) > 0.5) schedule();
			}
		});
		for (const el of now.observe) if (el) ro.observe(el);
		const fonts = typeof document !== "undefined" ? document.fonts : undefined;
		const offFonts = onFontsLoaded(fonts, schedule);
		let alive = true;
		const onFontsSettled = () => { if (alive && deferredRef.current && fonts?.status !== "loading") schedule(); };
		fonts?.addEventListener?.("loadingdone", onFontsSettled);
		fonts?.addEventListener?.("loadingerror", onFontsSettled);
		void fonts?.ready?.then(onFontsSettled, onFontsSettled);
		const root = now.root;
		const onLoad = (e: Event) => { if ((e.target as Element | null)?.tagName === "IMG") schedule(); };
		root.addEventListener("load", onLoad, true);
		root.addEventListener("error", onLoad, true);
		return () => {
			alive = false;
			ro.disconnect();
			offFonts();
			fonts?.removeEventListener?.("loadingdone", onFontsSettled);
			fonts?.removeEventListener?.("loadingerror", onFontsSettled);
			root.removeEventListener("load", onLoad, true);
			root.removeEventListener("error", onLoad, true);
			if (frame) cancelAnimationFrame(frame);
		};
	}, [enabled, identity, layout?.kind]);
	return layout;
}
