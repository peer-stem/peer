import { spawn, type ChildProcessByStdio } from "node:child_process";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import type { Readable } from "node:stream";
import { PassThrough } from "node:stream";
import test, { after } from "node:test";
import { pathToFileURL } from "node:url";
import { readApiConfig } from "../src/api/config.ts";
import { createLogger } from "../src/api/log.ts";
import { formatForcedExitLine, isMainModule, reportGateRefusal, reportRouteError, reportServerError, reportServerWarn, safeRequestPath, startApiServer } from "../src/api/main.ts";
import { WORKTREE_ROOT, buildScratchChildEnv, createScratchDir, installScratchProcessEnv } from "./api-test-helpers.ts";

const MAIN_ENTRY = path.join(WORKTREE_ROOT, "src", "api", "main.ts");
const SCRATCH_DIR = createScratchDir("api-config-");

after(() => {
	fs.rmSync(SCRATCH_DIR, { recursive: true, force: true });
});

interface SpawnOutcome {
	code: number | null;
	signal: NodeJS.Signals | null;
	stderr: string;
}

interface StderrWatcher {
	text: () => string;
	waitFor: (needle: string, timeoutMs?: number) => Promise<string>;
}

function waitBufferNeedle(
	readBuf: () => string,
	waiters: Set<() => void>,
	needle: string,
	timeoutMs: number,
): Promise<string> {
	if (readBuf().includes(needle)) return Promise.resolve(readBuf());
	return new Promise<string>((resolve, reject) => {
		const check = () => {
			if (!readBuf().includes(needle)) return;
			clearTimeout(timer);
			waiters.delete(check);
			resolve(readBuf());
		};
		const timer = setTimeout(() => {
			waiters.delete(check);
			reject(new Error(`Timed out waiting for stderr "${needle}". Got:\n${readBuf()}`));
		}, timeoutMs);
		waiters.add(check);
	});
}

function createStderrWatcher(stream: Readable): StderrWatcher {
	let buf = "";
	const waiters = new Set<() => void>();
	stream.on("data", (chunk: Buffer) => {
		buf += chunk.toString("utf8");
		for (const notify of waiters) notify();
	});
	return {
		text: () => buf,
		waitFor: (needle: string, timeoutMs = 10_000) => waitBufferNeedle(() => buf, waiters, needle, timeoutMs),
	};
}

function killPidQuietly(pid: number | undefined): void {
	if (pid === undefined) return;
	try { process.kill(pid, "SIGKILL"); } catch { /* exited */ }
}

function waitChildClose(
	child: ChildProcessByStdio<null, Readable, Readable>,
	timeoutMs = 5_000,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
	if (child.exitCode !== null || child.signalCode !== null) {
		return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
	}
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			killPidQuietly(child.pid);
			reject(new Error(`Child ${child.pid ?? "?"} did not exit within ${timeoutMs}ms`));
		}, timeoutMs);
		child.once("close", (code, signal) => {
			clearTimeout(timer);
			resolve({ code, signal });
		});
	});
}

function spawnMainProcess(env: NodeJS.ProcessEnv): ChildProcessByStdio<null, Readable, Readable> {
	return spawn(process.execPath, ["--import", "tsx", MAIN_ENTRY], {
		cwd: WORKTREE_ROOT,
		env,
		stdio: ["ignore", "pipe", "pipe"],
	});
}

async function runMainWithoutPort(homeDir: string, dataDir: string, authFile: string): Promise<SpawnOutcome> {
	const childEnv = buildScratchChildEnv({ homeDir, dataDir, authFile });
	delete childEnv.PORT;
	const child = spawnMainProcess(childEnv);
	const watcher = createStderrWatcher(child.stderr);
	const { code, signal } = await waitChildClose(child, 8_000);
	return { code, signal, stderr: watcher.text() };
}

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

function collectHttpJsonResponse(
	res: http.IncomingMessage,
	clearTimer: () => void,
	resolve: (v: { status: number; body: string }) => void,
	reject: (err: Error) => void,
): void {
	const chunks: Buffer[] = [];
	res.on("data", (chunk: Buffer) => chunks.push(chunk));
	res.on("end", () => {
		clearTimer();
		resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") });
	});
	res.on("error", (err) => {
		clearTimer();
		reject(err);
	});
}

