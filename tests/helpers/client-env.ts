import * as nodeModule from "node:module";
import { resolveSync } from "./client-resolve.mjs";

const CLIENT_ENV_REGISTERED = Symbol.for("peer.client.env.registered");

type ClientEnvGlobal = typeof globalThis & {
	[CLIENT_ENV_REGISTERED]?: boolean;
	__PEER_DISABLE_AUTO_BOOT__?: boolean;
};

type ModuleWithRegisterHooks = typeof nodeModule & {
	registerHooks?: (hooks: { resolve: typeof resolveSync }) => unknown;
};

export function installClientEnv(): void {
	const host = globalThis as ClientEnvGlobal;
	host.__PEER_DISABLE_AUTO_BOOT__ = true;
	if (host[CLIENT_ENV_REGISTERED] === true) {
		return;
	}
	const mod = nodeModule as ModuleWithRegisterHooks;
	if (typeof mod.registerHooks === "function") {
		mod.registerHooks({ resolve: resolveSync });
	} else {
		nodeModule.register("./client-resolve.mjs", import.meta.url);
	}
	host[CLIENT_ENV_REGISTERED] = true;
}

installClientEnv();
