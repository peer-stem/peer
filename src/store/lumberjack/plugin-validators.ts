import type { PluginAgentRecord } from "../../core/plugin-agents.ts";
import { validatePluginInferenceOptions } from "../../core/plugin-validation.ts";
import type { PluginTaskRecord } from "../../core/plugin-workers.ts";

const SAFE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const AGENT_STATUSES = new Set(["idle", "running", "waiting", "error", "interrupted"]);
const AGENT_ROLES = new Set(["user", "assistant", "toolResult", "system"]);
const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const TASK_STATUSES = new Set(["queued", "running", "succeeded", "failed", "cancelled", "interrupted"]);
const TASK_ERROR_CODES = new Set([
	"no_result",
	"max_turns",
	"timeout",
	"run_error",
	"storage_error",
	"cancelled",
	"interrupted",
]);
const STOP_REASONS = new Set(["stop", "length", "toolUse", "error", "aborted", "deferred"]);
const USAGE_TOKEN_KEYS = [
	"inputTokens",
	"outputTokens",
	"cacheReadTokens",
	"cacheWriteTokens",
	"reasoningTokens",
	"cacheWrite1hTokens",
] as const;

const isSafeId = (v: unknown): v is string => typeof v === "string" && SAFE_ID_RE.test(v);
const isPlainObject = (v: unknown): v is Record<string, unknown> =>
	!!v && typeof v === "object" && !Array.isArray(v);
const isTimestamp = (v: unknown): v is string => typeof v === "string" && Number.isFinite(Date.parse(v));
const isNonNegative = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;

export function assertSafePluginRecordId(id: unknown, label: string): asserts id is string {
	if (!isSafeId(id)) {
		throw new Error(`Invalid ${label} id: ${String(id)}`);
	}
}

export function validatePluginAgentRecord(value: unknown, expectedId: string): PluginAgentRecord {
	assertSafePluginRecordId(expectedId, "plugin agent");
	if (!isPlainObject(value)) throw new Error(`Invalid plugin agent record: ${expectedId}`);
	const r = value;
	const validArrays =
		Array.isArray(r.messages) &&
		Array.isArray(r.pending) &&
		Array.isArray(r.acceptedInputs) &&
		!r.acceptedInputs.some((i) => typeof i !== "string") &&
		!r.pending.some((p) => !isPlainObject(p) || typeof p.toolCallId !== "string" || typeof p.toolName !== "string") &&
		!r.messages.some((m) => !isPlainObject(m) || !AGENT_ROLES.has(m.role as string));
	if (
		r.version !== 1 ||
		r.id !== expectedId ||
		typeof r.definitionId !== "string" ||
		typeof r.createdAt !== "string" ||
		typeof r.updatedAt !== "string" ||
		!AGENT_STATUSES.has(r.status as string) ||
		!validArrays
	) {
		throw new Error(`Invalid plugin agent record: ${expectedId}`);
	}
	assertSafePluginRecordId(r.definitionId, "plugin agent definition");
	return r as unknown as PluginAgentRecord;
}

function visitFinitePlainJson(v: unknown, seen: Set<object>): void {
	if (v === undefined || v === null || typeof v === "string" || typeof v === "boolean") return;
	if (typeof v === "number" && Number.isFinite(v)) return;
	if (!v || typeof v !== "object" || seen.has(v)) {
		throw new Error("Plugin task record must contain finite JSON data");
	}
	if (!Array.isArray(v) && Object.getPrototypeOf(v) !== Object.prototype) {
		throw new Error("Plugin task record must contain finite JSON data");
	}
	seen.add(v);
	for (const child of Object.values(v)) visitFinitePlainJson(child, seen);
	seen.delete(v);
}

export function assertFinitePlainJson(value: unknown): void {
	visitFinitePlainJson(value, new Set<object>());
}

function hasValidTaskOptions(options: unknown): boolean {
	try {
		validatePluginInferenceOptions(options as never);
		return true;
	} catch {
		return false;
	}
}

