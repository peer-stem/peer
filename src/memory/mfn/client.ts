import http from "node:http";
import { parseLoopbackEndpoint } from "./embedder-pin.ts";
import { mintUuidV7 } from "./ids.ts";
import type {
	LexicalSearchMatch,
	MfnExecuteResponse,
	MfnMemoryPutPayload,
	MfnPoolPutPayload,
	MfnRequestEnvelope,
	MfnResponseStatus,
	TurnIngestGroupResult,
	TurnIngestPayload,
	TurnRecallPayload,
	TurnRecallResult,
} from "./types.ts";

export interface MfnApiErrorInit {
	httpStatus: number;
	code: string;
	message: string;
	retryable: boolean;
	operationId?: string;
	response?: MfnExecuteResponse | null;
}

export class MfnApiError extends Error {
	readonly httpStatus: number;
	readonly code: string;
	readonly retryable: boolean;
	readonly operationId?: string;
	readonly response?: MfnExecuteResponse | null;

	constructor(init: MfnApiErrorInit) {
		super(`${init.code}: ${init.message}`);
		this.name = "MfnApiError";
		this.httpStatus = init.httpStatus;
		this.code = init.code;
		this.retryable = init.retryable;
		this.operationId = init.operationId;
		this.response = init.response;
	}
}

export type MfnTransport = (
	bodyJson: string,
	timeoutMs: number,
) => Promise<{ httpStatus: number; rawBody: string }>;

export interface MfnClientOptions {
	port?: number;
	host?: string;
	endpoint?: string;
	token: string;
	timeoutMs?: number;
	transport?: MfnTransport;
}

export interface EnsurePoolsOptions {
	mainPoolId: string;
	lexicalPoolId: string;
	spaceId: string;
	dimensions: number;
	capacity?: number;
}

interface ExecuteCallSpec<TPayload> {
	operation: string;
	payload: TPayload;
	poolId?: string;
	mutation?: boolean;
	operationId?: string;
	timeoutMs?: number;
}

function clampTimeoutMs(timeoutMs: number | undefined, fallback: number): number {
	const raw = timeoutMs ?? fallback;
	return Math.max(1, Math.min(30_000, Math.floor(raw)));
}

function readHttpResponse(
	res: http.IncomingMessage,
	resolve: (val: { httpStatus: number; rawBody: string }) => void,
	reject: (err: unknown) => void,
): void {
	const chunks: Buffer[] = [];
	res.on("data", (chunk: Buffer) => chunks.push(chunk));
	res.on("end", () => {
		resolve({
			httpStatus: res.statusCode ?? 0,
			rawBody: Buffer.concat(chunks).toString("utf8"),
		});
	});
	res.once("error", reject);
}

function postLoopbackExecute(
	host: string,
	port: number,
	token: string,
	bodyJson: string,
	timeoutMs: number,
): Promise<{ httpStatus: number; rawBody: string }> {
	const headers: http.OutgoingHttpHeaders = {
		Authorization: `Bearer ${token}`,
		Accept: "application/json",
		"Content-Type": "application/json",
		"Content-Length": String(Buffer.byteLength(bodyJson, "utf8")),
		Connection: "close",
	};
	return new Promise((resolve, reject) => {
		const opts = { hostname: host, port, path: "/v2/execute", method: "POST", headers, agent: false };
		const req = http.request(opts, (res) => readHttpResponse(res, resolve, reject));
		req.setTimeout(timeoutMs + 1_000, () => {
			req.destroy(new MfnApiError({ httpStatus: 504, code: "timeout", message: "MFN request timed out", retryable: true }));
		});
		req.once("error", reject);
		req.end(bodyJson, "utf8");
	});
}

function resolveTransport(opts: MfnClientOptions): { transport: MfnTransport; defaultTimeoutMs: number } {
	if (!opts.token || !opts.token.trim()) {
		throw new Error("MfnClient requires a non-empty bearer token");
	}
	const defaultTimeoutMs = clampTimeoutMs(opts.timeoutMs, 5_000);
	if (opts.transport) {
		return { transport: opts.transport, defaultTimeoutMs };
	}
	const token = opts.token.trim();
	if (opts.endpoint) {
		const parsed = parseLoopbackEndpoint(opts.endpoint);
		return { transport: (b, t) => postLoopbackExecute(parsed.host, parsed.port, token, b, t), defaultTimeoutMs };
	}
	if (!opts.port) {
		throw new Error("MfnClient requires port or endpoint");
	}
	const host = opts.host ?? "127.0.0.1";
	const parsed = parseLoopbackEndpoint(`http://${host === "::1" ? "[::1]" : host}:${opts.port}`);
	return { transport: (b, t) => postLoopbackExecute(parsed.host, parsed.port, token, b, t), defaultTimeoutMs };
}

