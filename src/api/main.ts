import { realpathSync } from "node:fs";
import type { Server } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { MfnClient } from "@/src/memory/mfn/client.ts";
import type { ActivateLumberJackOptions } from "@/src/server/stores.ts";
import { resolveComputeBackend } from "@/src/substrate/hardware-guard.ts";
import { readApiConfig } from "./config.ts";
import { createLogger, type Logger } from "./log.ts";

export interface RunningApiServer {
	server: Server;
	hostname: string;
	port: number;
	close(): Promise<void>;
}

export interface StartApiServerOptions {
	logger?: Logger;
	mfnClient?: MfnClient;
	streamIntervalMs?: number;
	mfnAutoFlushMs?: number;
	publicDir?: string;
	repoRoot?: string;
}

const PLUGIN_INIT_ERROR_MESSAGE = "[plugins] Initialization failed; plugin management will report the error:";
const SHUTDOWN_TIMEOUT_MS = 2500;

export function safeRequestPath(rawUrl: string): string {
	try {
		return new URL(rawUrl, "http://127.0.0.1").pathname;
	} catch {
		const queryIndex = rawUrl.indexOf("?");
		return queryIndex >= 0 ? rawUrl.slice(0, queryIndex) : rawUrl;
	}
}

export function reportRouteError(logger: Logger): (error: unknown, request: Request) => void {
	return (error: unknown, request: Request) => {
		logger.error("[api] Unhandled route error", {
			error,
			method: request.method,
			path: safeRequestPath(request.url),
		});
	};
}

export function reportServerError(logger: Logger, message: string): (error: unknown) => void {
	return (error: unknown) => {
		logger.error(message, { error });
	};
}

export function reportServerWarn(logger: Logger): (message: string) => void {
	return (message: string) => {
		logger.warn(message);
	};
}

export function reportGateRefusal(logger: Logger): (method: string, pathname: string) => void {
	return (method: string, pathname: string) => {
		logger.warn("[api] Gate refused request", { method, path: pathname });
	};
}

function attachProcessErrorReporters(logger: Logger): () => void {
	const onUncaught = reportServerError(logger, "[api] Uncaught exception");
	const onUnhandled = reportServerError(logger, "[api] Unhandled rejection");
	process.on("uncaughtException", onUncaught);
	process.on("unhandledRejection", onUnhandled);
	return () => {
		process.removeListener("uncaughtException", onUncaught);
		process.removeListener("unhandledRejection", onUnhandled);
	};
}

function listenServer(server: Server, port: number, hostname: string): Promise<number> {
	return new Promise<number>((resolve, reject) => {
		const onListening = () => {
			server.removeListener("error", onStartupError);
			const address = server.address();
			const boundPort = typeof address === "object" && address !== null ? address.port : port;
			resolve(boundPort);
		};
		const onStartupError = (err: Error) => {
			server.removeListener("listening", onListening);
			reject(err);
		};
		server.once("listening", onListening);
		server.once("error", onStartupError);
		server.listen(port, hostname);
	});
}

async function runCloseSequence(
	closeHttpServer: () => Promise<void>,
	closeSubstrate: (() => Promise<void>) | undefined,
	detachProcessReporters: () => void,
	logger: Logger,
): Promise<void> {
	try {
		await closeHttpServer();
	} finally {
		try {
			if (closeSubstrate) await closeSubstrate();
		} finally {
			detachProcessReporters();
			await logger.flush();
		}
	}
}

function createCloseHandler(
	closeHttpServer: () => Promise<void>,
	closeSubstrate: (() => Promise<void>) | undefined,
	detachProcessReporters: () => void,
	logger: Logger,
): () => Promise<void> {
	let closing: Promise<void> | null = null;
	return () => {
		closing ??= runCloseSequence(closeHttpServer, closeSubstrate, detachProcessReporters, logger);
		return closing;
	};
}

