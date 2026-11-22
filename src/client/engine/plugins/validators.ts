import type {
	PluginAction,
	PluginActionPlacement,
	PluginProblemRenderer,
	PluginQuestionRenderer,
	PluginSettingsSchema,
	PluginView,
} from "../../../core/index.ts";

function invalidSettings(detail: string): never {
	throw new Error(`Plugin settings mount must be a function or a valid row schema: ${detail}`);
}

function validDropdownOptions(options: unknown): boolean {
	return Array.isArray(options)
		&& options.every((opt) => opt && typeof opt.value === "string" && typeof opt.label === "string");
}

function validateNumericRow(row: Record<string, unknown>): void {
	if (typeof row.value !== "number" || !Number.isFinite(row.value)) invalidSettings("numeric value must be finite");
	for (const key of ["min", "max", "step"] as const) {
		if (row[key] !== undefined && (typeof row[key] !== "number" || !Number.isFinite(row[key]))) {
			invalidSettings(`${key} must be finite`);
		}
	}
	if (typeof row.min === "number" && typeof row.max === "number" && row.min > row.max) invalidSettings("minimum exceeds maximum");
	if (typeof row.step === "number" && row.step <= 0) invalidSettings("step must be positive");
}

function validateSettingsRowControl(row: Record<string, unknown>): void {
	switch (row.type) {
		case "toggle":
			if (typeof row.value !== "boolean") invalidSettings("toggle value must be boolean");
			break;
		case "text":
			if (typeof row.value !== "string") invalidSettings("text value must be a string");
			break;
		case "dropdown":
			if (typeof row.value !== "string" || !validDropdownOptions(row.options)) invalidSettings("dropdown needs a string value and options");
			break;
		case "number":
		case "slider":
			validateNumericRow(row);
			break;
		default:
			invalidSettings("unknown row control type");
	}
}

export function validateSettingsSchema(value: unknown): asserts value is PluginSettingsSchema {
	if (!value || typeof value !== "object" || Array.isArray(value) || !Array.isArray((value as { rows?: unknown }).rows)) {
		invalidSettings("rows must be an array");
	}
	const keys = new Set<string>();
	for (const row of (value as { rows: Record<string, unknown>[] }).rows) {
		if (!row || typeof row !== "object" || typeof row.key !== "string" || !row.key.trim() || keys.has(row.key)) {
			invalidSettings("row keys must be nonempty and unique");
		}
		keys.add(row.key);
		if (typeof row.label !== "string" || !row.label.trim() || typeof row.onChange !== "function") {
			invalidSettings("rows need a label and onChange callback");
		}
		if (row.validate !== undefined && typeof row.validate !== "function") invalidSettings("validate must be a function");
		if (row.disabled !== undefined && typeof row.disabled !== "boolean") invalidSettings("disabled must be boolean");
		validateSettingsRowControl(row);
	}
}

export function validateViewOrAction<T extends PluginView | PluginAction>(
	item: T,
	callback: "mount" | "run",
): void {
	if (!item || typeof item.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(item.id)) {
		throw new Error("Plugin registration id must be a route-safe string of 1–128 characters, starting with a letter or number");
	}
	if (typeof item.name !== "string" || !item.name.trim()) {
		throw new Error("Plugin registration name must be a nonempty string");
	}
	const handler = callback === "mount" ? (item as PluginView).mount : (item as PluginAction).run;
	if (typeof handler !== "function") throw new Error(`Plugin registration ${callback} must be a function`);
	if (callback === "run") {
		const action = item as PluginAction;
		if (action.icon !== undefined && typeof action.icon !== "string") {
			throw new Error("Plugin action icon must be SVG markup");
		}
		if (action.disabled !== undefined && typeof action.disabled !== "boolean" && typeof action.disabled !== "function") {
			throw new Error("Plugin action disabled must be boolean or a predicate");
		}
	}
}

export function validateActionPlacement(
	placement: PluginActionPlacement,
	actions: ReadonlyMap<string, PluginAction>,
): void {
	if (!placement || typeof placement.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(placement.id)) {
		throw new Error("Plugin placement id must be a route-safe string");
	}
	if (!actions.has(placement.actionId)) throw new Error("Plugin placement must reference a registered action");
	if (!["top-bar", "sidebar", "graph"].includes(placement.location)) {
		throw new Error("Unknown plugin action placement");
	}
	if (placement.location === "top-bar") {
		if (placement.sessions !== undefined && (!Array.isArray(placement.sessions) || placement.sessions.some((k) => k !== "teaching" && k !== "practice"))) {
			throw new Error("Invalid plugin top-bar session targets");
		}
		if (placement.views !== undefined && (!Array.isArray(placement.views) || placement.views.some((id) => typeof id !== "string" || !id))) {
			throw new Error("Invalid plugin top-bar view targets");
		}
		if (!placement.sessions?.length && !placement.views?.length) {
			throw new Error("Plugin top-bar placement requires explicit session or view targets");
		}
	}
}

function validContractVersions(versions: unknown): versions is readonly number[] {
	return (
		Array.isArray(versions) &&
		versions.length > 0 &&
		versions.every((v) => Number.isSafeInteger(v) && v >= 1) &&
		new Set(versions).size === versions.length
	);
}

export function validateQuestionRenderer(
	renderer: PluginQuestionRenderer,
	reject: (text: string) => never,
): void {
	if (!renderer || typeof renderer.id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(renderer.id)) {
		reject("Invalid question renderer id");
	}
	if (!validContractVersions(renderer.supportedContractVersions)) {
		reject("Invalid question renderer contract versions");
	}
	if (
		typeof renderer.mountAnswerEditor !== "function" ||
		(renderer.mountQuestion !== undefined && typeof renderer.mountQuestion !== "function") ||
		(renderer.mountAnswered !== undefined && typeof renderer.mountAnswered !== "function")
	) {
		reject("Invalid question renderer mount");
	}
}

export function validateProblemRenderer(
	renderer: PluginProblemRenderer,
	reject: (text: string) => never,
): void {
	if (!renderer || typeof renderer.id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(renderer.id)) {
		reject("Invalid problem renderer id");
	}
	if (!validContractVersions(renderer.supportedContractVersions)) {
		reject("Invalid problem renderer contract versions");
	}
	if (
		typeof renderer.mountSubmissionEditor !== "function" ||
		(renderer.mountSubmitted !== undefined && typeof renderer.mountSubmitted !== "function")
	) {
		reject("Invalid problem renderer mount");
	}
}
