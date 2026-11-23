import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { after, beforeEach, describe, it } from "node:test";

const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "peer-folder-settings-")));
const home = path.join(root, "home");
const data = path.join(root, "data");
const auth = path.join(root, "auth.json");
const a = path.join(home, "Study");
const b = path.join(root, "Other");
const prior = Object.fromEntries(["HOME", "USERPROFILE", "LH_AUTH_FILE", "LH_DATA_DIR"].map((key) => [key, process.env[key]]));
Object.assign(process.env, { HOME: home, USERPROFILE: home, LH_AUTH_FILE: auth, LH_DATA_DIR: data });
for (const directory of [a, b, data]) await fs.mkdir(directory, { recursive: true });
await fs.writeFile(auth, "{}\n");
await fs.writeFile(path.join(a, "notes.md"), "synthetic study\n");
await fs.writeFile(path.join(b, "notes.md"), "synthetic other\n");

const {
	ensureActiveLumberJackBundle,
	readFileAccessSettings,
	readSettings,
	resetActiveLumberJackForTests,
	writeSettings,
} = await import("../src/server/stores.ts");
const { fileAccessPolicy, fileAccessConfigurationError } = await import("../src/server/file-access.ts");
const { setFileAccessPolicy } = await import("../src/agent/tools/file-access.ts");
const { resolveSourcePath } = await import("../src/agent/tools/fs-shared.ts");
const { GET } = await import("../src/api/handlers/settings/route.ts");
const { PUT } = await import("../src/api/handlers/settings/[section]/route.ts");

const stored = (value: unknown) => {
	ensureActiveLumberJackBundle().forest.upsertNode({
		path: "config/settings",
		type: "leaf",
		kind: "config",
		slot: value,
	});
};
const put = (section: string, value: unknown) =>
	PUT(
		new Request(`http://localhost/api/settings/${section}`, {
			method: "PUT",
			body: JSON.stringify(value),
			headers: { "Content-Type": "application/json" },
		}),
		{ params: Promise.resolve({ section }) },
	);

