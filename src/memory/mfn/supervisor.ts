import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { sanitizeComputeEnv, type ComputeBackend } from "../../substrate/hardware-guard.ts";
import { MfnClient } from "./client.ts";
import { writePrivateFile0600 } from "./embedder-pin.ts";

export interface MfnReadinessInfo {
	endpoint: string;
	state: string;
	ready: boolean;
}

export interface MfnSupervisorOptions {
	repoRoot: string;
	stateRoot: string;
	binDir: string;
	port: number;
	backend?: ComputeBackend;
	embeddersFile?: string;
	almConfigFile?: string;
	startupTimeoutMs?: number;
	shutdownTimeoutMs?: number;
	pythonBin?: string;
	scriptPath?: string;
	env?: NodeJS.ProcessEnv;
}

interface SupervisorLayout {
	dataDir: string;
	runtimeDir: string;
	scratchDir: string;
	tokenFile: string;
	token: string;
}

const MAX_UNIX_SOCKET_BYTES = 108;
const TOKEN_VISIBLE_RE = /^[A-Za-z0-9._~+/-]{32,4096}=*$/;
const NUMERIC_PID_RE = /^[1-9][0-9]*$/;
const ALLOWED_SUPERVISOR_ENV_KEYS = [
	"PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "LC_CTYPE",
	"TZ", "NODE_ENV", "SSL_CERT_FILE", "SSL_CERT_DIR", "XDG_RUNTIME_DIR", "PEER_PERSIST_ROOT",
] as const;

function assertCleanAbsoluteDir(dirPath: string, label: string): void {
	if (!path.isAbsolute(dirPath) || dirPath.split(path.sep).includes("..")) {
		throw new Error(`${label} must be a clean absolute path: ${dirPath}`);
	}
	if (dirPath === "/tmp" || dirPath.startsWith("/tmp/")) {
		throw new Error(`${label} must not reside on /tmp tmpfs: ${dirPath}`);
	}
}

function ensurePrivateDir0700(dirPath: string): void {
	fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });
	const stat = fs.lstatSync(dirPath);
	if (!stat.isDirectory() || stat.isSymbolicLink()) {
		throw new Error(`Expected real private directory: ${dirPath}`);
	}
	fs.chmodSync(dirPath, 0o700);
}

function loadOrMintToken(tokenFile: string): string {
	if (fs.existsSync(tokenFile)) {
		const stat = fs.lstatSync(tokenFile);
		if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600) {
			throw new Error(`Unsafe MFN token file: ${tokenFile}`);
		}
		const existing = fs.readFileSync(tokenFile, "utf8").replace(/\n$/, "");
		if (!TOKEN_VISIBLE_RE.test(existing)) {
			throw new Error("Existing MFN token violates length or character rules");
		}
		return existing;
	}
	const minted = randomBytes(32).toString("hex");
	writePrivateFile0600(tokenFile, `${minted}\n`);
	return minted;
}

export function buildMfnSupervisorEnv(
	sourceEnv: NodeJS.ProcessEnv = process.env,
	backend: ComputeBackend = "cpu",
	tmpDir?: string,
): NodeJS.ProcessEnv {
	const allowlisted: Record<string, string | undefined> = {};
	for (const key of ALLOWED_SUPERVISOR_ENV_KEYS) {
		const val = sourceEnv[key];
		if (typeof val === "string") allowlisted[key] = val;
	}
	const clean = sanitizeComputeEnv(allowlisted as NodeJS.ProcessEnv, backend);
	if (tmpDir) {
		assertCleanAbsoluteDir(tmpDir, "tmpDir");
		clean.TMPDIR = tmpDir;
	}
	return clean;
}

export function parseMfnReadyLine(line: string): MfnReadinessInfo | null {
	const trimmed = line.trim();
	if (!trimmed.startsWith("{")) return null;
	try {
		const parsed = JSON.parse(trimmed) as { endpoint?: unknown; state?: unknown; ready?: unknown };
		if (typeof parsed.endpoint !== "string" || typeof parsed.ready !== "boolean") return null;
		return {
			endpoint: parsed.endpoint,
			state: typeof parsed.state === "string" ? parsed.state : "unknown",
			ready: parsed.ready,
		};
	} catch {
		return null;
	}
}

