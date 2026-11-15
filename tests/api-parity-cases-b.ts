import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import type { RouteRecord } from "../src/api/types.ts";
import { startParityPair, type ParityPair } from "./api-parity-servers.ts";
import type { ServerSide } from "./api-parity-stubs.ts";
import { sendRawSocket, sendWire, type LiveStreamHandle } from "./api-parity-wire.ts";
import {
	assertDataDirsEqual,
	runParityRequest,
	type ParityHarness,
} from "./api-parity-compare.ts";
import { runSharedEncodedPathParity } from "./api-parity-gate.ts";
import {
	openEventsWithPulse,
	waitChatSettledOnBoth,
	waitExtractionIdleOnBoth,
} from "./api-parity-routes-b.ts";
import {
	BODY_CAP_BYTES,
	BODY_CAP_PLUS_ONE,
	DOC_MARKDOWN_PATH,
	GOLDEN_TEACH_CHAT,
	encodeMultipartRequest,
} from "./api-test-helpers.ts";

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
	await Promise.all([
		h.pair.next.waitForLog((s) => /SyntaxError|JSON/i.test(s), 5_000),
		h.pair.api.waitForLog((s) => s.includes("[api] Unhandled route error"), 5_000),
	]);
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

function buildValidPositionsJson(byteLength: number): Buffer {
	const buf = Buffer.alloc(byteLength, 0x20);
	buf.write('{"positions":{', 0, "utf8");
	buf.write("}}", byteLength - 2, "utf8");
	return buf;
}

export async function caseBodyCap(h: ParityHarness): Promise<void> {
	const exactBuf = buildValidPositionsJson(BODY_CAP_BYTES);
	await runParityRequest(h, {
		label: "body-cap row 24 PUT exact cap uncut",
		isWrite: true,
		expectedStatus: 200,
		request: { method: "PUT", path: "/api/graph/positions", headers: { "Content-Type": "application/json" }, body: exactBuf },
	});
	const overBuf = buildValidPositionsJson(BODY_CAP_PLUS_ONE);
	await runParityRequest(h, {
		label: "body-cap row 24 PUT with Content-Length over cap",
		isWrite: true,
		expectedStatus: 400,
		request: { method: "PUT", path: "/api/graph/positions", headers: { "Content-Type": "application/json" }, body: overBuf },
	});
	await runParityRequest(h, {
		label: "body-cap row 24 PUT chunked over cap",
		isWrite: true,
		expectedStatus: 400,
		request: { method: "PUT", path: "/api/graph/positions", headers: { "Content-Type": "application/json" }, body: overBuf, chunked: true },
	});
	await runOversizedMultipartBodyCapChecks(h);
}

