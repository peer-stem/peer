import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readApiConfig } from "../src/api/config.ts";
import { isMainModule, startApiServer } from "../src/api/main.ts";

const WORKTREE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MAIN_ENTRY = path.join(WORKTREE_ROOT, "src", "api", "main.ts");
const TSX_BIN = path.join(WORKTREE_ROOT, "node_modules", ".bin", "tsx");

const SCRATCH_ROOT = fs.existsSync("/usr/lib/persist/peer")
	? "/usr/lib/persist/peer/scratch"
	: path.join(WORKTREE_ROOT, ".fresh-data");
fs.mkdirSync(SCRATCH_ROOT, { recursive: true, mode: 0o700 });
const SCRATCH_DIR = fs.mkdtempSync(path.join(SCRATCH_ROOT, "api-config-"));
fs.chmodSync(SCRATCH_DIR, 0o700);

after(() => {
	fs.rmSync(SCRATCH_DIR, { recursive: true, force: true });
});

interface SpawnOutcome {
	code: number | null;
	signal: NodeJS.Signals | null;
	stderr: string;
}

function runMainWithoutPort(dataDir: string, authFile: string): Promise<SpawnOutcome> {
	const childEnv: NodeJS.ProcessEnv = {
		...process.env,
		TMPDIR: SCRATCH_DIR,
		LH_DATA_DIR: dataDir,
		LH_AUTH_FILE: authFile,
	};
	delete childEnv.PORT;

	return new Promise<SpawnOutcome>((resolve, reject) => {
		const child = spawn(TSX_BIN, [MAIN_ENTRY], {
			cwd: WORKTREE_ROOT,
			env: childEnv,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stderr = "";
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf8");
		});
		const killer = setTimeout(() => {
			if (child.pid !== undefined) process.kill(child.pid, "SIGKILL");
		}, 8000);
		killer.unref();
		child.on("error", (err) => {
			clearTimeout(killer);
			reject(err);
		});
		child.on("close", (code, signal) => {
			clearTimeout(killer);
			resolve({ code, signal, stderr });
		});
	});
}

test("readApiConfig rejects missing and invalid PORT values", () => {
	const invalidPorts: Array<string | undefined> = [
		undefined,
		"",
		"   ",
		"0",
		"-1",
		"65536",
		"abc",
		"3000.5",
	];
	for (const port of invalidPorts) {
		assert.throws(
			() => readApiConfig({ PORT: port }),
			{ message: "PORT is required and must be an integer between 1 and 65535" },
		);
	}
});

test("readApiConfig parses valid PORT and applies default or trimmed HOSTNAME", () => {
	assert.deepEqual(readApiConfig({ PORT: "1" }), {
		port: 1,
		hostname: "127.0.0.1",
		logLevel: "info",
	});
	assert.deepEqual(readApiConfig({ PORT: "65535", HOSTNAME: "   " }), {
		port: 65535,
		hostname: "127.0.0.1",
		logLevel: "info",
	});
	assert.deepEqual(readApiConfig({ PORT: "42100", HOSTNAME: "  localhost  " }), {
		port: 42100,
		hostname: "localhost",
		logLevel: "info",
	});
});

test("readApiConfig parses case-insensitive LH_LOG_LEVEL and rejects invalid levels", () => {
	assert.equal(readApiConfig({ PORT: "4100", LH_LOG_LEVEL: "" }).logLevel, "info");
	assert.equal(readApiConfig({ PORT: "4100", LH_LOG_LEVEL: "   " }).logLevel, "info");
	assert.equal(readApiConfig({ PORT: "4100", LH_LOG_LEVEL: "DEBUG" }).logLevel, "debug");
	assert.equal(readApiConfig({ PORT: "4100", LH_LOG_LEVEL: "Info" }).logLevel, "info");
	assert.equal(readApiConfig({ PORT: "4100", LH_LOG_LEVEL: "  WARN " }).logLevel, "warn");
	assert.equal(readApiConfig({ PORT: "4100", LH_LOG_LEVEL: "ErRoR" }).logLevel, "error");
	assert.equal(readApiConfig({ PORT: "4100", LH_LOG_LEVEL: "Silent" }).logLevel, "silent");

	assert.throws(
		() => readApiConfig({ PORT: "4100", LH_LOG_LEVEL: "verbose" }),
		/LH_LOG_LEVEL/,
	);
});

