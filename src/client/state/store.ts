/**
 * Universal client store contract and 1/microtask state cell (`R2`, `C-08`, `state §2.1`).
 * Pure and DOM-free: notifications coalesce via `queueMicrotask` so Node unit
 * tests stay deterministic without `requestAnimationFrame`.
 */

export type Unsubscribe = () => void;
export type LoadState = "loading" | "ready" | "not-found" | "error";

export interface Store<M, I extends { readonly type: string }> {
	get(): M;
	subscribe(listener: (model: M) => void): Unsubscribe;
	send(intent: I): Promise<void>;
	dispose(): void;
}

export interface Cell<M> {
	get(): M;
	set(next: M): void;
	subscribe(listener: (model: M) => void): Unsubscribe;
	dispose(): void;
}

export interface StoreHooks<I extends { readonly type: string }> {
	onSend?: (intent: I) => void | Promise<void>;
	onDispose?: () => void;
}

export function assertNeverIntent(intent: { readonly type: string }): never {
	throw new Error(`Unknown store intent: ${intent.type}`);
}

function notifyListeners<M>(
	listeners: Set<(model: M) => void>,
	value: M,
	isDisposed: () => boolean,
): void {
	for (const listener of [...listeners]) {
		if (isDisposed() || !listeners.has(listener)) continue;
		listener(value);
	}
}

export function createCell<M>(initial: M): Cell<M> {
	let current = initial;
	let queued = false;
	let disposed = false;
	const listeners = new Set<(model: M) => void>();

	const flush = () => {
		if (disposed) return;
		queued = false;
		notifyListeners(listeners, current, () => disposed);
	};

	return {
		get: () => current,
		set(next: M) {
			if (disposed || Object.is(next, current)) return;
			current = next;
			if (queued || listeners.size === 0) return;
			queued = true;
			queueMicrotask(flush);
		},
		subscribe(listener: (model: M) => void): Unsubscribe {
			if (disposed) return () => {};
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		dispose() {
			disposed = true;
			queued = false;
			listeners.clear();
		},
	};
}

export function createStoreFromCell<M, I extends { readonly type: string }>(
	cell: Cell<M>,
	hooks: StoreHooks<I> = {},
): Store<M, I> {
	let disposed = false;

	return {
		get: () => cell.get(),
		subscribe: (listener) => cell.subscribe(listener),
		async send(intent: I): Promise<void> {
			if (disposed) throw new Error("Cannot send intent to a disposed store");
			if (!intent || typeof intent.type !== "string") {
				throw new Error("Invalid store intent");
			}
			if (!hooks.onSend) return assertNeverIntent(intent);
			await hooks.onSend(intent);
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			cell.dispose();
			hooks.onDispose?.();
		},
	};
}
