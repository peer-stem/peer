import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { createLumberJackObjectsClient, type LumberJackObjectsClient } from "./objects-client.ts";

export const LJ_STATUS = {
	OK: 0,
	INVALID: 1,
	UNAUTHENTICATED: 2,
	FORBIDDEN: 3,
	NOT_FOUND: 4,
	CONFLICT: 5,
	TOO_LARGE: 6,
	INTERNAL: 7,
	TRUNCATED: 8,
	BAD_HANDLE: 9,
	CLOSED: 10,
	PANIC: 11,
	CODEC: 12,
	GAP: 13,
	LOCKED: 14,
	BUSY: 15,
	UNGUARDED: 16,
} as const;

export interface RawLumberJackAddon {
	abiVersion(): number;
	open(yamlReq: string): bigint;
	adopt(yamlReq: string): void;
	close(handle: bigint): void;
	peerExec(handle: bigint, jsonReq: string): string;
	applicationConfigure(handle: bigint, jsonReq: string): void;
	applicationCall(handle: bigint, jsonReq: string): string;
	eventStart(handle: bigint, yamlOrJsonReq: string): string;
	eventAppend(handle: bigint, yamlOrJsonReq: string): string;
	eventEnd(handle: bigint, yamlOrJsonReq: string): string;
	eventEntries(handle: bigint, yamlOrJsonReq: string): string;
	streamPoll(handle: bigint, yamlReq: string): { status: number; yaml: string };
}

export interface UpsertNodeInput {
	path: string;
	type?: "leaf" | "branch";
	kind?: string;
	metadata?: Record<string, unknown>;
	replace_metadata?: boolean;
	parent_paths?: string[];
	clear_parents?: boolean;
	slot?: unknown;
	clear_slot?: boolean;
}

export interface NodeSnapshot {
	id: string;
	name: string;
	path: string;
	type: "leaf" | "branch";
	kind?: string;
	parents: Record<string, string>;
	child_names: string[];
	metadata?: Record<string, unknown>;
	slot?: unknown;
}

export interface EntryWire {
	id: string;
	parent_id?: string;
	rank?: string;
	content: unknown;
	metadata?: Record<string, unknown>;
	timestamp?: string;
}

export interface EventSnapshot {
	event_id: string;
	status: string;
	metadata?: Record<string, unknown>;
	entries: EntryWire[];
}

export interface StoredObjectReceipt {
	id: string;
	size: number;
	mime_type: string;
	existed: boolean;
}

export interface StoredObjectData {
	found: boolean;
	id?: string;
	size?: number;
	data_base64?: string;
}

export interface AppendEntriesOptions {
	eventMetadata?: Record<string, unknown>;
	endEvent?: boolean;
}

export interface LumberJackForestMethods {
	onClose(fn: () => void): () => void;
	registerStreamBridge(): () => void;
	noteStoreEmittedEvent(key: string): void;
	consumeStoreEmittedEvent(key: string): boolean;
	exec<T>(op: string, payload?: unknown): T;
	upsertNode(input: UpsertNodeInput): NodeSnapshot;
	batchUpsertNodes(nodes: UpsertNodeInput[]): number;
	getNode(nodePath: string): NodeSnapshot | null;
	listChildren(parentPath: string): NodeSnapshot[];
	deleteNode(nodePath: string): boolean;
	setEntries(path: string, eventId: string, entries: EntryWire[], eventMetadata?: Record<string, unknown>): number;
	appendEntries(path: string, eventId: string, entries: EntryWire[], opts?: AppendEntriesOptions): number;
	getEntries(path: string, eventId: string): EntryWire[];
	listEvents(path: string): EventSnapshot[];
	deleteEvent(path: string, eventId: string): boolean;
	eventStart(path: string, eventId: string, metadata?: Record<string, unknown>): string;
	eventAppend(path: string, eventId: string, content: string, metadata?: Record<string, unknown>): string;
	eventEnd(path: string, eventId: string): string;
	eventEntries(path: string, eventId: string): string;
	getRootSlot<T>(): T | null;
	setRootSlot(data: unknown): void;
	putObject(name: string, mimeType: string, dataBase64: string): StoredObjectReceipt;
	getObject(id: string): StoredObjectData;
	pollStream(after: bigint, epoch?: bigint, timeoutMs?: number): { status: number; yaml: string };
	close(): void;
}

const DEFAULT_PERSIST_ROOT = process.env.PEER_PERSIST_ROOT ?? "/usr/lib/persist/peer";
export const DEFAULT_ADDON_PATH = path.join(DEFAULT_PERSIST_ROOT, "build", "lumberjack", "lumberjack_peer.node");

let cachedAddon: RawLumberJackAddon | null = null;

