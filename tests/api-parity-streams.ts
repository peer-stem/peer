import assert from "node:assert/strict";
import * as http from "node:http";
import type { ServerSide } from "./api-parity-stubs.ts";
import { connectWireStream, openWireStream, parseNdjsonStream, parseSseStream, sendWire, type LiveStreamHandle } from "./api-parity-wire.ts";
import {
	assertDataDirsEqual,
	compareResponseHeaders,
	normalizeJsonValue,
	normalizeSseEvents,
	runParityRequest,
	type ParityHarness,
} from "./api-parity-compare.ts";
import { GOLDEN_TEACH_CHAT } from "./api-parity-routes-a.ts";
import { pulseEventsBusOnBoth, waitChatSettledOnBoth, waitExtractionIdleOnBoth } from "./api-parity-routes-b.ts";

const GOLDEN_SIDE_THREAD = "side_msg_mv27s2zx_8e76e94b";
const MAX_TTS_AUDIO_BYTES = 33_554_432;

async function waitStreamContainsCount(stream: LiveStreamHandle, needle: string, minCount: number, timeoutMs = 10_000): Promise<string> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const text = stream.snapshotText();
		const count = text.split(needle).length - 1;
		if (count >= minCount) return text;
		await new Promise((r) => setTimeout(r, 25));
	}
	throw new Error(`Timed out waiting for ${minCount}x "${needle}" in stream; got:\n${stream.snapshotText()}`);
}

export async function runEventsStreamParity(h: ParityHarness): Promise<void> {
	const nextConn = connectWireStream(h.pair.next.port, { method: "GET", path: "/api/events" });
	const apiConn = connectWireStream(h.pair.api.port, { method: "GET", path: "/api/events" });
	const apiStream = await apiConn.waitHeaders(1_500);
	assert.equal(apiStream.status, 200);
	await new Promise((r) => setTimeout(r, 80));
	if (!nextConn.headersArrived()) {
		h.recordObservation({
			ruleId: "events-header-flush-timing",
			request: "GET /api/events",
			nextSummary: "headers buffered until first SSE frame or 25s ping",
			apiSummary: `headers flushed immediately (${apiStream.headersElapsedMs}ms)`,
		});
	}
	await triggerEventsOnPending(h, nextConn, apiStream);
	nextConn.abort();
	apiConn.abort();
	const reopenNext = connectWireStream(h.pair.next.port, { method: "GET", path: "/api/events" });
	const reopenApi = connectWireStream(h.pair.api.port, { method: "GET", path: "/api/events" });
	await new Promise((r) => setTimeout(r, 40));
	await pulseEventsBusOnBoth(h);
	const [rn, ra] = await Promise.all([reopenNext.waitHeaders(5_000), reopenApi.waitHeaders(5_000)]);
	assert.equal(rn.status, 200);
	assert.equal(ra.status, 200);
	rn.abort();
	ra.abort();
}

async function triggerEventsOnPending(
	h: ParityHarness,
	nextConn: ReturnType<typeof connectWireStream>,
	apiStream: LiveStreamHandle,
): Promise<void> {
	await pulseEventsBusOnBoth(h);
	const nextStream = await nextConn.waitHeaders(5_000);
	assert.equal(nextStream.status, 200);
	compareResponseHeaders(h, nextStream.headers, apiStream.headers, { requestLabel: "stream /api/events" });
	const [nextRaw, apiRaw] = await Promise.all([
		waitStreamContainsCount(nextStream, "data: ", 3),
		waitStreamContainsCount(apiStream, "data: ", 3),
	]);
	const nextEvents = normalizeSseEvents(h, "next", parseSseStream(nextRaw).slice(0, 3));
	const apiEvents = normalizeSseEvents(h, "api", parseSseStream(apiRaw).slice(0, 3));
	assert.deepEqual(apiEvents, nextEvents, "/api/events SSE payload sequence mismatch");
}

