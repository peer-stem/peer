import assert from "node:assert/strict";
import * as http from "node:http";
import type { RouteRecord } from "../src/api/types.ts";
import { startParityPair, type GateEnvOptions, type ParityPair } from "./api-parity-servers.ts";
import type { ServerSide } from "./api-parity-stubs.ts";
import { normalizeRawHeaders, sendWire, type WireResponse } from "./api-parity-wire.ts";
import { compareResponseHeaders, createParityHarness, runParityRequest, type ParityHarness } from "./api-parity-compare.ts";
import { CONCRETE_ROUTE_PATHS, DESKTOP_SECRET, DOC_MARKDOWN_PATH } from "./api-test-helpers.ts";

const ALL_SEVEN_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const;

const MATCHER_PATHS_FROM_PROXY_TEST = [
	DOC_MARKDOWN_PATH, `${DOC_MARKDOWN_PATH}/`, `${DOC_MARKDOWN_PATH}?request=1`, `${DOC_MARKDOWN_PATH}/?request=1`,
	"/api/plugins/document%2Done/documents/markdown", "/api/plugins/%64ocument-one/documents/markdown/",
	"/api", "/api/", "/api?request=1", "/api/?request=1", "/api/nope",
	"/api/plugins", "/api/plugins/document-one", "/api/plugins/document-one/call",
	"/api/plugins/document-one/documents", "/api/plugins/document-one/documents/other",
	`${DOC_MARKDOWN_PATH}/extra`, `${DOC_MARKDOWN_PATH}ish`, `${DOC_MARKDOWN_PATH}.json`, `${DOC_MARKDOWN_PATH}.rsc`,
	"/api/plugins/document-one/other/documents/markdown", "/api/plugins/documents/markdown",
	"/api/graph/import", "/api/events", "/api/chat", "/api/settings/models", "/api/chats/scratch/markdown",
];

const NON_API_LOOKALIKE_PATHS = ["/", "/chat/new", "/apix", "/api-other/plugins/document-one/documents/markdown"];

const ENCODED_MATCHER_PATHS = [
	"/api/plugins/document%2Done/documents/markdown",
	"/api/plugins/%64ocument-one/documents/markdown",
	"/api/plugins/document-one/documents/%6Darkdown",
] as const;

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
		const outHeaders = normalizeRawHeaders(res.rawHeaders);
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

interface GateModeSuiteSpec {
	name: string;
	gate?: GateEnvOptions;
	refusedHeaders: (port: number) => Record<string, string>;
	passingHeaders?: (port: number) => Record<string, string>;
	runGateChecks: (mainHarness: ParityHarness, local: ParityHarness) => Promise<void>;
}

async function runBrowserGateChecks(mainHarness: ParityHarness, local: ParityHarness): Promise<void> {
	await checkPairRequest(local, "browser pass localhost", 200, (p) => ({ Host: `localhost:${p}` }));
	await checkPairRequest(local, "browser pass 127.0.0.1", 200, (p) => ({ Host: `127.0.0.1:${p}` }));
	const chatJson = JSON.stringify({ title: "Gate Check" });
	await checkPairRequest(local, "browser pass write no origin", 200, (p) => ({ Host: `127.0.0.1:${p}`, "Content-Type": "application/json" }), "POST", "/api/chats", chatJson);
	await checkPairRequest(local, "browser pass write matching origin", 200, (p) => ({ Host: `127.0.0.1:${p}`, Origin: `http://127.0.0.1:${p}`, "Content-Type": "application/json" }), "POST", "/api/chats", chatJson);
	await checkPairRequest(local, "browser refuse cross-site sec-fetch-site", 403, (p) => ({ Host: `127.0.0.1:${p}`, "sec-fetch-site": "cross-site" }), "POST", "/api/chats", chatJson);
	await checkPairRequest(local, "browser refuse mismatched origin", 403, (p) => ({ Host: `127.0.0.1:${p}`, Origin: "http://evil.example" }), "POST", "/api/chats", chatJson);
	await runRefusalMatrixForMode(mainHarness, "browser", local.pair, () => ({ Host: "evil.example" }));
}

async function runAllowedHostsGateChecks(mainHarness: ParityHarness, local: ParityHarness): Promise<void> {
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
	await runRefusalMatrixForMode(mainHarness, "allowed-hosts", local.pair, () => ({ Host: "other.test" }));
}

async function runDesktopSecretGateChecks(mainHarness: ParityHarness, local: ParityHarness): Promise<void> {
	await checkPairRequest(local, "desktop pass exact secret", 200, (p) => ({ Host: `127.0.0.1:${p}`, "x-learnharness-desktop": DESKTOP_SECRET }));
	await checkPairRequest(local, "desktop pass doc route OPTIONS", 204, (p) => ({ Host: `127.0.0.1:${p}`, "x-learnharness-desktop": DESKTOP_SECRET }), "OPTIONS", DOC_MARKDOWN_PATH);
	await checkPairRequest(local, "desktop refuse wrong secret", 403, (p) => ({ Host: `127.0.0.1:${p}`, "x-learnharness-desktop": "0".repeat(64) }));
	await runRefusalMatrixForMode(mainHarness, "desktop-secret", local.pair, (p) => ({ Host: `127.0.0.1:${p}` }));
}

async function runDesktopNoSecretGateChecks(mainHarness: ParityHarness, local: ParityHarness): Promise<void> {
	await checkPairRequest(local, "desktop-nosecret refuse even with header", 403, (p) => ({ Host: `127.0.0.1:${p}`, "x-learnharness-desktop": DESKTOP_SECRET }));
	await runRefusalMatrixForMode(mainHarness, "desktop-nosecret", local.pair, (p) => ({ Host: `127.0.0.1:${p}` }));
}

