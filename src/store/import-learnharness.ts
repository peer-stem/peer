import fs from "node:fs";
import path from "node:path";
import type {
	ChatRecord, CoverageEntry, GraphChain, GraphNode, Position, SessionCheckpoint,
} from "../core/contracts.ts";
import { isValidSegmentPath } from "../core/prompt-segments.ts";
import { isBuiltinThemeId, isThemeId, sanitizeThemeFile } from "../core/themes.ts";
import {
	isCheckpoint, isCoverageEntry, isGraphChain, isGraphNode, isNotesSource, isPosition, isSafeEntityId,
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

type Report = LearnHarnessImportReport;
type Bundle = LumberJackStoreBundle;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function skipNull(report: Report): null {
	report.corruptFilesSkipped++;
	return null;
}

function tryRun(fn: () => void, report: Report): boolean {
	try {
		fn();
		return true;
	} catch {
		report.corruptFilesSkipped++;
		return false;
	}
}

function isSafeEntry(entry: fs.Dirent, report: Report): boolean {
	if (!entry.isSymbolicLink()) return true;
	report.corruptFilesSkipped++;
	return false;
}

function safeReaddir(dirPath: string, report: Report): fs.Dirent[] {
	try {
		return fs.readdirSync(dirPath, { withFileTypes: true });
	} catch {
		report.corruptFilesSkipped++;
		return [];
	}
}

function readRegularFileNoFollow(filePath: string, report: Report, optionalMissing = false): Buffer | null {
	let fd: number;
	try {
		fd = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
	} catch (err) {
		return optionalMissing && (err as NodeJS.ErrnoException).code === "ENOENT" ? null : skipNull(report);
	}
	try {
		return fs.fstatSync(fd).isFile() ? fs.readFileSync(fd) : skipNull(report);
	} catch {
		return skipNull(report);
	} finally {
		fs.closeSync(fd);
	}
}

function resolveSafePath(root: string, relParts: string[], expectDir: boolean, report: Report): string | null {
	let cur = root;
	for (let i = 0; i < relParts.length; i++) {
		cur = path.join(cur, relParts[i]!);
		let st: fs.Stats;
		try {
			st = fs.lstatSync(cur);
		} catch (err) {
			return (err as NodeJS.ErrnoException).code === "ENOENT" ? null : skipNull(report);
		}
		const isLast = i === relParts.length - 1;
		const validKind = isLast ? (expectDir ? st.isDirectory() : st.isFile()) : st.isDirectory();
		if (st.isSymbolicLink() || !validKind) return skipNull(report);
	}
	return cur;
}

function readJsonIfPresent(root: string, relParts: string[], report: Report): unknown {
	const safePath = resolveSafePath(root, relParts, false, report);
	if (!safePath) return undefined;
	const buf = readRegularFileNoFollow(safePath, report, true);
	if (!buf) return undefined;
	try {
		return JSON.parse(buf.toString("utf8"));
	} catch {
		report.corruptFilesSkipped++;
		return undefined;
	}
}

function readJsonlIfPresent<T>(root: string, relParts: string[], isValid: (v: unknown) => v is T, report: Report): T[] {
	const safePath = resolveSafePath(root, relParts, false, report);
	if (!safePath) return [];
	const buf = readRegularFileNoFollow(safePath, report, true);
	if (!buf) return [];
	const out: T[] = [];
	for (const rawLine of buf.toString("utf8").split(/\r?\n/)) {
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

function applyRecordIfPresent(raw: unknown, apply: (rec: Record<string, unknown>) => void, report: Report): boolean {
	if (raw === undefined) return false;
	if (!isRecord(raw)) {
		report.corruptFilesSkipped++;
		return false;
	}
	return tryRun(() => apply(raw), report);
}

function importOneThemeFile(root: string, entry: fs.Dirent, stores: Bundle, report: Report): void {
	if (!isSafeEntry(entry, report) || !entry.name.endsWith(".json")) return;
	const id = entry.name.slice(0, -5);
	if (!isThemeId(id) || isBuiltinThemeId(id)) return;
	const raw = readJsonIfPresent(root, ["themes", entry.name], report);
	if (raw === undefined) return;
	const parsed = sanitizeThemeFile(raw);
	if (!parsed) {
		report.corruptFilesSkipped++;
		return;
	}
	if (tryRun(() => stores.themeStore.writeTheme(id, parsed), report)) report.themesImported++;
}

function importConfigAndThemes(root: string, stores: Bundle, report: Report): void {
	const rawSettings = readJsonIfPresent(root, ["settings.json"], report);
	if (applyRecordIfPresent(rawSettings, (rec) => stores.settingsStore.writeSettings(rec as never), report)) {
		report.settingsImported = true;
	}
	const themesDir = resolveSafePath(root, ["themes"], true, report);
	if (!themesDir) return;
	for (const entry of safeReaddir(themesDir, report)) importOneThemeFile(root, entry, stores, report);
}

function walkPromptFiles(root: string, relParts: string[], out: Array<[string, string]>, report: Report): void {
	const safeDir = resolveSafePath(root, relParts, true, report);
	if (!safeDir) return;
	for (const entry of safeReaddir(safeDir, report)) {
		if (!isSafeEntry(entry, report)) continue;
		const childParts = [...relParts, entry.name];
		const relSeg = childParts.slice(1).join("/");
		if (entry.isDirectory()) {
			walkPromptFiles(root, childParts, out, report);
		} else if (entry.isFile() && entry.name.endsWith(".md") && isValidSegmentPath(relSeg)) {
			const buf = readRegularFileNoFollow(path.join(safeDir, entry.name), report);
			if (buf) out.push([relSeg, buf.toString("utf8")]);
		}
	}
}

function importPrompts(root: string, stores: Bundle, report: Report): void {
	const found: Array<[string, string]> = [];
	walkPromptFiles(root, ["prompts"], found, report);
	for (const [segPath, text] of found) {
		if (tryRun(() => stores.promptOverrides.writeOverride(segPath, text), report)) report.promptsImported++;
	}
}

function extractPositionCandidate(rawPos: unknown): Record<string, unknown> | null {
	if (!isRecord(rawPos)) return null;
	if (!("positions" in rawPos)) return rawPos;
	return isRecord(rawPos.positions) ? rawPos.positions : null;
}

function importPositionsFile(root: string, stores: Bundle, report: Report): void {
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
		if (nodeId === "positions" || nodeId === "updatedAt") continue;
		if (!isSafeEntityId(nodeId)) {
			report.corruptFilesSkipped++;
			continue;
		}
		if (!isPosition(val)) continue;
		validPos[nodeId] = { x: val.x, y: val.y };
		count++;
	}
	stores.graphStore.writePositions({ ...stores.graphStore.readPositions(), ...validPos });
	report.positionsImported = count;
}

function importGraphLedgersAndPositions(root: string, stores: Bundle, report: Report): void {
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

function upsertSourceEntry(item: unknown, stores: Bundle, report: Report): void {
	if (!isNotesSource(item)) {
		report.corruptFilesSkipped++;
		return;
	}
	if (tryRun(() => stores.graphStore.upsertSource(item), report)) report.sourcesImported++;
}

function importSourcesAndGraph(root: string, stores: Bundle, report: Report): void {
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
	applyRecordIfPresent(rawOrg, (rec) => stores.sourceOrganizationStore.write(rec as never), report);
	importGraphLedgersAndPositions(root, stores, report);
}

function importOneChatFile(root: string, entry: fs.Dirent, stores: Bundle, report: Report): void {
	if (!isSafeEntry(entry, report) || !entry.name.endsWith(".json")) return;
	const raw = readJsonIfPresent(root, ["chats", entry.name], report);
	if (raw === undefined) return;
	if (!isRecord(raw) || typeof raw.id !== "string" || !Array.isArray(raw.messages)) {
		report.corruptFilesSkipped++;
		return;
	}
	tryRun(() => {
		const res = stores.chatStore.importChatRecord(raw as unknown as ChatRecord);
		if (!res.imported) {
			report.corruptFilesSkipped++;
			return;
		}
		report.chatsImported++;
		report.objectsStored += res.objectsStored;
		report.objectsDeduplicated += res.objectsDeduplicated;
	}, report);
}

function importOneLooseImage(imagesDir: string, entry: fs.Dirent, stores: Bundle, report: Report): void {
	if (!isSafeEntry(entry, report) || !entry.isFile()) return;
	const buf = readRegularFileNoFollow(path.join(imagesDir, entry.name), report);
	if (!buf) return;
	tryRun(() => {
		const mime = entry.name.endsWith(".jpg") || entry.name.endsWith(".jpeg") ? "image/jpeg" : "image/png";
		const receipt = stores.forest.putObject(entry.name, mime, buf.toString("base64"));
		if (receipt.existed) report.objectsDeduplicated++;
		else report.objectsStored++;
	}, report);
}

function importChatsAndLooseImages(root: string, stores: Bundle, report: Report): void {
	const chatsDir = resolveSafePath(root, ["chats"], true, report);
	if (chatsDir) {
		for (const entry of safeReaddir(chatsDir, report)) importOneChatFile(root, entry, stores, report);
	}
	const imagesDir = resolveSafePath(root, ["images"], true, report);
	if (!imagesDir) return;
	for (const entry of safeReaddir(imagesDir, report)) importOneLooseImage(imagesDir, entry, stores, report);
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

type RawDeck = { id?: string; name?: string; propositionIds?: string[] };
type PropMap = Record<string, RawFlashcardProp>;
type FsrsOpt = FsrsCardSchedule | undefined;

interface RawFlashcardsFile {
	decks?: RawDeck[];
	propositions?: PropMap;
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

function shouldKeepExistingFsrs(existing: FsrsOpt, incoming: FsrsCardSchedule): boolean {
	if (!existing) return false;
	if (typeof existing.reps === "number" && typeof incoming.reps === "number" && existing.reps > incoming.reps) {
		return true;
	}
	const existMs = parseReviewTimestamp(existing.last_review);
	const incMs = parseReviewTimestamp(incoming.last_review);
	return existMs !== null && (incMs === null || existMs > incMs);
}

function resolveImportedFsrs(pid: string, incoming: FsrsOpt, stores: Bundle): FsrsOpt {
	const existing = stores.learnerStore.readPropositionProgress(pid)?.fsrs;
	if (!incoming || shouldKeepExistingFsrs(existing, incoming)) return existing;
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

function buildCardsForDeck(propIds: string[], propositions: PropMap, stores: Bundle): FlashcardDeckRecord["cards"] {
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

function preserveFlashcardReviews(reviews: unknown[], stores: Bundle): void {
	const slot = stores.forest.getNode("learner/flashcard-reviews")?.slot;
	const prev = Array.isArray(slot) ? slot : isRecord(slot) && Array.isArray(slot.reviews) ? slot.reviews : [];
	const keyOf = (r: unknown) => (isRecord(r) && typeof r.id === "string" ? r.id : JSON.stringify(r));
	const { merged } = dedupeByKey(prev, reviews, keyOf);
	stores.forest.upsertNode({
		path: "learner/flashcard-reviews",
		type: "leaf",
		kind: "flashcard_reviews",
		metadata: { count: merged.length },
		slot: { reviews: merged },
	});
}

function upsertImportedDeck(stores: Bundle, deck: RawDeck, props: PropMap, report: Report): void {
	if (!isSafeEntityId(deck?.id) || typeof deck.name !== "string" || !deck.name) {
		report.corruptFilesSkipped++;
		return;
	}
	const rawPropIds = Array.isArray(deck.propositionIds) ? deck.propositionIds : [];
	const propIds = rawPropIds.filter(isSafeEntityId);
	report.corruptFilesSkipped += rawPropIds.length - propIds.length;
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

function importFlashcards(root: string, stores: Bundle, report: Report): void {
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
		const props: PropMap = isRecord(typed.propositions) ? (typed.propositions as PropMap) : {};
		tryRun(() => {
			if (Array.isArray(typed.reviews)) preserveFlashcardReviews(typed.reviews, stores);
			for (const deck of typed.decks ?? []) upsertImportedDeck(stores, deck, props, report);
		}, report);
	}
}

export function importLearnHarnessData(sourceDir: string, stores: Bundle): Report {
	const resolved = path.resolve(sourceDir);
	const st = fs.lstatSync(resolved);
	if (st.isSymbolicLink() || !st.isDirectory()) {
		throw new Error(`LearnHarness import source must be a non-symlink directory: ${resolved}`);
	}
	const report: Report = {
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
