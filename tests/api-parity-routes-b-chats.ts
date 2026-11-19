import assert from "node:assert/strict";
import type { ServerSide } from "./api-parity-stubs.ts";
import {
	connectWireStream,
	countOccurrences,
	parseNdjsonStream,
	parseSseStream,
	sendWire,
	type LiveStreamHandle,
} from "./api-parity-wire.ts";
import {
	assertDataDirsEqual,
	compareResponseHeaders,
	normalizeJsonValue,
	normalizeSseEvents,
	runParityRequest,
	type ParityHarness,
} from "./api-parity-compare.ts";
import { GOLDEN_TEACH_CHAT } from "./api-test-helpers.ts";

const GOLDEN_DEMO_STEER_ID = "steer_job_mv28454n_25dc3185";
const GOLDEN_PROSE_MSG_ID = "msg_mv27s2zx_8c815926";

async function openNotifyEventsStream(port: number, timeoutMs: number): Promise<LiveStreamHandle> {
	const conn = connectWireStream(port, { method: "GET", path: "/api/events" });
	const pulseReq = { method: "DELETE", path: "/api/graph/sources", headers: { "Content-Type": "application/json" }, body: "{}" };
	const pulse = () => void sendWire(port, pulseReq).catch(() => {});
	const pulser = setInterval(pulse, 80);
	try {
		if (!conn.headersArrived()) pulse();
		return await conn.waitHeaders(timeoutMs);
	} catch (err) {
		conn.abort();
		throw err;
	} finally {
		clearInterval(pulser);
	}
}

async function waitPortIdleViaEvents(
	port: number,
	checkIdle: (port: number) => Promise<boolean>,
	label: string,
	timeoutMs: number,
): Promise<void> {
	if (await checkIdle(port)) return;
	const deadline = Date.now() + timeoutMs;
	const ev = await openNotifyEventsStream(port, Math.max(1, deadline - Date.now()));
	try {
		while (Date.now() < deadline) {
			const seen = countOccurrences(ev.snapshotText(), "\n\n");
			if (await checkIdle(port)) return;
			const remaining = deadline - Date.now();
			if (remaining <= 0) break;
			await ev.waitForCount("\n\n", seen + 1, remaining);
		}
	} finally {
		ev.abort();
	}
	throw new Error(`Timed out waiting for ${label}`);
}

export async function waitExtractionIdleOnBoth(h: ParityHarness, timeoutMs = 15_000): Promise<void> {
	const isIdle = async (port: number) => {
		const res = await sendWire(port, { method: "GET", path: "/api/graph/status" });
		return ((JSON.parse(res.text) as { runs?: unknown[] }).runs ?? []).length === 0;
	};
	const label = "extraction runs to drain on both servers";
	await Promise.all([
		waitPortIdleViaEvents(h.pair.next.port, isIdle, label, timeoutMs),
		waitPortIdleViaEvents(h.pair.api.port, isIdle, label, timeoutMs),
	]);
}

export async function waitChatSettledOnBoth(
	h: ParityHarness,
	chatIds: Record<ServerSide, string>,
	timeoutMs = 15_000,
): Promise<void> {
	const isSettled = (chatId: string) => async (port: number) => {
		const res = await sendWire(port, { method: "GET", path: `/api/chats/${chatId}` });
		const s = JSON.parse(res.text) as { turnInFlight?: boolean; compacting?: boolean };
		return !s.turnInFlight && !s.compacting;
	};
	const label = "chat turn to settle on both servers";
	await Promise.all([
		waitPortIdleViaEvents(h.pair.next.port, isSettled(chatIds.next), label, timeoutMs),
		waitPortIdleViaEvents(h.pair.api.port, isSettled(chatIds.api), label, timeoutMs),
	]);
}

export async function waitSideChatsSettledOnBoth(h: ParityHarness, chatId: string, timeoutMs = 15_000): Promise<void> {
	const isIdle = async (port: number) => {
		const res = await sendWire(port, { method: "GET", path: `/api/chats/${chatId}/side-chats` });
		return Object.keys((JSON.parse(res.text) as { answering?: Record<string, string> }).answering ?? {}).length === 0;
	};
	const label = "side-chat answer to settle on both servers";
	await Promise.all([
		waitPortIdleViaEvents(h.pair.next.port, isIdle, label, timeoutMs),
		waitPortIdleViaEvents(h.pair.api.port, isIdle, label, timeoutMs),
	]);
}

