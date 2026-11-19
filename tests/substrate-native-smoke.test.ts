import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { assertNoForbiddenGpuLibraries, sanitizeComputeEnv } from "../src/substrate/hardware-guard.ts";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PERSIST_ROOT = process.env.PEER_PERSIST_ROOT ?? "/usr/lib/persist/peer";
const BUILD_ROOT = path.join(PERSIST_ROOT, "build");
const SCRATCH_BASE = path.join(PERSIST_ROOT, "scratch");
const REQUIRE_SUBSTRATE = process.env.PEER_REQUIRE_SUBSTRATE === "1";

const LJ_ARCHIVE_PATH = path.join(BUILD_ROOT, "lumberjack", "liblumberjack.a");
const MFN_GATEWAY_PATH = path.join(BUILD_ROOT, "mfn", "bin", "mfn-gateway");
const HAS_LJ_ARCHIVE = fs.existsSync(LJ_ARCHIVE_PATH);
const HAS_MFN_BINARIES = fs.existsSync(MFN_GATEWAY_PATH);

const EXPECTED_LJ_EXPORTS = [
	"ic_lj_abi_version",
	"ic_lj_adopt",
	"ic_lj_aggregate",
	"ic_lj_application_call",
	"ic_lj_application_configure",
	"ic_lj_application_free",
	"ic_lj_close",
	"ic_lj_echo",
	"ic_lj_event_append",
	"ic_lj_event_end",
	"ic_lj_event_entries",
	"ic_lj_event_plan",
	"ic_lj_event_start",
	"ic_lj_events_publish",
	"ic_lj_forest",
	"ic_lj_node_create",
	"ic_lj_open",
	"ic_lj_query",
	"ic_lj_stream_poll",
];

const MFN_BINARY_NAMES = ["ifr", "dsr", "alm", "cpe", "psr", "mfn-gateway"] as const;

const LJ_SMOKE_C = `
#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include "lumberjack.h"

#define REQ(s) (const char *)(s), (int64_t)strlen(s)

int main(int argc, char **argv) {
	assert(argc == 2);
	assert(ic_lj_abi_version() == LJ_ABI_VERSION);
	char open_req[512];
	snprintf(open_req, sizeof open_req,
		"organization: peer\\ndatabase_path: %s\\nname: state\\nprincipal: peer-system\\n", argv[1]);
	lj_handle_t h = 0;
	assert(ic_lj_open(REQ(open_req), &h) == LJ_OK);
	assert(h != 0);
	char out[LJ_MUTATION_OUT_MIN + 4096];
	int64_t len = -1;
	assert(ic_lj_node_create(h, REQ("path: knowledge/propositions/n1\\ntype: leaf\\n"), out, sizeof out, &len) == LJ_OK);
	assert(ic_lj_event_start(h, REQ("path: knowledge/propositions/n1\\nevent_id: ev1\\n"), out, sizeof out, &len) == LJ_OK);
	assert(ic_lj_event_append(h, REQ("path: knowledge/propositions/n1\\nevent_id: ev1\\ncontent: bayes-rule\\n"), out, sizeof out, &len) == LJ_OK);
	assert(ic_lj_event_end(h, REQ("path: knowledge/propositions/n1\\nevent_id: ev1\\n"), out, sizeof out, &len) == LJ_OK);
	assert(ic_lj_event_entries(h, REQ("path: knowledge/propositions/n1\\nevent_id: ev1\\n"), out, sizeof out, &len) == LJ_OK);
	out[len] = '\\0';
	assert(strstr(out, "bayes-rule") != NULL);
	assert(ic_lj_stream_poll(h, REQ("after: 0\\ntimeout_ms: 0\\n"), out, sizeof out, &len) == LJ_OK);
	assert(ic_lj_close(h) == LJ_OK);
	return 0;
}
`;

function createScratchDir(prefix: string): string {
	fs.mkdirSync(SCRATCH_BASE, { recursive: true, mode: 0o755 });
	const dir = path.join(SCRATCH_BASE, `${prefix}-${process.pid}-${randomBytes(4).toString("hex")}`);
	fs.mkdirSync(dir, { mode: 0o700 });
	return dir;
}

function getFreeLoopbackPort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const srv = net.createServer();
		srv.once("error", reject);
		srv.listen(0, "127.0.0.1", () => {
			const addr = srv.address();
			const port = typeof addr === "object" && addr ? addr.port : 0;
			srv.close((err) => (err ? reject(err) : resolve(port)));
		});
	});
}

