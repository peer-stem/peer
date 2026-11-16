import { realpathSync } from "node:fs";
import type { Server } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readApiConfig } from "./config.ts";
import { createLogger, type Logger } from "./log.ts";

export interface RunningApiServer {
	server: Server;
	hostname: string;
	port: number;
	close(): Promise<void>;
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
	detachProcessReporters: () => void,
	logger: Logger,
): Promise<void> {
	try {
		await closeHttpServer();
	} finally {
		detachProcessReporters();
		await logger.flush();
	}
}

function createCloseHandler(
	closeHttpServer: () => Promise<void>,
	detachProcessReporters: () => void,
	logger: Logger,
): () => Promise<void> {
	let closing: Promise<void> | null = null;
	return () => {
		closing ??= runCloseSequence(closeHttpServer, detachProcessReporters, logger);
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

export async function startApiServer(
	env: Record<string, string | undefined> = process.env,
	options?: { logger?: Logger },
): Promise<RunningApiServer> {
	const config = readApiConfig(env);
	const logger = options?.logger ?? createLogger({ level: config.logLevel });
	const detachProcessReporters = attachProcessErrorReporters(logger);
	try {
		const { routes } = await import("./routes.ts");
		await initPluginsSafely(logger);
		const [{ createRouter, bodyLimit }, { createStaticHandler }, { createApiHttpServer }] = await Promise.all([
			import("./router.ts"),
			import("./static.ts"),
			import("./server.ts"),
		]);
		const dispatch = createRouter(routes, {
			fallback: createStaticHandler(),
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
		const close = createCloseHandler(closeHttpServer, detachProcessReporters, logger);
		logger.info("[api] Engine API server listening", { hostname: config.hostname, port: boundPort });
		return { server, hostname: config.hostname, port: boundPort, close };
	} catch (error) {
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

async function exitGracefully(running: RunningApiServer | null): Promise<never> {
	const forceExit = setTimeout(() => {
		const line = JSON.stringify({
			ts: new Date().toISOString(),
			level: "warn",
			msg: `[api] Forced process exit after ${SHUTDOWN_TIMEOUT_MS}ms shutdown deadline.`,
		});
		process.stderr.write(`${line}\n`);
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
