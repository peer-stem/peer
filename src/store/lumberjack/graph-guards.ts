import type {
	CoverageEntry,
	GraphChain,
	GraphNode,
	NotesSource,
	Position,
	ProvenancePoint,
	SessionCheckpoint,
} from "../../core/contracts.ts";

export function isPlainRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

const isString = (v: unknown): v is string => typeof v === "string";

export const isSafeEntityId = (v: unknown): v is string =>
	typeof v === "string" &&
	v.trim().length > 0 &&
	v.trim() !== "." &&
	v.trim() !== ".." &&
	!v.includes("/") &&
	!v.includes("\\") &&
	!v.includes("\0");

const isProvenancePoint = (v: unknown): v is ProvenancePoint =>
	isPlainRecord(v) &&
	isSafeEntityId(v.chatId) &&
	(v.messageId === "" || isSafeEntityId(v.messageId));

export const isGraphNode = (v: unknown): v is GraphNode =>
	isPlainRecord(v) &&
	isSafeEntityId(v.id) &&
	isString(v.name) &&
	isString(v.statement) &&
	Array.isArray(v.aliases) &&
	v.aliases.every(isString) &&
	isString(v.createdAt) &&
	Array.isArray(v.provenance) &&
	v.provenance.every(isProvenancePoint);

export const isGraphChain = (v: unknown): v is GraphChain =>
	isPlainRecord(v) &&
	isSafeEntityId(v.id) &&
	Array.isArray(v.premises) &&
	v.premises.length > 0 &&
	v.premises.every(isSafeEntityId) &&
	isSafeEntityId(v.conclusion) &&
	Array.isArray(v.provenance) &&
	v.provenance.every(isProvenancePoint) &&
	isString(v.createdAt);

export const isCheckpoint = (v: unknown): v is SessionCheckpoint =>
	isPlainRecord(v) && isSafeEntityId(v.chatId) && isString(v.foldedAt);

export const isCoverageEntry = (v: unknown): v is CoverageEntry =>
	isPlainRecord(v) &&
	isSafeEntityId(v.chatId) &&
	isString(v.fp) &&
	typeof v.tokens === "number" &&
	Number.isFinite(v.tokens) &&
	isString(v.foldedAt);

export const isNotesSource = (v: unknown): v is NotesSource =>
	isPlainRecord(v) && isSafeEntityId(v.id) && isString(v.filePath) && isString(v.importedAt);

export const isPosition = (v: unknown): v is Position =>
	isPlainRecord(v) &&
	typeof v.x === "number" &&
	Number.isFinite(v.x) &&
	typeof v.y === "number" &&
	Number.isFinite(v.y);

export function sanitizeSegment(raw: string): string {
	if (typeof raw !== "string") throw new Error("Invalid segment: expected string");
	const trimmed = raw.trim();
	if (trimmed === "" || trimmed === "." || trimmed === "..") throw new Error(`Invalid segment: ${raw}`);
	const clean = raw.replace(/[^A-Za-z0-9_.:-]/g, "_");
	if (clean === "" || clean === "." || clean === "..") throw new Error(`Invalid segment: ${raw}`);
	return clean;
}

const DIRECT_SEGMENT_RE = /^[A-Za-z0-9_.:-]+$/;

/**
 * Collision-free segment encoding for learner progress keys: plain safe IDs stay
 * readable (`n_prior` -> `n_prior`), while IDs with special characters (`n?1` vs `n_1`)
 * encode via `~hex` so two distinct entity IDs never alias the same progress node.
 */
export function encodeEntitySegment(raw: string): string {
	if (!isSafeEntityId(raw)) throw new Error(`Invalid entity id: ${String(raw)}`);
	if (DIRECT_SEGMENT_RE.test(raw) && !raw.startsWith("hex_")) {
		return raw;
	}
	return `hex_${Buffer.from(raw, "utf8").toString("hex")}`;
}
