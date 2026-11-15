import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tinyPdf } from "./helpers/tiny-pdf.ts";
import { WORKTREE_ROOT } from "./api-parity-servers.ts";
import type { ServerSide } from "./api-parity-stubs.ts";
import { connectWireStream, parseNdjsonStream, parseSseStream, sendWire } from "./api-parity-wire.ts";
import {
	assertDataDirsEqual,
	compareResponseHeaders,
	normalizeJsonValue,
	normalizeSseEvents,
	runParityRequest,
	type ParityHarness,
} from "./api-parity-compare.ts";
import { encodeMultipartRequest, GOLDEN_NODE_DELETE, GOLDEN_TEACH_CHAT } from "./api-parity-routes-a.ts";

const GOLDEN_JOB_ID = "job_murepie2_9d791321";
const GOLDEN_DEMO_STEER_ID = "steer_job_mv28454n_25dc3185";
const GOLDEN_PROSE_MSG_ID = "msg_mv27s2zx_8c815926";
const GOLDEN_KEEP_NODE_ID = "n_465398b5356a";

export async function waitExtractionIdleOnBoth(h: ParityHarness, timeoutMs = 15_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const [nextRes, apiRes] = await Promise.all([
			sendWire(h.pair.next.port, { method: "GET", path: "/api/graph/status" }),
			sendWire(h.pair.api.port, { method: "GET", path: "/api/graph/status" }),
		]);
		const nextRuns = (JSON.parse(nextRes.text) as { runs?: unknown[] }).runs ?? [];
		const apiRuns = (JSON.parse(apiRes.text) as { runs?: unknown[] }).runs ?? [];
		if (nextRuns.length === 0 && apiRuns.length === 0) return;
		await new Promise((r) => setTimeout(r, 40));
	}
	throw new Error("Timed out waiting for extraction runs to drain on both servers");
}

export async function waitChatSettledOnBoth(
	h: ParityHarness,
	chatIds: Record<ServerSide, string>,
	timeoutMs = 15_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const [nextRes, apiRes] = await Promise.all([
			sendWire(h.pair.next.port, { method: "GET", path: `/api/chats/${chatIds.next}` }),
			sendWire(h.pair.api.port, { method: "GET", path: `/api/chats/${chatIds.api}` }),
		]);
		const n = JSON.parse(nextRes.text) as { turnInFlight?: boolean; compacting?: boolean };
		const a = JSON.parse(apiRes.text) as { turnInFlight?: boolean; compacting?: boolean };
		if (!n.turnInFlight && !n.compacting && !a.turnInFlight && !a.compacting) return;
		await new Promise((r) => setTimeout(r, 40));
	}
	throw new Error("Timed out waiting for chat turn to settle on both servers");
}

async function waitSideChatsSettledOnBoth(h: ParityHarness, chatId: string, timeoutMs = 15_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const [nextRes, apiRes] = await Promise.all([
			sendWire(h.pair.next.port, { method: "GET", path: `/api/chats/${chatId}/side-chats` }),
			sendWire(h.pair.api.port, { method: "GET", path: `/api/chats/${chatId}/side-chats` }),
		]);
		const nAns = (JSON.parse(nextRes.text) as { answering?: Record<string, string> }).answering ?? {};
		const aAns = (JSON.parse(apiRes.text) as { answering?: Record<string, string> }).answering ?? {};
		if (Object.keys(nAns).length === 0 && Object.keys(aAns).length === 0) return;
		await new Promise((r) => setTimeout(r, 40));
	}
	throw new Error("Timed out waiting for side-chat answer to settle on both servers");
}

async function runActivityAndJobsSuite(h: ParityHarness): Promise<void> {
	await runParityRequest(h, {
		label: "row 2 GET /api/activity",
		pattern: "/api/activity",
		expectedStatus: 200,
		request: { method: "GET", path: "/api/activity" },
	});
	await runParityRequest(h, {
		label: "row 29 GET /api/jobs (missing chatId)",
		pattern: "/api/jobs",
		expectedStatus: 400,
		request: { method: "GET", path: "/api/jobs" },
	});
	await runParityRequest(h, {
		label: "row 29 GET /api/jobs?chatId=teach",
		expectedStatus: 200,
		request: { method: "GET", path: `/api/jobs?chatId=${GOLDEN_TEACH_CHAT}` },
	});
	await runAbortVariants(h);
}

