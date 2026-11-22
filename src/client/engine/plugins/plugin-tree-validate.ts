/**
 * Pure contract validation and visible-row flattening for `PluginUi.mountTree`
 * (`src/core/plugin-tree.ts` contract).
 */

import type { PluginTreeColumn, PluginTreeContent, PluginTreeProps, PluginTreeRow } from "../../../core/index.ts";

export interface ValidatedTreeColumn {
	readonly key: string;
	readonly header: PluginTreeContent;
	readonly width: string;
	readonly align: "left" | "right";
}

export interface FlattenedTreeRow {
	readonly row: PluginTreeRow;
	readonly depth: number;
	readonly expanded?: boolean;
}

function validateTreeContent(value: unknown, field: string): void {
	if (typeof value === "string" || typeof value === "function") return;
	throw new Error(`Plugin tree ${field} must be a string or render callback`);
}

function validateColumnWidth(width: number | string): string {
	if (typeof width === "number") {
		if (!Number.isFinite(width) || width <= 0) throw new Error("Plugin tree column width must be positive");
		return `${width}px`;
	}
	if (typeof width === "string" && width.trim().length > 0) return width.trim();
	throw new Error("Plugin tree column width must be a positive number or CSS width");
}

function validateColumns(columns: readonly PluginTreeColumn[] | undefined): readonly ValidatedTreeColumn[] {
	if (columns === undefined) return Object.freeze([]);
	if (!Array.isArray(columns)) throw new Error("Plugin tree columns must be an array");
	const seen = new Set<string>();
	return Object.freeze(columns.map((col) => {
		if (!col || typeof col.key !== "string" || !col.key.trim()) {
			throw new Error("Plugin tree column key must be a nonempty string");
		}
		if (seen.has(col.key)) throw new Error(`Duplicate plugin tree column key: ${col.key}`);
		seen.add(col.key);
		validateTreeContent(col.header, `column "${col.key}" header`);
		if (col.align !== undefined && col.align !== "left" && col.align !== "right") {
			throw new Error(`Invalid plugin tree column align: ${String(col.align)}`);
		}
		return Object.freeze({
			key: col.key,
			header: col.header,
			width: validateColumnWidth(col.width),
			align: col.align ?? "left",
		});
	}));
}

function validateRow(row: PluginTreeRow, seenKeys: Set<string>, colKeys: ReadonlySet<string>): void {
	if (!row || typeof row.key !== "string" || !row.key.trim()) {
		throw new Error("Plugin tree row key must be a nonempty string");
	}
	if (seenKeys.has(row.key)) throw new Error(`Duplicate plugin tree row key: ${row.key}`);
	seenKeys.add(row.key);
	validateTreeContent(row.content, `row "${row.key}" content`);
	if (row.cells !== undefined) {
		if (!row.cells || typeof row.cells !== "object") throw new Error(`Invalid cells on row "${row.key}"`);
		for (const [k, cell] of Object.entries(row.cells)) {
			if (!colKeys.has(k)) throw new Error(`Unknown plugin tree column "${k}" on row "${row.key}"`);
			validateTreeContent(cell, `row "${row.key}" cell "${k}"`);
		}
	}
	validateRowControls(row);
	if (row.children !== undefined) {
		if (!Array.isArray(row.children)) throw new Error(`Invalid children on row "${row.key}"`);
		for (const child of row.children) validateRow(child, seenKeys, colKeys);
	}
}

function validateRowControls(row: PluginTreeRow): void {
	if (row.selection !== undefined) {
		const s = row.selection;
		if (!s || typeof s.label !== "string" || !s.label.trim() || typeof s.checked !== "boolean" || typeof s.onChange !== "function") {
			throw new Error(`Invalid selection on plugin tree row "${row.key}"`);
		}
	}
	if (row.disclosure !== undefined) {
		const d = row.disclosure;
		if (!d || typeof d.label !== "string" || !d.label.trim() || typeof d.expanded !== "boolean" || typeof d.onChange !== "function") {
			throw new Error(`Invalid disclosure on plugin tree row "${row.key}"`);
		}
	}
}

export function validatePluginTree(props: PluginTreeProps): {
	label: string;
	columns: readonly ValidatedTreeColumn[];
} {
	if (!props || typeof props !== "object") throw new Error("Plugin tree props must be an object");
	if (typeof props.label !== "string" || !props.label.trim()) {
		throw new Error("Plugin tree label must be a nonempty string");
	}
	if (!Array.isArray(props.rows)) throw new Error("Plugin tree rows must be an array");
	if (props.header !== undefined) validateTreeContent(props.header, "header");
	const columns = validateColumns(props.columns);
	const colKeys = new Set(columns.map((c) => c.key));
	const seenKeys = new Set<string>();
	for (const row of props.rows) validateRow(row, seenKeys, colKeys);
	return { label: props.label.trim(), columns };
}

export function flattenVisiblePluginTreeRows(
	rows: readonly PluginTreeRow[],
	depth = 0,
	out: FlattenedTreeRow[] = [],
): FlattenedTreeRow[] {
	for (const row of rows) {
		const hasDisclosure = row.disclosure !== undefined;
		const expanded = hasDisclosure ? row.disclosure!.expanded : (row.children && row.children.length > 0 ? true : undefined);
		out.push({ row, depth, expanded });
		if (row.children && row.children.length > 0 && expanded !== false) {
			flattenVisiblePluginTreeRows(row.children, depth + 1, out);
		}
	}
	return out;
}
