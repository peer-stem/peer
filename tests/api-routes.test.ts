import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { after, it } from "node:test";
import { pathToFileURL } from "node:url";
import type { Method, RouteRecord } from "../src/api/types.ts";
import { GOLDEN_ROUTE_PATTERNS, installScratchProcessEnv, WORKTREE_ROOT } from "./api-test-helpers.ts";

const ALL_METHODS: readonly Method[] = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];
const scratchEnv = installScratchProcessEnv("api-routes-");

const { patternFromFile, routes } = await import("../src/api/routes.ts");

after(() => {
	scratchEnv.restore();
});

async function walkRouteFiles(dir: string, repoRoot: string): Promise<string[]> {
	const found: string[] = [];
	const entries = await fs.readdir(dir, { withFileTypes: true });
	for (const entry of entries) {
		const fullPath = path.join(dir, entry.name);
		if (entry.isDirectory()) found.push(...(await walkRouteFiles(fullPath, repoRoot)));
		else if (entry.isFile() && entry.name === "route.ts") {
			found.push(path.relative(repoRoot, fullPath).split(path.sep).join("/"));
		}
	}
	return found.sort();
}

async function assertModuleParity(repoRoot: string, file: string, records: readonly RouteRecord[]): Promise<void> {
	const mod = (await import(pathToFileURL(path.join(repoRoot, file)).href)) as Record<string, unknown>;
	const expectedMethods = ALL_METHODS.filter((method) => typeof mod[method] === "function");
	assert.ok(expectedMethods.length > 0, `expected >= 1 HTTP method export in ${file}`);
	assert.deepEqual(
		records.map((record) => record.method),
		expectedMethods,
		`method parity mismatch for ${file}`,
	);
	for (const record of records) {
		assert.equal(record.pattern, patternFromFile(file), `pattern mismatch for ${file}`);
		assert.equal(record.handler, mod[record.method], `handler identity mismatch for ${file} ${record.method}`);
	}
}

it("routes-import", async () => {
	const diskFiles = await walkRouteFiles(path.join(WORKTREE_ROOT, "app", "api"), WORKTREE_ROOT);
	assert.equal(diskFiles.length, 52, "expected exactly 52 app/api/**/route.ts files on disk");

	const listedFiles = [...new Set(routes.map((record) => record.file))].sort();
	assert.deepEqual(listedFiles, diskFiles, "routes.ts file list must match disk files 1:1");
	const listedPatterns = [...new Set(routes.map((record) => record.pattern))].sort();
	assert.deepEqual(listedPatterns, GOLDEN_ROUTE_PATTERNS, "routes.ts patterns must match the 52 golden patterns");
	assert.equal(routes.length, 76, "expected exactly 76 exported method records across all 52 modules");

	for (const file of diskFiles) {
		const fileRecords = routes.filter((record) => record.file === file);
		await assertModuleParity(WORKTREE_ROOT, file, fileRecords);
	}
});

it("patternFromFile converts valid route paths and rejects malformed ones", () => {
	assert.equal(patternFromFile("app/api/route.ts"), "/api");
	assert.equal(patternFromFile("app/api/settings/route.ts"), "/api/settings");
	assert.equal(patternFromFile("app/api/chats/[id]/route.ts"), "/api/chats/[id]");
	assert.equal(
		patternFromFile("app/api/plugins/[id]/assets/[...file]/route.ts"),
		"/api/plugins/[id]/assets/[...file]",
	);
	for (const bad of ["", "src/api/routes.ts", "app/page.tsx", "app/api//route.ts", "app/api/x//route.ts"]) {
		assert.throws(() => patternFromFile(bad), /Invalid API route file path/);
	}
});