function findReadyInLines(lines: string[]): { endpoint: string; ready: boolean } | null {
	for (const line of lines) {
		const trimmed = line.trim();
		if (trimmed.startsWith("{") && trimmed.includes('"endpoint"')) {
			return JSON.parse(trimmed) as { endpoint: string; ready: boolean };
		}
	}
	return null;
}

function waitForReadyLine(proc: ReturnType<typeof spawn>, timeoutMs: number): Promise<{ endpoint: string; ready: boolean }> {
	return new Promise((resolve, reject) => {
		let stdoutBuf = "";
		let stderrBuf = "";
		const timer = setTimeout(() => reject(new Error(`MFN readiness timeout; stderr=${stderrBuf}`)), timeoutMs);
		proc.stderr?.on("data", (chunk: Buffer) => { stderrBuf += chunk.toString("utf8"); });
		proc.stdout?.on("data", (chunk: Buffer) => {
			stdoutBuf += chunk.toString("utf8");
			const lines = stdoutBuf.split("\n");
			stdoutBuf = lines.pop() ?? "";
			const parsed = findReadyInLines(lines);
			if (!parsed) return;
			clearTimeout(timer);
			resolve(parsed);
		});
		proc.once("exit", (code) => {
			clearTimeout(timer);
			reject(new Error(`MFN exited early (${code}): ${stderrBuf}`));
		});
	});
}

function collectJsonResponse(
	res: http.IncomingMessage,
	onParsed: (value: { status: number; body: { status?: string } }) => void,
): void {
	const chunks: Buffer[] = [];
	res.on("data", (chunk: Buffer) => chunks.push(chunk));
	res.on("end", () => {
		const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { status?: string };
		onParsed({ status: res.statusCode ?? 0, body });
	});
}

function postMfnExecute(
	port: number,
	token: string,
	operation: string,
	timeoutMs = 5_000,
): Promise<{ status: number; body: { status?: string } }> {
	const request = { version: 2, request_id: `s0-${operation.replace(".", "-")}`, operation, payload: {}, timeout_ms: 5000 };
	const payload = JSON.stringify({ request });
	const headers = {
		Authorization: `Bearer ${token}`,
		Accept: "application/json",
		"Content-Type": "application/json",
		"Content-Length": Buffer.byteLength(payload),
		Connection: "close",
	};
	const opts = { hostname: "127.0.0.1", port, path: "/v2/execute", method: "POST", headers };
	return new Promise((resolve, reject) => {
		let settled = false;
		const finish = (fn: () => void) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			fn();
		};
		const req = http.request(opts, (res) => collectJsonResponse(res, (val) => finish(() => resolve(val))));
		const timer = setTimeout(() => {
			req.destroy();
			finish(() => reject(new Error(`postMfnExecute(${operation}) timed out after ${timeoutMs}ms`)));
		}, timeoutMs);
		req.once("error", (err) => finish(() => reject(err)));
		req.end(payload);
	});
}

function waitForExitOnSigterm(
	proc: ReturnType<typeof spawn>,
	timeoutMs: number,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			proc.kill("SIGKILL");
			reject(new Error(`Child pid=${proc.pid} failed to exit within ${timeoutMs}ms after SIGTERM`));
		}, timeoutMs);
		proc.once("exit", (code, signal) => {
			clearTimeout(timer);
			resolve({ code, signal });
		});
		proc.kill("SIGTERM");
	});
}

async function stopChild(
	proc: ReturnType<typeof spawn>,
	timeoutMs = 10_000,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
	const result = proc.exitCode === null && proc.signalCode === null
		? await waitForExitOnSigterm(proc, timeoutMs)
		: { code: proc.exitCode, signal: proc.signalCode };
	proc.stdout?.destroy();
	proc.stderr?.destroy();
	return result;
}

