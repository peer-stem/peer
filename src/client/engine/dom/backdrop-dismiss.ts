export interface BackdropGestureState<T extends Element = HTMLDivElement> {
	pointerId: number;
	backdrop: T;
	released: boolean;
}

export function stepBackdropPointerDown<T extends Element>(event: {
	isPrimary: boolean;
	button: number;
	pointerId: number;
	target: EventTarget | null;
	currentTarget: T;
}): BackdropGestureState<T> | null {
	const press = event.isPrimary && event.button === 0 && event.target === event.currentTarget
		? { pointerId: event.pointerId, backdrop: event.currentTarget, released: false }
		: null;
	if (press && event.currentTarget.hasPointerCapture?.(event.pointerId)) {
		event.currentTarget.releasePointerCapture(event.pointerId);
	}
	return press;
}

export function stepBackdropPointerUp<T extends Element>(
	press: BackdropGestureState<T> | null,
	event: {
		isPrimary: boolean;
		button: number;
		pointerId: number;
		target: EventTarget | null;
		currentTarget: T;
	},
): BackdropGestureState<T> | null {
	return press &&
		press.pointerId === event.pointerId &&
		event.isPrimary &&
		event.button === 0 &&
		event.target === event.currentTarget &&
		press.backdrop === event.currentTarget
		? { ...press, released: true }
		: null;
}

export function shouldDismissBackdropClick<T extends Element>(
	press: BackdropGestureState<T> | null,
	event: { button: number; target: EventTarget | null; currentTarget: T },
): boolean {
	return Boolean(
		press?.released &&
		press.backdrop === event.currentTarget &&
		event.button === 0 &&
		event.target === event.currentTarget,
	);
}