async function initPluginsSafely(logger: Logger): Promise<void> {
	const { initializePlugins } = await import("@/src/server/plugins.ts");
	try {
		await initializePlugins();
	} catch (error) {
		logger.error(PLUGIN_INIT_ERROR_MESSAGE, {
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

function parseOptionalPositiveInt(raw: string | undefined, label: string, max?: number): number | undefined {
	const trimmed = raw?.trim();
	if (!trimmed) return undefined;
	if (!/^\d+$/.test(trimmed)) throw new Error(`${label} must be a positive integer`);
	const val = Number(trimmed);
	if (!Number.isSafeInteger(val) || val < 1 || (max !== undefined && val > max)) {
		throw new Error(`${label} out of range: ${trimmed}`);
	}
	return val;
}

function buildSubstrateOptions(
	env: Record<string, string | undefined>,
	options?: StartApiServerOptions,
): Omit<ActivateLumberJackOptions, "onChange"> | null {
	const forestDir = env.PEER_FOREST_DIR?.trim();
	if (!forestDir) return null;
	const mfnPort = parseOptionalPositiveInt(env.PEER_MFN_PORT, "PEER_MFN_PORT", 65535);
	const streamIntervalMs = options?.streamIntervalMs ?? parseOptionalPositiveInt(env.PEER_STREAM_POLL_MS, "PEER_STREAM_POLL_MS");
	const autoFlushMs = options?.mfnAutoFlushMs ?? parseOptionalPositiveInt(env.PEER_MFN_AUTO_FLUSH_MS, "PEER_MFN_AUTO_FLUSH_MS");
	const mfnStateRoot = env.PEER_MFN_STATE_ROOT?.trim() || undefined;
	return {
		forestDir,
		streamIntervalMs,
		repoRoot: options?.repoRoot,
		mfnClient: options?.mfnClient,
		mfnEndpoint: env.PEER_MFN_ENDPOINT?.trim() || undefined,
		mfnToken: env.PEER_MFN_TOKEN?.trim() || undefined,
		mfnStateRoot,
		mfnBinDir: env.PEER_MFN_BIN_DIR?.trim() || undefined,
		mfnPort: mfnStateRoot ? mfnPort : undefined,
		mfnBackend: env.PEER_COMPUTE_BACKEND?.trim() ? resolveComputeBackend(env.PEER_COMPUTE_BACKEND) : undefined,
		mfnEmbeddersFile: env.PEER_MFN_EMBEDDERS_FILE?.trim() || undefined,
		mfnAlmConfigFile: env.PEER_MFN_ALM_CONFIG_FILE?.trim() || undefined,
		mfnEnv: env as NodeJS.ProcessEnv,
		mainPoolId: env.PEER_MFN_MAIN_POOL_ID?.trim() || undefined,
		lexicalPoolId: env.PEER_MFN_LEXICAL_POOL_ID?.trim() || undefined,
		autoFlushMs,
	};
}

export async function startApiServer(
	env: Record<string, string | undefined> = process.env,
	options?: StartApiServerOptions,
): Promise<RunningApiServer> {
	const config = readApiConfig(env);
	const substrateOpts = buildSubstrateOptions(env, options);
	const logger = options?.logger ?? createLogger({ level: config.logLevel });
	const detachProcessReporters = attachProcessErrorReporters(logger);
	let closeSubstrate: (() => Promise<void>) | undefined;
	try {
		if (substrateOpts) {
			const { activateLumberJackSubstrate } = await import("@/src/server/stores.ts");
			const active = await activateLumberJackSubstrate(substrateOpts);
			closeSubstrate = active.close;
		}
		const { routes } = await import("./routes.ts");
		await initPluginsSafely(logger);
		const [{ createRouter, bodyLimit }, { createStaticHandler }, { createApiHttpServer }] = await Promise.all([
			import("./router.ts"),
			import("./static.ts"),
			import("./server.ts"),
		]);
		const fallback = createStaticHandler(options?.publicDir, options?.repoRoot ? { repoRoot: options.repoRoot } : undefined);
		const dispatch = createRouter(routes, {
			fallback,
			onError: reportRouteError(logger),
			onRefusal: reportGateRefusal(logger),
		});
		const { server, close: closeHttpServer } = createApiHttpServer(dispatch, {
			getBodyLimit: bodyLimit,
			onWarn: reportServerWarn(logger),
			onError: reportServerError(logger, "[api] Transport error"),
		});
		const boundPort = await listenServer(server, config.port, config.hostname);
		if (server.listenerCount("error") === 0) {
			server.on("error", reportServerError(logger, "[api] Server error"));
		}
		const close = createCloseHandler(closeHttpServer, closeSubstrate, detachProcessReporters, logger);
		logger.info("[api] Engine API server listening", { hostname: config.hostname, port: boundPort });
		return { server, hostname: config.hostname, port: boundPort, close };
	} catch (error) {
		if (closeSubstrate) await closeSubstrate().catch(() => {});
		detachProcessReporters();
		throw error;
	}
}

function safeRealpath(filePath: string): string {
	const resolved = path.resolve(filePath);
	try {
		return realpathSync(resolved);
	} catch {
		return resolved;
	}
}

export function isMainModule(
	metaUrl: string = import.meta.url,
	argv1: string | undefined = process.argv[1],
): boolean {
	if (!argv1) return false;
	return safeRealpath(fileURLToPath(metaUrl)) === safeRealpath(argv1);
}

export function formatForcedExitLine(timeoutMs = SHUTDOWN_TIMEOUT_MS): string {
	return JSON.stringify({
		timestamp: new Date().toISOString(),
		level: "warn",
		message: `[api] Forced process exit after ${timeoutMs}ms shutdown deadline.`,
	});
}

async function exitGracefully(running: RunningApiServer | null): Promise<never> {
	const forceExit = setTimeout(() => {
		process.stderr.write(`${formatForcedExitLine()}\n`);
		process.exit(0);
	}, SHUTDOWN_TIMEOUT_MS);
	forceExit.unref();
	try {
		if (running) await running.close();
	} catch {
		/* exit cleanly within the 3 s SIGTERM window even if close rejects */
	}
	process.exit(0);
}

async function runCli(): Promise<void> {
	let running: RunningApiServer | null = null;
	let shuttingDown = false;
	const onSignal = () => {
		if (shuttingDown) return;
		shuttingDown = true;
		void exitGracefully(running);
	};
	process.on("SIGTERM", onSignal);
	process.on("SIGINT", onSignal);
	running = await startApiServer();
	if (shuttingDown) {
		await exitGracefully(running);
	}
}

if (isMainModule()) {
	runCli().catch((error: unknown) => {
		const message = error instanceof Error ? error.message : String(error);
		process.stderr.write(`${message}\n`);
		process.exit(1);
	});
}