async function runAbortVariants(h: ParityHarness): Promise<void> {
	const cases: Array<{ label: string; payload: unknown; status: number }> = [
		{ label: "job settled", payload: { kind: "job", id: GOLDEN_JOB_ID }, status: 409 },
		{ label: "plugin-worker missing", payload: { kind: "plugin-worker", id: "document-one" }, status: 404 },
		{ label: "turn idle", payload: { kind: "turn", id: GOLDEN_TEACH_CHAT }, status: 409 },
		{ label: "extraction idempotent", payload: { kind: "extraction", id: GOLDEN_TEACH_CHAT }, status: 200 },
		{ label: "invalid id", payload: { kind: "job", id: "bad/id" }, status: 400 },
	];
	for (const item of cases) {
		const req = { method: "POST", path: "/api/activity/abort", headers: { "Content-Type": "application/json" }, body: JSON.stringify(item.payload) };
		await runParityRequest(h, {
			label: `row 1 POST /api/activity/abort (${item.label})`,
			pattern: "/api/activity/abort",
			expectedStatus: item.status,
			request: req,
		});
	}
}

async function runGraphReadAndSettingsSuite(h: ParityHarness): Promise<void> {
	await runParityRequest(h, { label: "row 20 GET /api/graph/costs", pattern: "/api/graph/costs", expectedStatus: 200, request: { method: "GET", path: "/api/graph/costs" } });
	await runParityRequest(h, { label: "row 26 GET /api/graph", pattern: "/api/graph", expectedStatus: 200, request: { method: "GET", path: "/api/graph" } });
	await runParityRequest(h, { label: "row 28 GET /api/graph/status", pattern: "/api/graph/status", expectedStatus: 200, request: { method: "GET", path: "/api/graph/status" } });
	await runParityRequest(h, { label: "row 25 GET /api/graph/render-settings", pattern: "/api/graph/render-settings", expectedStatus: 200, request: { method: "GET", path: "/api/graph/render-settings" } });
	await runParityRequest(h, {
		label: "row 25 PUT /api/graph/render-settings",
		pattern: "/api/graph/render-settings",
		isWrite: true,
		expectedStatus: 200,
		request: {
			method: "PUT",
			path: "/api/graph/render-settings",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ nodeSize: 1.25, labelSize: 1.05 }),
		},
	});
	await runParityRequest(h, {
		label: "row 24 PUT /api/graph/positions",
		pattern: "/api/graph/positions",
		isWrite: true,
		expectedStatus: 200,
		request: {
			method: "PUT",
			path: "/api/graph/positions",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ [GOLDEN_KEEP_NODE_ID]: { x: 42.5, y: -17.25 } }),
		},
	});
}

async function runGraphSourcesAndNodeDeleteSuite(h: ParityHarness): Promise<void> {
	await runParityRequest(h, { label: "row 27 GET /api/graph/sources", pattern: "/api/graph/sources", expectedStatus: 200, request: { method: "GET", path: "/api/graph/sources" } });
	const created = await runParityRequest(h, {
		label: "row 27 POST /api/graph/sources (create-folder)",
		pattern: "/api/graph/sources",
		isWrite: true,
		expectedStatus: 200,
		request: {
			method: "POST",
			path: "/api/graph/sources",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ action: "create-folder", name: "Parity Folder", parentId: null }),
		},
	});
	const folderIds: Record<ServerSide, string> = {
		next: (JSON.parse(created.nextRes.text) as { createdFolderId: string }).createdFolderId,
		api: (JSON.parse(created.apiRes.text) as { createdFolderId: string }).createdFolderId,
	};
	await runParityRequest(h, {
		label: "row 27 POST /api/graph/sources (rename-folder)",
		isWrite: true,
		expectedStatus: 200,
		request: (side) => ({
			method: "POST",
			path: "/api/graph/sources",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ action: "rename-folder", id: folderIds[side], name: "Parity Folder Renamed" }),
		}),
	});
	await runDeleteFolderAndNode(h, folderIds);
}

