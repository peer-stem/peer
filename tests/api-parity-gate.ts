import assert from "node:assert/strict";
import * as http from "node:http";
import { startParityPair, type GateEnvOptions, type ParityPair } from "./api-parity-servers.ts";
import type { StubServer } from "./api-parity-stubs.ts";
import { sendWire, type WireResponse } from "./api-parity-wire.ts";
import { compareResponseHeaders, createParityHarness, type ParityHarness } from "./api-parity-compare.ts";
import { CONCRETE_ROUTE_PATHS } from "./api-parity-routes-a.ts";

const DESKTOP_SECRET = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";
const ALL_SEVEN_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const;
const DOC_PATH = "/api/plugins/document-one/documents/markdown";

const MATCHER_PATHS_FROM_PROXY_TEST = [
	DOC_PATH,
	`${DOC_PATH}/`,
	`${DOC_PATH}?request=1`,
	`${DOC_PATH}/?request=1`,
	"/api/plugins/document%2Done/documents/markdown",
	"/api/plugins/%64ocument-one/documents/markdown/",
	"/api",
	"/api/",
	"/api?request=1",
	"/api/?request=1",
	"/api/nope",
	"/api/plugins",
	"/api/plugins/document-one",
	"/api/plugins/document-one/call",
	"/api/plugins/document-one/documents",
	"/api/plugins/document-one/documents/other",
	`${DOC_PATH}/extra`,
	`${DOC_PATH}ish`,
	`${DOC_PATH}.json`,
	`${DOC_PATH}.rsc`,
	"/api/plugins/document-one/other/documents/markdown",
	"/api/plugins/documents/markdown",
	"/api/graph/import",
	"/api/events",
	"/api/chat",
	"/api/settings/models",
	"/api/chats/scratch/markdown",
];

const NON_API_LOOKALIKE_PATHS = [
	"/",
	"/chat/new",
	"/apix",
	"/api-other/plugins/document-one/documents/markdown",
];

function buildRefusalMatrixPaths(): string[] {
	return [...new Set([...Object.values(CONCRETE_ROUTE_PATHS), ...MATCHER_PATHS_FROM_PROXY_TEST])];
}

function hasTrailingSlashPathname(rawPath: string): boolean {
	const q = rawPath.indexOf("?");
	const pathname = q === -1 ? rawPath : rawPath.slice(0, q);
	return pathname.length > 1 && pathname.endsWith("/");
}