export function prepareMfnSupervisorLayout(stateRoot: string): SupervisorLayout {
	assertCleanAbsoluteDir(stateRoot, "stateRoot");
	const dataDir = path.join(stateRoot, "data");
	const runtimeDir = path.join(stateRoot, "runtime");
	const secretsDir = path.join(stateRoot, "secrets");
	const scratchDir = path.join(stateRoot, "scratch");
	const sockBytes = Buffer.byteLength(path.join(runtimeDir, "layer5.sock"), "utf8");
	if (sockBytes >= MAX_UNIX_SOCKET_BYTES) {
		throw new Error(`MFN runtime socket path (${sockBytes} bytes) exceeds 107-byte Unix sun_path limit`);
	}
	ensurePrivateDir0700(stateRoot);
	ensurePrivateDir0700(dataDir);
	ensurePrivateDir0700(runtimeDir);
	ensurePrivateDir0700(secretsDir);
	ensurePrivateDir0700(scratchDir);
	const tokenFile = path.join(secretsDir, "api-token");
	return { dataDir, runtimeDir, scratchDir, tokenFile, token: loadOrMintToken(tokenFile) };
}

function buildEngineCliArgs(opts: MfnSupervisorOptions, layout: SupervisorLayout): string[] {
	assertCleanAbsoluteDir(opts.repoRoot, "repoRoot");
	assertCleanAbsoluteDir(opts.binDir, "binDir");
	if (!Number.isSafeInteger(opts.port) || opts.port < 1 || opts.port > 65535) {
		throw new Error(`Invalid MFN port: ${opts.port}`);
	}
	const script = opts.scriptPath ?? path.join(opts.repoRoot, "extern", "mfn", "scripts", "mfn-engine.py");
	const args = [
		script, "--data-dir", layout.dataDir, "--runtime-dir", layout.runtimeDir,
		"--token-file", layout.tokenFile, "--port", String(opts.port),
		"--ifr", path.join(opts.binDir, "ifr"), "--dsr", path.join(opts.binDir, "dsr"),
		"--alm", path.join(opts.binDir, "alm"), "--cpe", path.join(opts.binDir, "cpe"),
		"--psr", path.join(opts.binDir, "psr"), "--gateway", path.join(opts.binDir, "mfn-gateway"),
	];
	if (opts.embeddersFile) args.push("--embedders-file", opts.embeddersFile);
	if (opts.almConfigFile) args.push("--alm-config-file", opts.almConfigFile);
	return args;
}

function scanStdoutChunk(
	stdoutBuf: string,
	onReady: (info: MfnReadinessInfo) => void,
	onFail: (err: Error) => void,
): string {
	const lines = stdoutBuf.split("\n");
	const rest = lines.pop() ?? "";
	for (const line of lines) {
		const info = parseMfnReadyLine(line);
		if (!info) continue;
		if (!info.ready) onFail(new Error(`MFN engine reported ready=false (state=${info.state})`));
		else onReady(info);
		return rest;
	}
	return rest;
}

function waitForChildReady(
	proc: ChildProcess,
	timeoutMs: number,
	appendStderr: (text: string) => void,
): Promise<MfnReadinessInfo> {
	return new Promise((resolve, reject) => {
		let stdoutBuf = "";
		let stderrBuf = "";
		let settled = false;
		const finish = (fn: () => void) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			fn();
		};
		const timer = setTimeout(() => finish(() => reject(new Error(`MFN readiness timed out; stderr=${stderrBuf}`))), timeoutMs);
		proc.stderr?.on("data", (chunk: Buffer) => {
			const text = chunk.toString("utf8");
			appendStderr(text);
			stderrBuf = (stderrBuf + text).slice(-8_192);
		});
		const onReady = (info: MfnReadinessInfo) => finish(() => resolve(info));
		const onFail = (err: Error) => finish(() => reject(err));
		proc.stdout?.on("data", (chunk: Buffer) => {
			stdoutBuf = scanStdoutChunk(stdoutBuf + chunk.toString("utf8"), onReady, onFail);
		});
		proc.once("error", (err) => finish(() => reject(err)));
		proc.once("exit", (code, sig) => finish(() => reject(new Error(`MFN exited early (${code ?? sig}): ${stderrBuf}`))));
	});
}

function forceKillRunning(proc: ChildProcess): boolean {
	if (proc.exitCode !== null || proc.signalCode !== null) return false;
	proc.kill("SIGKILL");
	return true;
}

function waitProcessExit(proc: ChildProcess, timeoutMs: number): Promise<boolean> {
	return new Promise<boolean>((resolve) => {
		let escalated = false;
		const killTimer = setTimeout(() => {
			escalated = forceKillRunning(proc);
		}, timeoutMs);
		proc.once("exit", () => {
			clearTimeout(killTimer);
			resolve(escalated);
		});
		proc.kill("SIGTERM");
	});
}

