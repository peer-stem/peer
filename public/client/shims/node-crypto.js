/**
 * Browser ESM stub for `node:crypto` (`C-12`, `client-contract-state §6.1`).
 * Server-only `src/core/coverage.ts` imports `createHash` from `node:crypto`;
 * keeping `node:crypto` external and mapped here avoids bundling Node crypto
 * while failing loudly if any server hash helper is called in the browser.
 */

/** @returns {never} */
function unavailable() {
	throw new Error("node:crypto is unavailable in browser client bundles");
}

/**
 * @param {...unknown} _args
 * @returns {never}
 */
export function createHash(..._args) {
	return unavailable();
}

/**
 * @param {...unknown} _args
 * @returns {never}
 */
export function randomBytes(..._args) {
	return unavailable();
}

/** @returns {string} */
export function randomUUID() {
	if (typeof globalThis.crypto?.randomUUID === "function") {
		return globalThis.crypto.randomUUID();
	}
	return unavailable();
}

/**
 * @param {...unknown} _args
 * @returns {never}
 */
export function timingSafeEqual(..._args) {
	return unavailable();
}

export default { createHash, randomBytes, randomUUID, timingSafeEqual };
