/**
 * The speech endpoint aims the server at a URL, so writing it needs the same
 * proof of origin as the custom provider: a same-origin `Origin` in
 * browser-only mode, the desktop secret in desktop mode.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { sameOriginWriteAllowed } from "../src/server/same-origin-write.ts";

const BROWSER_ONLY = {};
const SECRET = "s".repeat(64);
const DESKTOP = { LH_DESKTOP_SERVER: "1", LH_DESKTOP_API_SECRET: SECRET };

function put(headers: Record<string, string>): Request {
	return new Request("http://localhost:3000/api/settings/speech", { method: "PUT", headers: { "Content-Type": "application/json", ...headers } });
}

test("browser-only mode: a write without a same-origin Origin is refused", () => {
	const refused: Record<string, string>[] = [
		{}, { Origin: "http://attacker.example" }, { Origin: "null" },
		{ Origin: "http://localhost:3000", "Sec-Fetch-Site": "cross-site" },
		{ Origin: "http://localhost:3000", "Sec-Fetch-Site": "same-site" },
	];
	for (const headers of refused) assert.equal(sameOriginWriteAllowed(put(headers), BROWSER_ONLY), false, JSON.stringify(headers));
});

test("browser-only mode: the app's own same-origin write is allowed", () => {
	assert.equal(sameOriginWriteAllowed(put({ Origin: "http://localhost:3000" }), BROWSER_ONLY), true);
	assert.equal(sameOriginWriteAllowed(put({ Origin: "http://localhost:3000", "Sec-Fetch-Site": "same-origin" }), BROWSER_ONLY), true);
});

test("desktop mode: only the desktop secret authorises the write", () => {
	assert.equal(sameOriginWriteAllowed(put({ Origin: "http://localhost:3000" }), DESKTOP), false);
	assert.equal(sameOriginWriteAllowed(put({ "X-LearnHarness-Desktop": "t".repeat(64) }), DESKTOP), false);
	assert.equal(sameOriginWriteAllowed(put({ "X-LearnHarness-Desktop": SECRET }), DESKTOP), true);
});
