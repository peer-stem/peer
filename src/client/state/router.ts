/**
 * Client URL router and screen-key seam (`R1`, `state §4.1`, `views §2.4`).
 * Preserves root URLs (`/`, `/chat/new`, `/chat/{id}`, `/plugins/{pluginId}/{viewId}`)
 * while redirecting `/settings` -> `/chat/new` and stripping trailing slashes via `replace`.
 */

import {
	assertNeverIntent,
	createCell,
	createStoreFromCell,
	type Cell,
	type Store,
	type Unsubscribe,
} from "./store.ts";

export type Route =
	| { readonly name: "home" }
	| { readonly name: "new-session"; readonly mode: "teach" | "practice" }
	| { readonly name: "session"; readonly id: string; readonly prompt?: string }
	| { readonly name: "plugin-view"; readonly pluginId: string; readonly viewId: string }
	| { readonly name: "not-found"; readonly path: string };

export interface RouteModel {
	readonly route: Route;
	readonly pathname: string;
	readonly search: string;
	readonly hash: string;
}

export type RouteIntent =
	| { readonly type: "navigate"; readonly to: string | Route; readonly replace?: boolean }
	| { readonly type: "back" };

export type RouterStore = Store<RouteModel, RouteIntent> & {
	href(route: Route): string;
};

export interface HistoryAdapter {
	getLocation(): string;
	push(url: string): void;
	replace(url: string): void;
	back?(): void;
	subscribePopState(cb: () => void): Unsubscribe;
}

export interface CreateRouterOptions {
	history?: HistoryAdapter;
	initialUrl?: string;
}

const DUMMY_ORIGIN = "http://peer.local";

function safeDecode(segment: string): string | null {
	try {
		const decoded = decodeURIComponent(segment);
		return decoded.length > 0 ? decoded : null;
	} catch {
		return null;
	}
}

function matchPathname(pathname: string, searchParams: URLSearchParams): Route {
	if (pathname === "/") return { name: "home" };
	if (pathname === "/chat/new") {
		const mode = searchParams.get("mode") === "practice" ? "practice" : "teach";
		return { name: "new-session", mode };
	}
	const segments = pathname.slice(1).split("/");
	if (segments.length === 2 && segments[0] === "chat" && segments[1]) {
		const decodedId = safeDecode(segments[1]);
		if (!decodedId) return { name: "not-found", path: pathname };
		const prompt = searchParams.get("prompt");
		return prompt ? { name: "session", id: decodedId, prompt } : { name: "session", id: decodedId };
	}
	if (segments.length === 3 && segments[0] === "plugins" && segments[1] && segments[2]) {
		const pluginId = safeDecode(segments[1]);
		const viewId = safeDecode(segments[2]);
		if (!pluginId || !viewId) return { name: "not-found", path: pathname };
		return { name: "plugin-view", pluginId, viewId };
	}
	return { name: "not-found", path: pathname };
}

export function parseRouteUrl(rawUrl: string): RouteModel {
	const parsed = new URL(rawUrl || "/", DUMMY_ORIGIN);
	const stripped = parsed.pathname.length > 1
		? parsed.pathname.replace(/\/+$/, "") || "/"
		: parsed.pathname;
	if (stripped === "/settings") {
		return {
			route: { name: "new-session", mode: "teach" },
			pathname: "/chat/new",
			search: "",
			hash: "",
		};
	}
	return {
		route: matchPathname(stripped, parsed.searchParams),
		pathname: stripped,
		search: parsed.search,
		hash: parsed.hash,
	};
}

export function routeToHref(route: Route): string {
	switch (route.name) {
		case "home":
			return "/";
		case "new-session":
			return route.mode === "practice" ? "/chat/new?mode=practice" : "/chat/new";
		case "session": {
			const base = `/chat/${encodeURIComponent(route.id)}`;
			return route.prompt ? `${base}?prompt=${encodeURIComponent(route.prompt)}` : base;
		}
		case "plugin-view":
			return `/plugins/${encodeURIComponent(route.pluginId)}/${encodeURIComponent(route.viewId)}`;
		case "not-found":
			return route.path.startsWith("/") ? route.path : `/${route.path}`;
	}
}

