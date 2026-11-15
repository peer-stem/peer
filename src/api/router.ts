import { MAX_IMPORT_BODY_BYTES } from "@/lib/notes-import-limits.ts";
import { apiRequestRefusal } from "@/src/server/desktop-access.ts";
import type { Dispatch, Method, Params, RouteHandler, RouteRecord } from "./types.ts";

const EXEMPT_RE = /^\/api\/plugins\/[^/]+\/documents\/markdown\/?$/;
const METHODS: ReadonlySet<string> = new Set<Method>(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);

export interface RouterOptions {
	fallback?: Dispatch;
	onError?: (error: unknown, request: Request) => void;
	onRefusal?: (method: string, pathname: string) => void;
}

type PatternSegment =
	| { readonly kind: "static"; readonly value: string; readonly rank: 0 }
	| { readonly kind: "dynamic"; readonly name: string; readonly rank: 1 }
	| { readonly kind: "catch-all"; readonly name: string; readonly rank: 2 };

interface RawCapture {
	readonly name: string;
	readonly value: string | readonly string[];
}

interface CompiledRoute {
	readonly pattern: string;
	readonly segments: readonly PatternSegment[];
	readonly methods: Map<Method, RouteHandler>;
}

type MatchResult =
	| { readonly kind: "none" }
	| { readonly kind: "bad-param" }
	| { readonly kind: "matched"; readonly route: CompiledRoute; readonly params: Params };

export function bodyLimit(pathname: string): number | null {
	if (pathname !== "/api" && !pathname.startsWith("/api/")) return null;
	if (!EXEMPT_RE.test(pathname)) return MAX_IMPORT_BODY_BYTES;
	try {
		const decoded = decodeURIComponent(pathname);
		return EXEMPT_RE.test(decoded) ? null : MAX_IMPORT_BODY_BYTES;
	} catch {
		return MAX_IMPORT_BODY_BYTES;
	}
}

function parsePatternSegments(pattern: string): readonly PatternSegment[] {
	if (!pattern.startsWith("/")) throw new Error(`Route pattern must start with "/": ${pattern}`);
	const raw = pattern === "/" ? [""] : pattern.slice(1).split("/");
	return raw.map((part, index): PatternSegment => {
		if (part.startsWith("[...") && part.endsWith("]") && part.length > 5) {
			if (index !== raw.length - 1) throw new Error(`Catch-all must be last segment: ${pattern}`);
			return { kind: "catch-all", name: part.slice(4, -1), rank: 2 };
		}
		if (part.startsWith("[") && part.endsWith("]") && part.length > 2) {
			return { kind: "dynamic", name: part.slice(1, -1), rank: 1 };
		}
		return { kind: "static", value: part, rank: 0 };
	});
}

function compareRoutes(a: CompiledRoute, b: CompiledRoute): number {
	const limit = Math.min(a.segments.length, b.segments.length);
	for (let i = 0; i < limit; i++) {
		const segA = a.segments[i];
		const segB = b.segments[i];
		if (segA && segB && segA.rank !== segB.rank) return segA.rank - segB.rank;
	}
	return a.segments.length - b.segments.length;
}

function compileRoutes(records: readonly RouteRecord[]): readonly CompiledRoute[] {
	const byPattern = new Map<string, CompiledRoute>();
	for (const record of records) {
		let entry = byPattern.get(record.pattern);
		if (!entry) {
			entry = { pattern: record.pattern, segments: parsePatternSegments(record.pattern), methods: new Map() };
			byPattern.set(record.pattern, entry);
		}
		entry.methods.set(record.method, record.handler);
	}
	return [...byPattern.values()].sort(compareRoutes);
}

function matchPrefix(
	pattern: readonly PatternSegment[],
	actual: readonly string[],
	count: number,
): RawCapture[] | null {
	const captures: RawCapture[] = [];
	for (let i = 0; i < count; i++) {
		const seg = pattern[i];
		const part = actual[i];
		if (!seg || part === undefined) return null;
		if (seg.kind === "static" && part !== seg.value) return null;
		if (seg.kind === "dynamic" && part.length === 0) return null;
		if (seg.kind === "dynamic") captures.push({ name: seg.name, value: part });
	}
	return captures;
}