async function runDeleteFolderAndNode(h: ParityHarness, folderIds: Record<ServerSide, string>): Promise<void> {
	await runParityRequest(h, {
		label: "row 27 DELETE /api/graph/sources (delete empty folder)",
		pattern: "/api/graph/sources",
		isWrite: true,
		expectedStatus: 200,
		request: (side) => ({
			method: "DELETE",
			path: "/api/graph/sources",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ sourceIds: [], folderIds: [folderIds[side]], deleteSessions: false }),
		}),
	});
	await runParityRequest(h, {
		label: `row 23 DELETE /api/graph/nodes/${GOLDEN_NODE_DELETE}`,
		pattern: "/api/graph/nodes/[id]",
		isWrite: true,
		expectedStatus: 200,
		request: { method: "DELETE", path: `/api/graph/nodes/${GOLDEN_NODE_DELETE}` },
	});
}

async function runGraphImportAndExtractSuite(h: ParityHarness): Promise<void> {
	const samplePdf = fs.readFileSync(path.join(WORKTREE_ROOT, "tests", "fixtures", "sample-3page.pdf"));
	const notAPdf = fs.readFileSync(path.join(WORKTREE_ROOT, "tests", "fixtures", "not-a-pdf.txt"));
	const generatedPdf = Buffer.from(tinyPdf([{ runs: [{ text: "Parity imported note.", x: 72, y: 700 }] }]));
	const files = [
		new File(["# Parity Note\n\nB+trees store values in leaves.\n"], "parity-note.md", { type: "text/markdown" }),
		new File([samplePdf], "sample-3page.pdf", { type: "application/pdf" }),
		new File([notAPdf], "not-a-pdf.bin", { type: "application/octet-stream" }),
		new File([generatedPdf], "tiny-import.pdf", { type: "application/pdf" }),
	];
	for (const file of files) {
		const form = new FormData();
		form.append("files", file);
		const mp = await encodeMultipartRequest(form);
		await runParityRequest(h, {
			label: `row 22 POST /api/graph/import (${file.name})`,
			pattern: "/api/graph/import",
			isWrite: true,
			expectedStatus: 200,
			awaitBeforeUpstreamCheck: () => waitExtractionIdleOnBoth(h),
			request: { method: "POST", path: "/api/graph/import", headers: { "Content-Type": mp.contentType }, body: mp.body },
		});
	}
	await runParityRequest(h, {
		label: "row 21 POST /api/graph/coverage/extract",
		pattern: "/api/graph/coverage/extract",
		isWrite: true,
		expectedStatus: 202,
		awaitBeforeUpstreamCheck: () => waitExtractionIdleOnBoth(h),
		request: {
			method: "POST",
			path: "/api/graph/coverage/extract",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ chatId: GOLDEN_TEACH_CHAT }),
		},
	});
}

async function runChatsCrudSuite(h: ParityHarness): Promise<Record<ServerSide, string>> {
	await runParityRequest(h, { label: "row 15 GET /api/chats", pattern: "/api/chats", expectedStatus: 200, request: { method: "GET", path: "/api/chats" } });
	const created = await runParityRequest(h, {
		label: "row 15 POST /api/chats (teach)",
		pattern: "/api/chats",
		isWrite: true,
		expectedStatus: 200,
		request: { method: "POST", path: "/api/chats", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "Parity Teach Session" }) },
	});
	const teachIds: Record<ServerSide, string> = {
		next: (JSON.parse(created.nextRes.text) as { id: string }).id,
		api: (JSON.parse(created.apiRes.text) as { id: string }).id,
	};
	const disposable = await runParityRequest(h, {
		label: "row 15 POST /api/chats (disposable)",
		isWrite: true,
		expectedStatus: 200,
		request: { method: "POST", path: "/api/chats", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "Disposable Session", kind: "practice" }) },
	});
	const dispIds: Record<ServerSide, string> = {
		next: (JSON.parse(disposable.nextRes.text) as { id: string }).id,
		api: (JSON.parse(disposable.apiRes.text) as { id: string }).id,
	};
	await runChatItemMutations(h, teachIds, dispIds);
	return teachIds;
}

