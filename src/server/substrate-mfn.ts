import path from "node:path";
import { ROOT } from "../../config.ts";
import type {
	MfnActiveRuntime,
	MfnClient,
	MfnSupervisor,
} from "../memory/mfn/index.ts";
import type { LumberJackStoreBundle } from "../store/lumberjack/index.ts";
import { resolveComputeBackend, sanitizeComputeEnv, type ComputeBackend } from "../substrate/hardware-guard.ts";

export interface SubstrateMfnOptions {
	repoRoot?: string;
	mfnStateRoot?: string;
	mfnBinDir?: string;
	mfnPort?: number;
	mfnEndpoint?: string;
	mfnToken?: string;
	mfnClient?: MfnClient;
	mfnBackend?: ComputeBackend;
	mfnEmbeddersFile?: string;
	mfnAlmConfigFile?: string;
	mfnStartupTimeoutMs?: number;
	mfnShutdownTimeoutMs?: number;
	mfnEnv?: NodeJS.ProcessEnv;
	mainPoolId?: string;
	lexicalPoolId?: string;
	liveTailTokens?: number;
	autoFlushMs?: number;
}

export interface StartedMfnBinding {
	runtime: MfnActiveRuntime;
	stopAutoFlush: () => void;
	supervisor?: MfnSupervisor;
}

function defaultMfnBinDir(sourceEnv?: NodeJS.ProcessEnv): string {
	const persistRoot =
		sourceEnv?.PEER_PERSIST_ROOT?.trim() || process.env.PEER_PERSIST_ROOT?.trim() || "/usr/lib/persist/peer";
	return path.join(persistRoot, "build", "mfn", "bin");
}

async function loadMfnRuntimeModule(): Promise<typeof import("../memory/mfn/index.ts")> {
	const spec = "../memory/mfn/index.ts";
	return import(/* turbopackIgnore: true */ spec) as Promise<typeof import("../memory/mfn/index.ts")>;
}

async function resolveMfnClientAndSupervisor(
	mfnMod: typeof import("../memory/mfn/index.ts"),
	options: SubstrateMfnOptions,
): Promise<{ client: MfnClient; supervisor?: MfnSupervisor } | null> {
	if (options.mfnClient) return { client: options.mfnClient };
	if (options.mfnEndpoint && options.mfnToken) {
		return { client: new mfnMod.MfnClient({ endpoint: options.mfnEndpoint, token: options.mfnToken }) };
	}
	if (!options.mfnStateRoot || options.mfnPort === undefined) return null;
	const backend = resolveComputeBackend(options.mfnBackend ?? "cpu");
	const env = sanitizeComputeEnv(options.mfnEnv ?? process.env, backend);
	const supervisor = new mfnMod.MfnSupervisor({
		repoRoot: options.repoRoot ?? ROOT,
		stateRoot: options.mfnStateRoot,
		binDir: options.mfnBinDir ?? defaultMfnBinDir(options.mfnEnv),
		port: options.mfnPort,
		backend,
		embeddersFile: options.mfnEmbeddersFile,
		almConfigFile: options.mfnAlmConfigFile,
		startupTimeoutMs: options.mfnStartupTimeoutMs,
		shutdownTimeoutMs: options.mfnShutdownTimeoutMs,
		env,
	});
	await supervisor.start();
	return { client: supervisor.createClient(), supervisor };
}

export async function startMfnBinding(
	bundle: LumberJackStoreBundle,
	options: SubstrateMfnOptions,
): Promise<StartedMfnBinding | null> {
	const hasMfnOpts = Boolean(
		options.mfnClient ||
			(options.mfnEndpoint && options.mfnToken) ||
			(options.mfnStateRoot && options.mfnPort !== undefined),
	);
	if (!hasMfnOpts) return null;
	const mfnMod = await loadMfnRuntimeModule();
	const resolved = await resolveMfnClientAndSupervisor(mfnMod, options);
	if (!resolved) return null;
	try {
		const outbox = new mfnMod.MfnIngestOutbox({
			persistence: mfnMod.createLumberJackOutboxPersistence(bundle.forest),
		});
		const stopAutoFlush = outbox.startAutoFlush(resolved.client, options.autoFlushMs ?? 5_000);
		const runtime: MfnActiveRuntime = {
			client: resolved.client,
			outbox,
			mainPoolId: options.mainPoolId ?? "peer-main",
			lexicalPoolId: options.lexicalPoolId ?? "peer-lexical",
			...(options.liveTailTokens !== undefined ? { liveTailTokens: options.liveTailTokens } : {}),
			...(resolved.supervisor ? { supervisor: resolved.supervisor } : {}),
		};
		mfnMod.setActiveMfnRuntime(runtime);
		return { runtime, stopAutoFlush, supervisor: resolved.supervisor };
	} catch (err) {
		await resolved.supervisor?.stop();
		throw err;
	}
}

export async function stopMfnBinding(mfn: StartedMfnBinding | null): Promise<void> {
	if (!mfn) return;
	mfn.stopAutoFlush();
	const mfnMod = await loadMfnRuntimeModule();
	if (mfnMod.getActiveMfnRuntime() === mfn.runtime) mfnMod.setActiveMfnRuntime(null);
	if (mfn.supervisor) await mfn.supervisor.stop();
}