async function runOversizedMultipartBodyCapChecks(h: ParityHarness): Promise<void> {
	const bigNotesForm = new FormData();
	bigNotesForm.append("files", new File([Buffer.alloc(BODY_CAP_PLUS_ONE, 0x61)], "huge.md", { type: "text/markdown" }));
	const mpImport = await encodeMultipartRequest(bigNotesForm);
	await runParityRequest(h, {
		label: "body-cap row 22 POST /api/graph/import chunked",
		isWrite: true,
		expectedStatus: 400,
		request: { method: "POST", path: "/api/graph/import", headers: { "Content-Type": mpImport.contentType }, body: mpImport.body, chunked: true },
	});
	const smallDocForm = new FormData();
	smallDocForm.append("file", new File(["Valid small text\n"], "small.txt", { type: "text/plain" }));
	const mpDoc = await encodeMultipartRequest(smallDocForm);
	const docWithEpilogue = Buffer.concat([mpDoc.body, Buffer.alloc(BODY_CAP_PLUS_ONE, 0x20)]);
	const docOut = await runParityRequest(h, {
		label: "body-cap row 35 POST /api/plugins/document-one/documents/markdown uncut 413",
		isWrite: true,
		expectedStatus: 413,
		request: {
			method: "POST",
			path: DOC_MARKDOWN_PATH,
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

async function verifySigtermIdle(pair: ParityPair): Promise<void> {
	try {
		const [nextRes, apiRes] = await Promise.all([
			sendWire(pair.next.port, { method: "GET", path: "/api/settings" }),
			sendWire(pair.api.port, { method: "GET", path: "/api/settings" }),
		]);
		assert.equal(nextRes.status, 200);
		assert.equal(apiRes.status, 200);
		pair.api.clearLogs();
		const [nextStop, apiStop] = await Promise.all([pair.next.stop(), pair.api.stop()]);
		assert.equal(nextStop.killedHard, false, `Idle Next did not exit cleanly on SIGTERM (${nextStop.elapsedMs}ms)`);
		assert.equal(apiStop.killedHard, false, `Idle API did not exit cleanly on SIGTERM (${apiStop.elapsedMs}ms)`);
		assert.ok(nextStop.elapsedMs < 3_000, `Idle Next SIGTERM exceeded 3s: ${nextStop.elapsedMs}ms`);
		assert.ok(apiStop.elapsedMs < 3_000, `Idle API SIGTERM exceeded 3s: ${apiStop.elapsedMs}ms`);
		assert.equal(pair.api.logs().includes("Forced"), false, `Idle API logged forced shutdown:\n${pair.api.logs()}`);
	} finally {
		await pair.stopAll();
	}
}

async function verifySigtermWithOpenEvents(h: ParityHarness): Promise<void> {
	const pair = await startParityPair();
	let nextEv: LiveStreamHandle | null = null;
	let apiEv: LiveStreamHandle | null = null;
	try {
		const opened = await openEventsWithPulse(pair.next.port, pair.api.port);
		nextEv = opened.nextEv;
		apiEv = opened.apiEv;
		assert.equal(nextEv.status, 200);
		assert.equal(apiEv.status, 200);
		pair.api.clearLogs();
		const [nextStop, apiStop] = await Promise.all([pair.next.stop(), pair.api.stop()]);
		assert.equal(apiStop.killedHard, false, `API with open /api/events did not exit cleanly on SIGTERM (${apiStop.elapsedMs}ms)`);
		assert.ok(apiStop.elapsedMs < 3_000, `API with open /api/events SIGTERM exceeded 3s: ${apiStop.elapsedMs}ms`);
		assert.equal(pair.api.logs().includes("Forced"), false, `Open-SSE API logged forced shutdown:\n${pair.api.logs()}`);
		if (nextStop.killedHard || nextStop.elapsedMs >= 3_000) {
			const nextSummary = `killedHard=${String(nextStop.killedHard)} elapsedMs=${nextStop.elapsedMs}`;
			const apiSummary = `killedHard=${String(apiStop.killedHard)} elapsedMs=${apiStop.elapsedMs}`;
			h.recordObservation({ ruleId: "sigterm-open-sse-exit", request: "SIGTERM with GET /api/events open", nextSummary, apiSummary });
		}
	} finally {
		nextEv?.abort();
		apiEv?.abort();
		await pair.stopAll();
	}
}

export async function caseSigtermStop(h: ParityHarness): Promise<void> {
	await verifySigtermIdle(h.pair);
	await verifySigtermWithOpenEvents(h);
}

export async function caseLongStream(t: TestContext, h: ParityHarness): Promise<void> {
	if (process.env.PEER_API_PARITY_LONG !== "1") {
		t.skip("Set PEER_API_PARITY_LONG=1 to run 6-minute (>300s) SSE stream longevity check");
		return;
	}
	const { nextEv, apiEv } = await openEventsWithPulse(h.pair.next.port, h.pair.api.port);
	try {
		await new Promise((r) => setTimeout(r, 362_000));
		const body = JSON.stringify({ sourceIds: ["src_long_stream_probe"], folderIds: [], deleteSessions: false });
		await Promise.all([
			sendWire(h.pair.next.port, { method: "DELETE", path: "/api/graph/sources", headers: { "Content-Type": "application/json" }, body }),
			sendWire(h.pair.api.port, { method: "DELETE", path: "/api/graph/sources", headers: { "Content-Type": "application/json" }, body }),
		]);
		await Promise.all([
			nextEv.waitForText("sources-changed", 10_000),
			apiEv.waitForText("sources-changed", 10_000),
		]);
	} finally {
		nextEv.abort();
		apiEv.abort();
	}
}

export function caseMatcherEncodedPaths(
	mainHarness: ParityHarness,
	routes: readonly RouteRecord[],
): Promise<void> {
	return runSharedEncodedPathParity(mainHarness, routes);
}