async function runDismissAndSteerChecks(h: ParityHarness, teachIds: Record<ServerSide, string>): Promise<void> {
	await runParityRequest(h, {
		label: "row 5 POST /api/chats/[id]/dismiss (no active problem)",
		pattern: "/api/chats/[id]/dismiss",
		isWrite: true,
		expectedStatus: 400,
		request: (side) => ({
			method: "POST",
			path: `/api/chats/${teachIds[side]}/dismiss`,
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ input: { type: "dismiss-problem", problemCallId: "call_none" } }),
		}),
	});
	await runParityRequest(h, {
		label: "row 13 POST /api/chats/[id]/steer (settled)",
		pattern: "/api/chats/[id]/steer",
		isWrite: true,
		expectedStatus: 409,
		request: (side) => ({
			method: "POST",
			path: `/api/chats/${teachIds[side]}/steer`,
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ input: { type: "steer", id: "steer_parity_1", text: "Wait" } }),
		}),
	});
}

async function runChatTurnAndSettledChecks(h: ParityHarness, teachIds: Record<ServerSide, string>): Promise<void> {
	const turnOut = await runParityRequest(h, {
		label: "row 3 POST /api/chat",
		pattern: "/api/chat",
		isWrite: true,
		expectedStatus: 200,
		awaitBeforeUpstreamCheck: async () => {
			await waitChatSettledOnBoth(h, teachIds);
			await waitExtractionIdleOnBoth(h);
		},
		request: (side) => ({
			method: "POST",
			path: "/api/chat",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ chatId: teachIds[side], input: { type: "text", text: "Hello parity tutor" } }),
		}),
	});
	assert.deepEqual(
		normalizeSseEvents(h, "api", parseSseStream(turnOut.apiRes.text)),
		normalizeSseEvents(h, "next", parseSseStream(turnOut.nextRes.text)),
		"POST /api/chat SSE stream mismatch",
	);
	await runParityRequest(h, {
		label: "row 14 GET /api/chats/[id]/stream (settled)",
		pattern: "/api/chats/[id]/stream",
		expectedStatus: 200,
		request: (side) => ({ method: "GET", path: `/api/chats/${teachIds[side]}/stream` }),
	});
	await runDismissAndSteerChecks(h, teachIds);
}

export async function runChatSubroutesAndTurnSuite(h: ParityHarness, teachIds: Record<ServerSide, string>): Promise<void> {
	const uiBody = JSON.stringify({ input: { messageId: GOLDEN_DEMO_STEER_ID, inverted: true } });
	await runParityRequest(h, {
		label: "row 4 POST /api/chats/[id]/artifact-ui",
		pattern: "/api/chats/[id]/artifact-ui",
		isWrite: true,
		expectedStatus: 200,
		request: { method: "POST", path: `/api/chats/${GOLDEN_TEACH_CHAT}/artifact-ui`, headers: { "Content-Type": "application/json" }, body: uiBody },
	});
	await runParityRequest(h, {
		label: "row 6 GET /api/chats/[id]/images/[snapshotId] (missing)",
		pattern: "/api/chats/[id]/images/[snapshotId]",
		expectedStatus: 404,
		request: { method: "GET", path: `/api/chats/${GOLDEN_TEACH_CHAT}/images/${"0".repeat(64)}` },
	});
	await runParityRequest(h, {
		label: "row 7 GET /api/chats/[id]/markdown",
		pattern: "/api/chats/[id]/markdown",
		expectedStatus: 200,
		request: { method: "GET", path: `/api/chats/${GOLDEN_TEACH_CHAT}/markdown` },
	});
	await runChatTurnAndSettledChecks(h, teachIds);
}

async function runSideChatThreadSubroutes(h: ParityHarness, threadId: string): Promise<void> {
	const threadUrl = `/api/chats/${GOLDEN_TEACH_CHAT}/side-chats/${threadId}`;
	await runParityRequest(h, {
		label: "row 11 PATCH /api/chats/[id]/side-chats/[threadId]",
		pattern: "/api/chats/[id]/side-chats/[threadId]",
		isWrite: true,
		expectedStatus: 200,
		request: { method: "PATCH", path: threadUrl, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ open: false }) },
	});
	const watchOut = await runParityRequest(h, {
		label: "row 11 GET /api/chats/[id]/side-chats/[threadId]",
		pattern: "/api/chats/[id]/side-chats/[threadId]",
		expectedStatus: 200,
		request: { method: "GET", path: threadUrl },
	});
	assert.deepEqual(
		normalizeJsonValue(h, "api", parseNdjsonStream(watchOut.apiRes.text)),
		normalizeJsonValue(h, "next", parseNdjsonStream(watchOut.nextRes.text)),
	);
	await runParityRequest(h, {
		label: "row 12 POST /api/chats/[id]/side-chats/[threadId]/stop",
		pattern: "/api/chats/[id]/side-chats/[threadId]/stop",
		isWrite: true,
		expectedStatus: 409,
		request: { method: "POST", path: `${threadUrl}/stop` },
	});
}

