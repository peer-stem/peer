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
	nextRetryAtMs?: number;
}
export interface MfnDeadLetterEntry {
	entry: MfnOutboxEntry;
	quarantinedAtMs: number;
	reason: string;
	errorCode?: string;
}
export interface MfnOutboxSnapshot {
	entries: MfnOutboxEntry[];
	deadLetter: MfnDeadLetterEntry[];
}
export interface MfnOutboxPersistence {
	load(): MfnOutboxSnapshot;
	save(entries: readonly MfnOutboxEntry[], deadLetter?: readonly MfnDeadLetterEntry[]): void;
}
export interface LumberJackOutboxForest {
	getNode(path: string): { slot?: unknown } | null;
	upsertNode(input: { path: string; type?: "leaf" | "branch"; kind?: string; slot?: unknown }): unknown;
}
export interface MfnIngestOutboxOptions {
	filePath?: string;
	persistence?: MfnOutboxPersistence;
	maxEntries?: number;
	maxDeadLetters?: number;
	maxAgeMs?: number;
	baseBackoffMs?: number;
	nowFn?: () => number;
}
export type EnqueueIngestInput = Omit<
	MfnOutboxEntry,
	"enqueuedAtMs" | "attempts" | "lastErrorCode" | "nextRetryAtMs"
> & { errorCode?: string };

export interface MfnOutboxFlushOptions {
	force?: boolean;
	nowMs?: number;
}
export interface MfnOutboxFlushResult {
	flushed: number;
	remaining: number;
	quarantined: number;
}
export type MfnOutboxClient = Pick<MfnClient, "turnIngest"> & Partial<Pick<MfnClient, "lexicalPut">>;

const DEFAULT_MAX_ENTRIES = 1_024;
const DEFAULT_MAX_DEAD_LETTERS = 256;
const DEFAULT_MAX_AGE_MS = 7 * 86_400_000;
const DEFAULT_BASE_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 60_000;
const TRANSIENT_NODE_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EPIPE"]);
const PER_ITEM_POISON_HTTP_STATUSES = new Set([400, 413, 415, 422]);

class MalformedOutboxEntryError extends Error {
	readonly code = "malformed_outbox_entry";
	constructor(message: string) {
		super(message);
		this.name = "MalformedOutboxEntryError";
	}
}

export function isRetryableMfnError(err: unknown): boolean {
	if (err instanceof MfnApiError) return err.retryable || err.httpStatus === 503;
	if (err && typeof err === "object" && "code" in err) {
		const code = (err as { code?: unknown }).code;
		return typeof code === "string" && TRANSIENT_NODE_CODES.has(code);
	}
	return false;
}

export function isPerItemPoisonMfnError(err: unknown): boolean {
	if (err instanceof MalformedOutboxEntryError) return true;
	return err instanceof MfnApiError && PER_ITEM_POISON_HTTP_STATUSES.has(err.httpStatus);
}

function extractOutboxErrorCode(err: unknown): string {
	if (err instanceof MfnApiError || err instanceof MalformedOutboxEntryError) return err.code;
	if (err && typeof err === "object" && "code" in err) {
		const code = (err as { code?: unknown }).code;
		if (typeof code === "string" && code.length > 0) return code;
	}
	return "transport_error";
}

function parseOutboxSlot(raw: unknown, label: string): MfnOutboxSnapshot | null {
	if (!raw || typeof raw !== "object") {
		console.warn(`[mfn-outbox] Corrupt outbox container (${label}); resetting to empty`);
		return null;
	}
	const doc = raw as { format_version?: unknown; entries?: unknown; dead_letter?: unknown };
	const validVer = doc.format_version === 1 || doc.format_version === 2 || doc.format_version === 3;
	const validDead = doc.dead_letter === undefined || Array.isArray(doc.dead_letter);
	if (!validVer || !Array.isArray(doc.entries) || !validDead) {
		console.warn(`[mfn-outbox] Unsupported or corrupt outbox format (${label}); resetting to empty`);
		return null;
	}
	return {
		entries: structuredClone(doc.entries as MfnOutboxEntry[]),
		deadLetter: doc.dead_letter ? structuredClone(doc.dead_letter as MfnDeadLetterEntry[]) : [],
	};
}

function resolveCleanParentDir(filePath: string): string {
	if (!path.isAbsolute(filePath) || filePath.split(path.sep).includes("..")) {
		throw new Error(`Outbox file path must be clean and absolute: ${filePath}`);
	}
	return path.dirname(filePath);
}