export function loadLumberJackAddon(addonPath = DEFAULT_ADDON_PATH): RawLumberJackAddon {
	if (cachedAddon && addonPath === DEFAULT_ADDON_PATH) return cachedAddon;
	const req = createRequire(import.meta.url);
	const loaded = req(/* turbopackIgnore: true */ addonPath) as RawLumberJackAddon;
	if (loaded.abiVersion() !== 2) throw new Error(`Unexpected LumberJack ABI version: ${loaded.abiVersion()}`);
	if (addonPath === DEFAULT_ADDON_PATH) cachedAddon = loaded;
	return loaded;
}

function writeTieredConfigIfAbsent(forestDir: string): void {
	const cfgPath = path.join(forestDir, "config.yaml");
	if (fs.existsSync(cfgPath)) return;
	const yaml = [
		"persistence:",
		"  mode: tiered",
		"  hot_sync: commit",
		"  cold_every_commits: 2000",
		"  cold_every_seconds: 60",
		"",
	].join("\n");
	fs.writeFileSync(cfgPath, yaml, { mode: 0o600 });
}

interface ForestOpenOptions {
	name?: string;
	principal?: string;
	addon?: RawLumberJackAddon;
}

interface InternalForestState {
	readonly directory: string;
	readonly name: string;
	readonly addon: RawLumberJackAddon;
	readonly handle: bigint;
	readonly objects: LumberJackObjectsClient;
	readonly closeListeners: Set<() => void>;
	readonly suppressedStreamEvents: Set<string>;
	streamBridgeCount: number;
	rootSlotCache: { valid: boolean; value: unknown };
	closed: boolean;
}

function activeHandleOf(st: InternalForestState): bigint {
	if (!st.closed) return st.handle;
	const err = new Error("LumberJack forest handle is closed") as Error & { ljStatus?: number };
	err.ljStatus = LJ_STATUS.BAD_HANDLE;
	throw err;
}

function createForestState(directory: string, opts?: ForestOpenOptions): InternalForestState {
	const resolvedDir = path.resolve(directory);
	fs.mkdirSync(resolvedDir, { recursive: true, mode: 0o700 });
	writeTieredConfigIfAbsent(resolvedDir);
	const name = opts?.name ?? "state";
	const addon = opts?.addon ?? loadLumberJackAddon();
	const principal = opts?.principal ?? "system";
	const openYaml = [
		"organization: peer",
		`database_path: ${JSON.stringify(resolvedDir)}`,
		`name: ${JSON.stringify(name)}`,
		`principal: ${JSON.stringify(principal)}`,
		"",
	].join("\n");
	const handle = addon.open(openYaml);
	const st: InternalForestState = {
		directory: resolvedDir,
		name,
		addon,
		handle,
		objects: null as unknown as LumberJackObjectsClient,
		closeListeners: new Set(),
		suppressedStreamEvents: new Set(),
		streamBridgeCount: 0,
		rootSlotCache: { valid: false, value: null },
		closed: false,
	};
	(st as { objects: LumberJackObjectsClient }).objects = createLumberJackObjectsClient(addon, resolvedDir, () =>
		activeHandleOf(st),
	);
	return st;
}

function registerBridge(st: InternalForestState): () => void {
	st.streamBridgeCount++;
	let active = true;
	return () => {
		if (!active) return;
		active = false;
		st.streamBridgeCount = Math.max(0, st.streamBridgeCount - 1);
		if (st.streamBridgeCount === 0) st.suppressedStreamEvents.clear();
	};
}

function closeForestState(st: InternalForestState): void {
	if (st.closed) return;
	st.closed = true;
	st.rootSlotCache = { valid: false, value: null };
	for (const fn of [...st.closeListeners]) {
		try {
			fn();
		} catch {
			/* ignore close listener errors */
		}
	}
	st.closeListeners.clear();
	st.addon.close(st.handle);
}

function buildNodeMethods(
	self: LumberJackForest,
	st: InternalForestState,
): Pick<
	LumberJackForestMethods,
	"exec" | "upsertNode" | "batchUpsertNodes" | "getNode" | "listChildren" | "deleteNode" | "getRootSlot" | "setRootSlot"
> {
	return {
		exec: <T>(op: string, payload: unknown = {}) =>
			JSON.parse(st.addon.peerExec(activeHandleOf(st), JSON.stringify({ op, payload }))) as T,
		upsertNode: (input) => self.exec<NodeSnapshot>("upsert_node", input),
		batchUpsertNodes: (nodes) => self.exec<{ count: number }>("batch_upsert_nodes", { nodes }).count,
		getNode: (nodePath) => {
			const res = self.exec<{ found: boolean; node?: NodeSnapshot }>("get_node", { path: nodePath });
			return res.found && res.node ? res.node : null;
		},
		listChildren: (parentPath) => self.exec<{ nodes: NodeSnapshot[] }>("list_children", { path: parentPath }).nodes,
		deleteNode: (nodePath) => self.exec<{ deleted: boolean }>("delete_node", { path: nodePath }).deleted,
		getRootSlot: <T>() => {
			if (st.rootSlotCache.valid) return (st.rootSlotCache.value as T | null) ?? null;
			const loaded = self.exec<{ data: T | null }>("get_root_slot", {}).data ?? null;
			st.rootSlotCache = { valid: true, value: loaded };
			return loaded;
		},
		setRootSlot: (data) => {
			self.exec("set_root_slot", { data });
			st.rootSlotCache = { valid: true, value: structuredClone(data) };
		},
	};
}

