import assert from "node:assert/strict";
import type { ServerSide } from "./api-parity-stubs.ts";
import { parseNdjsonStream, parseSseStream, sendWire, type WireRequest, type WireResponse } from "./api-parity-wire.ts";
import {
	CoverageTracker,
	IdMapper,
	assertDataDirsEqual,
	createParityHarness,
	normalizeJsonValue,
	normalizeSseEvents,
	type ObservedDifference,
	type ParityHarness,
} from "./api-parity-normalize.ts";

export {
	CoverageTracker,
	IdMapper,
	assertDataDirsEqual,
	createParityHarness,
	normalizeJsonValue,
	normalizeSseEvents,
	type ObservedDifference,
	type ParityHarness,
};

export const NEXT_APP_ROUTE_VARY = "rsc, next-router-state-tree, next-router-prefetch, next-router-segment-prefetch";
export const NEXT_PROXY_VARY = "Accept-Encoding";
const NEXT_TRACE_CACHE_CONTROL = "private, no-cache, no-store, max-age=0, must-revalidate";
const IGNORED_HEADERS = new Set(["date", "connection", "keep-alive", "transfer-encoding", "content-length"]);

export interface RecordedDifferenceRule {
	id: string;
	summary: string;
	specRef: string;
	approved: boolean;
}

export const RECORDED_DIFFERENCES: readonly RecordedDifferenceRule[] = [
	{
		id: "next-app-route-vary",
		summary: `Next 16.4.3 App Router adds vary: "${NEXT_APP_ROUTE_VARY}"; src/api omits it.`,
		specRef: "SPEC.md §2.9",
		approved: true,
	},
	{
		id: "next-proxy-vary",
		summary: `Next 16.4.3 proxy.ts adds vary: "${NEXT_PROXY_VARY}" on proxy-generated 403 refusals; src/api omits it.`,
		specRef: "SPEC.md §2.9",
		approved: true,
	},
	{
		id: "custom-provider-per-process-etag",
		summary: "GET/POST/PATCH/DELETE /api/custom-provider computes HMAC ETag from a per-process 32-byte startup key.",
		specRef: "src/server/custom-provider-http.ts:17",
		approved: true,
	},
	{
		id: "unknown-api-path-404",
		summary: "Unmatched /api/* path post-gate: Next returns 404 HTML _not-found page; src/api returns 404 empty body.",
		specRef: "SPEC.md §2.1, §2.4 step 3, §2.9",
		approved: true,
	},
	{
		id: "trailing-slash-redirect-vs-gate-and-404",
		summary: "Trailing-slash /api.../ paths: Next returns 308 Permanent Redirect BEFORE proxy.ts; src/api gates first (403) or 404 post-gate.",
		specRef: "SPEC.md §2.4 steps 2-3, §2.9",
		approved: true,
	},
	{
		id: "trace-method-500-headers",
		summary: "TRACE /api/... returns 500 Internal Server Error on both; Next sends text/plain + vary/cache-control/etag, src/api sends text/plain; charset=utf-8.",
		specRef: "SPEC.md §2.9",
		approved: true,
	},
	{
		id: "events-header-flush-timing",
		summary: "GET /api/events: src/api calls res.flushHeaders() immediately (<50ms); Next standalone buffers headers until first SSE frame or 25s ping.",
		specRef: "src/api/server.ts:324, SPEC.md §2.7",
		approved: true,
	},
	{
		id: "sigterm-open-sse-exit",
		summary: "SIGTERM with /api/events open: src/api cancels stream readers and exits <3s; Next standalone server.close() waits past 3s on open SSE.",
		specRef: "SPEC.md §2.8, §2.10",
		approved: true,
	},
];

export function auditRecordedDifferences(
	observed: readonly ObservedDifference[],
	rules: readonly RecordedDifferenceRule[] = RECORDED_DIFFERENCES,
): { unapprovedRuleIds: string[] } {
	const byId = new Map(rules.map((r) => [r.id, r]));
	const unapproved = new Set<string>();
	for (const obs of observed) {
		const rule = byId.get(obs.ruleId);
		if (!rule) {
			throw new Error(`Unrecorded parity difference "${obs.ruleId}" on ${obs.request}: next=${obs.nextSummary} api=${obs.apiSummary}`);
		}
		if (!rule.approved) unapproved.add(rule.id);
	}
	return { unapprovedRuleIds: [...unapproved].sort() };
}