function collectPooledResponse(res: http.IncomingMessage, resolve: (r: WireResponse) => void): void {
	const chunks: Buffer[] = [];
	res.on("data", (c: Buffer) => chunks.push(c));
	res.on("end", () => {
		const rawBody = Buffer.concat(chunks);
		const outHeaders: Record<string, string> = {};
		for (const [k, v] of Object.entries(res.headers)) {
			if (v !== undefined) outHeaders[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : v;
		}
		resolve({ status: res.statusCode ?? 0, headers: outHeaders, rawBody, text: rawBody.toString("utf8"), prematureClose: false });
	});
}

function sendPooled(
	agent: http.Agent,
	port: number,
	method: string,
	reqPath: string,
	headers: Record<string, string>,
): Promise<WireResponse> {
	return new Promise((resolve, reject) => {
		const req = http.request(
			{ host: "127.0.0.1", port, method, path: reqPath, headers, agent },
			(res) => collectPooledResponse(res, resolve),
		);
		req.on("error", reject);
		req.end();
	});
}

async function assertRefusalPair(
	mainHarness: ParityHarness,
	modeName: string,
	pair: ParityPair,
	agent: http.Agent,
	method: string,
	reqPath: string,
	refusedHeaders: Record<string, string>,
): Promise<void> {
	const [nextRes, apiRes] = await Promise.all([
		sendPooled(agent, pair.next.port, method, reqPath, refusedHeaders),
		sendPooled(agent, pair.api.port, method, reqPath, refusedHeaders),
	]);
	if (hasTrailingSlashPathname(reqPath)) {
		assert.equal(nextRes.status, 308, `[${modeName}] Next trailing slash expected 308 on ${method} ${reqPath}`);
		assert.equal(apiRes.status, 403, `[${modeName}] API trailing slash expected 403 on ${method} ${reqPath}`);
		assert.equal(apiRes.headers["cache-control"], "no-store");
		mainHarness.recordObservation({
			ruleId: "trailing-slash-redirect-vs-gate-and-404",
			request: `[gate:${modeName}] ${method} ${reqPath}`,
			nextSummary: "status=308 Permanent Redirect (before proxy.ts)",
			apiSummary: "status=403 refused by gate (cache-control: no-store)",
		});
		return;
	}
	assert.equal(nextRes.status, 403, `[${modeName}] Next expected 403 on ${method} ${reqPath}, got ${nextRes.status}`);
	assert.equal(apiRes.status, 403, `[${modeName}] API expected 403 on ${method} ${reqPath}, got ${apiRes.status}`);
	assert.equal(nextRes.headers["cache-control"], "no-store");
	assert.equal(apiRes.headers["cache-control"], "no-store");
	if (method === "HEAD") {
		assert.equal(nextRes.rawBody.length, 0);
		assert.equal(apiRes.rawBody.length, 0);
	} else {
		assert.deepEqual(JSON.parse(apiRes.text), JSON.parse(nextRes.text), `[${modeName}] 403 body mismatch on ${method} ${reqPath}`);
	}
}

async function runRefusalMatrixForMode(
	mainHarness: ParityHarness,
	modeName: string,
	pair: ParityPair,
	refusedHeaders: (port: number) => Record<string, string>,
): Promise<void> {
	const agent = new http.Agent({ keepAlive: true, maxSockets: 16 });
	try {
		const paths = buildRefusalMatrixPaths();
		for (const reqPath of paths) {
			const hdrs = refusedHeaders(pair.next.port);
			await Promise.all(ALL_SEVEN_METHODS.map((method) => assertRefusalPair(mainHarness, modeName, pair, agent, method, reqPath, hdrs)));
		}
		for (const nonApiPath of NON_API_LOOKALIKE_PATHS) {
			const apiRes = await sendPooled(agent, pair.api.port, "GET", nonApiPath, refusedHeaders(pair.api.port));
			assert.equal(apiRes.status, 404, `[${modeName}] non-/api path ${nonApiPath} must return ungated 404 on src/api`);
			assert.equal(apiRes.rawBody.length, 0);
		}
	} finally {
		agent.destroy();
	}
}

async function checkPairRequest(
	localHarness: ParityHarness,
	label: string,
	expectedStatus: number,
	makeHeaders: (port: number) => Record<string, string>,
	method = "GET",
	reqPath = "/api/settings",
	body?: string,
): Promise<void> {
	const [nextRes, apiRes] = await Promise.all([
		sendWire(localHarness.pair.next.port, { method, path: reqPath, headers: makeHeaders(localHarness.pair.next.port), body }),
		sendWire(localHarness.pair.api.port, { method, path: reqPath, headers: makeHeaders(localHarness.pair.api.port), body }),
	]);
	assert.equal(nextRes.status, expectedStatus, `${label} Next status`);
	assert.equal(apiRes.status, expectedStatus, `${label} API status`);
	compareResponseHeaders(localHarness, nextRes.headers, apiRes.headers, { requestLabel: label });
}

async function runBrowserModeChecks(mainHarness: ParityHarness, stub: StubServer): Promise<void> {
	const pair = await startParityPair();
	const local = createParityHarness(pair, stub);
	try {
		await checkPairRequest(local, "browser pass localhost", 200, (p) => ({ Host: `localhost:${p}` }));
		await checkPairRequest(local, "browser pass 127.0.0.1", 200, (p) => ({ Host: `127.0.0.1:${p}` }));
		const chatJson = JSON.stringify({ title: "Gate Check" });
		await checkPairRequest(local, "browser pass write no origin", 200, (p) => ({ Host: `127.0.0.1:${p}`, "Content-Type": "application/json" }), "POST", "/api/chats", chatJson);
		await checkPairRequest(local, "browser pass write matching origin", 200, (p) => ({ Host: `127.0.0.1:${p}`, Origin: `http://127.0.0.1:${p}`, "Content-Type": "application/json" }), "POST", "/api/chats", chatJson);
		await checkPairRequest(local, "browser refuse cross-site sec-fetch-site", 403, (p) => ({ Host: `127.0.0.1:${p}`, "sec-fetch-site": "cross-site" }), "POST", "/api/chats", chatJson);
		await checkPairRequest(local, "browser refuse mismatched origin", 403, (p) => ({ Host: `127.0.0.1:${p}`, Origin: "http://evil.example" }), "POST", "/api/chats", chatJson);
		await runRefusalMatrixForMode(mainHarness, "browser", pair, () => ({ Host: "evil.example" }));
		for (const obs of local.observed) mainHarness.recordObservation(obs);
	} finally {
		await pair.stopAll();
	}
}

async function runAllowedHostsModeChecks(mainHarness: ParityHarness, stub: StubServer): Promise<void> {
	const gate: GateEnvOptions = { LH_ALLOWED_HOSTS: "peer.test", readyHeaders: { Host: "peer.test" } };
	const pair = await startParityPair(gate);
	const local = createParityHarness(pair, stub);
	try {
		await checkPairRequest(local, "allowed-hosts pass peer.test", 200, (p) => ({ Host: `peer.test:${p}` }));
		await checkPairRequest(
			local,
			"allowed-hosts pass write peer.test",
			200,
			(p) => ({ Host: `peer.test:${p}`, Origin: `http://peer.test:${p}`, "Content-Type": "application/json" }),
			"POST",
			"/api/chats",
			JSON.stringify({ title: "Allowed Host Write" }),
		);
		await runRefusalMatrixForMode(mainHarness, "allowed-hosts", pair, () => ({ Host: "other.test" }));
		for (const obs of local.observed) mainHarness.recordObservation(obs);
	} finally {
		await pair.stopAll();
	}
}

async function runDesktopSecretModeChecks(mainHarness: ParityHarness, stub: StubServer): Promise<void> {
	const gate: GateEnvOptions = {
		LH_DESKTOP_SERVER: "1",
		LH_DESKTOP_API_SECRET: DESKTOP_SECRET,
		readyHeaders: { "x-learnharness-desktop": DESKTOP_SECRET },
	};
	const pair = await startParityPair(gate);
	const local = createParityHarness(pair, stub);
	try {
		await checkPairRequest(local, "desktop pass exact secret", 200, (p) => ({ Host: `127.0.0.1:${p}`, "x-learnharness-desktop": DESKTOP_SECRET }));
		await checkPairRequest(local, "desktop pass doc route OPTIONS", 204, (p) => ({ Host: `127.0.0.1:${p}`, "x-learnharness-desktop": DESKTOP_SECRET }), "OPTIONS", DOC_PATH);
		await checkPairRequest(local, "desktop refuse wrong secret", 403, (p) => ({ Host: `127.0.0.1:${p}`, "x-learnharness-desktop": "0".repeat(64) }));
		await runRefusalMatrixForMode(mainHarness, "desktop-secret", pair, (p) => ({ Host: `127.0.0.1:${p}` }));
		for (const obs of local.observed) mainHarness.recordObservation(obs);
	} finally {
		await pair.stopAll();
	}
}

async function runDesktopNoSecretModeChecks(mainHarness: ParityHarness, stub: StubServer): Promise<void> {
	const gate: GateEnvOptions = { LH_DESKTOP_SERVER: "1", readyExpectedStatus: 403 };
	const pair = await startParityPair(gate);
	const local = createParityHarness(pair, stub);
	try {
		await checkPairRequest(local, "desktop-nosecret refuse even with header", 403, (p) => ({ Host: `127.0.0.1:${p}`, "x-learnharness-desktop": DESKTOP_SECRET }));
		await runRefusalMatrixForMode(mainHarness, "desktop-nosecret", pair, (p) => ({ Host: `127.0.0.1:${p}` }));
		for (const obs of local.observed) mainHarness.recordObservation(obs);
	} finally {
		await pair.stopAll();
	}
}

export async function runAllGateModesParity(mainHarness: ParityHarness): Promise<void> {
	await runBrowserModeChecks(mainHarness, mainHarness.stub);
	await runAllowedHostsModeChecks(mainHarness, mainHarness.stub);
	await runDesktopSecretModeChecks(mainHarness, mainHarness.stub);
	await runDesktopNoSecretModeChecks(mainHarness, mainHarness.stub);
}
