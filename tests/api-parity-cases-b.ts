import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { startParityPair, type GateEnvOptions } from "./api-parity-servers.ts";
import type { ServerSide } from "./api-parity-stubs.ts";
import { connectWireStream, openWireStream, sendRawSocket, sendWire } from "./api-parity-wire.ts";
import {
	assertDataDirsEqual,
	compareResponseHeaders,
	createParityHarness,
	runParityRequest,
	type ParityHarness,
} from "./api-parity-compare.ts";
import { encodeMultipartRequest, GOLDEN_TEACH_CHAT } from "./api-parity-routes-a.ts";
import { waitChatSettledOnBoth, waitExtractionIdleOnBoth } from "./api-parity-routes-b.ts";

const BODY_CAP_PLUS_ONE = 27_262_977;
const DESKTOP_SECRET = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";

export async function caseTrailingSlash(h: ParityHarness): Promise<void> {
	const passingCases: Array<{ path: string; expectedLoc: string }> = [
		{ path: "/api/graph/", expectedLoc: "/api/graph" },
		{ path: "/api/graph/?x=1", expectedLoc: "/api/graph?x=1" },
		{ path: "/api/", expectedLoc: "/api" },
		{ path: "/api/?request=1", expectedLoc: "/api?request=1" },
	];
	for (const item of passingCases) {
		const [nextRes, apiRes] = await Promise.all([
			sendWire(h.pair.next.port, { method: "GET", path: item.path }),
			sendWire(h.pair.api.port, { method: "GET", path: item.path }),
		]);
		assert.equal(nextRes.status, 308);
		assert.equal(nextRes.headers.location, item.expectedLoc);
		assert.equal(apiRes.status, 404);
		assert.equal(apiRes.rawBody.length, 0);
		h.recordObservation({
			ruleId: "trailing-slash-redirect-vs-gate-and-404",
			request: `GET ${item.path} (gate passing)`,
			nextSummary: `status=308 Location=${nextRes.headers.location ?? ""}`,
			apiSummary: "status=404 empty body",
		});
	}
	await checkRefusedTrailingSlash(h);
}

async function checkRefusedTrailingSlash(h: ParityHarness): Promise<void> {
	for (const reqPath of ["/api/graph/", "/api/graph/?x=1"]) {
		const [nextRes, apiRes] = await Promise.all([
			sendWire(h.pair.next.port, { method: "GET", path: reqPath, headers: { Host: "evil.example" } }),
			sendWire(h.pair.api.port, { method: "GET", path: reqPath, headers: { Host: "evil.example" } }),
		]);
		assert.equal(nextRes.status, 308);
		assert.equal(apiRes.status, 403);
		assert.equal(apiRes.headers["cache-control"], "no-store");
		h.recordObservation({
			ruleId: "trailing-slash-redirect-vs-gate-and-404",
			request: `GET ${reqPath} (gate refused)`,
			nextSummary: `status=308 Location=${nextRes.headers.location ?? ""} (pre-gate)`,
			apiSummary: "status=403 refused by gate",
		});
	}
}

export async function caseHandlerThrows(h: ParityHarness): Promise<void> {
	h.pair.next.clearLogs();
	h.pair.api.clearLogs();
	const out = await runParityRequest(h, {
		label: "handler-throws POST /api/chats/[id]/steer malformed JSON",
		expectedStatus: 500,
		request: {
			method: "POST",
			path: `/api/chats/${GOLDEN_TEACH_CHAT}/steer`,
			headers: { "Content-Type": "application/json" },
			body: "{bad",
		},
	});
	assert.equal(out.nextRes.rawBody.length, 0);
	assert.equal(out.apiRes.rawBody.length, 0);
	await waitBothLogged(h);
}

async function waitBothLogged(h: ParityHarness): Promise<void> {
	for (let i = 0; i < 40; i++) {
		if (h.pair.next.logs().trim().length > 0 && h.pair.api.logs().trim().length > 0) return;
		await new Promise((r) => setTimeout(r, 25));
	}
	assert.ok(h.pair.next.logs().trim().length > 0, "Expected error log line from Next server on thrown handler");
	assert.ok(h.pair.api.logs().trim().length > 0, "Expected error log line from API server on thrown handler");
}

export async function caseUnknownApiPath(h: ParityHarness): Promise<void> {
	const [nextRes, apiRes] = await Promise.all([
		sendWire(h.pair.next.port, { method: "GET", path: "/api/nope" }),
		sendWire(h.pair.api.port, { method: "GET", path: "/api/nope" }),
	]);
	assert.equal(nextRes.status, 404);
	assert.equal(apiRes.status, 404);
	assert.match(nextRes.headers["content-type"] ?? "", /text\/html/);
	assert.equal(apiRes.rawBody.length, 0);
	h.recordObservation({
		ruleId: "unknown-api-path-404",
		request: "GET /api/nope",
		nextSummary: `status=404 content-type=${nextRes.headers["content-type"] ?? ""} x-powered-by=${nextRes.headers["x-powered-by"] ?? ""}`,
		apiSummary: "status=404 empty body (0 bytes)",
	});
}