beforeEach(() => {
	ensureActiveLumberJackBundle().forest.deleteNode("config/settings");
	setFileAccessPolicy(fileAccessPolicy);
});
after(async () => {
	setFileAccessPolicy(() => ({ restricted: false, folders: [] }));
	await resetActiveLumberJackForTests();
	for (const [key, value] of Object.entries(prior)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	await fs.rm(root, { recursive: true, force: true });
});
const blocked = /File-access configuration.*blocked/;

describe("strict persisted file-access policy", () => {
	it("genuinely absent preferences default OFF, including a fresh data folder", async () => {
		assert.deepEqual(readFileAccessSettings(), { ok: true, settings: { restricted: false, folders: [] } });
		assert.equal(fileAccessConfigurationError(), null);
		assert.equal(resolveSourcePath(path.join(b, "notes.md")), path.join(b, "notes.md"));
	});
	it("valid existing preferences with no policy default OFF; a legacy list alone does not turn it ON", () => {
		stored({ version: 1, agent: { tools: { pdf: false } } });
		assert.equal(fileAccessPolicy().restricted, false);
		stored({ version: 1, agent: { fileAccess: { folders: [a] } } });
		assert.equal(fileAccessPolicy().restricted, false);
		assert.equal(resolveSourcePath(path.join(b, "notes.md")), path.join(b, "notes.md"));
	});
	it("reads the latest policy for the next operation, not a cached sanitized default", () => {
		stored({ version: 1, agent: { fileAccess: { restricted: true, folders: ["~/Study"] } } });
		assert.equal(resolveSourcePath("Study/notes.md"), path.join(a, "notes.md"));
		assert.throws(() => resolveSourcePath(path.join(b, "notes.md")), /allowed folders/);
		stored({ version: 1, agent: { fileAccess: { restricted: true, folders: [b] } } });
		assert.throws(() => resolveSourcePath("Study/notes.md"), /allowed folders/);
		assert.equal(resolveSourcePath(path.join(b, "notes.md")), path.join(b, "notes.md"));
		stored({ version: 1, agent: { fileAccess: { restricted: false, folders: [b] } } });
		assert.equal(resolveSourcePath("Study/notes.md"), path.join(a, "notes.md"));
	});
	it("malformed records and policies fail CLOSED with a safe actionable diagnostic", async () => {
		for (const value of [
			null,
			[],
			5,
			{ agent: null },
			{ agent: [] },
			{ agent: { fileAccess: null } },
			{ agent: { fileAccess: { restricted: "yes", folders: [a] } } },
			{ agent: { fileAccess: { folders: [a, "relative"] } } },
		]) {
			stored(value);
			assert.equal(readFileAccessSettings().ok, false);
			assert.throws(() => resolveSourcePath(path.join(a, "notes.md")), blocked);
		}
		stored("SYNTHETIC_PRIVATE_PAYLOAD");
		const response = await GET();
		const body = await response.json();
		assert.equal(body.settings, null);
		assert.match(body.fileAccessError, blocked);
		assert.ok(!JSON.stringify(body).includes("SYNTHETIC_PRIVATE_PAYLOAD"));
	});
	it("an unreadable storage node fails closed", (t) => {
		stored({ version: 1 });
		const forest = ensureActiveLumberJackBundle().forest;
		t.mock.method(forest, "getNode", () => {
			throw Object.assign(new Error("synthetic unreadable settings"), { code: "EACCES" });
		});
		assert.equal(readSettings(), null);
		assert.equal(readFileAccessSettings().ok, false);
		assert.throws(() => resolveSourcePath(path.join(a, "notes.md")), blocked);
	});
	it("dangling data-directory symlinks fail closed when opening a cold forest", async () => {
		await resetActiveLumberJackForTests();
		await fs.rm(data, { recursive: true, force: true });
		await fs.symlink(path.join(root, "missing-data"), data, process.platform === "win32" ? "junction" : "dir");
		try {
			assert.equal(readFileAccessSettings().ok, false);
		} finally {
			await fs.unlink(data);
			await fs.mkdir(data, { recursive: true });
		}
	});
});

describe("settings HTTP and safe repair", () => {
	it("section writes preserve policy, toggle OFF retains roots, and ON+empty blocks", async () => {
		assert.equal((await put("agent", { tools: { pdf: false }, fileAccess: { restricted: true, folders: [a, b] } })).status, 200);
		assert.equal((await put("appearance", { theme: "catppuccin-mocha" })).status, 200);
		assert.deepEqual(readSettings()?.agent?.fileAccess, { restricted: true, folders: [a, b] });
		assert.equal((await put("agent", { tools: { pdf: false }, fileAccess: { restricted: false, folders: [a, b] } })).status, 200);
		assert.deepEqual(readSettings()?.agent?.fileAccess, { restricted: false, folders: [a, b] });
		assert.equal((await put("agent", { tools: { pdf: false }, fileAccess: { restricted: true, folders: [] } })).status, 200);
		assert.throws(() => resolveSourcePath(path.join(a, "notes.md")), /allowed folders/);
		assert.deepEqual(readSettings()?.appearance, { theme: "catppuccin-mocha" });
	});
	it("invalid writes return 400 without altering a valid restricted record", async () => {
		stored({ version: 1, agent: { fileAccess: { restricted: true, folders: [a] } } });
		const before = JSON.stringify(ensureActiveLumberJackBundle().forest.getNode("config/settings")?.slot);
		for (const fileAccess of [
			{ restricted: "true", folders: [b] },
			{ restricted: true, folders: ["relative"] },
			{ restricted: false, folders: [a, 2] },
			[],
		]) {
			assert.equal((await put("agent", { fileAccess })).status, 400);
			assert.equal(JSON.stringify(ensureActiveLumberJackBundle().forest.getNode("config/settings")?.slot), before);
		}
		assert.throws(() => resolveSourcePath(path.join(b, "notes.md")), /allowed folders/);
	});
	it("unrelated writes cannot launder malformed policy into unrestricted access", async () => {
		stored({ version: 1, agent: { tools: { pdf: false }, fileAccess: { restricted: true, folders: [a, 7] } } });
		assert.equal((await put("appearance", { theme: "catppuccin-latte" })).status, 200);
		assert.deepEqual(readSettings()?.agent?.fileAccess, { restricted: true, folders: [] });
		assert.deepEqual(readSettings()?.agent?.tools, { pdf: false });
		assert.throws(() => resolveSourcePath(path.join(a, "notes.md")), /allowed folders/);
		stored("broken JSON");
		const response = await put("appearance", { theme: "catppuccin-mocha" });
		assert.equal(response.status, 200);
		assert.deepEqual((await response.json()).settings.agent.fileAccess, { restricted: true, folders: [] });
		assert.equal(fileAccessConfigurationError(), null);
		assert.throws(() => resolveSourcePath(path.join(a, "notes.md")), /allowed folders/);
	});
	it("an explicit valid File access edit repairs corrupt settings and clears the UI diagnostic", async () => {
		stored("broken JSON");
		assert.match((await (await GET()).json()).fileAccessError, blocked);
		const response = await put("agent", { fileAccess: { restricted: true, folders: [a] } });
		assert.equal(response.status, 200);
		assert.equal((await response.json()).fileAccessError, undefined);
		assert.equal((await (await GET()).json()).fileAccessError, undefined);
		assert.equal(resolveSourcePath("Study/notes.md"), path.join(a, "notes.md"));
		assert.throws(() => resolveSourcePath(path.join(b, "notes.md")), /allowed folders/);
		stored("broken JSON again");
		writeSettings({ version: 1, agent: { fileAccess: { restricted: false, folders: [a] } } });
		assert.equal(resolveSourcePath(path.join(b, "notes.md")), path.join(b, "notes.md"));
	});
});