function buildLifecycleAndObjectMethods(
	st: InternalForestState,
): Pick<
	LumberJackForestMethods,
	| "onClose"
	| "registerStreamBridge"
	| "noteStoreEmittedEvent"
	| "consumeStoreEmittedEvent"
	| "putObject"
	| "getObject"
	| "pollStream"
	| "close"
> {
	return {
		onClose: (fn) => {
			st.closeListeners.add(fn);
			return () => { st.closeListeners.delete(fn); };
		},
		registerStreamBridge: () => registerBridge(st),
		noteStoreEmittedEvent: (key) => {
			if (st.streamBridgeCount > 0) st.suppressedStreamEvents.add(key);
		},
		consumeStoreEmittedEvent: (key) => {
			if (!st.suppressedStreamEvents.has(key)) return false;
			st.suppressedStreamEvents.delete(key);
			return true;
		},
		putObject: (name, mime, b64) => st.objects.putObject(name, mime, b64),
		getObject: (id) => st.objects.getObject(id),
		pollStream: (after, epoch = 0n, timeoutMs = 0) => {
			const lines = [`after: ${after.toString()}`, `timeout_ms: ${timeoutMs}`];
			if (epoch > 0n) lines.push(`epoch: ${epoch.toString()}`);
			return st.addon.streamPoll(activeHandleOf(st), `${lines.join("\n")}\n`);
		},
		close: () => closeForestState(st),
	};
}

function buildEventMethods(
	self: LumberJackForest,
	st: InternalForestState,
): Pick<
	LumberJackForestMethods,
	| "setEntries"
	| "appendEntries"
	| "getEntries"
	| "listEvents"
	| "deleteEvent"
	| "eventStart"
	| "eventAppend"
	| "eventEnd"
	| "eventEntries"
> {
	return {
		setEntries: (nodePath, eventId, entries, eventMetadata) =>
			self.exec<{ count: number }>("set_entries", {
				path: nodePath,
				event_id: eventId,
				entries,
				...(eventMetadata ? { event_metadata: eventMetadata } : {}),
			}).count,
		appendEntries: (nodePath, eventId, entries, opts) =>
			self.exec<{ added: number }>("append_entries", {
				path: nodePath,
				event_id: eventId,
				entries,
				...(opts?.eventMetadata ? { event_metadata: opts.eventMetadata } : {}),
				...(opts?.endEvent ? { end_event: true } : {}),
			}).added,
		getEntries: (nodePath, eventId) =>
			self.exec<{ entries: EntryWire[] }>("get_entries", { path: nodePath, event_id: eventId }).entries,
		listEvents: (nodePath) => self.exec<{ events: EventSnapshot[] }>("list_events", { path: nodePath }).events,
		deleteEvent: (nodePath, eventId) =>
			self.exec<{ deleted: boolean }>("delete_event", { path: nodePath, event_id: eventId }).deleted,
		eventStart: (nodePath, eventId, metadata) =>
			st.addon.eventStart(activeHandleOf(st), JSON.stringify({ path: nodePath, event_id: eventId, metadata })),
		eventAppend: (nodePath, eventId, content, metadata) =>
			st.addon.eventAppend(activeHandleOf(st), JSON.stringify({ path: nodePath, event_id: eventId, content, metadata })),
		eventEnd: (nodePath, eventId) =>
			st.addon.eventEnd(activeHandleOf(st), JSON.stringify({ path: nodePath, event_id: eventId })),
		eventEntries: (nodePath, eventId) =>
			st.addon.eventEntries(activeHandleOf(st), JSON.stringify({ path: nodePath, event_id: eventId })),
	};
}

export interface LumberJackForest extends LumberJackForestMethods {}

export class LumberJackForest {
	readonly directory: string;
	readonly name: string;
	private readonly s: InternalForestState;

	constructor(directory: string, opts?: ForestOpenOptions) {
		this.s = createForestState(directory, opts);
		this.directory = this.s.directory;
		this.name = this.s.name;
		Object.assign(
			this,
			buildNodeMethods(this, this.s),
			buildLifecycleAndObjectMethods(this.s),
			buildEventMethods(this, this.s),
		);
	}

	get isOpen(): boolean {
		return !this.s.closed;
	}

	get hasStreamBridge(): boolean {
		return this.s.streamBridgeCount > 0;
	}
}