export async function caseBodilessShape(h: ParityHarness): Promise<void> {
	for (const method of ["POST", "DELETE"] as const) {
		const [nextRaw, apiRaw] = await Promise.all([
			sendRawSocket(h.pair.next.port, `${method} /api/graph/sources HTTP/1.1\r\nHost: 127.0.0.1:${h.pair.next.port}\r\nConnection: close\r\n\r\n`),
			sendRawSocket(h.pair.api.port, `${method} /api/graph/sources HTTP/1.1\r\nHost: 127.0.0.1:${h.pair.api.port}\r\nConnection: close\r\n\r\n`),
		]);
		assert.equal(nextRaw.status, 400);
		assert.equal(apiRaw.status, 400);
		assert.deepEqual(JSON.parse(apiRaw.text), JSON.parse(nextRaw.text));
		await runParityRequest(h, {
			label: `bodiless-shape Content-Length:0 ${method} /api/graph/sources`,
			expectedStatus: 400,
			request: { method, path: "/api/graph/sources", headers: { "Content-Length": "0" } },
		});
	}
}

function buildOversizedValidPositionsJson(): Buffer {
	const buf = Buffer.alloc(BODY_CAP_PLUS_ONE, 0x20);
	buf.write('{"positions":{', 0, "utf8");
	buf.write("}}", BODY_CAP_PLUS_ONE - 2, "utf8");
	return buf;
}

export async function caseBodyCap(h: ParityHarness): Promise<void> {
	const jsonBuf = buildOversizedValidPositionsJson();
	await runParityRequest(h, {
		label: "body-cap row 24 PUT with Content-Length",
		expectedStatus: 400,
		request: { method: "PUT", path: "/api/graph/positions", headers: { "Content-Type": "application/json" }, body: jsonBuf },
	});
	await runParityRequest(h, {
		label: "body-cap row 24 PUT chunked",
		expectedStatus: 400,
		request: { method: "PUT", path: "/api/graph/positions", headers: { "Content-Type": "application/json" }, body: jsonBuf, chunked: true },
	});
	await runOversizedMultipartBodyCapChecks(h);
}

async function runOversizedMultipartBodyCapChecks(h: ParityHarness): Promise<void> {
	const bigNotesForm = new FormData();
	bigNotesForm.append("files", new File([Buffer.alloc(BODY_CAP_PLUS_ONE, 0x61)], "huge.md", { type: "text/markdown" }));
	const mpImport = await encodeMultipartRequest(bigNotesForm);
	await runParityRequest(h, {
		label: "body-cap row 22 POST /api/graph/import chunked",
		expectedStatus: 400,
		request: { method: "POST", path: "/api/graph/import", headers: { "Content-Type": mpImport.contentType }, body: mpImport.body, chunked: true },
	});
	const smallDocForm = new FormData();
	smallDocForm.append("file", new File(["Valid small text\n"], "small.txt", { type: "text/plain" }));
	const mpDoc = await encodeMultipartRequest(smallDocForm);
	const docWithEpilogue = Buffer.concat([mpDoc.body, Buffer.alloc(BODY_CAP_PLUS_ONE, 0x20)]);
	const docOut = await runParityRequest(h, {
		label: "body-cap row 35 POST /api/plugins/document-one/documents/markdown uncut 413",
		expectedStatus: 413,
		request: {
			method: "POST",
			path: "/api/plugins/document-one/documents/markdown",
			headers: { "Content-Type": mpDoc.contentType },
			body: docWithEpilogue,
			chunked: true,
		},
	});
	assert.match(docOut.nextRes.text, /26 MiB/);
	assert.match(docOut.apiRes.text, /26 MiB/);
}

export async function caseSharedRegistries(h: ParityHarness, teachIds: Record<ServerSide, string>): Promise<void> {
	const hold = h.stub.armChatHold();
	try {
		h.stub.setSide("next");
		const nextTurn = sendWire(h.pair.next.port, {
			method: "POST",
			path: "/api/chat",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ chatId: teachIds.next, input: { type: "text", text: "Shared registry check" } }),
		});
		await hold.waitStarted("next");
		h.stub.setSide("api");
		const apiTurn = sendWire(h.pair.api.port, {
			method: "POST",
			path: "/api/chat",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ chatId: teachIds.api, input: { type: "text", text: "Shared registry check" } }),
		});
		await hold.waitStarted("api");
		await verifyTurnInFlightOnBoth(h, teachIds);
		hold.release("next");
		hold.release("api");
		await Promise.all([nextTurn, apiTurn]);
	} finally {
		hold.clear();
	}
	await waitChatSettledOnBoth(h, teachIds);
	await waitExtractionIdleOnBoth(h);
	assertDataDirsEqual(h, "shared-registries turn");
}

