import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import http from "node:http";
import net from "node:net";
import * as path from "node:path";
import { writeCliStubs, type ServerSide } from "./api-parity-stubs.ts";

export const WORKTREE_ROOT = path.resolve(import.meta.dirname, "..");
export const STANDALONE_DIR = path.join(WORKTREE_ROOT, ".next", "standalone");
export const STANDALONE_SERVER = path.join(STANDALONE_DIR, "server.js");
export const API_MAIN = path.join(WORKTREE_ROOT, "src", "api", "main.ts");
export const FIXTURES_DIR = path.join(WORKTREE_ROOT, "tests", "fixtures");
export const GOLDEN_DIR = path.join(FIXTURES_DIR, "golden-data");
export const PARITY_TMP_ROOT = fs.existsSync("/usr/lib/persist/peer")
	? "/usr/lib/persist/peer/scratch"
	: path.join(WORKTREE_ROOT, ".fresh-data");

const FORBIDDEN_PORTS = new Set([3000, 3901]);
const BOOT_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 120;
const SIGKILL_AFTER_MS = 3_000;

export interface GateEnvOptions {
	LH_DESKTOP_SERVER?: string;
	LH_DESKTOP_API_SECRET?: string;
	LH_ALLOWED_HOSTS?: string;
	readyHeaders?: Record<string, string>;
	readyExpectedStatus?: number;
}

export interface ServerInstance {
	side: ServerSide;
	pid: number;
	port: number;
	dataDir: string;
	authFile: string;
	logs: () => string;
	clearLogs: () => void;
	stop: () => Promise<{ elapsedMs: number; killedHard: boolean }>;
}

export interface ParityPair {
	runDir: string;
	binDir: string;
	next: ServerInstance;
	api: ServerInstance;
	stopAll: () => Promise<void>;
}

export function parityRunCheck(): { ok: true } | { ok: false; reason: string } {
	if (process.env.PEER_API_PARITY !== "1") {
		return { ok: false, reason: "Set PEER_API_PARITY=1 to run the dual-server API parity suite." };
	}
	if (!fs.existsSync(STANDALONE_SERVER)) {
		return { ok: false, reason: "Missing .next/standalone/server.js build output." };
	}
	return { ok: true };
}

function listenZeroOnce(): Promise<number> {
	return new Promise<number>((resolve, reject) => {
		const srv = net.createServer();
		srv.once("error", reject);
		srv.listen(0, "127.0.0.1", () => {
			const addr = srv.address();
			const port = typeof addr === "object" && addr ? addr.port : 0;
			srv.close((err) => (err ? reject(err) : resolve(port)));
		});
	});
}

export async function allocateSparePort(reserved: ReadonlySet<number> = new Set()): Promise<number> {
	for (let attempt = 0; attempt < 16; attempt++) {
		const port = await listenZeroOnce();
		if (port > 0 && !FORBIDDEN_PORTS.has(port) && !reserved.has(port)) return port;
	}
	throw new Error("Could not allocate an allowed spare loopback port");
}

export function seedCommunityPlugin(dataDir: string): void {
	const distDir = path.join(dataDir, "plugins", "document-one", "dist");
	const nestedDir = path.join(distDir, "assets", "nested");
	fs.mkdirSync(nestedDir, { recursive: true });
	const manifest = {
		apiVersion: 1,
		id: "document-one",
		name: "Document One",
		version: "1.0.0",
		minAppVersion: "0.4.1",
		main: "main.js",
		backend: "backend.cjs",
		styles: "styles.css",
	};
	fs.writeFileSync(path.join(distDir, "manifest.json"), `${JSON.stringify(manifest, null, "\t")}\n`);
	fs.writeFileSync(path.join(distDir, "main.js"), "export function activate() {}\n");
	const backendSrc = "module.exports = { activate(ctx) { ctx.handle(\"echo\", (input) => ({ echoed: input ?? null })); } };\n";
	fs.writeFileSync(path.join(distDir, "backend.cjs"), backendSrc);
	fs.writeFileSync(path.join(distDir, "styles.css"), ".doc-one { color: inherit; }\n");
	fs.writeFileSync(path.join(nestedDir, "info.txt"), "nested plugin asset\n");
}

