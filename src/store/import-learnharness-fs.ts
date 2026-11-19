import fs from "node:fs";
import path from "node:path";

export interface ImportErrorCounter {
	corruptFilesSkipped: number;
}

export const isRecord = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v);

export function skipNull(report: ImportErrorCounter): null {
	report.corruptFilesSkipped++;
	return null;
}

export function tryRun(fn: () => void, report: ImportErrorCounter): boolean {
	try {
		fn();
		return true;
	} catch {
		report.corruptFilesSkipped++;
		return false;
	}
}

export function isSafeEntry(entry: fs.Dirent, report: ImportErrorCounter): boolean {
	if (!entry.isSymbolicLink()) return true;
	report.corruptFilesSkipped++;
	return false;
}

export function safeReaddir(dirPath: string, report: ImportErrorCounter): fs.Dirent[] {
	try {
		return fs.readdirSync(dirPath, { withFileTypes: true });
	} catch {
		report.corruptFilesSkipped++;
		return [];
	}
}

export function readRegularFileNoFollow(
	filePath: string,
	report: ImportErrorCounter,
	optionalMissing = false,
): Buffer | null {
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

export function resolveSafePath(
	root: string,
	relParts: string[],
	expectDir: boolean,
	report: ImportErrorCounter,
): string | null {
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

export function readJsonIfPresent(root: string, relParts: string[], report: ImportErrorCounter): unknown {
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

export function readJsonlIfPresent<T>(
	root: string,
	relParts: string[],
	isValid: (v: unknown) => v is T,
	report: ImportErrorCounter,
): T[] {
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

export function dedupeByKey<T>(
	existing: T[],
	incoming: T[],
	keyOf: (item: T) => string,
): { merged: T[]; added: number } {
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

export function applyRecordIfPresent(
	raw: unknown,
	apply: (rec: Record<string, unknown>) => void,
	report: ImportErrorCounter,
): boolean {
	if (raw === undefined) return false;
	if (!isRecord(raw)) {
		report.corruptFilesSkipped++;
		return false;
	}
	return tryRun(() => apply(raw), report);
}