export interface HeaderCompareOptions {
	requestLabel: string;
	compareContentLength?: boolean;
	customProviderEtag?: boolean;
	traceMethod500?: boolean;
}

function sanitizeHeadersForSide(
	harness: ParityHarness,
	side: ServerSide,
	raw: Record<string, string>,
	opts: HeaderCompareOptions,
): Record<string, string> {
	const srv = side === "next" ? harness.pair.next : harness.pair.api;
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(raw)) {
		const key = k.toLowerCase();
		if (IGNORED_HEADERS.has(key) && !(opts.compareContentLength && key === "content-length")) continue;
		if (key === "etag" && opts.customProviderEtag) {
			assert.match(v, /^"[A-Za-z0-9_-]{43}"$/, `${opts.requestLabel} (${side}): invalid custom-provider etag`);
			out[key] = harness.ids.mapToken(side, "CP_ETAG", v);
			continue;
		}
		out[key] = harness.ids.normalizeString(side, v, srv.port, srv.dataDir);
	}
	return out;
}

function stripRecordedHeaderDiffs(
	harness: ParityHarness,
	normNext: Record<string, string>,
	normApi: Record<string, string>,
	opts: HeaderCompareOptions,
): void {
	if (opts.traceMethod500) {
		assert.equal(normNext["content-type"], "text/plain", `${opts.requestLabel}: unexpected Next TRACE content-type`);
		assert.equal(normNext.vary, NEXT_PROXY_VARY, `${opts.requestLabel}: unexpected Next TRACE vary`);
		assert.equal(normNext["cache-control"], NEXT_TRACE_CACHE_CONTROL, `${opts.requestLabel}: unexpected Next TRACE cache-control`);
		assert.match(normNext.etag ?? "", /^"(?:W\/)?[0-9a-z-]+"$/i, `${opts.requestLabel}: unexpected Next TRACE etag`);
		assert.equal(normApi["content-type"], "text/plain; charset=utf-8", `${opts.requestLabel}: unexpected API TRACE content-type`);
		harness.recordObservation({
			ruleId: "trace-method-500-headers",
			request: opts.requestLabel,
			nextSummary: `content-type: ${normNext["content-type"]}, vary: ${normNext.vary}, cache-control: ${normNext["cache-control"]}, etag: ${normNext.etag}`,
			apiSummary: `content-type: ${normApi["content-type"]}`,
		});
		delete normNext["cache-control"];
		delete normNext.etag;
		delete normNext.vary;
		normNext["content-type"] = "text/plain; charset=utf-8";
		return;
	}
	if (normNext.vary === NEXT_APP_ROUTE_VARY && normApi.vary === undefined) {
		harness.recordObservation({ ruleId: "next-app-route-vary", request: opts.requestLabel, nextSummary: `vary: ${NEXT_APP_ROUTE_VARY}`, apiSummary: "(absent)" });
		delete normNext.vary;
	} else if (normNext.vary === NEXT_PROXY_VARY && normApi.vary === undefined) {
		harness.recordObservation({ ruleId: "next-proxy-vary", request: opts.requestLabel, nextSummary: `vary: ${NEXT_PROXY_VARY}`, apiSummary: "(absent)" });
		delete normNext.vary;
	}
}

export function compareResponseHeaders(
	harness: ParityHarness,
	nextHeaders: Record<string, string>,
	apiHeaders: Record<string, string>,
	opts: HeaderCompareOptions,
): void {
	if (opts.customProviderEtag && nextHeaders.etag !== apiHeaders.etag) {
		harness.recordObservation({
			ruleId: "custom-provider-per-process-etag",
			request: opts.requestLabel,
			nextSummary: "etag: \"<hmac-next>\"",
			apiSummary: "etag: \"<hmac-api>\"",
		});
	}
	const normNext = sanitizeHeadersForSide(harness, "next", nextHeaders, opts);
	const normApi = sanitizeHeadersForSide(harness, "api", apiHeaders, opts);
	stripRecordedHeaderDiffs(harness, normNext, normApi, opts);
	assert.deepEqual(normApi, normNext, `Header mismatch for ${opts.requestLabel}`);
}

