import fs from "node:fs";
import path from "node:path";
import type { ChatRecord, CoverageEntry, GraphChain, GraphNode, Position, SessionCheckpoint } from "../core/contracts.ts";
import { isValidSegmentPath } from "../core/prompt-segments.ts";
import { isBuiltinThemeId, isThemeId, sanitizeThemeFile } from "../core/themes.ts";
import {
	isCheckpoint,
	isCoverageEntry,
	isGraphChain,
	isGraphNode,
	isNotesSource,
	isPosition,
} from "./lumberjack/graph-store.ts";
import type { FlashcardDeckRecord, FsrsCardSchedule, LumberJackStoreBundle } from "./lumberjack/index.ts";

export interface LearnHarnessImportReport {
	sourceDirectory: string;
	settingsImported: boolean;
	themesImported: number;
	promptsImported: number;
	sourcesImported: number;
	nodesImported: number;
	chainsImported: number;
	positionsImported: number;
	chatsImported: number;
	objectsStored: number;
	objectsDeduplicated: number;
	flashcardDecksImported: number;
	flashcardCardsImported: number;
	corruptFilesSkipped: number;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function resolveSafePath(root: string, relParts: string[], expectDir: boolean, report: LearnHarnessImportReport): string | null {
	let cur = root;
	for (let i = 0; i < relParts.length; i++) {
		cur = path.join(cur, relParts[i]!);
		let st: fs.Stats;
		try {
			st = fs.lstatSync(cur);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
			report.corruptFilesSkipped++;
			return null;
		}
		const isLast = i === relParts.length - 1;
		const validKind = isLast ? (expectDir ? st.isDirectory() : st.isFile()) : st.isDirectory();
		if (st.isSymbolicLink() || !validKind) {
			report.corruptFilesSkipped++;
			return null;
		}
	}
	return cur;
}

function readJsonIfPresent(root: string, relParts: string[], report: LearnHarnessImportReport): unknown {
	const safePath = resolveSafePath(root, relParts, false, report);
	if (!safePath) return undefined;
	try {
		return JSON.parse(fs.readFileSync(safePath, "utf8"));
	} catch {
		report.corruptFilesSkipped++;
		return undefined;
	}
}

function readJsonlIfPresent<T>(
	root: string,
	relParts: string[],
	isValid: (v: unknown) => v is T,
	report: LearnHarnessImportReport,
): T[] {
	const safePath = resolveSafePath(root, relParts, false, report);
	if (!safePath) return [];
	let rawText: string;
	try {
		rawText = fs.readFileSync(safePath, "utf8");
	} catch {
		report.corruptFilesSkipped++;
		return [];
	}
	const out: T[] = [];
	for (const rawLine of rawText.split(/\r?\n/)) {
		const trimmed = rawLine.trim();
		if (!trimmed) continue;
		try {
			const parsed: unknown = JSON.parse(trimmed);
			if (isValid(parsed)) out.push(parsed);
			else report.corruptFilesSkipped++;
		} catch {
			report.corruptFilesSkipped++;
		}
	}
	return out;
}

function dedupeByKey<T>(existing: T[], incoming: T[], keyOf: (item: T) => string): { merged: T[]; added: number } {
	const seen = new Set(existing.map(keyOf));
	const merged = [...existing];
	let added = 0;
	for (const item of incoming) {
		const key = keyOf(item);
		if (seen.has(key)) continue;
		seen.add(key);
		merged.push(item);
		added++;
	}
	return { merged, added };
}

function importOneThemeFile(root: string, entry: fs.Dirent, stores: LumberJackStoreBundle, report: LearnHarnessImportReport): void {
	if (entry.isSymbolicLink()) {
		report.corruptFilesSkipped++;
		return;
	}
	if (!entry.name.endsWith(".json")) return;
	const id = entry.name.slice(0, -5);
	if (!isThemeId(id) || isBuiltinThemeId(id)) return;
	const raw = readJsonIfPresent(root, ["themes", entry.name], report);
	if (raw === undefined) return;
	const parsed = sanitizeThemeFile(raw);
	if (!parsed) {
		report.corruptFilesSkipped++;
		return;
	}
	try {
		stores.themeStore.writeTheme(id, parsed);
		report.themesImported++;
	} catch {
		report.corruptFilesSkipped++;
	}
}

function importConfigAndThemes(root: string, stores: LumberJackStoreBundle, report: LearnHarnessImportReport): void {
	const rawSettings = readJsonIfPresent(root, ["settings.json"], report);
	if (isRecord(rawSettings)) {
		try {
			stores.settingsStore.writeSettings(rawSettings as never);
			report.settingsImported = true;
		} catch {
			report.corruptFilesSkipped++;
		}
	} else if (rawSettings !== undefined) {
		report.corruptFilesSkipped++;
	}
	const themesDir = resolveSafePath(root, ["themes"], true, report);
	if (!themesDir) return;
	for (const entry of fs.readdirSync(themesDir, { withFileTypes: true })) {
		importOneThemeFile(root, entry, stores, report);
	}
}

function walkPromptFiles(root: string, relParts: string[], out: Array<[string, string]>, report: LearnHarnessImportReport): void {
	const safeDir = resolveSafePath(root, relParts, true, report);
	if (!safeDir) return;
	for (const entry of fs.readdirSync(safeDir, { withFileTypes: true })) {
		if (entry.isSymbolicLink()) {
			report.corruptFilesSkipped++;
			continue;
		}
		const childParts = [...relParts, entry.name];
		const relSeg = childParts.slice(1).join("/");
		if (entry.isDirectory()) {
			walkPromptFiles(root, childParts, out, report);
		} else if (entry.isFile() && entry.name.endsWith(".md") && isValidSegmentPath(relSeg)) {
			const safeFile = resolveSafePath(root, childParts, false, report);
			if (safeFile) out.push([relSeg, fs.readFileSync(safeFile, "utf8")]);
		}
	}
}

function importPrompts(root: string, stores: LumberJackStoreBundle, report: LearnHarnessImportReport): void {
	const found: Array<[string, string]> = [];
	walkPromptFiles(root, ["prompts"], found, report);
	for (const [segPath, text] of found) {
		try {
			stores.promptOverrides.writeOverride(segPath, text);
			report.promptsImported++;
		} catch {
			report.corruptFilesSkipped++;
		}
	}
}

function extractPositionCandidate(rawPos: unknown): Record<string, unknown> | null {
	if (!isRecord(rawPos)) return null;
	if (!("positions" in rawPos)) return rawPos;
	return isRecord(rawPos.positions) ? rawPos.positions : null;
}

function importPositionsFile(root: string, stores: LumberJackStoreBundle, report: LearnHarnessImportReport): void {
	const rawPos = readJsonIfPresent(root, ["graph", "positions.json"], report);
	if (rawPos === undefined) return;
	const candidate = extractPositionCandidate(rawPos);
	if (!candidate) {
		report.corruptFilesSkipped++;
		return;
	}
	const validPos: Record<string, Position> = {};
	let count = 0;
	for (const [nodeId, val] of Object.entries(candidate)) {
		if (nodeId === "positions" || nodeId === "updatedAt" || !isPosition(val)) continue;
		validPos[nodeId] = { x: val.x, y: val.y };
		count++;
	}
	stores.graphStore.writePositions({ ...stores.graphStore.readPositions(), ...validPos });
	report.positionsImported = count;
}

function importGraphLedgersAndPositions(root: string, stores: LumberJackStoreBundle, report: LearnHarnessImportReport): void {
	const inNodes = readJsonlIfPresent<GraphNode>(root, ["graph", "nodes.jsonl"], isGraphNode, report);
	const inChains = readJsonlIfPresent<GraphChain>(root, ["graph", "chains.jsonl"], isGraphChain, report);
	const inSessions = readJsonlIfPresent<SessionCheckpoint>(root, ["graph", "sessions.jsonl"], isCheckpoint, report);
	const inCoverage = readJsonlIfPresent<CoverageEntry>(root, ["graph", "coverage.jsonl"], isCoverageEntry, report);
	const nodesRes = dedupeByKey(stores.graphStore.readNodes(), inNodes, (n) => `${n.id}:${JSON.stringify(n)}`);
	const chainsRes = dedupeByKey(stores.graphStore.readChains(), inChains, (c) => `${c.id}:${JSON.stringify(c)}`);
	const sessRes = dedupeByKey(stores.graphStore.readCheckpoints(), inSessions, (s) => `${s.chatId}:${s.foldedAt}`);
	const covRes = dedupeByKey(stores.graphStore.readCoverage(), inCoverage, (c) => `${c.chatId}:${c.fp}`);
	stores.graphStore.rewriteLedgers({
		nodes: nodesRes.merged,
		chains: chainsRes.merged,
		checkpoints: sessRes.merged,
		coverage: covRes.merged,
	});
	report.nodesImported = nodesRes.added;
	report.chainsImported = chainsRes.added;
	importPositionsFile(root, stores, report);
}

function upsertSourceEntry(item: unknown, stores: LumberJackStoreBundle, report: LearnHarnessImportReport): void {
	if (!isNotesSource(item)) {
		report.corruptFilesSkipped++;
		return;
	}
	try {
		stores.graphStore.upsertSource(item);
		report.sourcesImported++;
	} catch {
		report.corruptFilesSkipped++;
	}
}

function importSourcesAndGraph(root: string, stores: LumberJackStoreBundle, report: LearnHarnessImportReport): void {
	const rawSources = readJsonIfPresent(root, ["graph", "sources.json"], report);
	if (rawSources !== undefined) {
		if (typeof rawSources === "object" && rawSources !== null) {
			const entries = Array.isArray(rawSources) ? rawSources : Object.values(rawSources);
			for (const item of entries) upsertSourceEntry(item, stores, report);
		} else {
			report.corruptFilesSkipped++;
		}
	}
	const rawOrg = readJsonIfPresent(root, ["graph", "source-organization.json"], report);
	if (isRecord(rawOrg)) {
		try {
			stores.sourceOrganizationStore.write(rawOrg as never);
		} catch {
			report.corruptFilesSkipped++;
		}
	} else if (rawOrg !== undefined) {
		report.corruptFilesSkipped++;
	}
	importGraphLedgersAndPositions(root, stores, report);
}

function importOneChatFile(root: string, entry: fs.Dirent, stores: LumberJackStoreBundle, report: LearnHarnessImportReport): void {
	if (entry.isSymbolicLink()) {
		report.corruptFilesSkipped++;
		return;
	}
	if (!entry.name.endsWith(".json")) return;
	const raw = readJsonIfPresent(root, ["chats", entry.name], report);
	if (raw === undefined) return;
	if (!isRecord(raw) || typeof raw.id !== "string" || !Array.isArray(raw.messages)) {
		report.corruptFilesSkipped++;
		return;
	}
	try {
		const res = stores.chatStore.importChatRecord(raw as unknown as ChatRecord);
		if (!res.imported) {
			report.corruptFilesSkipped++;
			return;
		}
		report.chatsImported++;
		report.objectsStored += res.objectsStored;
		report.objectsDeduplicated += res.objectsDeduplicated;
	} catch {
		report.corruptFilesSkipped++;
	}
}

function importOneLooseImage(root: string, entry: fs.Dirent, stores: LumberJackStoreBundle, report: LearnHarnessImportReport): void {
	if (entry.isSymbolicLink()) {
		report.corruptFilesSkipped++;
		return;
	}
	if (!entry.isFile()) return;
	const safeFile = resolveSafePath(root, ["images", entry.name], false, report);
	if (!safeFile) return;
	try {
		const mime = entry.name.endsWith(".jpg") || entry.name.endsWith(".jpeg") ? "image/jpeg" : "image/png";
		const receipt = stores.forest.putObject(entry.name, mime, fs.readFileSync(safeFile).toString("base64"));
		if (receipt.existed) report.objectsDeduplicated++;
		else report.objectsStored++;
	} catch {
		report.corruptFilesSkipped++;
	}
}

function importChatsAndLooseImages(root: string, stores: LumberJackStoreBundle, report: LearnHarnessImportReport): void {
	const chatsDir = resolveSafePath(root, ["chats"], true, report);
	if (chatsDir) {
		for (const entry of fs.readdirSync(chatsDir, { withFileTypes: true })) {
			importOneChatFile(root, entry, stores, report);
		}
	}
	const imagesDir = resolveSafePath(root, ["images"], true, report);
	if (!imagesDir) return;
	for (const entry of fs.readdirSync(imagesDir, { withFileTypes: true })) {
		importOneLooseImage(root, entry, stores, report);
	}
}

interface RawFlashcardCue {
	id?: string;
	question?: string;
	front?: string;
	answer?: string;
	back?: string;
	deleted?: boolean;
	schedule?: FsrsCardSchedule;
}

interface RawFlashcardProp {
	id?: string;
	schedule?: FsrsCardSchedule;
	fsrs?: FsrsCardSchedule;
	cues?: RawFlashcardCue[];
}

interface RawFlashcardsFile {
	decks?: Array<{ id?: string; name?: string; propositionIds?: string[] }>;
	propositions?: Record<string, RawFlashcardProp>;
	reviews?: unknown[];
}

function parseReviewTimestamp(val: number | string | null | undefined): number | null {
	if (typeof val === "number" && Number.isFinite(val)) return val;
	if (typeof val === "string") {
		const parsed = Date.parse(val);
		return Number.isFinite(parsed) ? parsed : null;
	}
	return null;
}

function shouldKeepExistingFsrs(existing: FsrsCardSchedule | undefined, incoming: FsrsCardSchedule): boolean {
	if (!existing) return false;
	if (typeof existing.reps === "number" && typeof incoming.reps === "number" && existing.reps > incoming.reps) {
		return true;
	}
	const existMs = parseReviewTimestamp(existing.last_review);
	const incMs = parseReviewTimestamp(incoming.last_review);
	return existMs !== null && (incMs === null || existMs > incMs);
}

function resolveImportedFsrs(pid: string, incoming: FsrsCardSchedule | undefined, stores: LumberJackStoreBundle): FsrsCardSchedule | undefined {
	const existing = stores.learnerStore.readPropositionProgress(pid)?.fsrs;
	if (!incoming) return existing;
	if (shouldKeepExistingFsrs(existing, incoming)) return existing;
	stores.learnerStore.updatePropositionProgress(pid, { fsrs: incoming });
	return incoming;
}

function makeCueCard(pid: string, cue: RawFlashcardCue, idx: number, sched?: FsrsCardSchedule) {
	return {
		id: cue.id ?? `${pid}_cue_${idx}`,
		front: cue.question ?? cue.front ?? "",
		back: cue.answer ?? cue.back ?? "",
		propositionId: pid,
		...(sched ? { fsrs: sched } : {}),
	};
}

function buildCardsForDeck(
	propIds: string[],
	propositions: Record<string, RawFlashcardProp>,
	stores: LumberJackStoreBundle,
): FlashcardDeckRecord["cards"] {
	const cards: FlashcardDeckRecord["cards"] = [];
	for (const pid of propIds) {
		const prop = propositions[pid];
		if (!prop) continue;
		const propSched = resolveImportedFsrs(pid, prop.schedule ?? prop.fsrs, stores);
		for (const cue of prop.cues ?? []) {
			if (cue.deleted) continue;
			const sched = cue.schedule ? resolveImportedFsrs(pid, cue.schedule, stores) : propSched;
			cards.push(makeCueCard(pid, cue, cards.length, sched));
		}
	}
	return cards;
}

function preserveFlashcardReviews(reviews: unknown[], stores: LumberJackStoreBundle): void {
	const existingSlot = stores.forest.getNode("learner/flashcard-reviews")?.slot;
	const prev = Array.isArray(existingSlot)
		? existingSlot
		: isRecord(existingSlot) && Array.isArray(existingSlot.reviews)
			? existingSlot.reviews
			: [];
	const { merged } = dedupeByKey(prev, reviews, (r) =>
		isRecord(r) && typeof r.id === "string" ? r.id : JSON.stringify(r),
	);
	stores.forest.upsertNode({
		path: "learner/flashcard-reviews",
		type: "leaf",
		kind: "flashcard_reviews",
		metadata: { count: merged.length },
		slot: { reviews: merged },
	});
}

function upsertImportedDeck(
	stores: LumberJackStoreBundle,
	deck: { id?: string; name?: string; propositionIds?: string[] },
	props: Record<string, RawFlashcardProp>,
	report: LearnHarnessImportReport,
): void {
	if (!deck.id || !deck.name) return;
	const propIds = Array.isArray(deck.propositionIds) ? deck.propositionIds : [];
	const cards = buildCardsForDeck(propIds, props, stores);
	stores.learnerStore.upsertDeck({
		id: deck.id,
		name: deck.name,
		propositionIds: propIds,
		cards,
		updatedAt: new Date().toISOString(),
	});
	report.flashcardDecksImported++;
	report.flashcardCardsImported += cards.length;
}

function importFlashcards(root: string, stores: LumberJackStoreBundle, report: LearnHarnessImportReport): void {
	const candidates: string[][] = [
		["core-plugin-data", "flashcards", "flashcards.json"],
		["plugins", "flashcards", "data", "flashcards.json"],
		["flashcards", "flashcards.json"],
	];
	for (const relParts of candidates) {
		const raw = readJsonIfPresent(root, relParts, report);
		if (raw === undefined) continue;
		if (!isRecord(raw) || !Array.isArray(raw.decks)) {
			report.corruptFilesSkipped++;
			continue;
		}
		const typed = raw as unknown as RawFlashcardsFile;
		const props = isRecord(typed.propositions) ? (typed.propositions as Record<string, RawFlashcardProp>) : {};
		try {
			if (Array.isArray(typed.reviews)) preserveFlashcardReviews(typed.reviews, stores);
			for (const deck of typed.decks ?? []) upsertImportedDeck(stores, deck, props, report);
		} catch {
			report.corruptFilesSkipped++;
		}
	}
}

export function importLearnHarnessData(sourceDir: string, stores: LumberJackStoreBundle): LearnHarnessImportReport {
	const resolved = path.resolve(sourceDir);
	const st = fs.lstatSync(resolved);
	if (st.isSymbolicLink() || !st.isDirectory()) {
		throw new Error(`LearnHarness import source must be a non-symlink directory: ${resolved}`);
	}
	const report: LearnHarnessImportReport = {
		sourceDirectory: resolved,
		settingsImported: false,
		themesImported: 0,
		promptsImported: 0,
		sourcesImported: 0,
		nodesImported: 0,
		chainsImported: 0,
		positionsImported: 0,
		chatsImported: 0,
		objectsStored: 0,
		objectsDeduplicated: 0,
		flashcardDecksImported: 0,
		flashcardCardsImported: 0,
		corruptFilesSkipped: 0,
	};
	importConfigAndThemes(resolved, stores, report);
	importPrompts(resolved, stores, report);
	importSourcesAndGraph(resolved, stores, report);
	importChatsAndLooseImages(resolved, stores, report);
	importFlashcards(resolved, stores, report);
	return report;
}