async function runChatItemMutations(
	h: ParityHarness,
	teachIds: Record<ServerSide, string>,
	dispIds: Record<ServerSide, string>,
): Promise<void> {
	await runParityRequest(h, {
		label: "row 8 GET /api/chats/[id]",
		pattern: "/api/chats/[id]",
		expectedStatus: 200,
		request: (side) => ({ method: "GET", path: `/api/chats/${teachIds[side]}` }),
	});
	await runParityRequest(h, {
		label: "row 8 PUT /api/chats/[id] (rename)",
		pattern: "/api/chats/[id]",
		isWrite: true,
		expectedStatus: 200,
		request: (side) => ({
			method: "PUT",
			path: `/api/chats/${teachIds[side]}`,
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ title: "Renamed Parity Session" }),
		}),
	});
	await runParityRequest(h, {
		label: "row 9 PUT /api/chats/[id]/settings",
		pattern: "/api/chats/[id]/settings",
		isWrite: true,
		expectedStatus: 200,
		request: (side) => ({
			method: "PUT",
			path: `/api/chats/${teachIds[side]}/settings`,
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ model: { provider: "custom", id: "stub-model" }, thinkingLevel: "off" }),
		}),
	});
	await runParityRequest(h, {
		label: "row 8 DELETE /api/chats/[id]?mode=preserve-graph",
		pattern: "/api/chats/[id]",
		isWrite: true,
		expectedStatus: 200,
		request: (side) => ({ method: "DELETE", path: `/api/chats/${dispIds[side]}?mode=preserve-graph` }),
	});
}

async function runChatSubroutesAndTurnSuite(h: ParityHarness, teachIds: Record<ServerSide, string>): Promise<void> {
	await runParityRequest(h, {
		label: "row 4 POST /api/chats/[id]/artifact-ui",
		pattern: "/api/chats/[id]/artifact-ui",
		isWrite: true,
		expectedStatus: 200,
		request: {
			method: "POST",
			path: `/api/chats/${GOLDEN_TEACH_CHAT}/artifact-ui`,
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ input: { messageId: GOLDEN_DEMO_STEER_ID, inverted: true } }),
		},
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

async function runDismissAndSteerChecks(h: ParityHarness, teachIds: Record<ServerSide, string>): Promise<void> {
	await runParityRequest(h, {
		label: "row 5 POST /api/chats/[id]/dismiss (no active problem)",
		pattern: "/api/chats/[id]/dismiss",
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
		expectedStatus: 409,
		request: (side) => ({
			method: "POST",
			path: `/api/chats/${teachIds[side]}/steer`,
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ input: { type: "steer", id: "steer_parity_1", text: "Wait" } }),
		}),
	});
}

async function runSideChatsAndEventsSuite(h: ParityHarness): Promise<void> {
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
		expectedStatus: 409,
		request: { method: "POST", path: `${threadUrl}/stop` },
	});
}

export async function pulseEventsBusOnBoth(h: ParityHarness): Promise<void> {
	const body = JSON.stringify({ sourceIds: ["src_event_pulse_noop"], folderIds: [], deleteSessions: false });
	await Promise.all([
		sendWire(h.pair.next.port, { method: "DELETE", path: "/api/graph/sources", headers: { "Content-Type": "application/json" }, body }),
		sendWire(h.pair.api.port, { method: "DELETE", path: "/api/graph/sources", headers: { "Content-Type": "application/json" }, body }),
	]);
}

async function runEventsQuickCheck(h: ParityHarness): Promise<void> {
	h.coverage.record("/api/events", "GET");
	const nextConn = connectWireStream(h.pair.next.port, { method: "GET", path: "/api/events" });
	const apiConn = connectWireStream(h.pair.api.port, { method: "GET", path: "/api/events" });
	await new Promise((r) => setTimeout(r, 40));
	await pulseEventsBusOnBoth(h);
	const [nextEv, apiEv] = await Promise.all([nextConn.waitHeaders(5_000), apiConn.waitHeaders(5_000)]);
	compareResponseHeaders(h, nextEv.headers, apiEv.headers, { requestLabel: "row 18 GET /api/events" });
	nextEv.abort();
	apiEv.abort();
}

export async function runRoutesGroupB(h: ParityHarness): Promise<Record<ServerSide, string>> {
	await runActivityAndJobsSuite(h);
	await runGraphReadAndSettingsSuite(h);
	await runGraphSourcesAndNodeDeleteSuite(h);
	await runGraphImportAndExtractSuite(h);
	const teachIds = await runChatsCrudSuite(h);
	await runChatSubroutesAndTurnSuite(h, teachIds);
	await runSideChatsAndEventsSuite(h);
	return teachIds;
}
