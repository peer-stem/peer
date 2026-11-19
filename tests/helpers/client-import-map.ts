import { readFileSync } from "node:fs";
import path from "node:path";
import { WORKTREE_ROOT } from "../api-test-helpers.ts";

export interface PackageExportManifest {
	readonly name: string;
	readonly exports: Readonly<Record<string, string>>;
}

export interface ClientImportMap {
	readonly imports: Record<string, string>;
}

export const PEER_BROWSER_IMPORTS: Readonly<Record<string, string>> = {
	"peer-state": "/client/build/state.js",
	"peer-keyboard": "/client/build/keyboard.js",
	"peer-blocks-math": "/client/build/blocks-math.js",
	"peer-blocks-code": "/client/build/blocks-code.js",
	"peer-blocks-mermaid": "/client/build/blocks-mermaid.js",
	"node:crypto": "/client/shims/node-crypto.js",
};

/** `{specifier: url}` for one package's module exports (no wildcards, `.js` targets only). */
export function packageImports(
	manifest: PackageExportManifest,
	urlBase: string,
): Record<string, string> {
	const imports: Record<string, string> = {};
	for (const [key, target] of Object.entries(manifest.exports)) {
		if (key.includes("*") || !target.endsWith(".js")) continue;
		const specifier = key === "." ? manifest.name : `${manifest.name}/${key.slice(2)}`;
		imports[specifier] = `${urlBase}${target.slice(2)}`;
	}
	return imports;
}

function readManifest(repoRoot: string, relativePath: string): PackageExportManifest {
	const fullPath = path.join(repoRoot, relativePath);
	return JSON.parse(readFileSync(fullPath, "utf8")) as PackageExportManifest;
}

export function buildClientImportMap(repoRoot: string = WORKTREE_ROOT): ClientImportMap {
	const coreManifest = readManifest(repoRoot, "extern/cloudcanvas/package.json");
	const libManifest = readManifest(repoRoot, "extern/cloudcanvas-lib/package.json");
	return {
		imports: {
			...packageImports(coreManifest, "/client/vendor/cloudcanvas/"),
			...packageImports(libManifest, "/client/vendor/cloudcanvas-lib/"),
			...PEER_BROWSER_IMPORTS,
		},
	};
}

function assertStringRecord(value: unknown, label: string): Record<string, string> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${label} must be a plain JSON object`);
	}
	const out: Record<string, string> = {};
	for (const [key, entry] of Object.entries(value)) {
		if (typeof entry !== "string") {
			throw new Error(`${label}["${key}"] must be a string`);
		}
		out[key] = entry;
	}
	return out;
}

export function extractHtmlImportMap(html: string): ClientImportMap {
	const matches = [...html.matchAll(/<script\s+type=(?:"importmap"|'importmap')[^>]*>([\s\S]*?)<\/script>/gi)];
	if (matches.length === 0) {
		throw new Error('Missing <script type="importmap"> in HTML');
	}
	if (matches.length > 1) {
		throw new Error('Multiple <script type="importmap"> blocks in HTML');
	}
	const rawJson = matches[0]?.[1]?.trim() ?? "";
	const parsed: unknown = JSON.parse(rawJson);
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("Import map JSON must be an object");
	}
	const imports = assertStringRecord((parsed as { imports?: unknown }).imports, "importmap.imports");
	return { imports };
}