export async function pulseEventsBusPorts(nextPort: number, apiPort: number): Promise<void> {
	const body = JSON.stringify({ sourceIds: ["src_event_pulse_noop"], folderIds: [], deleteSessions: false });
	await Promise.all([
		sendWire(nextPort, { method: "DELETE", path: "/api/graph/sources", headers: { "Content-Type": "application/json" }, body }),
		sendWire(apiPort, { method: "DELETE", path: "/api/graph/sources", headers: { "Content-Type": "application/json" }, body }),
	]);
}

export function pulseEventsBusOnBoth(h: ParityHarness): Promise<void> {
	return pulseEventsBusPorts(h.pair.next.port, h.pair.api.port);
}

export async function openEventsWithPulse(
	nextPort: number,
	apiPort: number,
	headers?: Record<string, string>,
): Promise<{ nextEv: LiveStreamHandle; apiEv: LiveStreamHandle }> {
	const nextConn = connectWireStream(nextPort, { method: "GET", path: "/api/events", headers });
	const apiConn = connectWireStream(apiPort, { method: "GET", path: "/api/events", headers });
	const apiEv = await apiConn.waitHeaders(5_000);
	const pulser = setInterval(() => {
		void pulseEventsBusPorts(nextPort, apiPort).catch(() => {});
	}, 80);
	try {
		await pulseEventsBusPorts(nextPort, apiPort);
		const nextEv = await nextConn.waitHeaders(5_000);
		return { nextEv, apiEv };
	} finally {
		clearInterval(pulser);
	}
}

async function runEventsQuickCheck(h: ParityHarness): Promise<void> {
	h.coverage.record("/api/events", "GET");
	const { nextEv, apiEv } = await openEventsWithPulse(h.pair.next.port, h.pair.api.port);
	try {
		compareResponseHeaders(h, nextEv.headers, apiEv.headers, { requestLabel: "row 18 GET /api/events" });
	} finally {
		nextEv.abort();
		apiEv.abort();
	}
}

export async function runSideChatsAndEventsSuite(h: ParityHarness): Promise<void> {
	await runParityRequest(h, {
		label: "row 9 PUT /api/chats/[id]/settings (golden teach)",
		isWrite: true,
		expectedStatus: 200,
		request: {
			method: "PUT",
			path: `/api/chats/${GOLDEN_TEACH_CHAT}/settings`,
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ model: { provider: "custom", id: "stub-model" }, thinkingLevel: "off" }),
		},
	});
	const sideUrl = `/api/chats/${GOLDEN_TEACH_CHAT}/side-chats`;
	await runParityRequest(h, { label: "row 10 GET /api/chats/[id]/side-chats", pattern: "/api/chats/[id]/side-chats", expectedStatus: 200, request: { method: "GET", path: sideUrl } });
	const askBody = JSON.stringify({
		anchor: { messageId: GOLDEN_PROSE_MSG_ID, partId: `${GOLDEN_PROSE_MSG_ID}-t0`, blockIndex: 0, blockText: "Parity quote" },
		text: "Can you clarify this passage?",
	});
	h.coverage.record("/api/chats/[id]/side-chats", "POST");
	h.stub.setSide("next");
	const nextAsk = await sendWire(h.pair.next.port, { method: "POST", path: sideUrl, headers: { "Content-Type": "application/json" }, body: askBody });
	h.stub.setSide("api");
	const apiAsk = await sendWire(h.pair.api.port, { method: "POST", path: sideUrl, headers: { "Content-Type": "application/json" }, body: askBody });
	assert.equal(apiAsk.status, 200);
	assert.equal(nextAsk.status, 200);
	compareResponseHeaders(h, nextAsk.headers, apiAsk.headers, { requestLabel: "row 10 POST side-chats" });
	const nextEvents = parseNdjsonStream(nextAsk.text);
	assert.deepEqual(
		normalizeJsonValue(h, "api", parseNdjsonStream(apiAsk.text)),
		normalizeJsonValue(h, "next", nextEvents),
		"POST side-chats NDJSON mismatch",
	);
	const createdThreadId = (nextEvents[0] as { thread: { id: string } }).thread.id;
	await waitSideChatsSettledOnBoth(h, GOLDEN_TEACH_CHAT);
	assertDataDirsEqual(h, "row 10 POST side-chats");
	await runSideChatThreadSubroutes(h, createdThreadId);
	await runEventsQuickCheck(h);
}