function httpJsonRequest(
	port: number,
	method: string,
	urlPath: string,
	body?: unknown,
	timeoutMs = 5_000,
	extraHeaders?: Record<string, string>,
): Promise<{ status: number; body: string }> {
	const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), "utf8");
	const baseHeaders = payload
		? { "content-type": "application/json", "content-length": String(payload.length) }
		: {};
	const headers = { ...baseHeaders, ...extraHeaders };
	const opts = { hostname: "127.0.0.1", port, method, path: urlPath, headers };
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			req.destroy(new Error(`HTTP ${method} ${urlPath} timed out after ${timeoutMs}ms`));
		}, timeoutMs);
		const clearTimer = () => clearTimeout(timer);
		const req = http.request(opts, (res) => collectHttpJsonResponse(res, clearTimer, resolve, reject));
		req.on("error", (err) => {
			clearTimer();
			reject(err);
		});
		if (payload) req.write(payload);
		req.end();
	});
}

function seedCrashProbePlugin(dataDir: string): void {
	const pluginsRoot = path.join(dataDir, "plugins");
	const distDir = path.join(pluginsRoot, "crash-probe", "dist");
	fs.mkdirSync(distDir, { recursive: true, mode: 0o700 });
	const manifest = {
		apiVersion: 1,
		id: "crash-probe",
		name: "Crash Probe",
		version: "1.0.0",
		minAppVersion: "0.1.0",
		backend: "backend.cjs",
	};
	const backendSource = [
		'"use strict";',
		"exports.activate = function activate(ctx) {",
		'\tctx.handle("reject", () => {',
		'\t\tvoid Promise.reject(new Error("boom-unhandled-rejection"));',
		"\t\treturn { triggered: \"reject\" };",
		"\t});",
		'\tctx.handle("throw-async", () => {',
		"\t\tsetImmediate(() => {",
		'\t\t\tthrow new Error("boom-uncaught-exception");',
		"\t\t});",
		"\t\treturn { triggered: \"throw-async\" };",
		"\t});",
		"};",
		"",
	].join("\n");
	fs.writeFileSync(path.join(distDir, "manifest.json"), JSON.stringify(manifest), { mode: 0o600 });
	fs.writeFileSync(path.join(distDir, "backend.cjs"), backendSource, { mode: 0o600 });
	const state = { version: 1, enabled: { "crash-probe": true } };
	fs.writeFileSync(path.join(dataDir, "plugins-state.json"), JSON.stringify(state), { mode: 0o600 });
}

test("readApiConfig rejects missing and invalid PORT values", () => {
	const invalidPorts: Array<string | undefined> = [undefined, "", "   ", "0", "-1", "65536", "abc", "3000.5"];
	for (const port of invalidPorts) {
		assert.throws(
			() => readApiConfig({ PORT: port }),
			{ message: "PORT is required and must be an integer between 1 and 65535" },
		);
	}
});