async function runExecute<TPayload, TComposite = unknown, TOutcome = unknown>(
	transport: MfnTransport,
	defaultTimeoutMs: number,
	spec: ExecuteCallSpec<TPayload>,
): Promise<{ httpStatus: number; envelope: MfnExecuteResponse<TComposite, TOutcome>; operationId?: string }> {
	const timeoutMs = clampTimeoutMs(spec.timeoutMs, defaultTimeoutMs);
	const opId = spec.mutation ? (spec.operationId ?? mintUuidV7()) : undefined;
	const request: MfnRequestEnvelope<TPayload> = {
		version: 2,
		request_id: `req-${mintUuidV7()}`,
		operation: spec.operation,
		payload: spec.payload,
		timeout_ms: timeoutMs,
		...(spec.poolId ? { pool_id: spec.poolId } : {}),
		...(spec.mutation ? { operation_id: opId, durability: "committed" } : {}),
	};
	const { httpStatus, rawBody } = await transport(JSON.stringify({ request }), timeoutMs);
	let parsed: MfnExecuteResponse<TComposite, TOutcome>;
	try {
		parsed = JSON.parse(rawBody) as MfnExecuteResponse<TComposite, TOutcome>;
	} catch {
		throw new MfnApiError({
			httpStatus,
			code: "protocol_error",
			message: "Malformed JSON response from MFN gateway",
			retryable: httpStatus >= 500,
			operationId: opId,
		});
	}
	if (httpStatus >= 400 || parsed.status === "error" || parsed.error) {
		throw new MfnApiError({
			httpStatus,
			code: parsed.error?.code ?? "http_error",
			message: parsed.error?.message ?? `HTTP ${httpStatus}`,
			retryable: parsed.error?.retryable ?? httpStatus === 503,
			operationId: opId,
			response: parsed,
		});
	}
	return { httpStatus, envelope: parsed, operationId: opId };
}

function isPoolMissingError(err: unknown): boolean {
	if (!(err instanceof MfnApiError)) {
		return false;
	}
	return (
		err.httpStatus === 404 ||
		err.code === "not_found" ||
		err.code === "pool_not_found" ||
		err.code === "all_targets_failed"
	);
}

async function ensureSinglePool(client: MfnClient, poolId: string, putPayload: MfnPoolPutPayload): Promise<void> {
	let needsCreate = false;
	try {
		const found = await client.execute("pool.get", {}, { poolId });
		needsCreate = found.envelope.status === "partial";
	} catch (err) {
		if (!isPoolMissingError(err)) {
			throw err;
		}
		needsCreate = true;
	}
	if (needsCreate) {
		await client.execute("pool.put", putPayload, { poolId, mutation: true });
	}
}

interface RawSearchHit {
	memory_id?: unknown;
	score?: unknown;
	content?: unknown;
	tags?: unknown;
	metadata?: unknown;
	created_at_us?: unknown;
}

interface RawPeekResult {
	memory?: { memory_id?: string; content?: string; tags?: string[]; metadata?: Record<string, string> };
	created_at_us?: number;
}

function mergeOutcomeHits(
	hits: RawSearchHit[],
	byId: Map<string, RawSearchHit & { memory_id: string; score: number }>,
): void {
	for (const hit of hits) {
		if (typeof hit?.memory_id !== "string" || typeof hit.score !== "number") continue;
		const prev = byId.get(hit.memory_id);
		if (!prev || hit.score > prev.score) {
			byId.set(hit.memory_id, { ...hit, memory_id: hit.memory_id, score: hit.score });
		}
	}
}

function mergeSearchHits(envelope: MfnExecuteResponse<unknown, { hits?: RawSearchHit[] }>, topK: number): RawSearchHit[] {
	const byId = new Map<string, RawSearchHit & { memory_id: string; score: number }>();
	for (const outcome of envelope.result?.outcomes ?? []) {
		if (Array.isArray(outcome.result?.hits)) {
			mergeOutcomeHits(outcome.result.hits, byId);
		}
	}
	return [...byId.values()].sort((a, b) => b.score - a.score).slice(0, topK);
}

async function hydrateSingleHit(
	client: MfnClient,
	poolId: string,
	hit: RawSearchHit,
	timeoutMs?: number,
): Promise<LexicalSearchMatch | null> {
	const memoryId = hit.memory_id as string;
	const score = hit.score as number;
	if (typeof hit.content === "string" && hit.content.length > 0) {
		return {
			memory_id: memoryId,
			score,
			content: hit.content,
			tags: Array.isArray(hit.tags) ? (hit.tags as string[]) : [],
			metadata: hit.metadata && typeof hit.metadata === "object" ? (hit.metadata as Record<string, string>) : {},
			...(typeof hit.created_at_us === "number" ? { created_at_us: hit.created_at_us } : {}),
		};
	}
	try {
		const peek = await client.execute<{ memory_id: string }, unknown, RawPeekResult>("memory.peek", { memory_id: memoryId }, { poolId, timeoutMs });
		const rec = peek.envelope.result?.outcomes?.find((o) => o.state === "ok" && o.result?.memory?.content)?.result;
		if (!rec?.memory?.content) return null;
		return {
			memory_id: memoryId,
			score,
			content: rec.memory.content,
			tags: rec.memory.tags ?? [],
			metadata: rec.memory.metadata ?? {},
			...(typeof rec.created_at_us === "number" ? { created_at_us: rec.created_at_us } : {}),
		};
	} catch (err) {
		if (!isPoolMissingError(err)) throw err;
		return null;
	}
}