async function verifyTurnInFlightOnBoth(h: ParityHarness, teachIds: Record<ServerSide, string>): Promise<void> {
	const out = await runParityRequest(h, {
		label: "shared-registries GET /api/chats/[id] while turn running",
		expectedStatus: 200,
		request: (side) => ({ method: "GET", path: `/api/chats/${teachIds[side]}` }),
	});
	assert.equal((JSON.parse(out.nextRes.text) as { turnInFlight?: boolean }).turnInFlight, true);
	assert.equal((JSON.parse(out.apiRes.text) as { turnInFlight?: boolean }).turnInFlight, true);
}

export async function caseOutboundFetchUncached(h: ParityHarness): Promise<void> {
	try {
		h.stub.setVoices([{ id: "voice-one", name: "Voice One" }]);
		const first = await runParityRequest(h, {
			label: "outbound-fetch-uncached call 1",
			expectedStatus: 200,
			request: { method: "GET", path: "/api/tts/voices" },
		});
		assert.match(first.apiRes.text, /voice-one/);
		h.stub.setVoices([{ id: "voice-two", name: "Voice Two" }, { id: "voice-three", name: "Voice Three" }]);
		const second = await runParityRequest(h, {
			label: "outbound-fetch-uncached call 2",
			expectedStatus: 200,
			request: { method: "GET", path: "/api/tts/voices" },
		});
		assert.match(second.apiRes.text, /voice-two/);
		assert.doesNotMatch(second.apiRes.text, /voice-one/);
	} finally {
		h.stub.setVoices([
			{ id: "alloy", name: "Alloy" },
			{ id: "nova", name: "Nova" },
		]);
	}
}

async function verifySigtermIdle(): Promise<void> {
	const pair = await startParityPair();
	const [nextRes, apiRes] = await Promise.all([
		sendWire(pair.next.port, { method: "GET", path: "/api/settings" }),
		sendWire(pair.api.port, { method: "GET", path: "/api/settings" }),
	]);
	assert.equal(nextRes.status, 200);
	assert.equal(apiRes.status, 200);
	const [nextStop, apiStop] = await Promise.all([pair.next.stop(), pair.api.stop()]);
	await pair.stopAll();
	assert.equal(nextStop.killedHard, false, `Idle Next did not exit cleanly on SIGTERM (${nextStop.elapsedMs}ms)`);
	assert.equal(apiStop.killedHard, false, `Idle API did not exit cleanly on SIGTERM (${apiStop.elapsedMs}ms)`);
	assert.ok(nextStop.elapsedMs < 3_000, `Idle Next SIGTERM exceeded 3s: ${nextStop.elapsedMs}ms`);
	assert.ok(apiStop.elapsedMs < 3_000, `Idle API SIGTERM exceeded 3s: ${apiStop.elapsedMs}ms`);
}

async function verifySigtermWithOpenEvents(h: ParityHarness): Promise<void> {
	const pair = await startParityPair();
	const nextEv = connectWireStream(pair.next.port, { method: "GET", path: "/api/events" });
	const apiEv = connectWireStream(pair.api.port, { method: "GET", path: "/api/events" });
	await new Promise((r) => setTimeout(r, 80));
	const apiHdr = await apiEv.waitHeaders(2_000);
	assert.equal(apiHdr.status, 200);
	const [nextStop, apiStop] = await Promise.all([pair.next.stop(), pair.api.stop()]);
	nextEv.abort();
	apiEv.abort();
	await pair.stopAll();
	assert.equal(apiStop.killedHard, false, `API with open /api/events did not exit cleanly on SIGTERM (${apiStop.elapsedMs}ms)`);
	assert.ok(apiStop.elapsedMs < 3_000, `API with open /api/events SIGTERM exceeded 3s: ${apiStop.elapsedMs}ms`);
	if (nextStop.killedHard || nextStop.elapsedMs >= 3_000) {
		h.recordObservation({
			ruleId: "sigterm-open-sse-exit",
			request: "SIGTERM with GET /api/events open",
			nextSummary: `killedHard=${String(nextStop.killedHard)} elapsedMs=${nextStop.elapsedMs}`,
			apiSummary: `killedHard=${String(apiStop.killedHard)} elapsedMs=${apiStop.elapsedMs}`,
		});
	}
}

export async function caseSigtermStop(h: ParityHarness): Promise<void> {
	await verifySigtermIdle();
	await verifySigtermWithOpenEvents(h);
}

