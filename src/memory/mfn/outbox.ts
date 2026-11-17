import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { MfnApiError, type MfnClient } from "./client.ts";
import { isUuidV7 } from "./ids.ts";
import type { MfnMemoryPutPayload, TurnIngestPayload } from "./types.ts";

export type MfnOutboxEntryKind = "turn_ingest" | "lexical_put";

export interface MfnOutboxEntry {
	kind?: MfnOutboxEntryKind;
	operationId: string;
	poolId: string;
	payload?: TurnIngestPayload;
	lexicalPayload?: MfnMemoryPutPayload;
	enqueuedAtMs: number;
	attempts: number;
	lastErrorCode?: string;
}

export interface MfnOutboxPersistence {
	load(): MfnOutboxEntry[];
	save(entries: readonly MfnOutboxEntry[]): void;
}

export interface LumberJackOutboxForest {
	getNode(path: string): { slot?: unknown } | null;
	upsertNode(input: { path: string; type?: "leaf" | "branch"; kind?: string; slot?: unknown }): unknown;
}

export interface MfnIngestOutboxOptions {
	filePath?: string;
	persistence?: MfnOutboxPersistence;
	maxEntries?: number;
	maxAttempts?: number;
	maxAgeMs?: number;
}

export interface EnqueueIngestInput {
	kind?: MfnOutboxEntryKind;
	operationId: string;
	poolId: string;
	payload?: TurnIngestPayload;
	lexicalPayload?: MfnMemoryPutPayload;
	errorCode?: string;
}

export interface MfnOutboxFlushResult {
	flushed: number;
	remaining: number;
	quarantined: number;
}

export type MfnOutboxClient = Pick<MfnClient, "turnIngest"> & Partial<Pick<MfnClient, "lexicalPut">>;

const DEFAULT_MAX_ENTRIES = 1_024;
const DEFAULT_MAX_ATTEMPTS = 16;
const DEFAULT_MAX_AGE_MS = 7 * 86_400_000;
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

function parseOutboxSlot(raw: unknown, label: string): MfnOutboxEntry[] {
	if (!raw || typeof raw !== "object") {
		console.warn(`[mfn-outbox] Corrupt outbox container (${label}); resetting to empty`);
		return [];
	}
	const doc = raw as { format_version?: unknown; entries?: unknown };
	if ((doc.format_version !== 1 && doc.format_version !== 2) || !Array.isArray(doc.entries)) {
		console.warn(`[mfn-outbox] Unsupported or corrupt outbox format (${label}); resetting to empty`);
		return [];
	}
	return structuredClone(doc.entries as MfnOutboxEntry[]);
}

function readOutboxFile(filePath: string): MfnOutboxEntry[] {
	if (!fs.existsSync(filePath)) {
		return [];
	}
	const stat = fs.lstatSync(filePath);
	if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600) {
		throw new Error(`Unsafe MFN outbox file: ${filePath}`);
	}
	try {
		const rawText = fs.readFileSync(filePath, "utf8");
		return parseOutboxSlot(JSON.parse(rawText), filePath);
	} catch (err) {
		console.warn(`[mfn-outbox] Corrupt or truncated outbox JSON at ${filePath}; recovering empty:`, err);
		return [];
	}
}

function ensureCleanParentDir0700(filePath: string): string {
	if (!path.isAbsolute(filePath) || filePath.split(path.sep).includes("..")) {
		throw new Error(`Outbox file path must be clean and absolute: ${filePath}`);
	}
	const parentDir = path.dirname(filePath);
	fs.mkdirSync(parentDir, { recursive: true, mode: 0o700 });
	const parentStat = fs.lstatSync(parentDir);
	if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
		throw new Error(`Outbox parent path must be a real directory: ${parentDir}`);
	}
	fs.chmodSync(parentDir, 0o700);
	const existing = fs.lstatSync(filePath, { throwIfNoEntry: false });
	if (existing && (!existing.isFile() || existing.isSymbolicLink())) {
		throw new Error(`Unsafe MFN outbox file: ${filePath}`);
	}
	return parentDir;
}

function writeTmpFile0600(tmpPath: string, content: string): void {
	const flags =
		fs.constants.O_WRONLY |
		fs.constants.O_CREAT |
		fs.constants.O_EXCL |
		fs.constants.O_NOFOLLOW;
	const fd = fs.openSync(tmpPath, flags, 0o600);
	try {
		fs.fchmodSync(fd, 0o600);
		const buf = Buffer.from(content, "utf8");
		let offset = 0;
		while (offset < buf.length) {
			offset += fs.writeSync(fd, buf, offset, buf.length - offset, offset);
		}
		fs.fsyncSync(fd);
	} finally {
		fs.closeSync(fd);
	}
}