export function compareResponseBodies(
	harness: ParityHarness,
	nextRes: WireResponse,
	apiRes: WireResponse,
	requestLabel: string,
): void {
	const ct = (nextRes.headers["content-type"] ?? "").toLowerCase();
	if (ct.includes("application/json") && nextRes.rawBody.byteLength > 0) {
		const nextJson = normalizeJsonValue(harness, "next", JSON.parse(nextRes.text));
		const apiJson = normalizeJsonValue(harness, "api", JSON.parse(apiRes.text));
		assert.deepEqual(apiJson, nextJson, `JSON body mismatch for ${requestLabel}`);
		return;
	}
	if (ct.includes("application/x-ndjson") && nextRes.rawBody.byteLength > 0) {
		const nextLines = normalizeJsonValue(harness, "next", parseNdjsonStream(nextRes.text));
		const apiLines = normalizeJsonValue(harness, "api", parseNdjsonStream(apiRes.text));
		assert.deepEqual(apiLines, nextLines, `NDJSON body mismatch for ${requestLabel}`);
		return;
	}
	if (ct.includes("text/event-stream") && nextRes.rawBody.byteLength > 0) {
		const nextEv = normalizeSseEvents(harness, "next", parseSseStream(nextRes.text));
		const apiEv = normalizeSseEvents(harness, "api", parseSseStream(apiRes.text));
		assert.deepEqual(apiEv, nextEv, `SSE body mismatch for ${requestLabel}`);
		return;
	}
	if (ct.startsWith("text/") || ct.includes("charset=utf-8")) {
		const nextText = harness.ids.normalizeString("next", nextRes.text, harness.pair.next.port, harness.pair.next.dataDir);
		const apiText = harness.ids.normalizeString("api", apiRes.text, harness.pair.api.port, harness.pair.api.dataDir);
		assert.equal(apiText, nextText, `Text body mismatch for ${requestLabel}`);
		return;
	}
	assert.equal(Buffer.compare(apiRes.rawBody, nextRes.rawBody), 0, `Binary body mismatch for ${requestLabel}`);
}

export interface ParityCaseOptions {
	label: string;
	pattern?: string;
	coverageMethod?: string;
	isWrite?: boolean;
	compareContentLength?: boolean;
	customProviderEtag?: boolean;
	expectedStatus?: number;
	awaitBeforeUpstreamCheck?: () => Promise<void>;
	request: WireRequest | ((side: ServerSide, port: number) => WireRequest);
}

export async function runParityRequest(
	harness: ParityHarness,
	opts: ParityCaseOptions,
): Promise<{ nextRes: WireResponse; apiRes: WireResponse }> {
	const nextReq = typeof opts.request === "function" ? opts.request("next", harness.pair.next.port) : opts.request;
	const apiReq = typeof opts.request === "function" ? opts.request("api", harness.pair.api.port) : opts.request;
	if (opts.pattern) harness.coverage.record(opts.pattern, opts.coverageMethod ?? nextReq.method);
	harness.stub.clearCalls();
	harness.stub.setSide("next");
	const nextRes = await sendWire(harness.pair.next.port, nextReq);
	harness.stub.setSide("api");
	const apiRes = await sendWire(harness.pair.api.port, apiReq);
	assert.equal(apiRes.status, nextRes.status, `Status mismatch on ${opts.label}: next=${nextRes.status} api=${apiRes.status}`);
	if (opts.expectedStatus !== undefined) {
		assert.equal(nextRes.status, opts.expectedStatus, `Unexpected status on ${opts.label}: got ${nextRes.status}`);
	}
	compareResponseHeaders(harness, nextRes.headers, apiRes.headers, {
		requestLabel: opts.label,
		compareContentLength: opts.compareContentLength,
		customProviderEtag: opts.customProviderEtag,
	});
	compareResponseBodies(harness, nextRes, apiRes, opts.label);
	if (opts.awaitBeforeUpstreamCheck) await opts.awaitBeforeUpstreamCheck();
	const upstream = harness.stub.takeCalls();
	const normUpstreamNext = normalizeJsonValue(harness, "next", upstream.next.map(({ side: _s, ...rest }) => rest));
	const normUpstreamApi = normalizeJsonValue(harness, "api", upstream.api.map(({ side: _s, ...rest }) => rest));
	assert.deepEqual(normUpstreamApi, normUpstreamNext, `Upstream calls mismatch on ${opts.label}`);
	if (opts.isWrite) assertDataDirsEqual(harness, opts.label);
	return { nextRes, apiRes };
}
