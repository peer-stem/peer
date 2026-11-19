import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { WORKTREE_ROOT } from "./api-test-helpers.ts";
import { installClientEnv } from "./helpers/client-env.ts";

const EXPECTED_NODE_TARGETS: ReadonlyArray<readonly [string, string]> = [
	["cloudcanvas", "extern/cloudcanvas/index.js"],
	["cloudcanvas/theme", "extern/cloudcanvas/graphics/theme.js"],
	["cloudcanvas/tokens", "extern/cloudcanvas/graphics/tokens.js"],
	["cloudcanvas-lib", "extern/cloudcanvas-lib/index.js"],
	["cloudcanvas-lib/ui", "extern/cloudcanvas-lib/ui/index.js"],
	["peer-state", "src/client/state/index.ts"],
	["peer-keyboard", "src/core/keyboard.ts"],
	["peer-blocks-math", "src/client/state/vendor-math.ts"],
	["peer-blocks-code", "src/client/state/vendor-code.ts"],
	["peer-blocks-mermaid", "src/client/state/vendor-mermaid.ts"],
];

function importDynamicSpecifier(specifier: string): Promise<Record<string, unknown>> {
	return import(specifier) as Promise<Record<string, unknown>>;
}

test("installClientEnv sets __PEER_DISABLE_AUTO_BOOT__ idempotently and keeps node:crypto native", async () => {
	installClientEnv();
	installClientEnv();
	const autoBootDisabled = (globalThis as { __PEER_DISABLE_AUTO_BOOT__?: unknown }).__PEER_DISABLE_AUTO_BOOT__;
	assert.equal(autoBootDisabled, true);
	assert.equal(typeof globalThis.document, "undefined");
	assert.equal(import.meta.resolve("node:crypto"), "node:crypto");
	const cryptoModule = await importDynamicSpecifier("node:crypto");
	assert.equal(typeof cryptoModule.createHash, "function");
});

test("client-resolve.mjs maps CloudCanvas and peer specifiers to exact repository file URLs", () => {
	for (const [specifier, relativeTarget] of EXPECTED_NODE_TARGETS) {
		const expectedHref = pathToFileURL(path.join(WORKTREE_ROOT, relativeTarget)).href;
		const resolvedHref = import.meta.resolve(specifier);
		assert.equal(resolvedHref, expectedHref, `Specifier "${specifier}" resolved to unexpected URL`);
	}
});

test("client-resolve.mjs imports CloudCanvas and peer modules cleanly in Node without a DOM", async () => {
	assert.equal(typeof globalThis.document, "undefined");
	for (const [specifier] of EXPECTED_NODE_TARGETS) {
		const loaded = await importDynamicSpecifier(specifier);
		assert.equal(typeof loaded, "object", `Expected module namespace object for "${specifier}"`);
		assert.equal(Object.keys(loaded).length > 0, true, `Expected non-empty exports for "${specifier}"`);
	}
	assert.equal(typeof globalThis.document, "undefined");
});