function fsyncDirectory(dirPath: string): void {
	const dirFd = fs.openSync(dirPath, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
	try {
		fs.fsyncSync(dirFd);
	} finally {
		fs.closeSync(dirFd);
	}
}

function writeOutboxFileAtomic(filePath: string, entries: readonly MfnOutboxEntry[]): void {
	const parentDir = ensureCleanParentDir0700(filePath);
	const tmpPath = `${filePath}.tmp.${process.pid}.${randomBytes(6).toString("hex")}`;
	const serialized = `${JSON.stringify({ format_version: 2, entries })}\n`;
	try {
		writeTmpFile0600(tmpPath, serialized);
		fs.renameSync(tmpPath, filePath);
	} catch (err) {
		fs.rmSync(tmpPath, { force: true });
		throw err;
	}
	fsyncDirectory(parentDir);
}

export function createFileOutboxPersistence(filePath: string): MfnOutboxPersistence {
	return {
		load: () => readOutboxFile(filePath),
		save: (entries) => writeOutboxFileAtomic(filePath, entries),
	};
}

function loadLumberJackOutbox(forest: LumberJackOutboxForest): MfnOutboxEntry[] {
	const node = forest.getNode("memory/outbox");
	if (!node || node.slot === undefined || node.slot === null) return [];
	return parseOutboxSlot(node.slot, "memory/outbox");
}

function saveLumberJackOutbox(forest: LumberJackOutboxForest, entries: readonly MfnOutboxEntry[]): void {
	forest.upsertNode({
		path: "memory/outbox",
		type: "leaf",
		kind: "mfn_outbox",
		slot: { format_version: 2, entries: structuredClone(entries) },
	});
}

export function createLumberJackOutboxPersistence(forest: LumberJackOutboxForest): MfnOutboxPersistence {
	return {
		load: () => loadLumberJackOutbox(forest),
		save: (entries) => saveLumberJackOutbox(forest, entries),
	};
}

interface OutboxState {
	queue: MfnOutboxEntry[];
	persistence?: MfnOutboxPersistence;
	maxEntries: number;
	maxAttempts: number;
	maxAgeMs: number;
	quarantinedCount: number;
	droppedCount: number;
	inFlight: Promise<MfnOutboxFlushResult> | null;
}

function buildOutboxEntry(input: EnqueueIngestInput): MfnOutboxEntry {
	const kind: MfnOutboxEntryKind = input.kind ?? "turn_ingest";
	if (kind === "lexical_put") {
		if (!input.lexicalPayload) {
			throw new Error("lexical_put outbox entry requires lexicalPayload");
		}
		return {
			kind: "lexical_put",
			operationId: input.operationId,
			poolId: input.poolId,
			lexicalPayload: structuredClone(input.lexicalPayload),
			enqueuedAtMs: Date.now(),
			attempts: 1,
			...(input.errorCode ? { lastErrorCode: input.errorCode } : {}),
		};
	}
	if (!input.payload) {
		throw new Error("turn_ingest outbox entry requires payload");
	}
	return {
		kind: "turn_ingest",
		operationId: input.operationId,
		poolId: input.poolId,
		payload: structuredClone(input.payload),
		enqueuedAtMs: Date.now(),
		attempts: 1,
		...(input.errorCode ? { lastErrorCode: input.errorCode } : {}),
	};
}

function appendOutboxItem(state: OutboxState, input: EnqueueIngestInput): MfnOutboxEntry {
	if (!isUuidV7(input.operationId)) {
		throw new Error(`Outbox operationId must be UUIDv7: ${input.operationId}`);
	}
	const existing = state.queue.find((item) => item.operationId === input.operationId);
	if (existing) {
		return structuredClone(existing);
	}
	while (state.queue.length >= state.maxEntries && state.queue.length > 0) {
		const evicted = state.queue.shift();
		state.droppedCount += 1;
		console.warn(`[mfn-outbox] Capacity (${state.maxEntries}) reached; evicted oldest ${evicted?.operationId}`);
	}
	const entry = buildOutboxEntry(input);
	state.queue.push(entry);
	return structuredClone(entry);
}

function quarantineHead(state: OutboxState, reason: string): "quarantined" {
	const removed = state.queue.shift();
	state.quarantinedCount += 1;
	console.warn(`[mfn-outbox] Quarantined entry ${removed?.operationId ?? "unknown"}: ${reason}`);
	state.persistence?.save(state.queue);
	return "quarantined";
}

async function replayOutboxEntry(head: MfnOutboxEntry, client: MfnOutboxClient): Promise<void> {
	const kind = head.kind ?? "turn_ingest";
	if (kind === "lexical_put") {
		if (!head.lexicalPayload) {
			throw new Error("Missing lexicalPayload on lexical_put outbox entry");
		}
		if (!client.lexicalPut) {
			throw new Error("MFN outbox client missing lexicalPut method");
		}
		await client.lexicalPut(head.poolId, head.lexicalPayload, head.operationId);
		return;
	}
	if (!head.payload) {
		throw new Error("Missing payload on turn_ingest outbox entry");
	}
	await client.turnIngest(head.poolId, head.payload, head.operationId);
}

async function flushHeadEntry(
	state: OutboxState,
	head: MfnOutboxEntry,
	client: MfnOutboxClient,
): Promise<"flushed" | "quarantined" | "retry_later"> {
	if (Date.now() - head.enqueuedAtMs > state.maxAgeMs) {
		return quarantineHead(state, `expired (age > ${state.maxAgeMs}ms)`);
	}
	if (head.attempts > state.maxAttempts) {
		return quarantineHead(state, `exceeded maxAttempts (${state.maxAttempts})`);
	}
	try {
		await replayOutboxEntry(head, client);
		state.queue.shift();
		state.persistence?.save(state.queue);
		return "flushed";
	} catch (err) {
		if (!isRetryableMfnError(err)) {
			const code = err instanceof MfnApiError ? err.code : String(err);
			return quarantineHead(state, `non-retryable error (${code})`);
		}
		head.attempts += 1;
		head.lastErrorCode = err instanceof MfnApiError ? err.code : "transport_error";
		if (head.attempts > state.maxAttempts) {
			return quarantineHead(state, `exceeded maxAttempts (${state.maxAttempts}) after ${head.lastErrorCode}`);
		}
		state.persistence?.save(state.queue);
		return "retry_later";
	}
}

async function drainOutboxQueue(state: OutboxState, client: MfnOutboxClient): Promise<MfnOutboxFlushResult> {
	let flushed = 0;
	let quarantined = 0;
	while (state.queue.length > 0) {
		const step = await flushHeadEntry(state, state.queue[0]!, client);
		if (step === "retry_later") break;
		if (step === "flushed") flushed += 1;
		else quarantined += 1;
	}
	return { flushed, remaining: state.queue.length, quarantined };
}

function createOutboxState(opts: MfnIngestOutboxOptions): OutboxState {
	const persistence = opts.persistence ?? (opts.filePath ? createFileOutboxPersistence(opts.filePath) : undefined);
	return {
		queue: persistence ? persistence.load() : [],
		persistence,
		maxEntries: Math.max(1, opts.maxEntries ?? DEFAULT_MAX_ENTRIES),
		maxAttempts: Math.max(1, opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS),
		maxAgeMs: Math.max(1, opts.maxAgeMs ?? DEFAULT_MAX_AGE_MS),
		quarantinedCount: 0,
		droppedCount: 0,
		inFlight: null,
	};
}

function startOutboxAutoFlush(
	outbox: MfnIngestOutbox,
	client: MfnOutboxClient,
	intervalMs: number,
): () => void {
	const safeFlush = () => {
		if (outbox.size() === 0) return;
		void outbox.flush(client).catch((err) => {
			console.warn("[mfn-outbox] Auto-flush failed:", err);
		});
	};
	safeFlush();
	const timer = setInterval(safeFlush, Math.max(25, intervalMs));
	timer.unref?.();
	return () => clearInterval(timer);
}

export class MfnIngestOutbox {
	private readonly state: OutboxState;

	constructor(opts: MfnIngestOutboxOptions = {}) {
		this.state = createOutboxState(opts);
	}

	size(): number {
		return this.state.queue.length;
	}

	entries(): MfnOutboxEntry[] {
		return structuredClone(this.state.queue);
	}

	get quarantinedCount(): number {
		return this.state.quarantinedCount;
	}

	get droppedCount(): number {
		return this.state.droppedCount;
	}

	isRetryableIngestError(err: unknown): boolean {
		return isRetryableMfnError(err);
	}

	enqueue(input: EnqueueIngestInput): MfnOutboxEntry {
		const added = appendOutboxItem(this.state, input);
		this.state.persistence?.save(this.state.queue);
		return added;
	}

	flush(client: MfnOutboxClient): Promise<MfnOutboxFlushResult> {
		if (this.state.inFlight) return this.state.inFlight;
		const run = drainOutboxQueue(this.state, client).finally(() => {
			this.state.inFlight = null;
		});
		this.state.inFlight = run;
		return run;
	}

	startAutoFlush(client: MfnOutboxClient, intervalMs = 5_000): () => void {
		return startOutboxAutoFlush(this, client, intervalMs);
	}
}
