/**
 * Typed SSE notification hub over `GET /api/events` (`state §2.2, §2.3, §3`).
 * Connects when `createEventSource` or `globalThis.EventSource` is present and
 * stays `{ connected: false, opens: 0 }` in headless Node tests otherwise.
 */

import {
	SERVER_EVENT_TYPES,
	type ServerEventType,
	type ServerEvents,
} from "../../core/events.ts";
import {
	createCell,
	createStoreFromCell,
	type Cell,
	type Store,
	type Unsubscribe,
} from "./store.ts";

export interface EventSourceLike {
	close(): void;
	onOpen(cb: () => void): void;
	onEvent(name: string, cb: (data: string) => void): void;
	onError?(cb: () => void): void;
}

export interface EventsModel {
	readonly connected: boolean;
	readonly opens: number;
}

export interface Events extends Store<EventsModel, never> {
	on<K extends ServerEventType>(type: K, cb: (payload: ServerEvents[K]) => void): Unsubscribe;
	onResync(cb: () => void): Unsubscribe;
}

export interface CreateEventsOptions {
	createEventSource?: (url: string) => EventSourceLike;
	url?: string;
}

type RawListener = (payload: unknown) => void;

function openBrowserEventSource(url: string): EventSourceLike | null {
	if (typeof globalThis.EventSource !== "function") return null;
	const es = new globalThis.EventSource(url);
	return {
		close: () => es.close(),
		onOpen: (cb) => {
			es.onopen = () => cb();
		},
		onEvent: (name, cb) => {
			es.addEventListener(name, (ev) => cb(String((ev as MessageEvent).data ?? "")));
		},
		onError: (cb) => {
			es.onerror = () => cb();
		},
	};
}

function dispatchEventFrame(
	name: string,
	raw: string,
	byType: Map<string, Set<RawListener>>,
): void {
	const listeners = byType.get(name);
	if (!listeners || listeners.size === 0) return;
	let payload: unknown;
	try {
		payload = JSON.parse(raw);
	} catch {
		return;
	}
	for (const listener of [...listeners]) {
		if (!listeners.has(listener)) continue;
		try {
			listener(payload);
		} catch (err) {
			console.error(`[events] ${name} handler failed:`, err);
		}
	}
}

function fireResyncListeners(resyncs: Set<() => void>): void {
	for (const cb of [...resyncs]) {
		if (!resyncs.has(cb)) continue;
		try {
			cb();
		} catch (err) {
			console.error("[events] resync handler failed:", err);
		}
	}
}

function wireEventSource(
	source: EventSourceLike,
	cell: Cell<EventsModel>,
	byType: Map<string, Set<RawListener>>,
	resyncs: Set<() => void>,
	isDisposed: () => boolean,
): void {
	for (const name of SERVER_EVENT_TYPES) {
		source.onEvent(name, (raw) => {
			if (!isDisposed()) dispatchEventFrame(name, raw, byType);
		});
	}
	source.onOpen(() => {
		if (isDisposed()) return;
		const nextOpens = cell.get().opens + 1;
		cell.set({ connected: true, opens: nextOpens });
		if (nextOpens > 1) fireResyncListeners(resyncs);
	});
	source.onError?.(() => {
		if (isDisposed()) return;
		const cur = cell.get();
		if (cur.connected) cell.set({ connected: false, opens: cur.opens });
	});
}

function addTypedListener(
	byType: Map<string, Set<RawListener>>,
	type: ServerEventType,
	cb: RawListener,
): Unsubscribe {
	const set = byType.get(type) ?? new Set<RawListener>();
	byType.set(type, set);
	set.add(cb);
	return () => {
		set.delete(cb);
	};
}

export function createEventsStore(options?: CreateEventsOptions): Events {
	const url = options?.url ?? "/api/events";
	const cell = createCell<EventsModel>({ connected: false, opens: 0 });
	const byType = new Map<string, Set<RawListener>>();
	const resyncs = new Set<() => void>();
	let disposed = false;

	const source = options?.createEventSource
		? options.createEventSource(url)
		: openBrowserEventSource(url);
	if (source) wireEventSource(source, cell, byType, resyncs, () => disposed);

	const base = createStoreFromCell<EventsModel, never>(cell, {
		onDispose() {
			disposed = true;
			source?.close();
			byType.clear();
			resyncs.clear();
		},
	});

	return {
		...base,
		dispose() {
			if (!disposed && cell.get().connected) {
				cell.set({ connected: false, opens: cell.get().opens });
			}
			base.dispose();
		},
		on: (type, cb) => (disposed ? () => {} : addTypedListener(byType, type, cb as RawListener)),
		onResync(cb) {
			if (disposed) return () => {};
			resyncs.add(cb);
			return () => {
				resyncs.delete(cb);
			};
		},
	};
}