function matchSegments(
	pattern: readonly PatternSegment[],
	actual: readonly string[],
): readonly RawCapture[] | null {
	const last = pattern[pattern.length - 1];
	if (last?.kind === "catch-all") {
		const prefixLen = pattern.length - 1;
		if (actual.length <= prefixLen) return null;
		const captures = matchPrefix(pattern, actual, prefixLen);
		if (!captures) return null;
		const tail = actual.slice(prefixLen);
		if (tail.some((part) => part.length === 0)) return null;
		captures.push({ name: last.name, value: tail });
		return captures;
	}
	if (actual.length !== pattern.length) return null;
	return matchPrefix(pattern, actual, pattern.length);
}

function decodeCaptureValue(value: string | readonly string[]): string | string[] {
	return typeof value === "string"
		? decodeURIComponent(value)
		: value.map((part) => decodeURIComponent(part));
}

function decodeCaptures(captures: readonly RawCapture[]): Params | null {
	const params: Params = {};
	try {
		for (const item of captures) {
			params[item.name] = decodeCaptureValue(item.value);
		}
		return params;
	} catch {
		return null;
	}
}

function findMatch(routes: readonly CompiledRoute[], pathname: string): MatchResult {
	const actual = pathname === "/" ? [""] : pathname.slice(1).split("/");
	for (const route of routes) {
		const captures = matchSegments(route.segments, actual);
		if (!captures) continue;
		const params = decodeCaptures(captures);
		if (!params) return { kind: "bad-param" };
		return { kind: "matched", route, params };
	}
	return { kind: "none" };
}

function isMethod(value: string): value is Method {
	return METHODS.has(value);
}

function allowHeader(methods: ReadonlyMap<Method, RouteHandler>): string {
	const allowed = new Set<Method>(["OPTIONS", ...methods.keys()]);
	if (methods.has("GET")) allowed.add("HEAD");
	return [...allowed].sort().join(", ");
}

async function invokeHandler(
	handler: RouteHandler,
	request: Request,
	params: Params,
	onError?: (error: unknown, request: Request) => void,
): Promise<Response> {
	try {
		return await handler(request, { params: Promise.resolve(params) });
	} catch (error) {
		onError?.(error, request);
		return new Response(null, { status: 500 });
	}
}

async function dispatchMatched(
	route: CompiledRoute,
	params: Params,
	request: Request,
	onError?: (error: unknown, request: Request) => void,
): Promise<Response> {
	if (!isMethod(request.method)) return new Response(null, { status: 400 });
	const direct = route.methods.get(request.method);
	if (direct) return invokeHandler(direct, request, params, onError);
	if (request.method === "OPTIONS") {
		return new Response(null, { status: 204, headers: { Allow: allowHeader(route.methods) } });
	}
	const getHandler = request.method === "HEAD" ? route.methods.get("GET") : undefined;
	if (getHandler) {
		const res = await invokeHandler(getHandler, request, params, onError);
		await res.body?.cancel().catch(() => {});
		return new Response(null, { status: res.status, statusText: res.statusText, headers: res.headers });
	}
	return new Response(null, { status: 405 });
}

async function defaultFallback(request: Request): Promise<Response> {
	const { serveStatic } = await import("./static.ts");
	return serveStatic(request);
}

function refusalResponse(message: string): Response {
	return Response.json(
		{ error: message },
		{ status: 403, headers: { "Cache-Control": "no-store" } },
	);
}

export function createRouter(records: readonly RouteRecord[], options?: RouterOptions): Dispatch {
	const compiled = compileRoutes(records);
	const fallback = options?.fallback ?? defaultFallback;
	return async (request: Request): Promise<Response> => {
		const { pathname } = new URL(request.url);
		if (pathname !== "/api" && !pathname.startsWith("/api/")) return fallback(request);
		const refusal = apiRequestRefusal(request);
		if (refusal) {
			options?.onRefusal?.(request.method, pathname);
			return refusalResponse(refusal);
		}
		const match = findMatch(compiled, pathname);
		if (match.kind === "none") return new Response(null, { status: 404 });
		if (match.kind === "bad-param") return new Response(null, { status: 400 });
		return dispatchMatched(match.route, match.params, request, options?.onError);
	};
}
