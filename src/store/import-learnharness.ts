import fs from "node:fs";
import path from "node:path";
import type {
	ChatRecord,
	CoverageEntry,
	GraphChain,
	GraphNode,
	NotesSource,
	Position,
	SessionCheckpoint,
} from "../core/contracts.ts";
import { isValidSegmentPath } from "../core/prompt-segments.ts";
import { isBuiltinThemeId, isThemeId, sanitizeThemeFile } from "../core/themes.ts";
import type {
	FlashcardDeckRecord,
	FsrsCardSchedule,
	LumberJackStoreBundle,
} from "./lumberjack/index.ts";

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
}

function readJsonIfPresent(filePath: string): unknown {
	if (!fs.existsSync(filePath)) return undefined;
	return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function readJsonlIfPresent<T>(filePath: string): T[] {
	if (!fs.existsSync(filePath)) return [];
	const out: T[] = [];
	for (const rawLine of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
		const trimmed = rawLine.trim();
		if (!trimmed) continue;
		try {
			out.push(JSON.parse(trimmed) as T);
		} catch {
			// Skip malformed JSONL lines, matching upstream GraphStore resilience.
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

function importConfigAndThemes(root: string, stores: LumberJackStoreBundle, report: LearnHarnessImportReport): void {
	const rawSettings = readJsonIfPresent(path.join(root, "settings.json"));
	if (rawSettings && typeof rawSettings === "object" && !Array.isArray(rawSettings)) {
		stores.settingsStore.writeSettings(rawSettings as never);
		report.settingsImported = true;
	}
	const themesDir = path.join(root, "themes");
	if (!fs.existsSync(themesDir)) return;
	for (const entry of fs.readdirSync(themesDir)) {
		if (!entry.endsWith(".json")) continue;
		const id = entry.slice(0, -5);
		if (!isThemeId(id) || isBuiltinThemeId(id)) continue;
		const parsed = sanitizeThemeFile(readJsonIfPresent(path.join(themesDir, entry)));
		if (!parsed) continue;
		stores.themeStore.writeTheme(id, parsed);
		report.themesImported++;
	}
}

function walkPromptFiles(dir: string, prefix: string, out: Array<[string, string]>): void {
	if (!fs.existsSync(dir)) return;
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			walkPromptFiles(full, rel, out);
		} else if (entry.isFile() && entry.name.endsWith(".md") && isValidSegmentPath(rel)) {
			out.push([rel, fs.readFileSync(full, "utf8")]);
		}
	}
}

function importPrompts(root: string, stores: LumberJackStoreBundle, report: LearnHarnessImportReport): void {
	const found: Array<[string, string]> = [];
	walkPromptFiles(path.join(root, "prompts"), "", found);
	for (const [segPath, text] of found) {
		stores.promptOverrides.writeOverride(segPath, text);
		report.promptsImported++;
	}
}

function upsertSourceEntry(item: unknown, stores: LumberJackStoreBundle, report: LearnHarnessImportReport): void {
	if (!item || typeof item !== "object" || typeof (item as NotesSource).id !== "string") return;
	stores.graphStore.upsertSource(item as NotesSource);
	report.sourcesImported++;
}

function importSourcesAndGraph(root: string, stores: LumberJackStoreBundle, report: LearnHarnessImportReport): void {
	const graphDir = path.join(root, "graph");
	const rawSources = readJsonIfPresent(path.join(graphDir, "sources.json"));
	if (rawSources && typeof rawSources === "object") {
		const entries = Array.isArray(rawSources) ? rawSources : Object.values(rawSources as Record<string, unknown>);
		for (const item of entries) upsertSourceEntry(item, stores, report);
	}
	const rawOrg = readJsonIfPresent(path.join(graphDir, "source-organization.json"));
	if (rawOrg && typeof rawOrg === "object") {
		stores.sourceOrganizationStore.write(rawOrg as never);
	}
	importGraphLedgersAndPositions(graphDir, stores, report);
}

function importGraphLedgersAndPositions(
	graphDir: string,
	stores: LumberJackStoreBundle,
	report: LearnHarnessImportReport,
): void {
	const inNodes = readJsonlIfPresent<GraphNode>(path.join(graphDir, "nodes.jsonl"));
	const inChains = readJsonlIfPresent<GraphChain>(path.join(graphDir, "chains.jsonl"));
	const inSessions = readJsonlIfPresent<SessionCheckpoint>(path.join(graphDir, "sessions.jsonl"));
	const inCoverage = readJsonlIfPresent<CoverageEntry>(path.join(graphDir, "coverage.jsonl"));
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
	const rawPos = readJsonIfPresent(path.join(graphDir, "positions.json")) as Record<string, Position> | undefined;
	if (rawPos && typeof rawPos === "object" && !Array.isArray(rawPos)) {
		const mergedPos = { ...stores.graphStore.readPositions(), ...rawPos };
		stores.graphStore.writePositions(mergedPos);
		report.positionsImported = Object.keys(rawPos).length;
	}
}

function importChatsAndLooseImages(root: string, stores: LumberJackStoreBundle, report: LearnHarnessImportReport): void {
	const chatsDir = path.join(root, "chats");
	if (fs.existsSync(chatsDir)) {
		for (const name of fs.readdirSync(chatsDir)) {
			if (!name.endsWith(".json")) continue;
			const raw = readJsonIfPresent(path.join(chatsDir, name)) as ChatRecord | undefined;
			if (!raw || typeof raw.id !== "string" || !Array.isArray(raw.messages)) continue;
			const res = stores.chatStore.importChatRecord(raw);
			if (res.imported) report.chatsImported++;
			report.objectsStored += res.objectsStored;
			report.objectsDeduplicated += res.objectsDeduplicated;
		}
	}
	const imagesDir = path.join(root, "images");
	if (!fs.existsSync(imagesDir)) return;
	for (const fileName of fs.readdirSync(imagesDir)) {
		const full = path.join(imagesDir, fileName);
		if (!fs.statSync(full).isFile()) continue;
		const mime = fileName.endsWith(".jpg") || fileName.endsWith(".jpeg") ? "image/jpeg" : "image/png";
		const receipt = stores.forest.putObject(fileName, mime, fs.readFileSync(full).toString("base64"));
		if (receipt.existed) report.objectsDeduplicated++;
		else report.objectsStored++;
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
}

function makeDeckCard(
	pid: string,
	cue: RawFlashcardCue,
	index: number,
	sched?: FsrsCardSchedule,
): FlashcardDeckRecord["cards"][number] {
	return {
		id: cue.id ?? `${pid}_cue_${index}`,
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
		const propSched = prop.schedule ?? prop.fsrs;
		if (propSched) stores.learnerStore.updatePropositionProgress(pid, { fsrs: propSched });
		for (const cue of prop.cues ?? []) {
			if (cue.deleted) continue;
			const sched = cue.schedule ?? propSched;
			if (sched && !propSched) stores.learnerStore.updatePropositionProgress(pid, { fsrs: sched });
			cards.push(makeDeckCard(pid, cue, cards.length, sched));
		}
	}
	return cards;
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
	const candidates = [
		path.join(root, "core-plugin-data", "flashcards", "flashcards.json"),
		path.join(root, "plugins", "flashcards", "data", "flashcards.json"),
		path.join(root, "flashcards", "flashcards.json"),
	];
	for (const candidate of candidates) {
		const raw = readJsonIfPresent(candidate) as RawFlashcardsFile | undefined;
		if (!raw || !Array.isArray(raw.decks)) continue;
		const props = raw.propositions ?? {};
		for (const deck of raw.decks) upsertImportedDeck(stores, deck, props, report);
	}
}

export function importLearnHarnessData(sourceDir: string, stores: LumberJackStoreBundle): LearnHarnessImportReport {
	const resolved = path.resolve(sourceDir);
	const st = fs.statSync(resolved);
	if (!st.isDirectory()) {
		throw new Error(`LearnHarness import source must be a directory: ${resolved}`);
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
	};
	importConfigAndThemes(resolved, stores, report);
	importPrompts(resolved, stores, report);
	importSourcesAndGraph(resolved, stores, report);
	importChatsAndLooseImages(resolved, stores, report);
	importFlashcards(resolved, stores, report);
	return report;
}
