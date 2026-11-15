import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { CUSTOM_AUTH_BINDING } from "../src/core/custom-provider-auth.ts";
import { routes } from "../src/api/routes.ts";
import { GOLDEN_DIR, type ParityPair } from "./api-parity-servers.ts";
import type { ServerSide, StubServer } from "./api-parity-stubs.ts";
import {
	parseNdjsonStream,
	parseSseStream,
	sendWire,
	type SseEvent,
	type WireRequest,
	type WireResponse,
} from "./api-parity-wire.ts";

export const NEXT_APP_ROUTE_VARY = "rsc, next-router-state-tree, next-router-prefetch, next-router-segment-prefetch";
export const NEXT_PROXY_VARY = "Accept-Encoding";

export interface ApprovedDifferenceRule {
	id: string;
	summary: string;
	specRef: string;
}

export const APPROVED_RECORDED_DIFFERENCES: readonly ApprovedDifferenceRule[] = [
	{
		id: "next-app-route-vary",
		summary: `Next 16.4.3 App Router adds vary: "${NEXT_APP_ROUTE_VARY}"; src/api omits it.`,
		specRef: "SPEC.md §2.9",
	},
	{
		id: "next-proxy-vary",
		summary: `Next 16.4.3 proxy.ts (NextResponse) adds vary: "${NEXT_PROXY_VARY}" on proxy-generated 403 refusals; src/api omits it.`,
		specRef: "SPEC.md §2.9",
	},
	{
		id: "custom-provider-per-process-etag",
		summary: "GET/POST/PATCH/DELETE /api/custom-provider computes HMAC ETag from a per-process 32-byte startup key.",
		specRef: "src/server/custom-provider-http.ts:17",
	},
	{
		id: "unknown-api-path-404",
		summary: "Unmatched /api/* path post-gate: Next returns 404 HTML _not-found page (with x-powered-by: Next.js); src/api returns 404 empty body.",
		specRef: "SPEC.md §2.1, §2.4 step 3, §2.9",
	},
	{
		id: "trailing-slash-redirect-vs-gate-and-404",
		summary: "Trailing-slash /api.../ paths: Next returns 308 Permanent Redirect BEFORE proxy.ts; src/api gates first (403) or returns 404 post-gate.",
		specRef: "SPEC.md §2.4 steps 2-3, §2.9",
	},
	{
		id: "trace-method-500-headers",
		summary: "TRACE /api/... returns 500 Internal Server Error on both; Next sends text/plain + vary/cache-control/etag, src/api sends text/plain; charset=utf-8.",
		specRef: "SPEC.md §2.9",
	},
	{
		id: "events-header-flush-timing",
		summary: "GET /api/events: src/api calls res.flushHeaders() immediately (<50ms); Next standalone buffers headers until first SSE frame or 25s ping.",
		specRef: "src/api/server.ts:327, SPEC.md §2.7",
	},
	{
		id: "sigterm-open-sse-exit",
		summary: "SIGTERM with /api/events open: src/api cancels stream readers and exits <3s; Next standalone server.close() waits past 3s on open SSE.",
		specRef: "SPEC.md §2.8, §2.10 item 12",
	},
];

export interface ObservedDifference {
	ruleId: string;
	request: string;
	nextSummary: string;
	apiSummary: string;
}

const IGNORED_HEADERS = new Set(["date", "connection", "keep-alive", "transfer-encoding", "content-length"]);
const EPOCH_KEYS = new Set(["timestamp", "startedAt", "graphRevision", "updatedAt", "createdAt", "completedAt", "checkedAt"]);
const DURATION_KEYS = new Set(["durationMs", "elapsedMs"]);
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const DYN_TOKEN_RE = /\b(?:exchange_)?(?:side_msg|chat|msg|side|job)_[a-z0-9]+_[0-9a-f]{8}(?:_update_\d+)?\b|\b(?:(n|arg)_[0-9a-f]{12}|folder_[0-9a-f-]{36}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/gi;

interface GoldenCorpus {
	tokens: Set<string>;
	isos: Set<string>;
	numbers: Set<number>;
}

function collectGoldenFromValue(val: unknown, out: GoldenCorpus, keyHint = ""): void {
	if (typeof val === "string") {
		if (ISO_RE.test(val)) out.isos.add(val);
		for (const m of val.matchAll(DYN_TOKEN_RE)) out.tokens.add(m[0]);
		return;
	}
	if (typeof val === "number") {
		if (EPOCH_KEYS.has(keyHint) || DURATION_KEYS.has(keyHint)) out.numbers.add(val);
		return;
	}
	if (Array.isArray(val)) {
		for (const item of val) collectGoldenFromValue(item, out, keyHint);
		return;
	}
	if (val && typeof val === "object") {
		for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
			for (const m of k.matchAll(DYN_TOKEN_RE)) out.tokens.add(m[0]);
			collectGoldenFromValue(v, out, k);
		}
	}
}

