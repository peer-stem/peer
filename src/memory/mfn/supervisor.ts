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
	const clean = sanitizeComputeEnv(sourceEnv, backend);
	for (const key of Object.keys(clean)) {
		if (key.startsWith("MFN_")) {
			delete clean[key];
		}
	}
	if (tmpDir) {
		assertCleanAbsoluteDir(tmpDir, "tmpDir");
		clean.TMPDIR = tmpDir;
	}
	return clean;
}

export function parseMfnReadyLine(line: string): MfnReadinessInfo | null {
	const trimmed = line.trim();
	if (!trimmed.startsWith("{")) {
		return null;
	}
	try {
		const parsed = JSON.parse(trimmed) as { endpoint?: unknown; state?: unknown; ready?: unknown };
		if (typeof parsed.endpoint !== "string" || typeof parsed.ready !== "boolean") {
			return null;
		}
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
		script,
		"--data-dir",
		layout.dataDir,
		"--runtime-dir",
		layout.runtimeDir,
		"--token-file",
		layout.tokenFile,
		"--port",
		String(opts.port),
		"--ifr",
		path.join(opts.binDir, "ifr"),
		"--dsr",
		path.join(opts.binDir, "dsr"),
		"--alm",
		path.join(opts.binDir, "alm"),
		"--cpe",
		path.join(opts.binDir, "cpe"),
		"--psr",
		path.join(opts.binDir, "psr"),
		"--gateway",
		path.join(opts.binDir, "mfn-gateway"),
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
		if (!info.ready) {
			onFail(new Error(`MFN engine reported ready=false (state=${info.state})`));
		} else {
			onReady(info);
		}
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

function waitProcessExit(proc: ChildProcess, timeoutMs: number): Promise<void> {
	return new Promise<void>((resolve) => {
		const killTimer = setTimeout(() => {
			if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
		}, timeoutMs);
		proc.once("exit", () => {
			clearTimeout(killTimer);
			resolve();
		});
		proc.kill("SIGTERM");
	});
}

async function terminateChildProcess(proc: ChildProcess, timeoutMs: number): Promise<void> {
	if (proc.exitCode === null && proc.signalCode === null) {
		await waitProcessExit(proc, timeoutMs);
	}
	proc.stdout?.removeAllListeners();
	proc.stderr?.removeAllListeners();
	proc.stdout?.destroy();
	proc.stderr?.destroy();
}

export class MfnSupervisor {
	private readonly opts: MfnSupervisorOptions;
	private child: ChildProcess | null = null;
	private tokenValue: string | null = null;
	private readiness: MfnReadinessInfo | null = null;
	private stderrTail = "";

	constructor(opts: MfnSupervisorOptions) {
		this.opts = opts;
	}

	async start(): Promise<MfnReadinessInfo> {
		if (this.child && this.readiness) return this.readiness;
		const layout = prepareMfnSupervisorLayout(this.opts.stateRoot);
		const args = buildEngineCliArgs(this.opts, layout);
		const env = buildMfnSupervisorEnv(this.opts.env ?? process.env, this.opts.backend ?? "cpu", layout.scratchDir);
		const proc = spawn(this.opts.pythonBin ?? "python3", args, { env, stdio: ["ignore", "pipe", "pipe"] });
		this.child = proc;
		this.tokenValue = layout.token;
		this.stderrTail = "";
		const append = (txt: string) => {
			this.stderrTail = (this.stderrTail + txt).slice(-8_192);
		};
		try {
			this.readiness = await waitForChildReady(proc, this.opts.startupTimeoutMs ?? 30_000, append);
			return this.readiness;
		} catch (err) {
			await this.stop();
			throw err;
		}
	}

	getStderrTail(): string {
		return this.stderrTail;
	}

	async stop(): Promise<void> {
		const proc = this.child;
		this.child = null;
		this.readiness = null;
		if (proc) {
			await terminateChildProcess(proc, this.opts.shutdownTimeoutMs ?? 30_000);
		}
	}

	createClient(timeoutMs?: number): MfnClient {
		if (!this.tokenValue) {
			throw new Error("MfnSupervisor has not been started");
		}
		const endpoint = this.readiness?.endpoint ?? `http://127.0.0.1:${this.opts.port}`;
		return new MfnClient({ endpoint, token: this.tokenValue, timeoutMs });
	}
}