async function execEnsurePools(client: MfnClient, opts: EnsurePoolsOptions): Promise<void> {
	const capacity = opts.capacity ?? 100_000;
	const mainSpace = { id: opts.spaceId, dimensions: opts.dimensions, mode: "caller" as const };
	await ensureSinglePool(client, opts.mainPoolId, { capacity, vector_space: mainSpace });
	await ensureSinglePool(client, opts.lexicalPoolId, { capacity });
}

async function execTurnRecall(
	client: MfnClient,
	poolId: string,
	payload: TurnRecallPayload,
	timeoutMs?: number,
): Promise<{ httpStatus: number; status: MfnResponseStatus; result: TurnRecallResult }> {
	const { httpStatus, envelope } = await client.execute<TurnRecallPayload, TurnRecallResult>("turn.recall", payload, { poolId, timeoutMs });
	const empty: TurnRecallResult = { memories: [], themes: [], anticipations: { actors: [], entities: [], topics: [] }, degraded: [] };
	return { httpStatus, status: envelope.status, result: envelope.result?.result ?? empty };
}

async function execLexicalSearch(
	client: MfnClient,
	poolId: string,
	payload: { query: string; tags?: string[]; top_k?: number; minimum_score?: number },
	timeoutMs?: number,
): Promise<LexicalSearchMatch[]> {
	const topK = payload.top_k ?? 10;
	const { envelope } = await client.execute<typeof payload, unknown, { hits?: RawSearchHit[] }>("memory.search", payload, { poolId, timeoutMs });
	const out: LexicalSearchMatch[] = [];
	for (const hit of mergeSearchHits(envelope, topK)) {
		const hydrated = await hydrateSingleHit(client, poolId, hit, timeoutMs);
		if (hydrated) out.push(hydrated);
	}
	return out;
}

export class MfnClient {
	private readonly transport: MfnTransport;
	private readonly defaultTimeoutMs: number;

	constructor(opts: MfnClientOptions) {
		const resolved = resolveTransport(opts);
		this.transport = resolved.transport;
		this.defaultTimeoutMs = resolved.defaultTimeoutMs;
	}

	execute<TPayload extends object = Record<string, unknown>, TComposite = unknown, TOutcome = unknown>(
		operation: string,
		payload: TPayload,
		opts: { poolId?: string; mutation?: boolean; operationId?: string; timeoutMs?: number } = {},
	): Promise<{ httpStatus: number; envelope: MfnExecuteResponse<TComposite, TOutcome>; operationId?: string }> {
		return runExecute<TPayload, TComposite, TOutcome>(this.transport, this.defaultTimeoutMs, { operation, payload, ...opts });
	}

	ping(timeoutMs?: number): Promise<MfnExecuteResponse> {
		return this.execute("ping", {}, { timeoutMs }).then((r) => r.envelope);
	}

	healthGet(timeoutMs?: number): Promise<MfnExecuteResponse> {
		return this.execute("health.get", {}, { timeoutMs }).then((r) => r.envelope);
	}

	ensurePools(opts: EnsurePoolsOptions): Promise<void> {
		return execEnsurePools(this, opts);
	}

	turnRecall(poolId: string, payload: TurnRecallPayload, timeoutMs?: number) {
		return execTurnRecall(this, poolId, payload, timeoutMs);
	}

	async turnIngest(poolId: string, payload: TurnIngestPayload, operationId?: string, timeoutMs?: number) {
		const opId = operationId ?? mintUuidV7();
		const { envelope } = await this.execute<TurnIngestPayload, TurnIngestGroupResult>("turn.ingest", payload, { poolId, mutation: true, operationId: opId, timeoutMs });
		return { operationId: opId, response: envelope };
	}

	lexicalPut(poolId: string, payload: MfnMemoryPutPayload, operationId?: string, timeoutMs?: number): Promise<MfnExecuteResponse> {
		return this.execute("memory.put", payload, { poolId, mutation: true, operationId, timeoutMs }).then((r) => r.envelope);
	}

	lexicalSearch(poolId: string, payload: { query: string; tags?: string[]; top_k?: number; minimum_score?: number }, timeoutMs?: number) {
		return execLexicalSearch(this, poolId, payload, timeoutMs);
	}
}