test("readApiConfig parses valid PORT and applies default or trimmed HOSTNAME", () => {
	assert.deepEqual(readApiConfig({ PORT: "1" }), { port: 1, hostname: "127.0.0.1", logLevel: "info" });
	assert.deepEqual(readApiConfig({ PORT: "65535", HOSTNAME: "   " }), { port: 65535, hostname: "127.0.0.1", logLevel: "info" });
	assert.deepEqual(readApiConfig({ PORT: "42100", HOSTNAME: "  localhost  " }), { port: 42100, hostname: "localhost", logLevel: "info" });
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

test("typed main.ts reporters format structured events and strip URL query strings", async () => {
	const sink = new PassThrough();
	let output = "";
	sink.setEncoding("utf8");
	sink.on("data", (chunk: string) => {
		output += chunk;
	});
	const logger = createLogger({ level: "debug", stream: sink });

	reportRouteError(logger)(
		new Error("route-boom"),
		new Request("http://127.0.0.1:4100/api/keys?secret=top-secret-query", { method: "POST" }),
	);
	reportServerError(logger, "[api] Transport error")(new Error("socket-boom"));
	reportServerWarn(logger)("Body capped warning");
	reportGateRefusal(logger)("DELETE", "/api/chats/c1");
	assert.equal(safeRequestPath("http://127.0.0.1/api/search?q=private"), "/api/search");
	assert.equal(safeRequestPath(":::bad-url?token=leak"), "/:::bad-url");
	assert.equal(safeRequestPath("http://[invalid?token=leak"), "http://[invalid");
	await logger.flush();

	assert.equal(output.includes("top-secret-query"), false);
	assert.equal(output.includes("leak"), false);
	const records = output.trim().split("\n").map((line) => JSON.parse(line) as {
		message?: string;
		fields?: Record<string, unknown>;
	});
	assert.equal(records.length, 4);
	assert.equal(records[0]?.message, "[api] Unhandled route error");
	assert.equal(records[0]?.fields?.path, "/api/keys");
	assert.equal(records[0]?.fields?.url, undefined);
	assert.equal(records[1]?.message, "[api] Transport error");
	assert.equal(records[2]?.message, "Body capped warning");
	assert.equal(records[3]?.message, "[api] Gate refused request");
	assert.equal(records[3]?.fields?.path, "/api/chats/c1");
	const forced = JSON.parse(formatForcedExitLine()) as Record<string, unknown>;
	assert.equal(typeof forced.timestamp, "string");
	assert.equal(forced.level, "warn");
	assert.match(String(forced.message), /\[api\] Forced process exit after 2500ms shutdown deadline\./);
	assert.equal("ts" in forced || "msg" in forced, false);
});

test("startApiServer logs plugin initialization failure and continues serving HTTP", async (t) => {
	const scratch = installScratchProcessEnv("api-config-plugin-fail-");
	t.after(() => scratch.restore());
	fs.mkdirSync(path.join(scratch.dataDir, "plugins"), { recursive: true, mode: 0o700 });
	fs.writeFileSync(path.join(scratch.dataDir, "plugins-state.json"), "{corrupt-json", { mode: 0o600 });

	const sink = new PassThrough();
	let logs = "";
	sink.setEncoding("utf8");
	sink.on("data", (chunk: string) => {
		logs += chunk;
	});
	const logger = createLogger({ level: "info", stream: sink });
	const port = await findSparePort();
	const running = await startApiServer(
		{ PORT: String(port), HOSTNAME: "127.0.0.1" },
		{ logger },
	);
	try {
		const res = await httpJsonRequest(running.port, "GET", "/api/settings");
		assert.equal(res.status, 200);
	} finally {
		await running.close();
	}
	assert.match(logs, /\[plugins\] Initialization failed; plugin management will report the error:/);
	assert.match(logs, /Engine API server listening/);
});

test("httpJsonRequest destroys stalled sockets after timeoutMs", async (t) => {
	const sockets = new Set<net.Socket>();
	const stalled = net.createServer((sock) => {
		sockets.add(sock);
		sock.on("close", () => sockets.delete(sock));
	});
	t.after(() => {
		for (const sock of sockets) sock.destroy();
		stalled.close();
	});
	await new Promise<void>((resolve) => stalled.listen(0, "127.0.0.1", () => resolve()));
	const port = (stalled.address() as net.AddressInfo).port;
	await assert.rejects(() => httpJsonRequest(port, "GET", "/stall", undefined, 80), /timed out after 80ms/);
});

test("startApiServer wires onRefusal warning and runtime server error listener without crashing", async (t) => {
	const scratch = installScratchProcessEnv("api-config-refusal-err-");
	t.after(() => scratch.restore());
	const sink = new PassThrough();
	let logs = "";
	sink.setEncoding("utf8");
	sink.on("data", (chunk: string) => {
		logs += chunk;
	});
	const logger = createLogger({ level: "info", stream: sink });
	const port = await findSparePort();
	const running = await startApiServer({ PORT: String(port), HOSTNAME: "127.0.0.1" }, { logger });
	try {
		const refused = await httpJsonRequest(running.port, "POST", "/api/chats", { title: "Cross-Site" }, 5_000, { Origin: "http://evil.example" });
		assert.equal(refused.status, 403);
		running.server.emit("error", new Error("synthetic-listen-fault"));
		const ok = await httpJsonRequest(running.port, "GET", "/api/settings");
		assert.equal(ok.status, 200);
	} finally {
		await running.close();
	}
	const records = logs.trim().split("\n").map((line) => JSON.parse(line) as { level?: string; message?: string; fields?: Record<string, unknown> });
	const refusalLog = records.find((r) => r.message === "[api] Gate refused request");
	assert.equal(refusalLog?.level, "warn");
	assert.deepEqual(refusalLog?.fields, { method: "POST", path: "/api/chats" });
	const srvErrLog = records.find((r) => r.message === "[api] Server error");
	assert.equal(srvErrLog?.level, "error");
	assert.equal((srvErrLog?.fields?.error as { message?: string } | undefined)?.message, "synthetic-listen-fault");
});

test("main.ts CLI exits non-zero immediately without PORT and creates no auth.json", async () => {
	const homeDir = path.join(SCRATCH_DIR, "cli-no-port-home");
	const dataDir = path.join(SCRATCH_DIR, "cli-data");
	const authFile = path.join(SCRATCH_DIR, "auth.json");

	const outcome = await runMainWithoutPort(homeDir, dataDir, authFile);
	assert.equal(outcome.code, 1);
	assert.match(outcome.stderr, /PORT is required and must be an integer between 1 and 65535/);
	assert.equal(fs.existsSync(authFile), false, "auth.json must not be created when PORT is missing");
	assert.equal(fs.existsSync(dataDir), false, "LH_DATA_DIR must not be created when PORT is missing");
});

test("main.ts CLI starts on explicit PORT and exits 0 cleanly within 3s on SIGTERM", async () => {
	const port = await findSparePort();
	assert.notEqual(port, 3000);
	assert.notEqual(port, 3901);
	const homeDir = path.join(SCRATCH_DIR, "sigterm-home");
	const dataDir = path.join(SCRATCH_DIR, "sigterm-data");
	const authFile = path.join(SCRATCH_DIR, "sigterm-auth.json");
	fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });

	const child = spawnMainProcess(buildScratchChildEnv({
		homeDir,
		dataDir,
		authFile,
		extra: { PORT: String(port), HOSTNAME: "127.0.0.1", LH_LOG_LEVEL: "info" },
	}));
	const stderr = createStderrWatcher(child.stderr);
	try {
		await stderr.waitFor("Engine API server listening");
		const probe = await httpJsonRequest(port, "GET", "/api/settings");
		assert.equal(probe.status, 200);
		const sigtermSentAt = Date.now();
		if (child.pid !== undefined) process.kill(child.pid, "SIGTERM");
		const { code } = await waitChildClose(child, 5_000);
		const elapsedMs = Date.now() - sigtermSentAt;
		assert.equal(code, 0);
		assert.equal(elapsedMs < 3000, true, `expected SIGTERM exit < 3000ms, took ${elapsedMs}ms`);
		assert.equal(stderr.text().includes("Forced"), false, `unexpected forced close log:\n${stderr.text()}`);
	} finally {
		if (child.exitCode === null && child.pid !== undefined) {
			try { process.kill(child.pid, "SIGKILL"); } catch { /* already exited */ }
		}
	}
});