function sweepStaleOutboxTmpFiles(filePath: string): void {
	const parentDir = resolveCleanParentDir(filePath);
	const parentStat = fs.lstatSync(parentDir, { throwIfNoEntry: false });
	if (!parentStat || !parentStat.isDirectory() || parentStat.isSymbolicLink()) return;
	const prefix = `${path.basename(filePath)}.tmp.`;
	for (const name of fs.readdirSync(parentDir)) {
		if (!name.startsWith(prefix)) continue;
		const candidate = path.join(parentDir, name);
		const st = fs.lstatSync(candidate, { throwIfNoEntry: false });
		if (st && st.isFile() && !st.isSymbolicLink()) fs.rmSync(candidate, { force: true });
	}
}

function writeTmpFile0600(tmpPath: string, content: string): void {
	const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW;
	const fd = fs.openSync(tmpPath, flags, 0o600);
	try {
		fs.fchmodSync(fd, 0o600);
		fs.writeFileSync(fd, content, "utf8");
		fs.fsyncSync(fd);
	} finally {
		fs.closeSync(fd);
	}
}

function readOutboxFile(filePath: string): MfnOutboxSnapshot {
	sweepStaleOutboxTmpFiles(filePath);
	if (!fs.existsSync(filePath)) return { entries: [], deadLetter: [] };
	const stat = fs.lstatSync(filePath);
	if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600) {
		throw new Error(`Unsafe MFN outbox file: ${filePath}`);
	}
	const rawText = fs.readFileSync(filePath, "utf8");
	try {
		const parsed = parseOutboxSlot(JSON.parse(rawText), filePath);
		if (parsed) return parsed;
	} catch (err) {
		console.warn(`[mfn-outbox] Corrupt or truncated outbox JSON at ${filePath}; recovering empty:`, err);
	}
	const primary = `${filePath}.corrupt.${Date.now()}`;
	const backupPath = fs.existsSync(primary) ? `${primary}.${randomBytes(2).toString("hex")}` : primary;
	try {
		writeTmpFile0600(backupPath, rawText);
	} catch (err) {
		console.warn(`[mfn-outbox] Failed to preserve corrupt outbox backup at ${backupPath}:`, err);
	}
	return { entries: [], deadLetter: [] };
}