async function runLiveAttachOnOneSide(
	h: ParityHarness,
	side: ServerSide,
	port: number,
	chatId: string,
	hold: ReturnType<ParityHarness["stub"]["armChatHold"]>,
): Promise<{ headers: Record<string, string>; text: string }> {
	h.stub.setSide(side);
	const chatPost = sendWire(port, {
		method: "POST",
		path: "/api/chat",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ chatId, input: { type: "text", text: "Second live streamed turn" } }),
	});
	await hold.waitStarted(side);
	const attach = await openWireStream(port, { method: "GET", path: `/api/chats/${chatId}/stream` });
	assert.equal(attach.status, 200);
	hold.release(side);
	const [attachedRes] = await Promise.all([attach.readRest(15_000), chatPost]);
	return { headers: attach.headers, text: attachedRes.rawBody.toString("utf8") };
}

export async function runChatStreamParity(h: ParityHarness, teachIds: Record<ServerSide, string>): Promise<void> {
	const settled = await runParityRequest(h, {
		label: "stream settled GET /api/chats/[id]/stream",
		expectedStatus: 200,
		request: (side) => ({ method: "GET", path: `/api/chats/${teachIds[side]}/stream` }),
	});
	assert.deepEqual(
		normalizeSseEvents(h, "api", parseSseStream(settled.apiRes.text)),
		normalizeSseEvents(h, "next", parseSseStream(settled.nextRes.text)),
	);
	const hold = h.stub.armChatHold();
	try {
		const nextLive = await runLiveAttachOnOneSide(h, "next", h.pair.next.port, teachIds.next, hold);
		const apiLive = await runLiveAttachOnOneSide(h, "api", h.pair.api.port, teachIds.api, hold);
		compareResponseHeaders(h, nextLive.headers, apiLive.headers, { requestLabel: "live GET /api/chats/[id]/stream" });
		assert.deepEqual(
			normalizeSseEvents(h, "api", parseSseStream(apiLive.text)),
			normalizeSseEvents(h, "next", parseSseStream(nextLive.text)),
			"Live attached /api/chats/[id]/stream SSE mismatch",
		);
	} finally {
		hold.clear();
	}
	await waitChatSettledOnBoth(h, teachIds);
	await waitExtractionIdleOnBoth(h);
	assertDataDirsEqual(h, "live /api/chats/[id]/stream turn");
	await runParityRequest(h, {
		label: "stream 404 GET /api/chats/missing/stream",
		expectedStatus: 404,
		request: { method: "GET", path: "/api/chats/chat_missing_00000000/stream" },
	});
}

export async function runSideChatStreamsParity(h: ParityHarness): Promise<void> {
	const sideUrl = `/api/chats/${GOLDEN_TEACH_CHAT}/side-chats`;
	const body = JSON.stringify({ threadId: GOLDEN_SIDE_THREAD, text: "Follow-up streamed question?" });
	h.stub.setSide("next");
	const nextPost = await sendWire(h.pair.next.port, { method: "POST", path: sideUrl, headers: { "Content-Type": "application/json" }, body });
	h.stub.setSide("api");
	const apiPost = await sendWire(h.pair.api.port, { method: "POST", path: sideUrl, headers: { "Content-Type": "application/json" }, body });
	assert.equal(nextPost.status, 200);
	assert.equal(apiPost.status, 200);
	compareResponseHeaders(h, nextPost.headers, apiPost.headers, { requestLabel: "stream POST side-chats" });
	assert.deepEqual(
		normalizeJsonValue(h, "api", parseNdjsonStream(apiPost.text)),
		normalizeJsonValue(h, "next", parseNdjsonStream(nextPost.text)),
		"Follow-up POST side-chats NDJSON mismatch",
	);
	await waitSideIdle(h);
	assertDataDirsEqual(h, "stream POST side-chats");
	const watchUrl = `${sideUrl}/${GOLDEN_SIDE_THREAD}`;
	const watchOut = await runParityRequest(h, {
		label: "stream GET side-chats/[threadId]",
		expectedStatus: 200,
		request: { method: "GET", path: watchUrl },
	});
	assert.deepEqual(
		normalizeJsonValue(h, "api", parseNdjsonStream(watchOut.apiRes.text)),
		normalizeJsonValue(h, "next", parseNdjsonStream(watchOut.nextRes.text)),
	);
}