async function terminateChildProcess(proc: ChildProcess, timeoutMs: number): Promise<boolean> {
	let escalated = false;
	if (proc.exitCode === null && proc.signalCode === null) {
		escalated = await waitProcessExit(proc, timeoutMs);
	}
	proc.stdout?.removeAllListeners();
	proc.stderr?.removeAllListeners();
	proc.stdout?.destroy();
	proc.stderr?.destroy();
	return escalated;
}

interface ProcStatInfo {
	uid: number;
	state: string;
	ppid: number;
	startTime: string;
}

function readProcStatInfo(pid: number): ProcStatInfo | null {
	try {
		const st = fs.statSync(`/proc/${pid}`);
		const raw = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
		const rparen = raw.lastIndexOf(")");
		if (rparen < 0) return null;
		const fields = raw.slice(rparen + 2).trim().split(/\s+/);
		const startTime = fields[19] ?? "";
		if (!startTime) return null;
		return { uid: st.uid, state: fields[0] ?? "", ppid: Number(fields[1] ?? "0"), startTime };
	} catch {
		return null;
	}
}

function hasRuntimeEnviron(pid: number, targetEnvEntry: string): boolean {
	try {
		const envRaw = fs.readFileSync(`/proc/${pid}/environ`, "utf8");
		return envRaw.split("\0").includes(targetEnvEntry);
	} catch {
		return false;
	}
}

function collectRuntimeChildren(
	runtimeDir: string,
	parentPid?: number,
	tracked?: ReadonlyMap<number, string>,
): Map<number, string> {
	const found = new Map<number, string>();
	if (!fs.existsSync("/proc")) return found;
	const myUid = process.getuid?.();
	const targetEntry = `MFN_RUNTIME_DIR=${runtimeDir}`;
	let entries: string[];
	try {
		entries = fs.readdirSync("/proc");
	} catch {
		return found;
	}
	for (const entry of entries) {
		if (!NUMERIC_PID_RE.test(entry)) continue;
		const pid = Number(entry);
		if (pid === process.pid || pid === parentPid) continue;
		const info = readProcStatInfo(pid);
		if (!info || info.state === "Z") continue;
		if (myUid !== undefined && info.uid !== myUid) continue;
		const isTracked = tracked?.get(pid) === info.startTime;
		const isDirectChild = parentPid !== undefined && info.ppid === parentPid;
		if (isTracked || isDirectChild || hasRuntimeEnviron(pid, targetEntry)) {
			found.set(pid, info.startTime);
		}
	}
	return found;
}

export function findRuntimeOrphanPids(runtimeDir: string, excludePid?: number): number[] {
	return [...collectRuntimeChildren(runtimeDir, excludePid).keys()];
}

function signalPids(pids: readonly number[], sig: NodeJS.Signals): void {
	for (const pid of pids) {
		try {
			process.kill(pid, sig);
		} catch {
			// Process already exited.
		}
	}
}