test(
	"LumberJack C-ABI v2 archive exports exact 19 functions and passes SSD C11 smoke",
	{ skip: !HAS_LJ_ARCHIVE && !REQUIRE_SUBSTRATE ? "prebuilt liblumberjack.a absent" : false },
	() => {
		const ljDir = path.join(BUILD_ROOT, "lumberjack");
		assert.equal(fs.existsSync(LJ_ARCHIVE_PATH), true, "missing liblumberjack.a");
		const nmOut = execFileSync("nm", ["-g", "--defined-only", LJ_ARCHIVE_PATH], { encoding: "utf8" });
		const rawNames = nmOut
			.split(/\r?\n/)
			.map((line) => line.trim().split(/\s+/))
			.filter((parts) => parts[1] === "T" && parts[2]?.startsWith("ic_lj_"))
			.map((parts) => parts[2] as string);
		assert.deepEqual([...new Set(rawNames)].sort(), EXPECTED_LJ_EXPORTS);

		const scratch = createScratchDir("s0-lj-smoke");
		try {
			const env = { ...sanitizeComputeEnv(process.env, "cpu"), TMPDIR: scratch };
			const cFile = path.join(scratch, "smoke.c");
			const binFile = path.join(scratch, "smoke");
			const dbDir = path.join(scratch, "forest");
			fs.mkdirSync(dbDir, { mode: 0o700 });
			fs.writeFileSync(cFile, LJ_SMOKE_C);
			execFileSync("gcc", ["-std=c11", "-Wall", "-Wextra", "-Werror", "-I", ljDir, "-o", binFile, cFile, LJ_ARCHIVE_PATH, "-lpthread", "-ldl", "-lresolv"], { env });
			assertNoForbiddenGpuLibraries("lumberjack-smoke", execFileSync("ldd", [binFile], { env, encoding: "utf8" }));
			execFileSync(binFile, [dbDir], { env });
		} finally {
			fs.rmSync(scratch, { recursive: true, force: true });
		}
	},
);

function spawnScratchMfnEngine(
	mfnBinDir: string,
	scratch: string,
	port: number,
	token: string,
	baseEnv: NodeJS.ProcessEnv,
): ReturnType<typeof spawn> {
	const dataDir = path.join(scratch, "data");
	const runtimeDir = path.join(scratch, "runtime");
	const secretsDir = path.join(scratch, "secrets");
	const tokenFile = path.join(secretsDir, "api-token");
	for (const d of [dataDir, runtimeDir, secretsDir]) fs.mkdirSync(d, { mode: 0o700 });
	fs.writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 });
	const engineEnv: NodeJS.ProcessEnv = { ...baseEnv, TMPDIR: scratch };
	for (const key of Object.keys(engineEnv)) {
		if (key.startsWith("MFN_")) delete engineEnv[key];
	}
	const scriptPath = path.join(REPO_ROOT, "extern", "mfn", "scripts", "mfn-engine.py");
	return spawn(
		"python3",
		[
			scriptPath, "--data-dir", dataDir, "--runtime-dir", runtimeDir, "--token-file", tokenFile, "--port", String(port),
			"--ifr", path.join(mfnBinDir, "ifr"), "--dsr", path.join(mfnBinDir, "dsr"),
			"--alm", path.join(mfnBinDir, "alm"), "--cpe", path.join(mfnBinDir, "cpe"),
			"--psr", path.join(mfnBinDir, "psr"), "--gateway", path.join(mfnBinDir, "mfn-gateway"),
		],
		{ env: engineEnv, stdio: ["ignore", "pipe", "pipe"] },
	);
}

test(
	"MFN 2.0 native CPU binaries link zero GPU libs, answer ping + health.get, and drain cleanly on SIGTERM",
	{ skip: !HAS_MFN_BINARIES && !REQUIRE_SUBSTRATE ? "prebuilt MFN binaries absent" : false },
	async () => {
		const mfnBinDir = path.join(BUILD_ROOT, "mfn", "bin");
		const env = sanitizeComputeEnv(process.env, "cpu");
		for (const name of MFN_BINARY_NAMES) {
			const binPath = path.join(mfnBinDir, name);
			assert.equal(fs.statSync(binPath).mode & 0o022, 0, `${name} must not be group/other writable`);
			assertNoForbiddenGpuLibraries(name, execFileSync("ldd", [binPath], { env, encoding: "utf8" }));
		}
		const scratch = createScratchDir("s0-mfn-smoke");
		const token = randomBytes(32).toString("hex");
		const port = await getFreeLoopbackPort();
		const proc = spawnScratchMfnEngine(mfnBinDir, scratch, port, token, env);
		let stopped = false;
		try {
			const ready = await waitForReadyLine(proc, 25_000);
			assert.equal(ready.ready, true);
			for (const op of ["ping", "health.get"]) {
				const res = await postMfnExecute(port, token, op, 5_000);
				assert.equal(res.status, 200, `${op} status`);
				assert.equal(res.body.status, "ok");
			}
			const exit = await stopChild(proc, 10_000);
			stopped = true;
			assert.equal(exit.code, 0, `expected clean SIGTERM exit code 0, got ${exit.code}`);
			assert.equal(exit.signal, null, `expected clean SIGTERM exit signal null, got ${exit.signal}`);
		} finally {
			if (!stopped) await stopChild(proc, 10_000).catch(() => undefined);
			fs.rmSync(scratch, { recursive: true, force: true });
		}
	},
);