export function screenKeyOf(route: Route): string {
	switch (route.name) {
		case "home":
			return "home";
		case "new-session":
			return "new-session";
		case "session":
			return `session:${route.id}`;
		case "plugin-view":
			return `plugin-view:${route.pluginId}/${route.viewId}`;
		case "not-found":
			return "not-found";
	}
}

function formatModelUrl(model: RouteModel): string {
	return `${model.pathname}${model.search}${model.hash}`;
}

function normalizeRawUrl(rawUrl: string): string {
	const parsed = new URL(rawUrl || "/", DUMMY_ORIGIN);
	return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}

function sameRouteModel(a: RouteModel, b: RouteModel): boolean {
	return (
		a.pathname === b.pathname &&
		a.search === b.search &&
		a.hash === b.hash &&
		JSON.stringify(a.route) === JSON.stringify(b.route)
	);
}

export function createMemoryHistory(initialUrl = "/"): HistoryAdapter {
	const stack = [normalizeRawUrl(initialUrl)];
	let index = 0;
	const listeners = new Set<() => void>();

	return {
		getLocation: () => stack[index] ?? "/",
		push(url: string) {
			stack.splice(index + 1);
			stack.push(normalizeRawUrl(url));
			index = stack.length - 1;
		},
		replace(url: string) {
			stack[index] = normalizeRawUrl(url);
		},
		back() {
			if (index <= 0) return;
			index -= 1;
			for (const cb of [...listeners]) cb();
		},
		subscribePopState(cb: () => void): Unsubscribe {
			listeners.add(cb);
			return () => {
				listeners.delete(cb);
			};
		},
	};
}

function createBrowserHistory(initialUrl?: string): HistoryAdapter {
	if (initialUrl !== undefined) {
		window.history.replaceState(null, "", initialUrl);
	}
	return {
		getLocation: () => `${window.location.pathname}${window.location.search}${window.location.hash}`,
		push: (url) => window.history.pushState(null, "", url),
		replace: (url) => window.history.replaceState(null, "", url),
		back: () => window.history.back(),
		subscribePopState(cb: () => void): Unsubscribe {
			const handler = () => cb();
			window.addEventListener("popstate", handler);
			return () => window.removeEventListener("popstate", handler);
		},
	};
}

function resolveHistoryAdapter(options?: CreateRouterOptions): HistoryAdapter {
	if (options?.history) {
		if (options.initialUrl !== undefined) options.history.replace(options.initialUrl);
		return options.history;
	}
	const hasBrowserHistory =
		typeof window !== "undefined" &&
		typeof window.history?.pushState === "function" &&
		typeof window.location?.pathname === "string";
	if (hasBrowserHistory) return createBrowserHistory(options?.initialUrl);
	return createMemoryHistory(options?.initialUrl ?? "/");
}

function syncCanonicalLocation(history: HistoryAdapter): RouteModel {
	const raw = history.getLocation();
	const model = parseRouteUrl(raw);
	const canonical = formatModelUrl(model);
	if (normalizeRawUrl(raw) !== canonical) history.replace(canonical);
	return model;
}

function handleRouterIntent(
	history: HistoryAdapter,
	cell: Cell<RouteModel>,
	intent: RouteIntent,
): void {
	if (intent.type === "navigate") {
		const rawTarget = typeof intent.to === "string" ? intent.to : routeToHref(intent.to);
		const next = parseRouteUrl(rawTarget);
		const canonical = formatModelUrl(next);
		if (intent.replace) history.replace(canonical);
		else history.push(canonical);
		if (!sameRouteModel(cell.get(), next)) cell.set(next);
		return;
	}
	if (intent.type === "back") {
		history.back?.();
		return;
	}
	assertNeverIntent(intent);
}

export function createRouterStore(options?: CreateRouterOptions): RouterStore {
	const history = resolveHistoryAdapter(options);
	const cell = createCell<RouteModel>(syncCanonicalLocation(history));
	const offPop = history.subscribePopState(() => {
		const next = syncCanonicalLocation(history);
		if (!sameRouteModel(cell.get(), next)) cell.set(next);
	});
	const base = createStoreFromCell<RouteModel, RouteIntent>(cell, {
		onSend: (intent) => handleRouterIntent(history, cell, intent),
		onDispose: offPop,
	});
	return { ...base, href: routeToHref };
}
