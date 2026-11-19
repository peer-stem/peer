import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import type { RouteRecord } from "../src/api/types.ts";
import { CUSTOM_AUTH_BINDING } from "../src/core/custom-provider-auth.ts";
import { GOLDEN_DIR, type ParityPair } from "./api-parity-servers.ts";
import type { ServerSide, StubServer } from "./api-parity-stubs.ts";
import type { SseEvent } from "./api-parity-wire.ts";

export interface ObservedDifference {
	ruleId: string;
	request: string;
	nextSummary: string;
	apiSummary: string;
}

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

let cachedGoldenCorpus: GoldenCorpus | null = null;

function getGoldenCorpus(): GoldenCorpus {
	if (!cachedGoldenCorpus) {
		const out: GoldenCorpus = { tokens: new Set(), isos: new Set(), numbers: new Set() };
		walkGoldenDir(GOLDEN_DIR, out);
		cachedGoldenCorpus = out;
	}
	return cachedGoldenCorpus;
}

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
		const corpus = getGoldenCorpus();
		let out = text.split(dataDir).join("<DATA_DIR>");
		out = out.split(`127.0.0.1:${port}`).join("127.0.0.1:<PORT>");
		out = out.split(`localhost:${port}`).join("localhost:<PORT>");
		if (this.stubPort > 0) {
			out = out.split(`127.0.0.1:${this.stubPort}/${side}/v1`).join(`127.0.0.1:${this.stubPort}/v1`);
		}
		return out.replace(DYN_TOKEN_RE, (matched) => {
			if (corpus.tokens.has(matched)) return matched;
			return this.mapToken(side, classifyTokenPrefix(matched), matched);
		});
	}
}

export class CoverageTracker {
	private readonly expected = new Set<string>();
	private readonly patterns = new Set<string>();
	private readonly seen = new Set<string>();
	private readonly exportedCount: number;

	constructor(routes: readonly RouteRecord[]) {
		this.exportedCount = routes.length;
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
		assert.equal(this.patterns.size, 51, "Expected exactly 51 route patterns");
		assert.equal(this.exportedCount, 74, "Expected exactly 74 exported route methods");
		const missing = [...this.expected].filter((entry) => !this.seen.has(entry)).sort();
		const extra = [...this.seen].filter((entry) => !this.expected.has(entry)).sort();
		assert.deepEqual(missing, [], `Missing route parity coverage: ${missing.join(", ")}`);
		assert.deepEqual(extra, [], `Unexpected route parity coverage entries: ${extra.join(", ")}`);
		return { patterns: this.patterns.size, exportedMethods: this.exportedCount, totalCheckedPairs: this.seen.size };
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

export function createParityHarness(
	pair: ParityPair,
	stub: StubServer,
	routes: readonly RouteRecord[],
): ParityHarness {
	const observed: ObservedDifference[] = [];
	const seenKeys = new Set<string>();
	return {
		pair,
		stub,
		ids: new IdMapper(stub.port),
		coverage: new CoverageTracker(routes),
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
	const corpus = getGoldenCorpus();
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
		if (ISO_RE.test(value) && !corpus.isos.has(value)) return "<ISO_TS>";
		return harness.ids.normalizeString(side, value, srv.port, srv.dataDir);
	}
	if (typeof value === "number") {
		if (EPOCH_KEYS.has(keyHint) && !corpus.numbers.has(value)) return "<EPOCH_MS>";
		if (DURATION_KEYS.has(keyHint) && !corpus.numbers.has(value)) return "<DURATION_MS>";
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

export function assertDataDirsEqual(harness: ParityHarness, contextLabel: string): void {
	const nextSnap: Record<string, unknown> = {};
	const apiSnap: Record<string, unknown> = {};
	walkSnapshotDir(harness, "next", harness.pair.next.dataDir, "", nextSnap);
	walkSnapshotDir(harness, "api", harness.pair.api.dataDir, "", apiSnap);
	if (fs.existsSync(harness.pair.next.authFile)) {
		nextSnap["__auth_file__.json"] = readNormalizedDataFile(harness, "next", harness.pair.next.authFile);
	}
	if (fs.existsSync(harness.pair.api.authFile)) {
		apiSnap["__auth_file__.json"] = readNormalizedDataFile(harness, "api", harness.pair.api.authFile);
	}
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
