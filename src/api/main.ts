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

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	if (value instanceof Error || value instanceof Request) return false;
	return true;
}

function makeWarnReporter(logger: Logger): (...args: unknown[]) => void {
	return (...args: unknown[]) => {
		const [first, second] = args;
		if (typeof first === "string") {
			logger.warn(first, isPlainRecord(second) ? second : second !== undefined ? { detail: second } : undefined);
			return;
		}
		logger.warn("[api] Request warning", { detail: args.length === 1 ? first : args });
	};
}

function makeErrorReporter(logger: Logger, fallbackMessage: string): (...args: unknown[]) => void {
	return (...args: unknown[]) => {
		const [first, second] = args;
		if (typeof first === "string" && (second === undefined || isPlainRecord(second))) {
			logger.error(first, second);
			return;
		}
		const fields: Record<string, unknown> = { error: first };
		if (second instanceof Request) {
			fields.method = second.method;
			fields.url = second.url;
		} else if (second !== undefined) {
			fields.detail = second;
		}
		logger.error(fallbackMessage, fields);
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

async function runCloseSequence(closeHttpServer: () => Promise<void>, logger: Logger): Promise<void> {
	try {
		await closeHttpServer();
	} finally {
		await logger.flush();
	}
}

function createCloseHandler(closeHttpServer: () => Promise<void>, logger: Logger): () => Promise<void> {
	let closing: Promise<void> | null = null;
	return () => {
		closing ??= runCloseSequence(closeHttpServer, logger);
		return closing;
	};
}

export async function startApiServer(
	env: Record<string, string | undefined> = process.env,
	options?: { logger?: Logger },
): Promise<RunningApiServer> {
	const config = readApiConfig(env);
	const logger = options?.logger ?? createLogger({ level: config.logLevel });

	const { routes } = await import("./routes.ts");

	const { initializePlugins } = await import("@/src/server/plugins.ts");
	try {
		await initializePlugins();
	} catch (error) {
		logger.error(PLUGIN_INIT_ERROR_MESSAGE, {
			error: error instanceof Error ? error.message : String(error),
		});
	}

	const [{ createRouter, bodyLimit }, { createStaticHandler }, { createApiHttpServer }] = await Promise.all([
		import("./router.ts"),
		import("./static.ts"),
		import("./server.ts"),
	]);

	const fallback = createStaticHandler();
	const dispatch = createRouter(routes, {
		fallback,
		onError: makeErrorReporter(logger, "[api] Unhandled route error"),
	});
	const { server, close: closeHttpServer } = createApiHttpServer(dispatch, {
		getBodyLimit: bodyLimit,
		onWarn: makeWarnReporter(logger),
		onError: makeErrorReporter(logger, "[api] Transport error"),
	});

	const boundPort = await listenServer(server, config.port, config.hostname);
	if (server.listenerCount("error") === 0) {
		server.on("error", makeErrorReporter(logger, "[api] Server error"));
	}
	const close = createCloseHandler(closeHttpServer, logger);
	logger.info("[api] Engine API server listening", { hostname: config.hostname, port: boundPort });
	return { server, hostname: config.hostname, port: boundPort, close };
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