export function seedDataCopy(dataDir: string): void {
	fs.cpSync(GOLDEN_DIR, dataDir, { recursive: true });
	seedCommunityPlugin(dataDir);
}

interface EnvInput {
	port: number;
	dataDir: string;
	authFile: string;
	homeDir: string;
	binDir: string;
	gate?: GateEnvOptions;
}

function buildAllowlistEnv(input: EnvInput): NodeJS.ProcessEnv {
	const tmpDir = path.join(input.homeDir, "tmp");
	const configHome = path.join(input.homeDir, ".config");
	const dataHome = path.join(input.homeDir, ".local", "share");
	const cacheHome = path.join(input.homeDir, ".cache");
	for (const dir of [input.homeDir, tmpDir, configHome, dataHome, cacheHome]) {
		fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	}
	const env: NodeJS.ProcessEnv = {
		NODE_ENV: "production",
		HOSTNAME: "127.0.0.1",
		PORT: String(input.port),
		LH_DATA_DIR: input.dataDir,
		LH_AUTH_FILE: input.authFile,
		LH_IGNORE_ENV_KEYS: "1",
		HOME: input.homeDir,
		XDG_CONFIG_HOME: configHome,
		XDG_DATA_HOME: dataHome,
		XDG_CACHE_HOME: cacheHome,
		TMPDIR: tmpDir,
		PATH: input.binDir,
	};
	if (input.gate?.LH_DESKTOP_SERVER !== undefined) env.LH_DESKTOP_SERVER = input.gate.LH_DESKTOP_SERVER;
	if (input.gate?.LH_DESKTOP_API_SECRET !== undefined) env.LH_DESKTOP_API_SECRET = input.gate.LH_DESKTOP_API_SECRET;
	if (input.gate?.LH_ALLOWED_HOSTS !== undefined) env.LH_ALLOWED_HOSTS = input.gate.LH_ALLOWED_HOSTS;
	return env;
}

function probeReadiness(port: number, headers?: Record<string, string>): Promise<number> {
	return new Promise<number>((resolve) => {
		const reqHeaders: Record<string, string> = {
			Host: headers?.Host ?? `127.0.0.1:${port}`,
			Connection: "close",
			...headers,
		};
		const opts = { hostname: "127.0.0.1", port, path: "/api/settings", method: "GET", headers: reqHeaders, agent: false };
		const req = http.request(opts, (res) => {
			res.resume();
			resolve(res.statusCode ?? 0);
		});
		req.on("error", () => resolve(0));
		req.setTimeout(2_500, () => {
			req.destroy();
			resolve(0);
		});
		req.end();
	});
}

function createLogCollector(child: ChildProcess): { read: () => string; clear: () => void } {
	const lines: string[] = [];
	const append = (chunk: Buffer | string) => {
		lines.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
		if (lines.length > 400) lines.splice(0, lines.length - 400);
	};
	child.stdout?.on("data", append);
	child.stderr?.on("data", append);
	return {
		read: () => lines.join(""),
		clear: () => { lines.length = 0; },
	};
}

function stopChildByPid(child: ChildProcess, isExited: () => boolean): Promise<{ elapsedMs: number; killedHard: boolean }> {
	const pid = child.pid;
	const started = Date.now();
	if (!pid || isExited()) return Promise.resolve({ elapsedMs: 0, killedHard: false });
	return new Promise((resolve) => {
		let killedHard = false;
		const finish = () => {
			clearTimeout(timer);
			resolve({ elapsedMs: Date.now() - started, killedHard });
		};
		child.once("exit", finish);
		const timer = setTimeout(() => {
			if (isExited()) return;
			killedHard = true;
			try { process.kill(pid, "SIGKILL"); } catch { /* exited */ }
		}, SIGKILL_AFTER_MS);
		try { process.kill(pid, "SIGTERM"); } catch { finish(); }
	});
}