export async function caseLongStream(t: TestContext, h: ParityHarness): Promise<void> {
	if (process.env.PEER_API_PARITY_LONG !== "1") {
		t.skip("Set PEER_API_PARITY_LONG=1 to run 6-minute (>300s) SSE stream longevity check");
		return;
	}
	const [nextEv, apiEv] = await Promise.all([
		openWireStream(h.pair.next.port, { method: "GET", path: "/api/events", timeoutMs: 400_000 }),
		openWireStream(h.pair.api.port, { method: "GET", path: "/api/events", timeoutMs: 400_000 }),
	]);
	try {
		await new Promise((r) => setTimeout(r, 362_000));
		const body = JSON.stringify({ sourceIds: ["src_long_stream_probe"], folderIds: [], deleteSessions: false });
		await Promise.all([
			sendWire(h.pair.next.port, { method: "DELETE", path: "/api/graph/sources", headers: { "Content-Type": "application/json" }, body }),
			sendWire(h.pair.api.port, { method: "DELETE", path: "/api/graph/sources", headers: { "Content-Type": "application/json" }, body }),
		]);
		await new Promise((r) => setTimeout(r, 250));
		assert.match(nextEv.snapshotText(), /sources-changed/);
		assert.match(apiEv.snapshotText(), /sources-changed/);
	} finally {
		nextEv.abort();
		apiEv.abort();
	}
}

interface EncodedGateModeSpec {
	name: string;
	gate?: GateEnvOptions;
	refusedHeaders: (port: number) => Record<string, string>;
	passingHeaders?: (port: number) => Record<string, string>;
}

const ENCODED_GATE_MODES: readonly EncodedGateModeSpec[] = [
	{
		name: "browser",
		refusedHeaders: () => ({ Host: "evil.example" }),
		passingHeaders: (p) => ({ Host: `127.0.0.1:${p}` }),
	},
	{
		name: "allowed-hosts",
		gate: { LH_ALLOWED_HOSTS: "peer.test", readyHeaders: { Host: "peer.test" } },
		refusedHeaders: () => ({ Host: "other.test" }),
		passingHeaders: (p) => ({ Host: `peer.test:${p}` }),
	},
	{
		name: "desktop-secret",
		gate: { LH_DESKTOP_SERVER: "1", LH_DESKTOP_API_SECRET: DESKTOP_SECRET, readyHeaders: { "x-learnharness-desktop": DESKTOP_SECRET } },
		refusedHeaders: (p) => ({ Host: `127.0.0.1:${p}` }),
		passingHeaders: (p) => ({ Host: `127.0.0.1:${p}`, "x-learnharness-desktop": DESKTOP_SECRET }),
	},
	{
		name: "desktop-nosecret",
		gate: { LH_DESKTOP_SERVER: "1", readyExpectedStatus: 403 },
		refusedHeaders: (p) => ({ Host: `127.0.0.1:${p}`, "x-learnharness-desktop": DESKTOP_SECRET }),
	},
];

export async function caseMatcherEncodedPaths(mainHarness: ParityHarness): Promise<void> {
	const encodedPaths = [
		"/api/plugins/document%2Done/documents/markdown",
		"/api/plugins/%64ocument-one/documents/markdown",
		"/api/plugins/document-one/documents/%6Darkdown",
	];
	for (const mode of ENCODED_GATE_MODES) {
		await checkEncodedPathsInOneMode(mainHarness, mode, encodedPaths);
	}
}

async function checkEncodedPathsInOneMode(
	mainHarness: ParityHarness,
	mode: EncodedGateModeSpec,
	encodedPaths: readonly string[],
): Promise<void> {
	const pair = await startParityPair(mode.gate);
	const local = createParityHarness(pair, mainHarness.stub);
	try {
		for (const p of encodedPaths) {
			const reqFn = (_side: ServerSide, port: number) => ({ method: "POST", path: p, headers: mode.refusedHeaders(port) });
			await runParityRequest(local, { label: `matcher-encoded-paths [${mode.name}] refused POST ${p}`, expectedStatus: 403, request: reqFn });
		}
		if (mode.passingHeaders) await checkPassingEncodedPaths(mainHarness, local, mode, encodedPaths);
		for (const obs of local.observed) mainHarness.recordObservation(obs);
	} finally {
		await pair.stopAll();
	}
}

async function checkPassingEncodedPaths(
	mainHarness: ParityHarness,
	local: ParityHarness,
	mode: EncodedGateModeSpec,
	encodedPaths: readonly string[],
): Promise<void> {
	const passHdrs = mode.passingHeaders!;
	for (const p of encodedPaths.slice(0, 2)) {
		await runParityRequest(local, {
			label: `matcher-encoded-paths [${mode.name}] pass OPTIONS ${p}`,
			expectedStatus: 204,
			request: (_side, port) => ({ method: "OPTIONS", path: p, headers: passHdrs(port) }),
		});
	}
	const staticEncPath = encodedPaths[2]!;
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