function hasValidTaskCoreFields(r: Record<string, unknown>, expectedId: string): boolean {
	if (r.version !== 1 || r.id !== expectedId || !isSafeId(r.id) || !isSafeId(r.definitionId)) return false;
	if (typeof r.requestId !== "string" || !r.requestId.length) return false;
	if (!isTimestamp(r.createdAt) || !isTimestamp(r.updatedAt) || typeof r.prompt !== "string") return false;
	if (!Object.hasOwn(r, "input")) return false;
	if (r.maxTurns !== undefined && (!Number.isSafeInteger(r.maxTurns) || (r.maxTurns as number) < 1)) return false;
	if (!Number.isSafeInteger(r.turns) || (r.turns as number) < 0) return false;
	if (r.purpose !== "user" && r.purpose !== "background") return false;
	if (!isPlainObject(r.model) || typeof r.model.provider !== "string" || !r.model.provider.trim()) return false;
	if (typeof r.model.id !== "string" || !r.model.id.trim()) return false;
	if (r.model.thinkingLevel !== undefined && !THINKING_LEVELS.has(r.model.thinkingLevel as string)) return false;
	if (r.timeoutMs !== undefined && (!Number.isSafeInteger(r.timeoutMs) || (r.timeoutMs as number) < 1)) return false;
	if (r.activity !== undefined && typeof r.activity !== "string") return false;
	return hasValidTaskOptions(r.options);
}

function hasValidTaskStatus(r: Record<string, unknown>): boolean {
	if (!TASK_STATUSES.has(r.status as string)) return false;
	if (r.status === "succeeded") {
		return Object.hasOwn(r, "result") && isTimestamp(r.completedAt) && r.error === undefined;
	}
	if (r.status === "failed" || r.status === "cancelled" || r.status === "interrupted") {
		if (Object.hasOwn(r, "result") || !isTimestamp(r.completedAt) || !isPlainObject(r.error)) return false;
		if (typeof r.error.message !== "string" || !TASK_ERROR_CODES.has(r.error.code as string)) return false;
		if (r.status === "cancelled" && r.error.code !== "cancelled") return false;
		if (r.status === "interrupted" && r.error.code !== "interrupted") return false;
		return true;
	}
	return !Object.hasOwn(r, "result") && r.error === undefined && r.completedAt === undefined;
}

function isValidTaskMessage(m: unknown): boolean {
	if (!isPlainObject(m) || typeof m.role !== "string") return false;
	if (!["user", "assistant", "toolResult"].includes(m.role)) return false;
	if (!isNonNegative(m.timestamp) || (typeof m.content !== "string" && !Array.isArray(m.content))) return false;
	if (m.role === "assistant") {
		return (
			typeof m.api === "string" &&
			typeof m.provider === "string" &&
			typeof m.model === "string" &&
			Array.isArray(m.content) &&
			isPlainObject(m.usage) &&
			STOP_REASONS.has(m.stopReason as string)
		);
	}
	if (m.role === "toolResult") {
		return (
			typeof m.toolCallId === "string" &&
			typeof m.toolName === "string" &&
			Array.isArray(m.content) &&
			typeof m.isError === "boolean"
		);
	}
	return true;
}

function hasValidTaskUsage(usage: unknown): boolean {
	if (usage === undefined) return true;
	if (!isPlainObject(usage) || typeof usage.model !== "string") return false;
	if (!Number.isSafeInteger(usage.steps) || (usage.steps as number) < 1) return false;
	for (const key of USAGE_TOKEN_KEYS) {
		if (usage[key] !== undefined && !isNonNegative(usage[key])) return false;
	}
	if (usage.calls !== undefined && (!Array.isArray(usage.calls) || !usage.calls.every(isPlainObject))) return false;
	if (usage.lastStep !== undefined && !isPlainObject(usage.lastStep)) return false;
	return true;
}

export function validatePluginTaskRecord(value: unknown, expectedId: string): PluginTaskRecord {
	assertSafePluginRecordId(expectedId, "plugin task");
	if (!isPlainObject(value)) {
		throw new Error(`Corrupt or unsupported plugin task record: ${expectedId}`);
	}
	const validMessages = Array.isArray(value.messages) && value.messages.length > 0 && value.messages.every(isValidTaskMessage);
	if (
		!hasValidTaskCoreFields(value, expectedId) ||
		!hasValidTaskStatus(value) ||
		!validMessages ||
		!hasValidTaskUsage(value.usage)
	) {
		throw new Error(`Corrupt or unsupported plugin task record: ${expectedId}`);
	}
	return value as unknown as PluginTaskRecord;
}