function ensureCleanParentDir0700(filePath: string): string {
	const parentDir = resolveCleanParentDir(filePath);
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

function writeOutboxFileAtomic(
	filePath: string,
	entries: readonly MfnOutboxEntry[],
	deadLetter: readonly MfnDeadLetterEntry[] = [],
): void {
	const parentDir = ensureCleanParentDir0700(filePath);
	const tmpPath = `${filePath}.tmp.${process.pid}.${randomBytes(6).toString("hex")}`;
	const serialized = `${JSON.stringify({ format_version: 3, entries, dead_letter: deadLetter })}\n`;
	try {
		writeTmpFile0600(tmpPath, serialized);
		fs.renameSync(tmpPath, filePath);
	} catch (err) {
		fs.rmSync(tmpPath, { force: true });
		throw err;
	}
	const dirFd = fs.openSync(parentDir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
	try {
		fs.fsyncSync(dirFd);
	} finally {
		fs.closeSync(dirFd);
	}
}

export function createFileOutboxPersistence(filePath: string): MfnOutboxPersistence {
	return {
		load: () => readOutboxFile(filePath),
		save: (entries, deadLetter = []) => writeOutboxFileAtomic(filePath, entries, deadLetter),
	};
}

export function createLumberJackOutboxPersistence(forest: LumberJackOutboxForest): MfnOutboxPersistence {
	return {
		load: () => {
			const node = forest.getNode("memory/outbox");
			if (!node || node.slot === undefined || node.slot === null) return { entries: [], deadLetter: [] };
			return parseOutboxSlot(node.slot, "memory/outbox") ?? { entries: [], deadLetter: [] };
		},
		save: (entries, dead = []) => {
			const slot = { format_version: 3, entries: structuredClone(entries), dead_letter: structuredClone(dead) };
			forest.upsertNode({ path: "memory/outbox", type: "leaf", kind: "mfn_outbox", slot });
		},
	};
}

interface OutboxState {
	queue: MfnOutboxEntry[];
	deadLetter: MfnDeadLetterEntry[];
	persistence?: MfnOutboxPersistence;
	maxEntries: number;
	maxDeadLetters: number;
	maxAgeMs: number;
	baseBackoffMs: number;
	nowFn: () => number;
	quarantinedCount: number;
	droppedCount: number;
	inFlight: Promise<MfnOutboxFlushResult> | null;
}

function removeEntryByOpId(queue: MfnOutboxEntry[], operationId: string): MfnOutboxEntry | undefined {
	const idx = queue.findIndex((item) => item.operationId === operationId);
	return idx < 0 ? undefined : queue.splice(idx, 1)[0];
}

function buildOutboxEntry(input: EnqueueIngestInput, nowMs: number): MfnOutboxEntry {
	const kind: MfnOutboxEntryKind = input.kind ?? "turn_ingest";
	if (kind === "lexical_put" && !input.lexicalPayload) {
		throw new Error("lexical_put outbox entry requires lexicalPayload");
	}
	if (kind === "turn_ingest" && !input.payload) throw new Error("turn_ingest outbox entry requires payload");
	const body = kind === "lexical_put"
		? { lexicalPayload: structuredClone(input.lexicalPayload!) }
		: { payload: structuredClone(input.payload!) };
	return {
		kind,
		operationId: input.operationId,
		poolId: input.poolId,
		...body,
		enqueuedAtMs: nowMs,
		attempts: 1,
		...(input.errorCode ? { lastErrorCode: input.errorCode } : {}),
	};
}

function enqueueOutboxItem(state: OutboxState, input: EnqueueIngestInput): MfnOutboxEntry {
	if (!isUuidV7(input.operationId)) throw new Error(`Outbox operationId must be UUIDv7: ${input.operationId}`);
	const existing = state.queue.find((item) => item.operationId === input.operationId);
	if (existing) return structuredClone(existing);
	while (state.queue.length >= state.maxEntries && state.queue.length > 0) {
		const evicted = state.queue.shift();
		state.droppedCount += 1;
		console.warn(`[mfn-outbox] Capacity (${state.maxEntries}) reached; evicted oldest ${evicted?.operationId}`);
	}
	const entry = buildOutboxEntry(input, state.nowFn());
	state.queue.push(entry);
	state.persistence?.save(state.queue, state.deadLetter);
	return structuredClone(entry);
}

function recordDeadLetter(
	state: OutboxState, entry: MfnOutboxEntry, reason: string, errorCode: string | undefined, nowMs: number,
): MfnDeadLetterEntry {
	while (state.deadLetter.length >= state.maxDeadLetters && state.deadLetter.length > 0) {
		const opId = state.deadLetter.shift()?.entry.operationId;
		console.warn(`[mfn-outbox] Dead-letter cap (${state.maxDeadLetters}) reached; evicted ${opId}`);
	}
	const dead: MfnDeadLetterEntry = {
		entry: structuredClone(entry), quarantinedAtMs: nowMs, reason, ...(errorCode ? { errorCode } : {}),
	};
	state.deadLetter.push(dead);
	state.quarantinedCount += 1;
	console.warn(`[mfn-outbox] Quarantined entry ${entry.operationId}: ${reason}`);
	state.persistence?.save(state.queue, state.deadLetter);
	return structuredClone(dead);
}

function quarantineInputItem(state: OutboxState, input: EnqueueIngestInput, reason: string): MfnDeadLetterEntry {
	if (!isUuidV7(input.operationId)) throw new Error(`Outbox operationId must be UUIDv7: ${input.operationId}`);
	const existingDead = state.deadLetter.find((d) => d.entry.operationId === input.operationId);
	if (existingDead) return structuredClone(existingDead);
	const nowMs = state.nowFn();
	const entry = removeEntryByOpId(state.queue, input.operationId) ?? buildOutboxEntry(input, nowMs);
	return recordDeadLetter(state, entry, reason, input.errorCode ?? entry.lastErrorCode, nowMs);
}

async function replayOutboxEntry(head: MfnOutboxEntry, client: MfnOutboxClient): Promise<void> {
	if ((head.kind ?? "turn_ingest") === "lexical_put") {
		if (!head.lexicalPayload || typeof head.lexicalPayload !== "object") {
			throw new MalformedOutboxEntryError("Missing lexicalPayload on lexical_put outbox entry");
		}
		if (!client.lexicalPut) throw new Error("MFN outbox client missing lexicalPut method");
		await client.lexicalPut(head.poolId, head.lexicalPayload, head.operationId);
		return;
	}
	if (!head.payload || typeof head.payload !== "object") {
		throw new MalformedOutboxEntryError("Missing payload on turn_ingest outbox entry");
	}
	await client.turnIngest(head.poolId, head.payload, head.operationId);
}

async function replayOrClassifyCandidate(
	state: OutboxState, candidate: MfnOutboxEntry, client: MfnOutboxClient, opts?: MfnOutboxFlushOptions,
): Promise<"flushed" | "quarantined" | "block_turn_ingest" | "stop"> {
	try {
		await replayOutboxEntry(candidate, client);
		if (removeEntryByOpId(state.queue, candidate.operationId)) {
			state.persistence?.save(state.queue, state.deadLetter);
		}
		return "flushed";
	} catch (err) {
		const errNow = opts?.nowMs ?? state.nowFn();
		const code = extractOutboxErrorCode(err);
		if (isPerItemPoisonMfnError(err)) {
			const removed = removeEntryByOpId(state.queue, candidate.operationId) ?? candidate;
			recordDeadLetter(state, removed, `per-item poison (${code})`, code, errNow);
			return "quarantined";
		}
		const current = state.queue.find((item) => item.operationId === candidate.operationId);
		if (current) {
			const exp = Math.min(6, Math.max(0, current.attempts - 1));
			current.attempts += 1;
			current.lastErrorCode = code;
			current.nextRetryAtMs = errNow + Math.min(MAX_BACKOFF_MS, state.baseBackoffMs * 2 ** exp);
			state.persistence?.save(state.queue, state.deadLetter);
		}
		const isTurn = (candidate.kind ?? "turn_ingest") === "turn_ingest";
		const isEmbedDown = err instanceof MfnApiError && (code === "embedder_unavailable" || code === "embedder");
		return isTurn && isEmbedDown ? "block_turn_ingest" : "stop";
	}
}

async function drainOutboxQueue(
	state: OutboxState, client: MfnOutboxClient, opts?: MfnOutboxFlushOptions,
): Promise<MfnOutboxFlushResult> {
	let flushed = 0;
	let quarantined = 0;
	let turnIngestBlocked = false;
	const visited = new Set<string>();
	while (true) {
		const candidate = state.queue.find((item) => !visited.has(item.operationId));
		if (!candidate) break;
		visited.add(candidate.operationId);
		const now = opts?.nowMs ?? state.nowFn();
		if (now - candidate.enqueuedAtMs > state.maxAgeMs) {
			const removed = removeEntryByOpId(state.queue, candidate.operationId) ?? candidate;
			recordDeadLetter(state, removed, `expired (age > ${state.maxAgeMs}ms)`, removed.lastErrorCode, now);
			quarantined += 1;
			continue;
		}
		if (turnIngestBlocked && (candidate.kind ?? "turn_ingest") === "turn_ingest") continue;
		if (!opts?.force && candidate.nextRetryAtMs !== undefined && now < candidate.nextRetryAtMs) continue;
		const step = await replayOrClassifyCandidate(state, candidate, client, opts);
		if (step === "flushed") flushed += 1;
		else if (step === "quarantined") quarantined += 1;
		else if (step === "block_turn_ingest") turnIngestBlocked = true;
		else break;
	}
	return { flushed, remaining: state.queue.length, quarantined };
}

function scheduleOutboxFlush(
	state: OutboxState, client: MfnOutboxClient, opts?: MfnOutboxFlushOptions,
): Promise<MfnOutboxFlushResult> {
	if (state.inFlight && !opts?.force && opts?.nowMs === undefined) return state.inFlight;
	const prior = state.inFlight;
	const run = (prior ? prior.catch(() => undefined) : Promise.resolve())
		.then(() => drainOutboxQueue(state, client, opts))
		.finally(() => {
			if (state.inFlight === run) state.inFlight = null;
		});
	state.inFlight = run;
	return run;
}

function createOutboxState(opts: MfnIngestOutboxOptions): OutboxState {
	const persistence = opts.persistence ?? (opts.filePath ? createFileOutboxPersistence(opts.filePath) : undefined);
	const loaded = persistence ? persistence.load() : { entries: [], deadLetter: [] };
	return {
		queue: loaded.entries,
		deadLetter: loaded.deadLetter,
		persistence,
		maxEntries: Math.max(1, opts.maxEntries ?? DEFAULT_MAX_ENTRIES),
		maxDeadLetters: Math.max(1, opts.maxDeadLetters ?? DEFAULT_MAX_DEAD_LETTERS),
		maxAgeMs: Math.max(1, opts.maxAgeMs ?? DEFAULT_MAX_AGE_MS),
		baseBackoffMs: Math.max(0, opts.baseBackoffMs ?? DEFAULT_BASE_BACKOFF_MS),
		nowFn: opts.nowFn ?? Date.now,
		quarantinedCount: loaded.deadLetter.length,
		droppedCount: 0,
		inFlight: null,
	};
}

function startOutboxAutoFlush(outbox: MfnIngestOutbox, client: MfnOutboxClient, intervalMs: number): () => void {
	const safeFlush = () => {
		if (outbox.size() === 0) return;
		void outbox.flush(client).catch((err) => console.warn("[mfn-outbox] Auto-flush failed:", err));
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
	deadLetters(): MfnDeadLetterEntry[] {
		return structuredClone(this.state.deadLetter);
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
		return enqueueOutboxItem(this.state, input);
	}
	quarantine(input: EnqueueIngestInput, reason: string): MfnDeadLetterEntry {
		return quarantineInputItem(this.state, input, reason);
	}
	flush(client: MfnOutboxClient, opts?: MfnOutboxFlushOptions): Promise<MfnOutboxFlushResult> {
		return scheduleOutboxFlush(this.state, client, opts);
	}
	startAutoFlush(client: MfnOutboxClient, intervalMs = 5_000): () => void {
		return startOutboxAutoFlush(this, client, intervalMs);
	}
}
