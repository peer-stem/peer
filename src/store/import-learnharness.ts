import fs from "node:fs";
import path from "node:path";
import type {
	ChatRecord,
	CoverageEntry,
	GraphChain,
	GraphNode,
	LearnHarnessImportReport,
	SessionCheckpoint,
} from "../core/contracts.ts";
import {
	applyRecordIfPresent,
	dedupeByKey,
	isRecord,
	isSafeEntry,
	readJsonIfPresent,
	readJsonlIfPresent,
	readRegularFileNoFollow,
	resolveSafePath,
	safeReaddir,
	tryRun,
} from "./import-learnharness-fs.ts";
import {
	importFlashcardFiles,
	importOneThemeFile,
	importPositionsFile,
	importPromptDirectory,
} from "./import-learnharness-mappers.ts";
import { isCheckpoint, isCoverageEntry, isGraphChain, isGraphNode, isNotesSource } from "./lumberjack/graph-store.ts";
import type { LumberJackStoreBundle } from "./lumberjack/index.ts";

export type { LearnHarnessImportReport } from "../core/contracts.ts";

function importConfigAndThemes(root: string, stores: LumberJackStoreBundle, report: LearnHarnessImportReport): void {
	const rawSettings = readJsonIfPresent(root, ["settings.json"], report);
	if (applyRecordIfPresent(rawSettings, (rec) => stores.settingsStore.writeSettings(rec as never), report)) {
		report.settingsImported = true;
	}
	const themesDir = resolveSafePath(root, ["themes"], true, report);
	if (!themesDir) return;
	for (const entry of safeReaddir(themesDir, report)) importOneThemeFile(root, entry, stores, report);
}

function importGraphLedgersAndPositions(
	root: string,
	stores: LumberJackStoreBundle,
	report: LearnHarnessImportReport,
): void {
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
	if (tryRun(() => stores.graphStore.upsertSource(item), report)) report.sourcesImported++;
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
	applyRecordIfPresent(rawOrg, (rec) => stores.sourceOrganizationStore.write(rec as never), report);
	importGraphLedgersAndPositions(root, stores, report);
}

function importOneChatFile(
	root: string,
	entry: fs.Dirent,
	stores: LumberJackStoreBundle,
	report: LearnHarnessImportReport,
): void {
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

function importOneLooseImage(
	imagesDir: string,
	entry: fs.Dirent,
	stores: LumberJackStoreBundle,
	report: LearnHarnessImportReport,
): void {
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

function importChatsAndLooseImages(root: string, stores: LumberJackStoreBundle, report: LearnHarnessImportReport): void {
	const chatsDir = resolveSafePath(root, ["chats"], true, report);
	if (chatsDir) {
		for (const entry of safeReaddir(chatsDir, report)) importOneChatFile(root, entry, stores, report);
	}
	const imagesDir = resolveSafePath(root, ["images"], true, report);
	if (!imagesDir) return;
	for (const entry of safeReaddir(imagesDir, report)) importOneLooseImage(imagesDir, entry, stores, report);
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
	importPromptDirectory(resolved, stores, report);
	importSourcesAndGraph(resolved, stores, report);
	importChatsAndLooseImages(resolved, stores, report);
	importFlashcardFiles(resolved, stores, report);
	return report;
}
