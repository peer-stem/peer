import { spawn, type ChildProcessByStdio } from "node:child_process";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import type { Readable } from "node:stream";
import { PassThrough } from "node:stream";
import test, { after } from "node:test";
import { createLogger } from "../src/api/log.ts";
import { startApiServer } from "../src/api/main.ts";
import { WORKTREE_ROOT, buildScratchChildEnv, createScratchDir, installScratchProcessEnv } from "./api-test-helpers.ts";

const MAIN_ENTRY = path.join(WORKTREE_ROOT, "src", "api", "main.ts");
const SCRATCH_DIR = createScratchDir("api-main-");

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

async function runMainExpectFailure(
	homeDir: string,
	dataDir: string,
	authFile: string,
	extra?: Record<string, string | undefined>,
): Promise<SpawnOutcome> {
	const childEnv = buildScratchChildEnv({ homeDir, dataDir, authFile, extra });
	if (!extra || !("PORT" in extra)) delete childEnv.PORT;
	const child = spawnMainProcess(childEnv);
	const watcher = createStderrWatcher(child.stderr);
	const { code, signal } = await waitChildClose(child, 8_000);
	return { code, signal, stderr: watcher.text() };
}

async function findSparePort(): Promise<number> {
	const probe = net.createServer();
	await new Promise<void>((resolve, reject) => {
		probe.once("error", reject);
		probe.listen(0, "127.0.0.1", () => resolve());
	});
	const addr = probe.address();
	const port = typeof addr === "object" && addr !== null ? addr.port : 0;
	await new Promise<void>((resolve, reject) => probe.close((err) => (err ? reject(err) : resolve())));
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
	const baseHeaders = payload ? { "content-type": "application/json", "content-length": String(payload.length) } : {};
	const opts = { hostname: "127.0.0.1", port, method, path: urlPath, headers: { ...baseHeaders, ...extraHeaders } };
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => req.destroy(new Error(`HTTP ${method} ${urlPath} timed out after ${timeoutMs}ms`)), timeoutMs);
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
	const distDir = path.join(dataDir, "plugins", "crash-probe", "dist");
	fs.mkdirSync(distDir, { recursive: true, mode: 0o700 });
	const manifest = { apiVersion: 1, id: "crash-probe", name: "Crash Probe", version: "1.0.0", minAppVersion: "0.1.0", backend: "backend.cjs" };
	const backendSource = [
		'"use strict";',
		"exports.activate = function activate(ctx) {",
		'\tctx.handle("reject", () => { void Promise.reject(new Error("boom-unhandled-rejection")); return { triggered: "reject" }; });',
		'\tctx.handle("throw-async", () => { setImmediate(() => { throw new Error("boom-uncaught-exception"); }); return { triggered: "throw-async" }; });',
		"};\n",
	].join("\n");
	fs.writeFileSync(path.join(distDir, "manifest.json"), JSON.stringify(manifest), { mode: 0o600 });
	fs.writeFileSync(path.join(distDir, "backend.cjs"), backendSource, { mode: 0o600 });
	fs.writeFileSync(path.join(dataDir, "plugins-state.json"), JSON.stringify({ version: 1, enabled: { "crash-probe": true } }), { mode: 0o600 });
}

test("startApiServer rejects missing PORT and non-loopback HOSTNAME before binding (D3)", async () => {
	await assert.rejects(() => startApiServer({}), { message: "PORT is required and must be an integer between 1 and 65535" });
	const port = await findSparePort();
	const hostMsg = (h: string) => ({ message: `HOSTNAME must be a loopback address (127.0.0.0/8, ::1, or localhost); received "${h}"` });
	await assert.rejects(() => startApiServer({ PORT: String(port), HOSTNAME: "0.0.0.0" }), hostMsg("0.0.0.0"));
	await assert.rejects(() => startApiServer({ PORT: String(port), HOSTNAME: "::" }), hostMsg("::"));
	await assert.rejects(() => startApiServer({ PORT: "0", HOSTNAME: "0.0.0.0" }));
});

