import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { after, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Method, RouteRecord } from "../src/api/types.ts";

const ALL_METHODS: readonly Method[] = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];
const ENV_KEYS = ["HOME", "USERPROFILE", "XDG_CONFIG_HOME", "TMPDIR", "LH_DATA_DIR", "LH_AUTH_FILE"] as const;
const WORKTREE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scratchBase = await fs.stat("/usr/lib/persist/peer").then(
	() => "/usr/lib/persist/peer/scratch",
	() => path.join(WORKTREE_ROOT, ".fresh-data"),
);

await fs.mkdir(scratchBase, { recursive: true, mode: 0o700 });
const scratchRoot = await fs.mkdtemp(path.join(scratchBase, "api-routes-"));
await fs.chmod(scratchRoot, 0o700);
const homeDir = path.join(scratchRoot, "home");
const configDir = path.join(scratchRoot, "config");
const dataDir = path.join(scratchRoot, "data");
const authFile = path.join(scratchRoot, "auth.json");
for (const dir of [homeDir, configDir, dataDir]) {
	await fs.mkdir(dir, { recursive: true, mode: 0o700 });
}
await fs.writeFile(authFile, "{}\n", { mode: 0o600 });

const priorEnv = new Map<string, string | undefined>(ENV_KEYS.map((key) => [key, process.env[key]]));
process.env.HOME = homeDir;
process.env.USERPROFILE = homeDir;
process.env.XDG_CONFIG_HOME = configDir;
process.env.TMPDIR = scratchRoot;
process.env.LH_DATA_DIR = dataDir;
process.env.LH_AUTH_FILE = authFile;

const { patternFromFile, routes } = await import("../src/api/routes.ts");

after(async () => {
	for (const [key, value] of priorEnv) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	await fs.rm(scratchRoot, { recursive: true, force: true });
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
	const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
	const diskFiles = await walkRouteFiles(path.join(repoRoot, "app", "api"), repoRoot);
	assert.equal(diskFiles.length, 50, "expected exactly 50 app/api/**/route.ts files on disk");

	const listedFiles = [...new Set(routes.map((record) => record.file))].sort();
	assert.deepEqual(listedFiles, diskFiles, "routes.ts file list must match disk files 1:1");
	assert.equal(routes.length, 73, "expected exactly 73 exported method records across all 50 modules");

	for (const file of diskFiles) {
		const fileRecords = routes.filter((record) => record.file === file);
		await assertModuleParity(repoRoot, file, fileRecords);
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