async function waitSideIdle(h: ParityHarness): Promise<void> {
	const url = `/api/chats/${GOLDEN_TEACH_CHAT}/side-chats`;
	for (let i = 0; i < 200; i++) {
		const [n, a] = await Promise.all([sendWire(h.pair.next.port, { method: "GET", path: url }), sendWire(h.pair.api.port, { method: "GET", path: url })]);
		const nAns = Object.keys((JSON.parse(n.text) as { answering?: Record<string, string> }).answering ?? {});
		const aAns = Object.keys((JSON.parse(a.text) as { answering?: Record<string, string> }).answering ?? {});
		if (nAns.length === 0 && aAns.length === 0) return;
		await new Promise((r) => setTimeout(r, 30));
	}
	throw new Error("Side-chat stream did not settle in time");
}

function collectAudioBytesResponse(
	res: http.IncomingMessage,
	resolve: (v: { status: number; headers: Record<string, string>; totalBytes: number }) => void,
): void {
	const headers: Record<string, string> = {};
	for (const [k, v] of Object.entries(res.headers)) {
		if (v !== undefined) headers[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : v;
	}
	let totalBytes = 0;
	let done = false;
	const finish = () => { if (!done) { done = true; resolve({ status: res.statusCode ?? 0, headers, totalBytes }); } };
	res.on("data", (chunk: Buffer) => { totalBytes += chunk.length; });
	res.on("end", finish);
	res.on("close", finish);
	res.on("error", finish);
}

function readStreamedAudioBytes(port: number, payload: string): Promise<{ status: number; headers: Record<string, string>; totalBytes: number }> {
	return new Promise((resolve, reject) => {
		const opts = { host: "127.0.0.1", port, method: "POST", path: "/api/tts/speak", headers: { "Content-Type": "application/json", Host: `127.0.0.1:${port}` } };
		const req = http.request(opts, (res) => collectAudioBytesResponse(res, resolve));
		req.on("error", reject);
		req.end(payload);
	});
}

export async function runTtsStreamParity(h: ParityHarness): Promise<void> {
	const payload = JSON.stringify({ text: "Streamed multi-chunk speech check." });
	h.stub.setTtsMode("normal");
	const [nextNorm, apiNorm] = await Promise.all([
		openWireStream(h.pair.next.port, { method: "POST", path: "/api/tts/speak", headers: { "Content-Type": "application/json" }, body: payload }),
		openWireStream(h.pair.api.port, { method: "POST", path: "/api/tts/speak", headers: { "Content-Type": "application/json" }, body: payload }),
	]);
	compareResponseHeaders(h, nextNorm.headers, apiNorm.headers, { requestLabel: "stream POST /api/tts/speak normal" });
	const [nextRest, apiRest] = await Promise.all([nextNorm.readRest(), apiNorm.readRest()]);
	assert.equal(Buffer.compare(apiRest.rawBody, nextRest.rawBody), 0, "Normal TTS WAV bytes mismatch");
	assert.ok(nextRest.rawBody.length >= 12_288, `Expected multi-chunk WAV >= 12288 bytes, got ${nextRest.rawBody.length}`);
	await runTtsOverCapChecks(h, payload);
}

async function runTtsOverCapChecks(h: ParityHarness, payload: string): Promise<void> {
	try {
		h.stub.setTtsMode("over-cap-header");
		await runParityRequest(h, {
			label: "stream POST /api/tts/speak over-cap Content-Length",
			expectedStatus: 502,
			request: { method: "POST", path: "/api/tts/speak", headers: { "Content-Type": "application/json" }, body: payload },
		});
		h.stub.setTtsMode("over-cap");
		const [nextCap, apiCap] = await Promise.all([
			readStreamedAudioBytes(h.pair.next.port, payload),
			readStreamedAudioBytes(h.pair.api.port, payload),
		]);
		assert.equal(nextCap.status, 200);
		assert.equal(apiCap.status, 200);
		assert.ok(nextCap.totalBytes <= MAX_TTS_AUDIO_BYTES, `Next exceeded TTS cap: ${nextCap.totalBytes}`);
		assert.ok(apiCap.totalBytes <= MAX_TTS_AUDIO_BYTES, `API exceeded TTS cap: ${apiCap.totalBytes}`);
	} finally {
		h.stub.setTtsMode("normal");
	}
}

export async function runAllStreamParityTests(h: ParityHarness, teachIds: Record<ServerSide, string>): Promise<void> {
	await runEventsStreamParity(h);
	await runChatStreamParity(h, teachIds);
	await runSideChatStreamsParity(h);
	await runTtsStreamParity(h);
}
