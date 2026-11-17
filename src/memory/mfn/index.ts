import type { MfnClient } from "./client.ts";
import type { MfnIngestOutbox } from "./outbox.ts";
import type { MfnSupervisor } from "./supervisor.ts";

export * from "./ids.ts";
export * from "./types.ts";
export * from "./embedder-pin.ts";
export * from "./client.ts";
export * from "./outbox.ts";
export * from "./supervisor.ts";
export * from "./context-mapper.ts";

export interface MfnActiveRuntime {
	client: MfnClient;
	outbox: MfnIngestOutbox;
	mainPoolId: string;
	lexicalPoolId: string;
	liveTailTokens?: number;
	supervisor?: MfnSupervisor;
}

const ACTIVE_MFN_RUNTIME_KEY = Symbol.for("peer.mfn.activeRuntime");

type GlobalWithMfnRuntime = typeof globalThis & {
	[ACTIVE_MFN_RUNTIME_KEY]?: MfnActiveRuntime | null;
};

export function getActiveMfnRuntime(): MfnActiveRuntime | null {
	return (globalThis as GlobalWithMfnRuntime)[ACTIVE_MFN_RUNTIME_KEY] ?? null;
}

export function setActiveMfnRuntime(runtime: MfnActiveRuntime | null): void {
	(globalThis as GlobalWithMfnRuntime)[ACTIVE_MFN_RUNTIME_KEY] = runtime;
}
