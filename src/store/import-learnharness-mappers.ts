import type fs from "node:fs";
import path from "node:path";
import type { Position } from "../core/contracts.ts";
import { isValidSegmentPath } from "../core/prompt-segments.ts";
import { isBuiltinThemeId, isThemeId, sanitizeThemeFile } from "../core/themes.ts";
import {
	dedupeByKey,
	isRecord,
	isSafeEntry,
	readJsonIfPresent,
	readRegularFileNoFollow,
	resolveSafePath,
	safeReaddir,
	tryRun,
	type ImportErrorCounter,
} from "./import-learnharness-fs.ts";
import { isPosition, isSafeEntityId } from "./lumberjack/graph-store.ts";
import type { FlashcardDeckRecord, FsrsCardSchedule, LumberJackStoreBundle } from "./lumberjack/index.ts";

export interface ImportMapperReport extends ImportErrorCounter {
	settingsImported: boolean;
	themesImported: number;
	promptsImported: number;
	positionsImported: number;
	flashcardDecksImported: number;
	flashcardCardsImported: number;
}

export function importOneThemeFile(
	root: string,
	entry: fs.Dirent,
	stores: LumberJackStoreBundle,
	report: ImportMapperReport,
): void {
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

function walkPromptFiles(
	root: string,
	relParts: string[],
	out: Array<[string, string]>,
	report: ImportErrorCounter,
): void {
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

export function importPromptDirectory(root: string, stores: LumberJackStoreBundle, report: ImportMapperReport): void {
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

export function importPositionsFile(root: string, stores: LumberJackStoreBundle, report: ImportMapperReport): void {
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

function resolveImportedFsrs(pid: string, incoming: FsrsOpt, stores: LumberJackStoreBundle): FsrsOpt {
	const existing = stores.learnerStore.readPropositionProgress(pid)?.fsrs;
	if (!incoming || shouldKeepExistingFsrs(existing, incoming)) return existing;
	stores.learnerStore.updatePropositionProgress(pid, { fsrs: incoming });
	return incoming;
}

function buildCardsForDeck(
	propIds: string[],
	propositions: PropMap,
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
			cards.push({
				id: cue.id ?? `${pid}_cue_${cards.length}`,
				front: cue.question ?? cue.front ?? "",
				back: cue.answer ?? cue.back ?? "",
				propositionId: pid,
				...(sched ? { fsrs: sched } : {}),
			});
		}
	}
	return cards;
}

function preserveFlashcardReviews(reviews: unknown[], stores: LumberJackStoreBundle): void {
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

function upsertImportedDeck(
	stores: LumberJackStoreBundle,
	deck: RawDeck,
	props: PropMap,
	report: ImportMapperReport,
): void {
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

export function importFlashcardFiles(root: string, stores: LumberJackStoreBundle, report: ImportMapperReport): void {
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
