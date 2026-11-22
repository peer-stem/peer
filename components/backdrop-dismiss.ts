"use client";

import { useRef, type MouseEvent, type PointerEvent } from "react";
import {
	shouldDismissBackdropClick,
	stepBackdropPointerDown,
	stepBackdropPointerUp,
	type BackdropGestureState,
} from "../src/client/engine/dom/backdrop-dismiss.ts";

export * from "../src/client/engine/dom/backdrop-dismiss.ts";

export function useBackdropDismiss(onDismiss: () => void) {
	const gesture = useRef<BackdropGestureState<HTMLDivElement> | null>(null);
	return {
		onPointerDownCapture(event: PointerEvent<HTMLDivElement>) {
			gesture.current = stepBackdropPointerDown(event);
		},
		onPointerUpCapture(event: PointerEvent<HTMLDivElement>) {
			gesture.current = stepBackdropPointerUp(gesture.current, event);
		},
		onPointerCancelCapture() {
			gesture.current = null;
		},
		onClickCapture(event: MouseEvent<HTMLDivElement>) {
			const press = gesture.current;
			gesture.current = null;
			if (shouldDismissBackdropClick(press, event)) onDismiss();
		},
	};
}
