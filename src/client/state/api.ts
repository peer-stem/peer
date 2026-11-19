/**
 * Same-origin HTTP API client (`client-contract-state §1.2`).
 * Enforces `/api/` path prefix, forbids client-supplied `x-learnharness-desktop`,
 * preserves `globalThis` receiver on `fetch`, passes `AbortError` through, and
 * normalizes network and non-2xx JSON failures into `ApiError`.
 */

export type ApiMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
export type ApiPath = `/api/${string}`;
export type Query = Readonly<Record<string, string | number | boolean | undefined>>;

export interface ApiRequest {
	method?: ApiMethod;
	query?: Query;
	json?: unknown;
	body?: BodyInit;
	headers?: Readonly<Record<string, string>>;
	signal?: AbortSignal;
}

export interface ApiErrorInit {
	message: string;
	status: number;
	method: ApiMethod;
	path: string;
	body?: unknown;
	code?: string;
	cause?: unknown;
}

export class ApiError extends Error {
	override readonly name = "ApiError" as const;
	readonly status: number;
	readonly method: ApiMethod;
	readonly path: string;
	readonly body: unknown;
	readonly code?: string;

	constructor(init: ApiErrorInit) {
		super(init.message, init.cause !== undefined ? { cause: init.cause } : undefined);
		this.status = init.status;
		this.method = init.method;
		this.path = init.path;
		this.body = init.body;
		if (init.code !== undefined) this.code = init.code;
	}
}

export interface ApiClient {
	readonly fetch: typeof globalThis.fetch;
	request(path: ApiPath, init?: ApiRequest): Promise<Response>;
	json<T>(path: ApiPath, init?: ApiRequest): Promise<T>;
	url(path: ApiPath, query?: Query): string;
}

export interface CreateApiClientOptions {
	fetch?: typeof globalThis.fetch;
}

const FORBIDDEN_DESKTOP_HEADER = "x-learnharness-desktop";

export function isAbortError(err: unknown): boolean {
	return typeof err === "object" && err !== null && (err as { name?: unknown }).name === "AbortError";
}

function assertApiPath(path: string): asserts path is ApiPath {
	if (typeof path !== "string" || !path.startsWith("/api/")) {
		throw new Error(`API path must start with "/api/": ${String(path)}`);
	}
}

export function apiPath(strings: TemplateStringsArray, ...segments: string[]): ApiPath {
	let out = strings[0] ?? "";
	for (let i = 0; i < segments.length; i++) {
		out += encodeURIComponent(segments[i]!) + (strings[i + 1] ?? "");
	}
	assertApiPath(out);
	return out;
}

function buildApiUrl(path: ApiPath, query?: Query): string {
	assertApiPath(path);
	if (!query) return path;
	const params = new URLSearchParams();
	for (const [key, value] of Object.entries(query)) {
		if (value !== undefined) params.set(key, String(value));
	}
	const qs = params.toString();
	if (!qs) return path;
	return path.includes("?") ? `${path}&${qs}` : `${path}?${qs}`;
}

function copyValidatedHeaders(raw?: Readonly<Record<string, string>>): Record<string, string> {
	const headers: Record<string, string> = {};
	if (!raw) return headers;
	for (const [key, value] of Object.entries(raw)) {
		if (key.toLowerCase() === FORBIDDEN_DESKTOP_HEADER) {
			throw new Error("x-learnharness-desktop header is forbidden in client requests");
		}
		headers[key] = value;
	}
	return headers;
}

function buildFetchInit(init?: ApiRequest): RequestInit {
	const method: ApiMethod = init?.method ?? "GET";
	const hasJson = init !== undefined && "json" in init && init.json !== undefined;
	const hasBody = init?.body !== undefined;
	if (hasJson && hasBody) {
		throw new Error("ApiRequest cannot specify both json and body");
	}
	const headers = copyValidatedHeaders(init?.headers);
	let body: BodyInit | undefined;
	if (hasJson) {
		const hasCt = Object.keys(headers).some((k) => k.toLowerCase() === "content-type");
		if (!hasCt) headers["Content-Type"] = "application/json";
		body = JSON.stringify(init!.json);
	} else if (hasBody) {
		body = init.body;
	}
	return {
		method,
		...(Object.keys(headers).length > 0 ? { headers } : {}),
		...(body !== undefined ? { body } : {}),
		...(init?.signal !== undefined ? { signal: init.signal } : {}),
	};
}

function throwHttpApiError(res: Response, text: string, method: ApiMethod, path: ApiPath): never {
	let parsed: unknown;
	let isJson = false;
	if (text.length > 0) {
		try {
			parsed = JSON.parse(text);
			isJson = true;
		} catch {
			isJson = false;
		}
	}
	if (isJson) {
		const rec = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
		const msg = typeof rec?.error === "string" && rec.error.length > 0
			? rec.error
			: typeof rec?.message === "string" && rec.message.length > 0
				? rec.message
				: `HTTP ${res.status} ${method} ${path}`;
		const code = typeof rec?.code === "string" ? rec.code : undefined;
		throw new ApiError({ message: msg, status: res.status, method, path, body: parsed, code });
	}
	const fallback = text.trim() || `HTTP ${res.status} ${method} ${path}`;
	throw new ApiError({ message: fallback, status: res.status, method, path, body: text });
}

function parseSuccessJson<T>(res: Response, text: string, method: ApiMethod, path: ApiPath): T {
	try {
		return JSON.parse(text) as T;
	} catch (err) {
		throw new ApiError({
			message: `Invalid JSON response (${res.status} ${method} ${path})`,
			status: res.status,
			method,
			path,
			body: text,
			cause: err,
		});
	}
}

async function sendRequest(
	boundFetch: typeof globalThis.fetch,
	path: ApiPath,
	init?: ApiRequest,
): Promise<Response> {
	const method: ApiMethod = init?.method ?? "GET";
	const targetUrl = buildApiUrl(path, init?.query);
	const fetchInit = buildFetchInit(init);
	try {
		return await boundFetch(targetUrl, fetchInit);
	} catch (err) {
		if (isAbortError(err)) throw err;
		throw new ApiError({
			message: err instanceof Error ? err.message : String(err),
			status: 0,
			method,
			path,
			body: null,
			cause: err,
		});
	}
}

async function readJsonResponse<T>(
	boundFetch: typeof globalThis.fetch,
	path: ApiPath,
	init?: ApiRequest,
): Promise<T> {
	const method: ApiMethod = init?.method ?? "GET";
	const res = await sendRequest(boundFetch, path, init);
	let text: string;
	try {
		text = await res.text();
	} catch (err) {
		if (isAbortError(err)) throw err;
		throw new ApiError({
			message: err instanceof Error ? err.message : String(err),
			status: res.status,
			method,
			path,
			body: null,
			cause: err,
		});
	}
	if (!res.ok) return throwHttpApiError(res, text, method, path);
	return parseSuccessJson<T>(res, text, method, path);
}

export function createApiClient(options?: CreateApiClientOptions): ApiClient {
	const customFetch = options?.fetch;
	const boundFetch: typeof globalThis.fetch = (input, init) => {
		const rawFetch = customFetch ?? globalThis.fetch;
		return Reflect.apply(rawFetch, globalThis, [input, init]);
	};
	return {
		fetch: boundFetch,
		request: (path, init) => sendRequest(boundFetch, path, init),
		json: <T>(path: ApiPath, init?: ApiRequest) => readJsonResponse<T>(boundFetch, path, init),
		url: buildApiUrl,
	};
}