test("main.ts CLI logs uncaughtException and unhandledRejection and continues serving", async () => {
	const port = await findSparePort();
	const homeDir = path.join(SCRATCH_DIR, "crash-home");
	const dataDir = path.join(SCRATCH_DIR, "crash-data");
	const authFile = path.join(SCRATCH_DIR, "crash-auth.json");
	seedCrashProbePlugin(dataDir);

	const child = spawnMainProcess(buildScratchChildEnv({
		homeDir,
		dataDir,
		authFile,
		extra: { PORT: String(port), HOSTNAME: "127.0.0.1", LH_LOG_LEVEL: "info" },
	}));
	const stderr = createStderrWatcher(child.stderr);
	try {
		await stderr.waitFor("Engine API server listening");
		const rejRes = await httpJsonRequest(port, "POST", "/api/plugins/crash-probe/call", {
			operation: "reject",
			input: {},
		});
		assert.equal(rejRes.status, 200);
		await stderr.waitFor("[api] Unhandled rejection");
		await stderr.waitFor("boom-unhandled-rejection");

		const excRes = await httpJsonRequest(port, "POST", "/api/plugins/crash-probe/call", {
			operation: "throw-async",
			input: {},
		});
		assert.equal(excRes.status, 200);
		await stderr.waitFor("[api] Uncaught exception");
		await stderr.waitFor("boom-uncaught-exception");

		assert.equal(child.exitCode, null, "server must stay alive after uncaught process errors");
		const health = await httpJsonRequest(port, "GET", "/api/settings");
		assert.equal(health.status, 200);

		if (child.pid !== undefined) process.kill(child.pid, "SIGTERM");
		const { code } = await waitChildClose(child, 5_000);
		assert.equal(code, 0);
	} finally {
		if (child.exitCode === null && child.pid !== undefined) {
			try { process.kill(child.pid, "SIGKILL"); } catch { /* already exited */ }
		}
	}
});
