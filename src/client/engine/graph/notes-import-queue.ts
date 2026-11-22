/** One import request: file bytes plus a bounded allowance for multipart metadata. */
export const MAX_IMPORT_BYTES = 25 * 1024 * 1024;
export const MAX_IMPORT_BODY_BYTES = 26 * 1024 * 1024;

const IMPORT_EXTENSION_NAMES = ["txt", "md", "markdown", "rst", "org", "adoc", "tex", "pdf"];
export const IMPORT_EXTENSIONS = new RegExp(`\\.(?:${IMPORT_EXTENSION_NAMES.join("|")})$`, "i");
export const IMPORT_ACCEPT = IMPORT_EXTENSION_NAMES.map((name) => `.${name}`).join(",");
export const UNSUPPORTED_TYPE_MESSAGE = "This file type isn't supported. Use text, Markdown, or PDF.";

/** Contributor's relative-path contract: identity only, never a disk path. */
export function validNotesPath(path: string, filename: string): boolean {
	const parts = path.split("/");
	return path.length > 0 && path.length <= 1024 && !/[\\:\x00-\x1f\x7f]/.test(path)
		&& parts.every((part) => part.length > 0 && part !== "." && part !== "..")
		&& (parts.at(-1) === filename || path === filename);
}

export interface NotesImportResult {
	requestIndex: number;
	filePath: string;
	ok: boolean;
	outcome: "completed" | "failed" | "partial" | "aborted" | "busy";
	stats?: { nodes: number; chains?: number; droppedChains?: number };
	error?: string;
	code?: string;
	missing?: string[];
	provider?: string;
	slots?: string[];
	notice?: string;
}

export const notesPath = (file: File): string => file.webkitRelativePath || file.name;

const hiddenInFolder = (file: File): boolean =>
	file.webkitRelativePath.split("/").slice(1).some((part) => part.startsWith("."));

const extensionLabel = (name: string): string => {
	const dot = name.lastIndexOf(".");
	return dot > 0 && dot < name.length - 1 ? name.slice(dot).toLowerCase() : "no extension";
};

const unsupportedSummary = (extensions: readonly string[]): string =>
	`Skipped ${extensions.length} ${extensions.length === 1 ? "file that isn't" : "files that aren't"} text, Markdown, or PDF (${[...new Set(extensions)].join(", ")}).`;

const unsafeSummary = (count: number): string =>
	`Skipped ${count} ${count === 1 ? "file with a name" : "files with names"} the import can't use (e.g. a ':' in the name).`;

export interface ImportQueueSnapshot {
	importing: boolean;
	errors: string[];
	notices: string[];
	completion: number;
}

export const EMPTY_IMPORT_QUEUE: ImportQueueSnapshot = { importing: false, errors: [], notices: [], completion: 0 };

interface QueueState {
	readonly listeners: Set<() => void>;
	readonly pending: { file: File; index: number }[];
	readonly failures: Map<number, string>;
	readonly notices: Map<number, string>;
	active: number;
	sequence: number;
	snapshot: ImportQueueSnapshot;
	readonly send: (file: File) => Promise<NotesImportResult[]>;
}

const orderedValues = (map: Map<number, string>): string[] =>
	[...map].sort(([a], [b]) => a - b).map(([, text]) => text);

function publishQueue(state: QueueState, completed = false): void {
	state.snapshot = {
		importing: state.active > 0 || state.pending.length > 0,
		errors: orderedValues(state.failures),
		notices: orderedValues(state.notices),
		completion: state.snapshot.completion + Number(completed),
	};
	for (const listener of [...state.listeners]) listener();
}

async function runSingleImport(state: QueueState, file: File, index: number): Promise<void> {
	try {
		const [r] = await state.send(file);
		if (!r) throw new Error("Invalid import response. Check the graph before retrying.");
		if (!r.ok) {
			const details = [r.provider, r.missing?.join(", "), r.slots?.join(", ")].filter(Boolean);
			const suffix = r.code ? `\n${[r.code, ...details].join(" — ")}` : "";
			state.failures.set(index, `${r.filePath}: ${r.error}${suffix}`);
		} else if (r.notice) {
			state.notices.set(index, `${r.filePath}: ${r.notice}`);
		}
	} catch (error) {
		state.failures.set(index, `${notesPath(file)}: ${error instanceof Error ? error.message : String(error)}`);
	} finally {
		state.active--;
		pumpQueue(state);
		publishQueue(state, state.active === 0 && state.pending.length === 0);
	}
}

function pumpQueue(state: QueueState): void {
	while (state.active < 3 && state.pending.length > 0) {
		const item = state.pending.shift()!;
		state.active++;
		void runSingleImport(state, item.file, item.index);
	}
}

function appendImportFiles(state: QueueState, files: readonly File[]): void {
	if (files.length === 0) return;
	if (!state.snapshot.importing) {
		state.failures.clear();
		state.notices.clear();
		state.sequence = 0;
	}
	const unsafe: number[] = [];
	const unsupported: { index: number; extension: string }[] = [];
	for (const file of files) {
		const index = state.sequence++;
		const path = notesPath(file);
		if (file.webkitRelativePath && hiddenInFolder(file)) continue;
		if (!validNotesPath(path, file.name)) unsafe.push(index);
		else if (!IMPORT_EXTENSIONS.test(file.name)) unsupported.push({ index, extension: extensionLabel(file.name) });
		else if (file.size > MAX_IMPORT_BYTES) state.failures.set(index, `${path}: Too big. Max 25 MB.`);
		else state.pending.push({ file, index });
	}
	if (unsafe.length > 0) state.failures.set(unsafe[0]!, unsafeSummary(unsafe.length));
	if (unsupported.length > 0) {
		state.failures.set(unsupported[0]!.index, unsupportedSummary(unsupported.map(({ extension }) => extension)));
	}
	const hadWork = state.active > 0 || state.pending.length > 0;
	pumpQueue(state);
	publishQueue(state, !hadWork);
}

/** Refill-on-completion, one-request-per-file transport, shared across picks. */
export function createNotesImportQueue(post: (files: readonly File[]) => Promise<NotesImportResult[]>) {
	// Normalize a synchronously throwing transport to the same async settlement.
	const send = async (file: File) => post([file]);
	const state: QueueState = {
		listeners: new Set(),
		pending: [],
		failures: new Map(),
		notices: new Map(),
		active: 0,
		sequence: 0,
		snapshot: EMPTY_IMPORT_QUEUE,
		send,
	};
	return {
		getSnapshot: () => state.snapshot,
		subscribe(listener: () => void) {
			state.listeners.add(listener);
			return () => { state.listeners.delete(listener); };
		},
		append(files: readonly File[]) {
			appendImportFiles(state, files);
		},
	};
}
