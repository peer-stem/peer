import fs from "node:fs";
import { MfnApiError, type MfnClient } from "./client.ts";
import { writePrivateFile0600 } from "./embedder-pin.ts";
import { isUuidV7 } from "./ids.ts";
import type { TurnIngestPayload } from "./types.ts";

export interface MfnOutboxEntry {
	operationId: string;
	poolId: string;
	payload: TurnIngestPayload;
	enqueuedAtMs: number;
	attempts: number;
	lastErrorCode?: string;
}

export interface MfnOutboxPersistence {
	load(): MfnOutboxEntry[];
	save(entries: readonly MfnOutboxEntry[]): void;
}

export interface MfnIngestOutboxOptions {
	filePath?: string;
	persistence?: MfnOutboxPersistence;
	maxEntries?: number;
}

export interface EnqueueIngestInput {
	operationId: string;
	poolId: string;
	payload: TurnIngestPayload;
	errorCode?: string;
}

const TRANSIENT_NODE_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EPIPE"]);

export function isRetryableMfnError(err: unknown): boolean {
	if (err instanceof MfnApiError) {
		return err.retryable || err.httpStatus === 503;
	}
	if (err && typeof err === "object" && "code" in err) {
		const code = (err as { code?: unknown }).code;
		return typeof code === "string" && TRANSIENT_NODE_CODES.has(code);
	}
	return false;
}

function readOutboxFile(filePath: string): MfnOutboxEntry[] {
	if (!fs.existsSync(filePath)) {
		return [];
	}
	const stat = fs.lstatSync(filePath);
	if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600) {
		throw new Error(`Unsafe MFN outbox file: ${filePath}`);
	}
	const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as {
		format_version?: unknown;
		entries?: unknown;
	};
	if (parsed.format_version !== 1 || !Array.isArray(parsed.entries)) {
		throw new Error(`Invalid MFN outbox file format: ${filePath}`);
	}
	return structuredClone(parsed.entries as MfnOutboxEntry[]);
}

export function createFileOutboxPersistence(filePath: string): MfnOutboxPersistence {
	return {
		load: () => readOutboxFile(filePath),
		save: (entries) => {
			const doc = JSON.stringify({ format_version: 1, entries });
			writePrivateFile0600(filePath, `${doc}\n`);
		},
	};
}

function appendOutboxItem(
	queue: MfnOutboxEntry[],
	maxEntries: number,
	input: EnqueueIngestInput,
): MfnOutboxEntry {
	if (!isUuidV7(input.operationId)) {
		throw new Error(`Outbox operationId must be UUIDv7: ${input.operationId}`);
	}
	const existing = queue.find((item) => item.operationId === input.operationId);
	if (existing) {
		return structuredClone(existing);
	}
	if (queue.length >= maxEntries) {
		throw new Error(`MFN ingest outbox capacity (${maxEntries}) exceeded`);
	}
	const entry: MfnOutboxEntry = {
		operationId: input.operationId,
		poolId: input.poolId,
		payload: structuredClone(input.payload),
		enqueuedAtMs: Date.now(),
		attempts: 1,
		...(input.errorCode ? { lastErrorCode: input.errorCode } : {}),
	};
	queue.push(entry);
	return structuredClone(entry);
}

async function flushHeadEntry(
	head: MfnOutboxEntry,
	queue: MfnOutboxEntry[],
	persist: () => void,
	client: Pick<MfnClient, "turnIngest">,
): Promise<boolean> {
	try {
		await client.turnIngest(head.poolId, head.payload, head.operationId);
		queue.shift();
		persist();
		return true;
	} catch (err) {
		if (!isRetryableMfnError(err)) {
			persist();
			throw err;
		}
		head.attempts += 1;
		head.lastErrorCode = err instanceof MfnApiError ? err.code : "transport_error";
		persist();
		return false;
	}
}

async function drainOutboxQueue(
	queue: MfnOutboxEntry[],
	persist: () => void,
	client: Pick<MfnClient, "turnIngest">,
): Promise<{ flushed: number; remaining: number }> {
	let flushed = 0;
	while (queue.length > 0) {
		const ok = await flushHeadEntry(queue[0]!, queue, persist, client);
		if (!ok) break;
		flushed++;
	}
	return { flushed, remaining: queue.length };
}

export class MfnIngestOutbox {
	private readonly queue: MfnOutboxEntry[];
	private readonly persistence?: MfnOutboxPersistence;
	private readonly maxEntries: number;
	private inFlight: Promise<{ flushed: number; remaining: number }> | null = null;

	constructor(opts: MfnIngestOutboxOptions = {}) {
		this.persistence = opts.persistence ?? (opts.filePath ? createFileOutboxPersistence(opts.filePath) : undefined);
		this.maxEntries = opts.maxEntries ?? 1_024;
		this.queue = this.persistence ? this.persistence.load() : [];
	}

	size(): number {
		return this.queue.length;
	}

	entries(): MfnOutboxEntry[] {
		return structuredClone(this.queue);
	}

	isRetryableIngestError(err: unknown): boolean {
		return isRetryableMfnError(err);
	}

	enqueue(input: EnqueueIngestInput): MfnOutboxEntry {
		const added = appendOutboxItem(this.queue, this.maxEntries, input);
		this.persistence?.save(this.queue);
		return added;
	}

	flush(client: Pick<MfnClient, "turnIngest">): Promise<{ flushed: number; remaining: number }> {
		if (this.inFlight) {
			return this.inFlight;
		}
		const run = drainOutboxQueue(this.queue, () => this.persistence?.save(this.queue), client).finally(() => {
			this.inFlight = null;
		});
		this.inFlight = run;
		return run;
	}
}