function delayMs(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function reapRuntimeOrphans(
	runtimeDir: string,
	tracked: Map<number, string>,
	graceMs = 250,
): Promise<number> {
	const initial = collectRuntimeChildren(runtimeDir, undefined, tracked);
	if (initial.size === 0) {
		tracked.clear();
		return 0;
	}
	signalPids([...initial.keys()], "SIGTERM");
	const deadline = Date.now() + graceMs;
	while (Date.now() < deadline) {
		if (collectRuntimeChildren(runtimeDir, undefined, initial).size === 0) {
			tracked.clear();
			return initial.size;
		}
		await delayMs(20);
	}
	const survivors = collectRuntimeChildren(runtimeDir, undefined, initial);
	if (survivors.size > 0) {
		signalPids([...survivors.keys()], "SIGKILL");
		const killDeadline = Date.now() + 120;
		while (Date.now() < killDeadline && collectRuntimeChildren(runtimeDir, undefined, initial).size > 0) {
			await delayMs(15);
		}
	}
	tracked.clear();
	return initial.size;
}

interface SupervisorState {
	readonly opts: MfnSupervisorOptions;
	child: ChildProcess | null;
	tokenValue: string | null;
	runtimeDir: string | null;
	readiness: MfnReadinessInfo | null;
	stderrTail: string;
	nodeExitHook: (() => void) | null;
	pendingReap: Promise<number> | null;
	trackedChildren: Map<number, string>;
}

function isSupervisorRunning(state: SupervisorState): boolean {
	return state.child !== null && state.child.exitCode === null && state.child.signalCode === null && state.readiness !== null;
}

function detachNodeExitHook(state: SupervisorState): void {
	if (!state.nodeExitHook) return;
	process.off("exit", state.nodeExitHook);
	state.nodeExitHook = null;
}

function killChildBestEffort(child: ChildProcess | null): void {
	if (!child || child.exitCode !== null || child.signalCode !== null) return;
	try {
		child.kill("SIGTERM");
	} catch {
		// Ignore shutdown race.
	}
}

function snapshotOwnedChildren(state: SupervisorState, runtimeDir: string, parentPid?: number): void {
	const fresh = collectRuntimeChildren(runtimeDir, parentPid, state.trackedChildren);
	for (const [pid, start] of fresh) {
		state.trackedChildren.set(pid, start);
	}
}

function attachProcessGuards(state: SupervisorState, proc: ChildProcess, runtimeDir: string): void {
	detachNodeExitHook(state);
	const onNodeExit = () => {
		snapshotOwnedChildren(state, runtimeDir, proc.pid);
		killChildBestEffort(state.child);
		signalPids([...state.trackedChildren.keys()], "SIGTERM");
	};
	state.nodeExitHook = onNodeExit;
	process.on("exit", onNodeExit);
	proc.once("exit", () => {
		if (state.child !== proc) return;
		state.child = null;
		state.readiness = null;
		detachNodeExitHook(state);
		state.pendingReap = reapRuntimeOrphans(runtimeDir, state.trackedChildren, 250).finally(() => {
			state.pendingReap = null;
		});
	});
}

async function stopSupervisorState(state: SupervisorState): Promise<void> {
	const proc = state.child;
	const runtimeDir = state.runtimeDir;
	state.child = null;
	state.readiness = null;
	detachNodeExitHook(state);
	if (proc && runtimeDir) {
		snapshotOwnedChildren(state, runtimeDir, proc.pid);
	}
	if (proc) {
		await terminateChildProcess(proc, state.opts.shutdownTimeoutMs ?? 30_000);
	}
	if (state.pendingReap) await state.pendingReap;
	if (runtimeDir) {
		await reapRuntimeOrphans(runtimeDir, state.trackedChildren, 250);
	}
}

async function startSupervisorState(state: SupervisorState): Promise<MfnReadinessInfo> {
	if (isSupervisorRunning(state) && state.readiness) return state.readiness;
	if (state.pendingReap) await state.pendingReap;
	const layout = prepareMfnSupervisorLayout(state.opts.stateRoot);
	await reapRuntimeOrphans(layout.runtimeDir, state.trackedChildren, 150);
	const args = buildEngineCliArgs(state.opts, layout);
	const env = buildMfnSupervisorEnv(state.opts.env ?? process.env, state.opts.backend ?? "cpu", layout.scratchDir);
	const proc = spawn(state.opts.pythonBin ?? "python3", args, { env, stdio: ["ignore", "pipe", "pipe"] });
	state.child = proc;
	state.tokenValue = layout.token;
	state.runtimeDir = layout.runtimeDir;
	state.stderrTail = "";
	attachProcessGuards(state, proc, layout.runtimeDir);
	const append = (txt: string) => {
		state.stderrTail = (state.stderrTail + txt).slice(-8_192);
	};
	try {
		state.readiness = await waitForChildReady(proc, state.opts.startupTimeoutMs ?? 30_000, append);
		snapshotOwnedChildren(state, layout.runtimeDir, proc.pid);
		return state.readiness;
	} catch (err) {
		await stopSupervisorState(state);
		throw err;
	}
}

export class MfnSupervisor {
	private readonly state: SupervisorState;

	constructor(opts: MfnSupervisorOptions) {
		this.state = {
			opts,
			child: null,
			tokenValue: null,
			runtimeDir: null,
			readiness: null,
			stderrTail: "",
			nodeExitHook: null,
			pendingReap: null,
			trackedChildren: new Map(),
		};
	}

	isRunning(): boolean {
		return isSupervisorRunning(this.state);
	}

	start(): Promise<MfnReadinessInfo> {
		return startSupervisorState(this.state);
	}

	getStderrTail(): string {
		return this.state.stderrTail;
	}

	stop(): Promise<void> {
		return stopSupervisorState(this.state);
	}

	createClient(timeoutMs?: number): MfnClient {
		if (!this.state.tokenValue) {
			throw new Error("MfnSupervisor has not been started");
		}
		const endpoint = this.state.readiness?.endpoint ?? `http://127.0.0.1:${this.state.opts.port}`;
		return new MfnClient({ endpoint, token: this.state.tokenValue, timeoutMs });
	}
}
