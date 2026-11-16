import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

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

export interface StoredObjectReceipt {
	id: string;
	sha256: string;
	size: number;
	mime_type: string;
	existed: boolean;
}

export interface StoredObjectData {
	found: boolean;
	id?: string;
	sha256?: string;
	name?: string;
	mime_type?: string;
	size?: number;
	data_base64?: string;
}

const DEFAULT_PERSIST_ROOT = process.env.PEER_PERSIST_ROOT ?? "/usr/lib/persist/peer";
const DEFAULT_ADDON_PATH = path.join(DEFAULT_PERSIST_ROOT, "build", "lumberjack", "lumberjack_peer.node");

let cachedAddon: RawLumberJackAddon | null = null;

export function loadLumberJackAddon(addonPath = DEFAULT_ADDON_PATH): RawLumberJackAddon {
	if (cachedAddon && addonPath === DEFAULT_ADDON_PATH) {
		return cachedAddon;
	}
	const req = createRequire(import.meta.url);
	const loaded = req(addonPath) as RawLumberJackAddon;
	if (loaded.abiVersion() !== 2) {
		throw new Error(`Unexpected LumberJack ABI version: ${loaded.abiVersion()}`);
	}
	if (addonPath === DEFAULT_ADDON_PATH) {
		cachedAddon = loaded;
	}
	return loaded;
}

function writeTieredConfigIfAbsent(forestDir: string): void {
	const cfgPath = path.join(forestDir, "config.yaml");
	if (fs.existsSync(cfgPath)) {
		return;
	}
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

export class LumberJackForest {
	readonly directory: string;
	readonly name: string;
	private readonly addon: RawLumberJackAddon;
	private handle: bigint;
	private closed = false;

	constructor(directory: string, opts?: { name?: string; principal?: string; addon?: RawLumberJackAddon }) {
		const resolvedDir = path.resolve(directory);
		fs.mkdirSync(resolvedDir, { recursive: true, mode: 0o700 });
		writeTieredConfigIfAbsent(resolvedDir);
		this.directory = resolvedDir;
		this.name = opts?.name ?? "state";
		this.addon = opts?.addon ?? loadLumberJackAddon();
		const principal = opts?.principal ?? "peer-system";
		const openYaml = [
			"organization: peer",
			`database_path: ${JSON.stringify(resolvedDir)}`,
			`name: ${JSON.stringify(this.name)}`,
			`principal: ${JSON.stringify(principal)}`,
			"",
		].join("\n");
		this.handle = this.addon.open(openYaml);
	}

	get isOpen(): boolean {
		return !this.closed;
	}

	private activeHandle(): bigint {
		if (this.closed) {
			const err = new Error("LumberJack forest handle is closed") as Error & { ljStatus?: number };
			err.ljStatus = LJ_STATUS.BAD_HANDLE;
			throw err;
		}
		return this.handle;
	}

	exec<T>(op: string, payload: unknown = {}): T {
		const raw = this.addon.peerExec(this.activeHandle(), JSON.stringify({ op, payload }));
		return JSON.parse(raw) as T;
	}

	upsertNode(input: UpsertNodeInput): NodeSnapshot {
		return this.exec<NodeSnapshot>("upsert_node", input);
	}

	batchUpsertNodes(nodes: UpsertNodeInput[]): number {
		return this.exec<{ count: number }>("batch_upsert_nodes", { nodes }).count;
	}

	getNode(nodePath: string): NodeSnapshot | null {
		const res = this.exec<{ found: boolean; node?: NodeSnapshot }>("get_node", { path: nodePath });
		return res.found && res.node ? res.node : null;
	}

	listChildren(parentPath: string): NodeSnapshot[] {
		return this.exec<{ nodes: NodeSnapshot[] }>("list_children", { path: parentPath }).nodes;
	}

	deleteNode(nodePath: string): boolean {
		return this.exec<{ deleted: boolean }>("delete_node", { path: nodePath }).deleted;
	}

	setEntries(nodePath: string, eventId: string, entries: EntryWire[]): number {
		return this.exec<{ count: number }>("set_entries", { path: nodePath, event_id: eventId, entries }).count;
	}

	getEntries(nodePath: string, eventId: string): EntryWire[] {
		return this.exec<{ entries: EntryWire[] }>("get_entries", { path: nodePath, event_id: eventId }).entries;
	}

	getRootSlot<T>(): T | null {
		const res = this.exec<{ data: T | null }>("get_root_slot", {});
		return res.data ?? null;
	}

	setRootSlot(data: unknown): void {
		this.exec("set_root_slot", { data });
	}

	putObject(name: string, mimeType: string, dataBase64: string): StoredObjectReceipt {
		return this.exec<StoredObjectReceipt>("put_object", { name, mime_type: mimeType, data_base64: dataBase64 });
	}

	getObject(id: string): StoredObjectData {
		return this.exec<StoredObjectData>("get_object", { id });
	}

	pollStream(after: bigint, epoch = 0n, timeoutMs = 0): { status: number; yaml: string } {
		const lines = [`after: ${after.toString()}`, `timeout_ms: ${timeoutMs}`];
		if (epoch > 0n) {
			lines.push(`epoch: ${epoch.toString()}`);
		}
		return this.addon.streamPoll(this.activeHandle(), `${lines.join("\n")}\n`);
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.addon.close(this.handle);
	}
}