test("startApiServer logs plugin initialization failure and continues serving HTTP", async (t) => {
	const scratch = installScratchProcessEnv("api-main-plugin-fail-");
	t.after(() => scratch.restore());
	fs.mkdirSync(path.join(scratch.dataDir, "plugins"), { recursive: true, mode: 0o700 });
	fs.writeFileSync(path.join(scratch.dataDir, "plugins-state.json"), "{corrupt-json", { mode: 0o600 });
	const sink = new PassThrough();
	let logs = "";
	sink.setEncoding("utf8");
	sink.on("data", (chunk: string) => { logs += chunk; });
	const logger = createLogger({ level: "info", stream: sink });
	const port = await findSparePort();
	const running = await startApiServer({ PORT: String(port), HOSTNAME: "127.0.0.1" }, { logger });
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
	const scratch = installScratchProcessEnv("api-main-refusal-err-");
	t.after(() => scratch.restore());
	const sink = new PassThrough();
	let logs = "";
	sink.setEncoding("utf8");
	sink.on("data", (chunk: string) => { logs += chunk; });
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

test("main.ts CLI exits non-zero immediately on invalid PORT or non-loopback HOSTNAME without side effects", async () => {
	const authA = path.join(SCRATCH_DIR, "auth.json");
	const dataA = path.join(SCRATCH_DIR, "cli-data");
	const noPort = await runMainExpectFailure(path.join(SCRATCH_DIR, "cli-no-port-home"), dataA, authA);
	assert.equal(noPort.code, 1);
	assert.match(noPort.stderr, /PORT is required and must be an integer between 1 and 65535/);
	assert.equal(fs.existsSync(authA), false);
	assert.equal(fs.existsSync(dataA), false);

	const badHostData = path.join(SCRATCH_DIR, "cli-host-data");
	const badHostAuth = path.join(SCRATCH_DIR, "cli-host-auth.json");
	const badHost = await runMainExpectFailure(path.join(SCRATCH_DIR, "cli-host-home"), badHostData, badHostAuth, { PORT: "42100", HOSTNAME: "0.0.0.0" });
	assert.equal(badHost.code, 1);
	assert.match(badHost.stderr, /HOSTNAME must be a loopback address/);
	assert.equal(fs.existsSync(badHostAuth), false);
	assert.equal(fs.existsSync(badHostData), false);
});

test("main.ts CLI starts on explicit PORT and exits 0 cleanly within 3s on SIGTERM", async () => {
	const port = await findSparePort();
	assert.notEqual(port, 3000);
	assert.notEqual(port, 3901);
	const dataDir = path.join(SCRATCH_DIR, "sigterm-data");
	fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
	const extra = { PORT: String(port), HOSTNAME: "127.0.0.1", LH_LOG_LEVEL: "info" };
	const child = spawnMainProcess(buildScratchChildEnv({ homeDir: path.join(SCRATCH_DIR, "sigterm-home"), dataDir, authFile: path.join(SCRATCH_DIR, "sigterm-auth.json"), extra }));
	const stderr = createStderrWatcher(child.stderr);
	try {
		await stderr.waitFor("Engine API server listening");
		assert.equal((await httpJsonRequest(port, "GET", "/api/settings")).status, 200);
		const sigtermSentAt = Date.now();
		if (child.pid !== undefined) process.kill(child.pid, "SIGTERM");
		const { code } = await waitChildClose(child, 5_000);
		const elapsedMs = Date.now() - sigtermSentAt;
		assert.equal(code, 0);
		assert.ok(elapsedMs < 3000, `expected SIGTERM exit < 3000ms, took ${elapsedMs}ms`);
		assert.equal(stderr.text().includes("Forced"), false, `unexpected forced close log:\n${stderr.text()}`);
	} finally {
		if (child.exitCode === null) killPidQuietly(child.pid);
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
		assert.equal((await httpJsonRequest(port, "POST", "/api/plugins/crash-probe/call", { operation: "reject", input: {} })).status, 200);
		await stderr.waitFor("[api] Unhandled rejection");
		await stderr.waitFor("boom-unhandled-rejection");
		assert.equal((await httpJsonRequest(port, "POST", "/api/plugins/crash-probe/call", { operation: "throw-async", input: {} })).status, 200);
		await stderr.waitFor("[api] Uncaught exception");
		await stderr.waitFor("boom-uncaught-exception");
		assert.equal(child.exitCode, null, "server must stay alive after uncaught process errors");
		assert.equal((await httpJsonRequest(port, "GET", "/api/settings")).status, 200);
		if (child.pid !== undefined) process.kill(child.pid, "SIGTERM");
		assert.equal((await waitChildClose(child, 5_000)).code, 0);
	} finally {
		if (child.exitCode === null) killPidQuietly(child.pid);
	}
});