async function waitUntilReady(
	port: number,
	expectedStatus: number,
	headers: Record<string, string> | undefined,
	isExited: () => boolean,
	readLogs: () => string,
): Promise<void> {
	const deadline = Date.now() + BOOT_TIMEOUT_MS;
	let lastStatus = 0;
	while (Date.now() < deadline) {
		if (isExited()) {
			throw new Error(`Server on port ${port} exited early:\n${readLogs().slice(-2000)}`);
		}
		lastStatus = await probeReadiness(port, headers);
		if (lastStatus === expectedStatus) return;
		await new Promise<void>((r) => setTimeout(r, POLL_INTERVAL_MS));
	}
	throw new Error(`Server on port ${port} missed readiness ${expectedStatus} (last=${lastStatus}):\n${readLogs().slice(-2000)}`);
}

interface SpawnSideSpec {
	side: ServerSide;
	runDir: string;
	binDir: string;
	reservedPorts: Set<number>;
	gate?: GateEnvOptions;
}

async function spawnSideOnce(spec: SpawnSideSpec): Promise<ServerInstance> {
	const port = await allocateSparePort(spec.reservedPorts);
	spec.reservedPorts.add(port);
	const dataDir = path.join(spec.runDir, `${spec.side}-data`);
	const authFile = path.join(spec.runDir, `${spec.side}-auth.json`);
	const homeDir = path.join(spec.runDir, "home", spec.side);
	const env = buildAllowlistEnv({ port, dataDir, authFile, homeDir, binDir: spec.binDir, gate: spec.gate });
	const args = spec.side === "next" ? [STANDALONE_SERVER] : ["--import", "tsx", API_MAIN];
	const cwd = spec.side === "next" ? STANDALONE_DIR : WORKTREE_ROOT;
	const child = spawn(process.execPath, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
	if (!child.pid) throw new Error(`Failed to spawn ${spec.side} server`);
	let exited = false;
	child.once("exit", () => { exited = true; });
	const collector = createLogCollector(child);
	let stopping: Promise<{ elapsedMs: number; killedHard: boolean }> | null = null;
	const stop = () => {
		stopping ??= stopChildByPid(child, () => exited);
		return stopping;
	};
	try {
		const expected = spec.gate?.readyExpectedStatus ?? 200;
		await waitUntilReady(port, expected, spec.gate?.readyHeaders, () => exited, collector.read);
	} catch (err) {
		await stop();
		throw err;
	}
	return {
		side: spec.side,
		pid: child.pid,
		port,
		dataDir,
		authFile,
		logs: collector.read,
		clearLogs: collector.clear,
		stop,
	};
}

async function spawnSideWithRetry(spec: SpawnSideSpec): Promise<ServerInstance> {
	try {
		return await spawnSideOnce(spec);
	} catch (firstErr) {
		const text = firstErr instanceof Error ? firstErr.message : String(firstErr);
		if (!text.includes("EADDRINUSE")) throw firstErr;
		return spawnSideOnce(spec);
	}
}

export async function startParityPair(gate?: GateEnvOptions): Promise<ParityPair> {
	fs.mkdirSync(PARITY_TMP_ROOT, { recursive: true, mode: 0o700 });
	const runDir = fs.mkdtempSync(path.join(PARITY_TMP_ROOT, "parity-"));
	fs.chmodSync(runDir, 0o700);
	const binDir = path.join(runDir, "bin");
	writeCliStubs(binDir);
	seedDataCopy(path.join(runDir, "next-data"));
	seedDataCopy(path.join(runDir, "api-data"));
	const reservedPorts = new Set<number>();
	let nextSrv: ServerInstance | null = null;
	let apiSrv: ServerInstance | null = null;
	try {
		nextSrv = await spawnSideWithRetry({ side: "next", runDir, binDir, reservedPorts, gate });
		apiSrv = await spawnSideWithRetry({ side: "api", runDir, binDir, reservedPorts, gate });
	} catch (err) {
		await Promise.allSettled([nextSrv?.stop(), apiSrv?.stop()]);
		if (process.env.PEER_KEEP_PARITY_RUN !== "1") fs.rmSync(runDir, { recursive: true, force: true });
		throw err;
	}
	const next = nextSrv;
	const api = apiSrv;
	return {
		runDir,
		binDir,
		next,
		api,
		stopAll: async () => {
			await Promise.allSettled([next.stop(), api.stop()]);
			if (process.env.PEER_KEEP_PARITY_RUN !== "1") fs.rmSync(runDir, { recursive: true, force: true });
		},
	};
}