function walkGoldenDir(dir: string, out: GoldenCorpus): void {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			walkGoldenDir(full, out);
		} else if (entry.name.endsWith(".json")) {
			collectGoldenFromValue(JSON.parse(fs.readFileSync(full, "utf8")), out);
		} else if (entry.name.endsWith(".jsonl")) {
			const lines = fs.readFileSync(full, "utf8").split("\n").filter(Boolean);
			for (const line of lines) collectGoldenFromValue(JSON.parse(line), out);
		}
	}
}

function loadGoldenCorpus(): GoldenCorpus {
	const out: GoldenCorpus = { tokens: new Set(), isos: new Set(), numbers: new Set() };
	walkGoldenDir(GOLDEN_DIR, out);
	return out;
}

const GOLDEN_CORPUS = loadGoldenCorpus();

function classifyTokenPrefix(raw: string): string {
	if (raw.startsWith("exchange_")) return "EXCHANGE";
	if (raw.startsWith("side_msg_")) return "SIDEMSG";
	if (raw.startsWith("job_")) return "JOB";
	if (raw.startsWith("chat_")) return "CHAT";
	if (raw.startsWith("msg_")) return "MSG";
	if (raw.startsWith("side_")) return "SIDE";
	if (raw.startsWith("folder_")) return "FOLDER";
	if (raw.startsWith("n_")) return "NODE";
	if (raw.startsWith("arg_")) return "ARG";
	return "UUID";
}

export class IdMapper {
	private maps: Record<ServerSide, Map<string, string>> = { next: new Map(), api: new Map() };
	private counts: Record<ServerSide, Record<string, number>> = { next: {}, api: {} };
	private readonly stubPort: number;

	constructor(stubPort = 0) {
		this.stubPort = stubPort;
	}

	mapToken(side: ServerSide, kind: string, raw: string): string {
		const sideMap = this.maps[side];
		const existing = sideMap.get(raw);
		if (existing) return existing;
		const nextIdx = (this.counts[side][kind] ?? 0) + 1;
		this.counts[side][kind] = nextIdx;
		const token = `<${kind}_${nextIdx}>`;
		sideMap.set(raw, token);
		return token;
	}

	normalizeString(side: ServerSide, text: string, port: number, dataDir: string): string {
		let out = text.split(dataDir).join("<DATA_DIR>");
		out = out.split(`127.0.0.1:${port}`).join("127.0.0.1:<PORT>");
		out = out.split(`localhost:${port}`).join("localhost:<PORT>");
		if (this.stubPort > 0) {
			out = out.split(`127.0.0.1:${this.stubPort}/${side}/v1`).join(`127.0.0.1:${this.stubPort}/v1`);
		}
		return out.replace(DYN_TOKEN_RE, (matched) => {
			if (GOLDEN_CORPUS.tokens.has(matched)) return matched;
			return this.mapToken(side, classifyTokenPrefix(matched), matched);
		});
	}
}

export class CoverageTracker {
	private readonly expected = new Set<string>();
	private readonly patterns = new Set<string>();
	private readonly seen = new Set<string>();

	constructor() {
		for (const rec of routes) {
			this.patterns.add(rec.pattern);
			this.expected.add(`${rec.pattern} ${rec.method}`);
		}
		for (const pattern of this.patterns) {
			this.expected.add(`${pattern} OPTIONS`);
			this.expected.add(`${pattern} HEAD`);
		}
	}

	get patternList(): string[] {
		return [...this.patterns].sort();
	}