const GATE_MODE_SPECS: readonly GateModeSuiteSpec[] = [
	{
		name: "browser",
		refusedHeaders: () => ({ Host: "evil.example" }),
		passingHeaders: (p) => ({ Host: `127.0.0.1:${p}` }),
		runGateChecks: runBrowserGateChecks,
	},
	{
		name: "allowed-hosts",
		gate: { LH_ALLOWED_HOSTS: "peer.test", readyHeaders: { Host: "peer.test" } },
		refusedHeaders: () => ({ Host: "other.test" }),
		passingHeaders: (p) => ({ Host: `peer.test:${p}` }),
		runGateChecks: runAllowedHostsGateChecks,
	},
	{
		name: "desktop-secret",
		gate: { LH_DESKTOP_SERVER: "1", LH_DESKTOP_API_SECRET: DESKTOP_SECRET, readyHeaders: { "x-learnharness-desktop": DESKTOP_SECRET } },
		refusedHeaders: (p) => ({ Host: `127.0.0.1:${p}` }),
		passingHeaders: (p) => ({ Host: `127.0.0.1:${p}`, "x-learnharness-desktop": DESKTOP_SECRET }),
		runGateChecks: runDesktopSecretGateChecks,
	},
	{
		name: "desktop-nosecret",
		gate: { LH_DESKTOP_SERVER: "1", readyExpectedStatus: 403 },
		refusedHeaders: (p) => ({ Host: `127.0.0.1:${p}`, "x-learnharness-desktop": DESKTOP_SECRET }),
		runGateChecks: runDesktopNoSecretGateChecks,
	},
];

async function runEncodedChecksOnHarness(
	mainHarness: ParityHarness,
	local: ParityHarness,
	mode: GateModeSuiteSpec,
): Promise<void> {
	for (const p of ENCODED_MATCHER_PATHS) {
		const reqFn = (_side: ServerSide, port: number) => ({ method: "POST", path: p, headers: mode.refusedHeaders(port) });
		await runParityRequest(local, { label: `matcher-encoded-paths [${mode.name}] refused POST ${p}`, expectedStatus: 403, request: reqFn });
	}
	if (!mode.passingHeaders) return;
	const passHdrs = mode.passingHeaders;
	for (const p of ENCODED_MATCHER_PATHS.slice(0, 2)) {
		await runParityRequest(local, {
			label: `matcher-encoded-paths [${mode.name}] pass OPTIONS ${p}`,
			expectedStatus: 204,
			request: (_side, port) => ({ method: "OPTIONS", path: p, headers: passHdrs(port) }),
		});
	}
	const staticEncPath = ENCODED_MATCHER_PATHS[2];
	const [nextRes, apiRes] = await Promise.all([
		sendWire(local.pair.next.port, { method: "OPTIONS", path: staticEncPath, headers: passHdrs(local.pair.next.port) }),
		sendWire(local.pair.api.port, { method: "OPTIONS", path: staticEncPath, headers: passHdrs(local.pair.api.port) }),
	]);
	assert.equal(nextRes.status, 404);
	assert.equal(apiRes.status, 404);
	mainHarness.recordObservation({
		ruleId: "unknown-api-path-404",
		request: `OPTIONS ${staticEncPath} (${mode.name} pass)`,
		nextSummary: "status=404 HTML _not-found",
		apiSummary: "status=404 empty body",
	});
}

interface SharedGateOutcome {
	encodedError: unknown;
	gateError: unknown;
}

const sharedOutcomes = new WeakMap<ParityHarness, Promise<SharedGateOutcome>>();

async function executeSharedModeOnHarness(
	mainHarness: ParityHarness,
	local: ParityHarness,
	spec: GateModeSuiteSpec,
	outcome: SharedGateOutcome,
): Promise<void> {
	try {
		await runEncodedChecksOnHarness(mainHarness, local, spec);
	} catch (err) {
		outcome.encodedError ??= err;
	}
	try {
		await spec.runGateChecks(mainHarness, local);
	} catch (err) {
		outcome.gateError ??= err;
	}
	if (local !== mainHarness) {
		for (const obs of local.observed) mainHarness.recordObservation(obs);
	}
}

async function runSharedGateSuitesOnce(
	mainHarness: ParityHarness,
	routes: readonly RouteRecord[],
): Promise<SharedGateOutcome> {
	const outcome: SharedGateOutcome = { encodedError: null, gateError: null };
	for (const spec of GATE_MODE_SPECS) {
		if (!spec.gate) {
			await executeSharedModeOnHarness(mainHarness, mainHarness, spec, outcome);
			continue;
		}
		const pair = await startParityPair(spec.gate);
		try {
			const local = createParityHarness(pair, mainHarness.stub, routes);
			await executeSharedModeOnHarness(mainHarness, local, spec, outcome);
		} finally {
			await pair.stopAll();
		}
	}
	return outcome;
}

function ensureSharedGateSuites(mainHarness: ParityHarness, routes: readonly RouteRecord[]): Promise<SharedGateOutcome> {
	let cached = sharedOutcomes.get(mainHarness);
	if (!cached) {
		cached = runSharedGateSuitesOnce(mainHarness, routes);
		sharedOutcomes.set(mainHarness, cached);
	}
	return cached;
}

export async function runSharedEncodedPathParity(mainHarness: ParityHarness, routes: readonly RouteRecord[]): Promise<void> {
	const outcome = await ensureSharedGateSuites(mainHarness, routes);
	if (outcome.encodedError !== null) throw outcome.encodedError;
}

export async function runAllGateModesParity(mainHarness: ParityHarness, routes: readonly RouteRecord[]): Promise<void> {
	const outcome = await ensureSharedGateSuites(mainHarness, routes);
	if (outcome.gateError !== null) throw outcome.gateError;
}
