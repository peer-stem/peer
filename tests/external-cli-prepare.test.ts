/**
 * What each Codex and Antigravity turn is given: its environment, home and
 * files, and that they are gone afterwards. The binaries are empty markers on
 * a private PATH; nothing here runs a real CLI.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test, { type TestContext } from "node:test";

import { agyDialect } from "../src/agent/external-cli/agy.ts";
import { codexDialect } from "../src/agent/external-cli/codex.ts";
import { CliLaunchError, type CliPrepareInput } from "../src/agent/external-cli/dialect.ts";
import { externalCliEnv } from "../src/core/auth-env.ts";

const SERVER_ONLY = { LH_DESKTOP_API_SECRET: "app-secret", LH_DESKTOP_SERVER: "1", LH_AUTH_FILE: "/auth.json", LH_DATA_DIR: "/data", PORT: "3210" };
const INPUT: CliPrepareInput = {
	model: "test-model",
	effort: "high",
	systemPrompt: "You are a tutor.",
	prompt: "hi",
	tools: [{ name: "read", description: "Read", parameters: {} } as CliPrepareInput["tools"][number]],
	bridge: { url: "http://127.0.0.1:1/mcp", authorization: "Bearer bridge-token" },
	home: undefined,
};

/** A private TMPDIR and PATH, the server-only variables set, all restored afterwards. */
function sandbox(t: TestContext): string {
	fs.mkdirSync("/tmp/peer", { recursive: true });
	const root = fs.mkdtempSync("/tmp/peer/external-cli-prepare-");
	const bin = path.join(root, "bin");
	const tmp = path.join(root, "tmp");
	fs.mkdirSync(bin);
	fs.mkdirSync(tmp);
	for (const name of ["codex", "agy"]) fs.writeFileSync(path.join(bin, name), "", { mode: 0o755 });
	const saved = Object.fromEntries(["PATH", "TMPDIR", "CODEX_HOME", ...Object.keys(SERVER_ONLY)].map((name) => [name, process.env[name]]));
	Object.assign(process.env, SERVER_ONLY, { PATH: bin, TMPDIR: tmp });
	delete process.env.CODEX_HOME;
	t.after(() => {
		for (const [name, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
		fs.rmSync(root, { recursive: true, force: true });
	});
	return root;
}

function assertNoServerAccess(env: NodeJS.ProcessEnv): void {
	for (const name of Object.keys(SERVER_ONLY)) assert.equal(env[name], undefined, name);
}

function configValue(args: string[], key: string): string | undefined {
	const index = args.findIndex((arg, at) => args[at - 1] === "-c" && arg.startsWith(`${key}=`));
	return index < 0 ? undefined : args[index]!.slice(key.length + 1);
}

test("CLI children never inherit the app server's own access or data location", () => {
	const env = { ...SERVER_ONLY, NODE_ENV: "test", PATH: "/bin", HOME: "/home/learner" } as NodeJS.ProcessEnv;
	assert.deepEqual(externalCliEnv(env), { NODE_ENV: "test", PATH: "/bin", HOME: "/home/learner" });
});

test("a Codex turn gets an empty directory, a private instructions file and the token only in its environment", async (t) => {
	const root = sandbox(t);
	const launch = await codexDialect.prepare(INPUT);
	assert.equal(launch.binary, path.join(root, "bin", "codex"));
	assert.equal(path.dirname(launch.cwd), path.join(root, "tmp"));
	assert.deepEqual(fs.readdirSync(launch.cwd), []);
	const instructions = JSON.parse(configValue(launch.args, "model_instructions_file")!) as string;
	assert.equal(fs.readFileSync(instructions, "utf8"), "You are a tutor.");
	assert.equal(fs.statSync(instructions).mode & 0o777, 0o600);
	assert.equal(launch.env.LH_CODEX_BRIDGE_TOKEN, "bridge-token");
	assert.ok(!launch.args.some((arg) => arg.includes("bridge-token")), "the token is never an argument");
	assert.equal(launch.env.CODEX_HOME, undefined, "no home named: Codex finds its own");
	assertNoServerAccess(launch.env);
	assert.equal(launch.stdin, "hi");
	await launch.cleanup();
	assert.deepEqual(fs.readdirSync(path.join(root, "tmp")), []);
});

test("a named Codex home becomes CODEX_HOME", async (t) => {
	sandbox(t);
	const launch = await codexDialect.prepare({ ...INPUT, home: "/tmp/peer/second-login" });
	t.after(() => launch.cleanup());
	assert.equal(launch.env.CODEX_HOME, "/tmp/peer/second-login");
});

function signedInHome(root: string): string {
	const home = path.join(root, "learner");
	const gemini = path.join(home, ".gemini");
	fs.mkdirSync(path.join(gemini, "antigravity-cli"), { recursive: true });
	fs.writeFileSync(path.join(gemini, "antigravity-cli", "antigravity-oauth-token"), "token");
	fs.writeFileSync(path.join(gemini, "oauth_creds.json"), "{}");
	fs.writeFileSync(path.join(gemini, "settings.json"), JSON.stringify({ security: { auth: "oauth" }, mcpServers: { own: {} }, theme: "dark" }));
	fs.writeFileSync(path.join(gemini, "GEMINI.md"), "my own instructions");
	return home;
}

test("an Antigravity turn runs in a private home holding only the sign-in links, its security choice and the bridge", async (t) => {
	const root = sandbox(t);
	const home = signedInHome(root);
	const launch = await agyDialect.prepare({ ...INPUT, home });
	const privateHome = launch.env.HOME!;
	const gemini = path.join(privateHome, ".gemini");
	assert.equal(path.dirname(privateHome), path.join(root, "tmp"));
	assert.equal(launch.cwd, path.join(privateHome, "work"));
	assert.deepEqual(fs.readdirSync(gemini).sort(), ["antigravity-cli", "config", "oauth_creds.json", "settings.json"]);
	assert.equal(fs.readlinkSync(path.join(gemini, "antigravity-cli", "antigravity-oauth-token")), path.join(home, ".gemini", "antigravity-cli", "antigravity-oauth-token"));
	assert.equal(fs.readlinkSync(path.join(gemini, "oauth_creds.json")), path.join(home, ".gemini", "oauth_creds.json"));
	assert.deepEqual(JSON.parse(fs.readFileSync(path.join(gemini, "settings.json"), "utf8")), { security: { auth: "oauth" } });
	const mcp = path.join(gemini, "config", "mcp_config.json");
	assert.deepEqual(JSON.parse(fs.readFileSync(mcp, "utf8")), { mcpServers: { learnharness: { disabled: false, headers: { Authorization: "Bearer bridge-token" }, serverUrl: "http://127.0.0.1:1/mcp" } } });
	assert.equal(fs.statSync(mcp).mode & 0o777, 0o600);
	assertNoServerAccess(launch.env);
	assert.match(launch.stdin, /You are a tutor\.[\s\S]*hi/);
	await launch.cleanup();
	assert.deepEqual(fs.readdirSync(path.join(root, "tmp")), []);
	assert.equal(fs.readFileSync(path.join(home, ".gemini", "antigravity-cli", "antigravity-oauth-token"), "utf8"), "token", "the login itself is untouched");
});

test("an Antigravity home without a sign-in is refused before anything is created", async (t) => {
	const root = sandbox(t);
	await assert.rejects(agyDialect.prepare({ ...INPUT, home: path.join(root, "nobody") }), (error: unknown) => error instanceof CliLaunchError && /not signed in/.test(error.message));
	assert.deepEqual(fs.readdirSync(path.join(root, "tmp")), []);
});