test("readApiConfig never reads or mutates gate or runtime environment variables", () => {
	const rawEnv: Record<string, string | undefined> = {
		PORT: "45123",
		LH_DESKTOP_SERVER: "1",
		LH_DESKTOP_API_SECRET: "secret-token",
		LH_ALLOWED_HOSTS: "peer.local",
		NODE_ENV: "production",
	};
	const snapshot = { ...rawEnv };
	const readKeys: string[] = [];
	const mutatedKeys: string[] = [];
	const proxied = new Proxy(rawEnv, {
		get(target, prop) {
			if (typeof prop === "string") readKeys.push(prop);
			return Reflect.get(target, prop);
		},
		set(target, prop, value) {
			if (typeof prop === "string") mutatedKeys.push(prop);
			return Reflect.set(target, prop, value);
		},
		deleteProperty(target, prop) {
			if (typeof prop === "string") mutatedKeys.push(prop);
			return Reflect.deleteProperty(target, prop);
		},
	});

	const config = readApiConfig(proxied);
	assert.equal(config.port, 45123);
	assert.deepEqual(new Set(readKeys), new Set(["PORT", "HOSTNAME", "LH_LOG_LEVEL"]));
	assert.deepEqual(mutatedKeys, []);
	assert.deepEqual(rawEnv, snapshot);
});

test("startApiServer rejects missing PORT before dynamic imports and isMainModule handles symlinks", async () => {
	await assert.rejects(
		() => startApiServer({}),
		{ message: "PORT is required and must be an integer between 1 and 65535" },
	);

	const linkPath = path.join(SCRATCH_DIR, "main-link.ts");
	fs.symlinkSync(MAIN_ENTRY, linkPath);
	const mainUrl = pathToFileURL(MAIN_ENTRY).href;
	assert.equal(isMainModule(mainUrl, linkPath), true);
	assert.equal(isMainModule(mainUrl, path.join(SCRATCH_DIR, "other.ts")), false);
	assert.equal(isMainModule(mainUrl, undefined), false);
});

test("main.ts CLI exits non-zero immediately without PORT and creates no auth.json", async () => {
	const dataDir = path.join(SCRATCH_DIR, "cli-data");
	const authFile = path.join(SCRATCH_DIR, "auth.json");

	const outcome = await runMainWithoutPort(dataDir, authFile);
	assert.notEqual(outcome.code, 0);
	assert.equal(outcome.code, 1);
	assert.match(outcome.stderr, /PORT is required and must be an integer between 1 and 65535/);
	assert.equal(fs.existsSync(authFile), false, "auth.json must not be created when PORT is missing");
	assert.equal(fs.existsSync(dataDir), false, "LH_DATA_DIR must not be created when PORT is missing");
});

function closeProbe(probe: net.Server): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		probe.close((err) => (err ? reject(err) : resolve()));
	});
}

async function findSparePort(): Promise<number> {
	const probe = net.createServer();
	await new Promise<void>((resolve, reject) => {
		probe.once("error", reject);
		probe.listen(0, "127.0.0.1", () => resolve());
	});
	const addr = probe.address();
	const port = typeof addr === "object" && addr !== null ? addr.port : 0;
	await closeProbe(probe);
	return port;
}

function probeHttpOnce(port: number): Promise<number | null> {
	return new Promise<number | null>((resolve) => {
		const req = http.get({ hostname: "127.0.0.1", port, path: "/" }, (res) => {
			res.resume();
			resolve(res.statusCode ?? 0);
		});
		req.on("error", () => resolve(null));
	});
}

async function waitUntilListening(port: number, maxAttempts = 80): Promise<number> {
	for (let i = 0; i < maxAttempts; i += 1) {
		const status = await probeHttpOnce(port);
		if (status !== null) return status;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error(`API server never answered on 127.0.0.1:${port}`);
}

test("main.ts CLI starts on explicit PORT and exits 0 within 3s on SIGTERM", async () => {
	const port = await findSparePort();
	assert.notEqual(port, 3000);
	assert.notEqual(port, 3901);
	const dataDir = path.join(SCRATCH_DIR, "sigterm-data");
	const authFile = path.join(SCRATCH_DIR, "sigterm-auth.json");
	fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });

	const child = spawn(TSX_BIN, [MAIN_ENTRY], {
		cwd: WORKTREE_ROOT,
		env: {
			...process.env,
			PORT: String(port),
			HOSTNAME: "127.0.0.1",
			LH_LOG_LEVEL: "info",
			TMPDIR: SCRATCH_DIR,
			LH_DATA_DIR: dataDir,
			LH_AUTH_FILE: authFile,
		},
		stdio: ["ignore", "pipe", "pipe"],
	});

	try {
		const status = await waitUntilListening(port);
		assert.equal(status > 0, true);
		const sigtermSentAt = Date.now();
		if (child.pid !== undefined) process.kill(child.pid, "SIGTERM");
		const exitCode = await new Promise<number | null>((resolve) => {
			child.once("close", (code) => resolve(code));
		});
		const elapsedMs = Date.now() - sigtermSentAt;
		assert.equal(exitCode, 0);
		assert.equal(elapsedMs < 3000, true, `expected SIGTERM exit < 3000ms, took ${elapsedMs}ms`);
	} finally {
		if (child.exitCode === null && child.pid !== undefined) {
			try { process.kill(child.pid, "SIGKILL"); } catch { /* already exited */ }
		}
	}
});