	record(pattern: string, method: string): void {
		assert.ok(this.patterns.has(pattern), `Unknown route pattern recorded in coverage: ${pattern}`);
		this.seen.add(`${pattern} ${method.toUpperCase()}`);
	}

	assertComplete(): { patterns: number; exportedMethods: number; totalCheckedPairs: number } {
		assert.equal(this.patterns.size, 50, "Expected exactly 50 route patterns");
		assert.equal(routes.length, 73, "Expected exactly 73 exported route methods");
		const missing = [...this.expected].filter((entry) => !this.seen.has(entry)).sort();
		const extra = [...this.seen].filter((entry) => !this.expected.has(entry)).sort();
		assert.deepEqual(missing, [], `Missing route parity coverage: ${missing.join(", ")}`);
		assert.deepEqual(extra, [], `Unexpected route parity coverage entries: ${extra.join(", ")}`);
		return { patterns: this.patterns.size, exportedMethods: routes.length, totalCheckedPairs: this.seen.size };
	}
}

export interface ParityHarness {
	pair: ParityPair;
	stub: StubServer;
	ids: IdMapper;
	coverage: CoverageTracker;
	observed: ObservedDifference[];
	recordObservation: (diff: ObservedDifference) => void;
}

export function createParityHarness(pair: ParityPair, stub: StubServer): ParityHarness {
	const observed: ObservedDifference[] = [];
	const seenKeys = new Set<string>();
	return {
		pair,
		stub,
		ids: new IdMapper(stub.port),
		coverage: new CoverageTracker(),
		observed,
		recordObservation: (diff) => {
			const key = `${diff.ruleId}|${diff.request}`;
			if (seenKeys.has(key)) return;
			seenKeys.add(key);
			observed.push(diff);
		},
	};
}

export function normalizeJsonValue(
	harness: ParityHarness,
	side: ServerSide,
	value: unknown,
	keyHint = "",
): unknown {
	const srv = side === "next" ? harness.pair.next : harness.pair.api;
	if (typeof value === "string") {
		if (keyHint === "credentialBindingId" && /^[0-9a-f]{32}$/.test(value)) {
			return harness.ids.mapToken(side, "CRED_BINDING", value);
		}
		if (keyHint === CUSTOM_AUTH_BINDING) {
			const parsed = JSON.parse(value) as Record<string, unknown>;
			if (typeof parsed.id === "string") parsed.id = harness.ids.mapToken(side, "CRED_BINDING", parsed.id);
			return normalizeJsonValue(harness, side, parsed, "");
		}
		if (ISO_RE.test(value) && !GOLDEN_CORPUS.isos.has(value)) {
			return "<ISO_TS>";
		}
		return harness.ids.normalizeString(side, value, srv.port, srv.dataDir);
	}
	if (typeof value === "number") {
		if (EPOCH_KEYS.has(keyHint) && !GOLDEN_CORPUS.numbers.has(value)) return "<EPOCH_MS>";
		if (DURATION_KEYS.has(keyHint) && !GOLDEN_CORPUS.numbers.has(value)) return "<DURATION_MS>";
		return value;
	}
	if (Array.isArray(value)) {
		return value.map((item) => normalizeJsonValue(harness, side, item, keyHint));
	}
	if (value && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
			const normKey = harness.ids.normalizeString(side, k, srv.port, srv.dataDir);
			out[normKey] = normalizeJsonValue(harness, side, v, k);
		}
		return out;
	}
	return value;
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

