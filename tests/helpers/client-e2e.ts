import { spawn, type ChildProcess } from "node:child_process";
import fs, { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import net from "node:net";
import { homedir } from "node:os";
import path from "node:path";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { createLumberJackStores, type LumberJackStoreBundle } from "../../src/store/lumberjack/index.ts";
import { sanitizeComputeEnv } from "../../src/substrate/hardware-guard.ts";
import { WORKTREE_ROOT, createScratchDir } from "../api-test-helpers.ts";

const MAIN_ENTRY = path.join(WORKTREE_ROOT, "src", "api", "main.ts");
const CHROME_ARGS = [
	"--disable-background-networking",
	"--disable-sync",
	"--no-first-run",
	"--no-default-browser-check",
];

export type ClientE2eSeedFn = (bundle: LumberJackStoreBundle, rootDir: string) => Promise<void> | void;

export interface ClientE2eOptions {
	seed?: ClientE2eSeedFn;
	executablePath?: string;
	timeoutMs?: number;
}

export interface ClientE2eConsoleError {
	type: string;
	text: string;
	url?: string;
}

export interface ClientE2ePageError {
	message: string;
	stack?: string;
}

export interface ClientE2eFailedRequest {
	method: string;
	url: string;
	errorText: string;
}

export interface ClientE2eBadResponse {
	method: string;
	url: string;
	status: number;
}

export interface ClientE2eOffOriginRequest {
	method: string;
	url: string;
}

export interface ClientE2eHarness {
	rootDir: string;
	forestDir: string;
	port: number;
	baseUrl: string;
	browser: Browser;
	page: Page;
	consoleErrors: ClientE2eConsoleError[];
	pageErrors: ClientE2ePageError[];
	failedRequests: ClientE2eFailedRequest[];
	badResponses: ClientE2eBadResponse[];
	offOriginRequests: ClientE2eOffOriginRequest[];
	stop(): Promise<void>;
}

interface E2eScratchLayout {
	rootDir: string;
	homeDir: string;
	forestDir: string;
	chromeProfileDir: string;
	tmpDir: string;
	dataDir: string;
	configHome: string;
	dataHome: string;
	cacheHome: string;
	authFile: string;
}

interface E2eObserverState {
	recording: boolean;
	consoleErrors: ClientE2eConsoleError[];
	pageErrors: ClientE2ePageError[];
	failedRequests: ClientE2eFailedRequest[];
	badResponses: ClientE2eBadResponse[];
	offOriginRequests: ClientE2eOffOriginRequest[];
}

function buildChromeCandidates(supplied?: string): string[] {
	if (supplied) return [supplied];
	const winDirs = [process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"], process.env.LOCALAPPDATA]
		.filter((dir): dir is string => Boolean(dir))
		.map((dir) => path.join(dir, "Google", "Chrome", "Application", "chrome.exe"));
	return [
		"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
		path.join(homedir(), "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
		"/usr/bin/google-chrome-stable",
		"/usr/bin/google-chrome",
		"/opt/google/chrome/chrome",
		"/usr/bin/chromium",
		"/usr/bin/chromium-browser",
		...winDirs,
	];
}

export async function findLocalChrome(supplied?: string): Promise<string> {
	const mode = process.platform === "win32" ? constants.F_OK : constants.X_OK;
	for (const candidate of buildChromeCandidates(supplied)) {
		try {
			await access(candidate, mode);
			if ((await stat(candidate)).isFile()) return candidate;
		} catch {
			/* Probe installed local browser binaries only; never download Chromium. */
		}
	}
	throw new Error(
		supplied
			? `Client E2E: executablePath is not an executable file: ${supplied}`
			: "Client E2E: local Chrome/Chromium binary is unavailable; never downloading Chromium.",
	);
}

function createScratchLayout(): E2eScratchLayout {
	const rootDir = createScratchDir("client-e2e-");
	const homeDir = path.join(rootDir, "home");
	const forestDir = path.join(rootDir, "forest");
	const chromeProfileDir = path.join(rootDir, "chrome-profile");
	const tmpDir = path.join(rootDir, "tmp");
	const dataDir = path.join(rootDir, "data");
	const mfnDataDir = path.join(rootDir, "mfn", "data");
	const mfnRuntimeDir = path.join(rootDir, "mfn", "runtime");
	const configHome = path.join(homeDir, ".config");
	const dataHome = path.join(homeDir, ".local", "share");
	const cacheHome = path.join(homeDir, ".cache");
	const authFile = path.join(rootDir, "auth.json");
	const dirs = [homeDir, forestDir, chromeProfileDir, tmpDir, dataDir, mfnDataDir, mfnRuntimeDir, configHome, dataHome, cacheHome];
	for (const dir of dirs) {
		fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	}
	fs.writeFileSync(authFile, "{}\n", { mode: 0o600 });
	return { rootDir, homeDir, forestDir, chromeProfileDir, tmpDir, dataDir, configHome, dataHome, cacheHome, authFile };
}

async function seedForest(forestDir: string, rootDir: string, seed?: ClientE2eSeedFn): Promise<void> {
	const bundle = createLumberJackStores(forestDir);
	try {
		if (seed) {
			await seed(bundle, rootDir);
		}
	} finally {
		bundle.close();
	}
}

function probeOneEphemeralPort(): Promise<number> {
	return new Promise<number>((resolve, reject) => {
		const probe = net.createServer();
		probe.once("error", reject);
		probe.listen(0, "127.0.0.1", () => {
			const addr = probe.address();
			const port = typeof addr === "object" && addr !== null ? addr.port : 0;
			probe.close((err) => (err ? reject(err) : resolve(port)));
		});
	});
}

async function pickSpareLoopbackPort(): Promise<number> {
	const first = await probeOneEphemeralPort();
	if (first !== 3000 && first !== 3901) return first;
	return probeOneEphemeralPort();
}

function parseOneLogLine(line: string): number | null {
	const trimmed = line.trim();
	if (!trimmed.startsWith("{")) return null;
	try {
		const parsed = JSON.parse(trimmed) as { message?: unknown; fields?: { port?: unknown } };
		if (parsed.message !== "[api] Engine API server listening") return null;
		return typeof parsed.fields?.port === "number" ? parsed.fields.port : null;
	} catch {
		return null;
	}
}

function parseListeningPortFromLogs(logs: string): number | null {
	for (const line of logs.split(/\r?\n/)) {
		const port = parseOneLogLine(line);
		if (port !== null) return port;
	}
	return null;
}

function buildChildServerEnv(layout: E2eScratchLayout, port: number): NodeJS.ProcessEnv {
	return sanitizeComputeEnv(
		{
			...process.env,
			NODE_ENV: "test",
			HOME: layout.homeDir,
			USERPROFILE: layout.homeDir,
			XDG_CONFIG_HOME: layout.configHome,
			XDG_DATA_HOME: layout.dataHome,
			XDG_CACHE_HOME: layout.cacheHome,
			TMPDIR: layout.tmpDir,
			LH_DATA_DIR: layout.dataDir,
			LH_AUTH_FILE: layout.authFile,
			LH_IGNORE_ENV_KEYS: "1",
			LH_LOG_LEVEL: "info",
			PEER_FOREST_DIR: layout.forestDir,
			PEER_STATE_DIR: layout.rootDir,
			HOSTNAME: "127.0.0.1",
			PORT: String(port),
		},
		"cpu",
	);
}

function killChildQuietly(child: ChildProcess, signal: NodeJS.Signals = "SIGKILL"): void {
	if (child.pid === undefined || child.exitCode !== null) return;
	try {
		process.kill(child.pid, signal);
	} catch {
		/* child already exited */
	}
}

function waitForServerListening(
	child: ChildProcess,
	readLogs: () => string,
	onChunkCallbacks: Set<() => void>,
	timeoutMs: number,
): Promise<number> {
	const existing = parseListeningPortFromLogs(readLogs());
	if (existing !== null) return Promise.resolve(existing);
	return new Promise<number>((resolve, reject) => {
		const cleanup = () => {
			clearTimeout(timer);
			onChunkCallbacks.delete(check);
			child.removeListener("close", onClose);
		};
		const check = () => {
			const bound = parseListeningPortFromLogs(readLogs());
			if (bound === null) return;
			cleanup();
			resolve(bound);
		};
		const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
			cleanup();
			reject(new Error(`API server exited early (code=${String(code)}, signal=${String(signal)}):\n${readLogs()}`));
		};
		const timer = setTimeout(() => {
			cleanup();
			reject(new Error(`Timed out waiting for API server after ${timeoutMs}ms:\n${readLogs()}`));
		}, timeoutMs);
		onChunkCallbacks.add(check);
		child.once("close", onClose);
	});
}

async function spawnApiServerOnce(layout: E2eScratchLayout, timeoutMs: number): Promise<{ child: ChildProcess; port: number }> {
	const candidatePort = await pickSpareLoopbackPort();
	const child = spawn(process.execPath, ["--import", "tsx", MAIN_ENTRY], {
		cwd: WORKTREE_ROOT,
		env: buildChildServerEnv(layout, candidatePort),
		stdio: ["ignore", "pipe", "pipe"],
	});
	let combinedLogs = "";
	const listeners = new Set<() => void>();
	const appendChunk = (chunk: Buffer) => {
		combinedLogs += chunk.toString("utf8");
		for (const notify of listeners) notify();
	};
	child.stdout?.on("data", appendChunk);
	child.stderr?.on("data", appendChunk);
	try {
		const port = await waitForServerListening(child, () => combinedLogs, listeners, timeoutMs);
		return { child, port };
	} catch (error) {
		killChildQuietly(child, "SIGKILL");
		throw error;
	}
}

async function spawnApiServerWithRetry(layout: E2eScratchLayout, timeoutMs: number): Promise<{ child: ChildProcess; port: number }> {
	try {
		return await spawnApiServerOnce(layout, timeoutMs);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (!message.includes("EADDRINUSE")) throw error;
		return spawnApiServerOnce(layout, timeoutMs);
	}
}

function stopChildServer(child: ChildProcess, timeoutMs = 4_000): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
	return new Promise<void>((resolve) => {
		const timer = setTimeout(() => {
			killChildQuietly(child, "SIGKILL");
			resolve();
		}, timeoutMs);
		child.once("close", () => {
			clearTimeout(timer);
			resolve();
		});
		killChildQuietly(child, "SIGTERM");
	});
}

function isAllowedFavicon404(rawUrl: string, status: number, baseUrl: string): boolean {
	if (status !== 404) return false;
	try {
		const parsed = new URL(rawUrl);
		return parsed.origin === baseUrl && parsed.pathname === "/favicon.ico";
	} catch {
		return false;
	}
}

function isIntentionalSseCancel(rawUrl: string, errorText: string, baseUrl: string): boolean {
	if (!errorText.includes("ERR_ABORTED")) return false;
	try {
		const parsed = new URL(rawUrl);
		if (parsed.origin !== baseUrl) return false;
		return parsed.pathname === "/api/events" || /^\/api\/chats\/[^/]+\/stream$/.test(parsed.pathname);
	} catch {
		return false;
	}
}

function isOffOriginUrl(rawUrl: string, baseUrl: string): boolean {
	try {
		const parsed = new URL(rawUrl);
		if (!["http:", "https:", "ws:", "wss:"].includes(parsed.protocol)) return false;
		return parsed.origin !== baseUrl;
	} catch {
		return false;
	}
}

function attachPageObservers(page: Page, baseUrl: string, state: E2eObserverState): void {
	page.on("console", (entry) => {
		if (!state.recording || entry.type() !== "error") return;
		const url = entry.location().url;
		if (url && isAllowedFavicon404(url, 404, baseUrl) && entry.text().includes("404")) return;
		state.consoleErrors.push({ type: entry.type(), text: entry.text(), url });
	});
	page.on("pageerror", (err) => {
		if (!state.recording) return;
		state.pageErrors.push({ message: String(err), stack: err instanceof Error ? err.stack : undefined });
	});
	page.on("request", (req) => {
		if (!state.recording || !isOffOriginUrl(req.url(), baseUrl)) return;
		state.offOriginRequests.push({ method: req.method(), url: req.url() });
	});
	page.on("requestfailed", (req) => {
		if (!state.recording) return;
		const errorText = req.failure()?.errorText ?? "failed";
		if (isIntentionalSseCancel(req.url(), errorText, baseUrl)) return;
		state.failedRequests.push({ method: req.method(), url: req.url(), errorText });
	});
	page.on("response", (res) => {
		if (!state.recording || res.status() < 400) return;
		if (isAllowedFavicon404(res.url(), res.status(), baseUrl)) return;
		state.badResponses.push({ method: res.request().method(), url: res.url(), status: res.status() });
	});
}

async function launchHeadlessChrome(
	executablePath: string,
	layout: E2eScratchLayout,
	timeoutMs: number,
): Promise<{ browser: Browser; page: Page }> {
	const chromeEnv = sanitizeComputeEnv(
		{
			...process.env,
			HOME: layout.homeDir,
			USERPROFILE: layout.homeDir,
			XDG_CONFIG_HOME: layout.configHome,
			XDG_DATA_HOME: layout.dataHome,
			XDG_CACHE_HOME: layout.cacheHome,
			TMPDIR: layout.tmpDir,
		},
		"cpu",
	);
	const browser = await puppeteer.launch({
		executablePath,
		headless: true,
		userDataDir: layout.chromeProfileDir,
		env: chromeEnv,
		args: CHROME_ARGS,
	});
	const page = await browser.newPage();
	page.setDefaultTimeout(timeoutMs);
	page.setDefaultNavigationTimeout(timeoutMs);
	await page.setViewport({ width: 1440, height: 960, deviceScaleFactor: 1 });
	return { browser, page };
}

function createStopHandler(
	browser: Browser,
	child: ChildProcess,
	rootDir: string,
	state: E2eObserverState,
): () => Promise<void> {
	let stopped = false;
	return async () => {
		if (stopped) return;
		stopped = true;
		state.recording = false;
		await browser.close().catch(() => {});
		await stopChildServer(child);
		fs.rmSync(rootDir, { recursive: true, force: true });
	};
}

export async function startClientE2eHarness(options?: ClientE2eOptions): Promise<ClientE2eHarness> {
	const timeoutMs = options?.timeoutMs ?? 25_000;
	const executablePath = await findLocalChrome(options?.executablePath);
	const layout = createScratchLayout();
	let serverChild: ChildProcess | null = null;
	let browser: Browser | null = null;
	try {
		await seedForest(layout.forestDir, layout.rootDir, options?.seed);
		const started = await spawnApiServerWithRetry(layout, timeoutMs);
		serverChild = started.child;
		const baseUrl = `http://127.0.0.1:${started.port}`;
		const launched = await launchHeadlessChrome(executablePath, layout, timeoutMs);
		browser = launched.browser;
		const state: E2eObserverState = {
			recording: true,
			consoleErrors: [],
			pageErrors: [],
			failedRequests: [],
			badResponses: [],
			offOriginRequests: [],
		};
		attachPageObservers(launched.page, baseUrl, state);
		return {
			rootDir: layout.rootDir,
			forestDir: layout.forestDir,
			port: started.port,
			baseUrl,
			browser: launched.browser,
			page: launched.page,
			consoleErrors: state.consoleErrors,
			pageErrors: state.pageErrors,
			failedRequests: state.failedRequests,
			badResponses: state.badResponses,
			offOriginRequests: state.offOriginRequests,
			stop: createStopHandler(launched.browser, started.child, layout.rootDir, state),
		};
	} catch (error) {
		if (browser) await browser.close().catch(() => {});
		if (serverChild) await stopChildServer(serverChild);
		fs.rmSync(layout.rootDir, { recursive: true, force: true });
		throw error;
	}
}