function stripApprovedHeaderDiffs(
	harness: ParityHarness,
	normNext: Record<string, string>,
	normApi: Record<string, string>,
	opts: HeaderCompareOptions,
): void {
	if (normNext.vary === NEXT_APP_ROUTE_VARY && normApi.vary === undefined) {
		harness.recordObservation({ ruleId: "next-app-route-vary", request: opts.requestLabel, nextSummary: `vary: ${NEXT_APP_ROUTE_VARY}`, apiSummary: "(absent)" });
		delete normNext.vary;
	} else if (normNext.vary === NEXT_PROXY_VARY && normApi.vary === undefined) {
		harness.recordObservation({ ruleId: "next-proxy-vary", request: opts.requestLabel, nextSummary: `vary: ${NEXT_PROXY_VARY}`, apiSummary: "(absent)" });
		delete normNext.vary;
	}
	if (!opts.traceMethod500) return;
	harness.recordObservation({
		ruleId: "trace-method-500-headers",
		request: opts.requestLabel,
		nextSummary: `content-type: ${normNext["content-type"] ?? ""}, vary: ${normNext.vary ?? "(none)"}, cache-control: ${normNext["cache-control"] ?? "(none)"}, etag: ${normNext.etag ?? "(none)"}`,
		apiSummary: `content-type: ${normApi["content-type"] ?? ""}`,
	});
	delete normNext["cache-control"];
	delete normNext.etag;
	delete normNext.vary;
	if (normNext["content-type"] === "text/plain" && normApi["content-type"] === "text/plain; charset=utf-8") {
		normNext["content-type"] = "text/plain; charset=utf-8";
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
	stripApprovedHeaderDiffs(harness, normNext, normApi, opts);
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

function walkSnapshotDir(
	harness: ParityHarness,
	side: ServerSide,
	dir: string,
	prefix: string,
	entries: Record<string, unknown>,
): void {
	const srv = side === "next" ? harness.pair.next : harness.pair.api;
	for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
		const rel = prefix ? `${prefix}/${item.name}` : item.name;
		const full = path.join(dir, item.name);
		if (item.isDirectory()) {
			walkSnapshotDir(harness, side, full, rel, entries);
			continue;
		}
		const normRel = harness.ids.normalizeString(side, rel, srv.port, srv.dataDir);
		entries[normRel] = readNormalizedDataFile(harness, side, full);
	}
}

function snapshotTree(harness: ParityHarness, side: ServerSide, rootDir: string, authFile: string): Record<string, unknown> {
	const entries: Record<string, unknown> = {};
	walkSnapshotDir(harness, side, rootDir, "", entries);
	if (fs.existsSync(authFile)) {
		entries["__auth_file__.json"] = readNormalizedDataFile(harness, side, authFile);
	}
	return entries;
}

function readNormalizedDataFile(harness: ParityHarness, side: ServerSide, filePath: string): unknown {
	const srv = side === "next" ? harness.pair.next : harness.pair.api;
	if (filePath.endsWith(".json")) {
		return normalizeJsonValue(harness, side, JSON.parse(fs.readFileSync(filePath, "utf8")));
	}
	if (filePath.endsWith(".jsonl")) {
		const lines = fs.readFileSync(filePath, "utf8").split("\n").filter((l) => l.trim().length > 0);
		return lines.map((line) => normalizeJsonValue(harness, side, JSON.parse(line)));
	}
	return harness.ids.normalizeString(side, fs.readFileSync(filePath, "utf8"), srv.port, srv.dataDir);
}

export function assertDataDirsEqual(harness: ParityHarness, contextLabel: string): void {
	const nextSnap = snapshotTree(harness, "next", harness.pair.next.dataDir, harness.pair.next.authFile);
	const apiSnap = snapshotTree(harness, "api", harness.pair.api.dataDir, harness.pair.api.authFile);
	assert.deepEqual(Object.keys(apiSnap).sort(), Object.keys(nextSnap).sort(), `Data dir file list mismatch after ${contextLabel}`);
	for (const key of Object.keys(nextSnap).sort()) {
		assert.deepEqual(apiSnap[key], nextSnap[key], `Data dir content mismatch in ${key} after ${contextLabel}`);
	}
}

export function normalizeSseEvents(harness: ParityHarness, side: ServerSide, events: readonly SseEvent[]): unknown[] {
	const srv = side === "next" ? harness.pair.next : harness.pair.api;
	return events.map((ev) => {
		let parsedData: unknown = ev.data;
		if (ev.data !== "[DONE]" && (ev.data.startsWith("{") || ev.data.startsWith("["))) {
			try { parsedData = normalizeJsonValue(harness, side, JSON.parse(ev.data)); }
			catch { parsedData = harness.ids.normalizeString(side, ev.data, srv.port, srv.dataDir); }
		} else if (typeof parsedData === "string") {
			parsedData = harness.ids.normalizeString(side, parsedData, srv.port, srv.dataDir);
		}
		return { event: ev.event, id: ev.id ? "<SSE_ID>" : "", data: parsedData };
	});
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
