import * as fs from "node:fs";
import * as path from "node:path";
import { tinyPdf } from "./helpers/tiny-pdf.ts";
import type { ServerSide } from "./api-parity-stubs.ts";
import { runParityRequest, type ParityHarness } from "./api-parity-compare.ts";
import { GOLDEN_NODE_DELETE, GOLDEN_TEACH_CHAT, WORKTREE_ROOT, encodeMultipartRequest } from "./api-test-helpers.ts";
import {
	openEventsWithPulse,
	pulseEventsBusOnBoth,
	pulseEventsBusPorts,
	runChatSubroutesAndTurnSuite,
	runSideChatsAndEventsSuite,
	waitChatSettledOnBoth,
	waitExtractionIdleOnBoth,
	waitSideChatsSettledOnBoth,
} from "./api-parity-routes-b-chats.ts";

export {
	openEventsWithPulse,
	pulseEventsBusOnBoth,
	pulseEventsBusPorts,
	waitChatSettledOnBoth,
	waitExtractionIdleOnBoth,
	waitSideChatsSettledOnBoth,
};

const GOLDEN_JOB_ID = "job_murepie2_9d791321";
const GOLDEN_KEEP_NODE_ID = "n_465398b5356a";

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
			isWrite: true,
			expectedStatus: item.status,
			request: req,
		});
	}
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
		request: { method: "PUT", path: "/api/graph/render-settings", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ nodeSize: 1.25, labelSize: 1.05 }) },
	});
	await runParityRequest(h, {
		label: "row 24 PUT /api/graph/positions",
		pattern: "/api/graph/positions",
		isWrite: true,
		expectedStatus: 200,
		request: { method: "PUT", path: "/api/graph/positions", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ [GOLDEN_KEEP_NODE_ID]: { x: 42.5, y: -17.25 } }) },
	});
}

async function runDeleteFolderAndNode(h: ParityHarness, folderIds: Record<ServerSide, string>): Promise<void> {
	await runParityRequest(h, {
		label: "row 27 DELETE /api/graph/sources (delete empty folder)",
		pattern: "/api/graph/sources",
		isWrite: true,
		expectedStatus: 200,
		request: (side) => ({ method: "DELETE", path: "/api/graph/sources", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sourceIds: [], folderIds: [folderIds[side]], deleteSessions: false }) }),
	});
	await runParityRequest(h, {
		label: `row 23 DELETE /api/graph/nodes/${GOLDEN_NODE_DELETE}`,
		pattern: "/api/graph/nodes/[id]",
		isWrite: true,
		expectedStatus: 200,
		request: { method: "DELETE", path: `/api/graph/nodes/${GOLDEN_NODE_DELETE}` },
	});
}

async function runGraphSourcesAndNodeDeleteSuite(h: ParityHarness): Promise<void> {
	await runParityRequest(h, { label: "row 27 GET /api/graph/sources", pattern: "/api/graph/sources", expectedStatus: 200, request: { method: "GET", path: "/api/graph/sources" } });
	const created = await runParityRequest(h, {
		label: "row 27 POST /api/graph/sources (create-folder)",
		pattern: "/api/graph/sources",
		isWrite: true,
		expectedStatus: 200,
		request: { method: "POST", path: "/api/graph/sources", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "create-folder", name: "Parity Folder", parentId: null }) },
	});
	const folderIds: Record<ServerSide, string> = {
		next: (JSON.parse(created.nextRes.text) as { createdFolderId: string }).createdFolderId,
		api: (JSON.parse(created.apiRes.text) as { createdFolderId: string }).createdFolderId,
	};
	await runParityRequest(h, {
		label: "row 27 POST /api/graph/sources (rename-folder)",
		isWrite: true,
		expectedStatus: 200,
		request: (side) => ({ method: "POST", path: "/api/graph/sources", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "rename-folder", id: folderIds[side], name: "Parity Folder Renamed" }) }),
	});
	await runDeleteFolderAndNode(h, folderIds);
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

async function runChatItemMutations(
	h: ParityHarness,
	teachIds: Record<ServerSide, string>,
	dispIds: Record<ServerSide, string>,
): Promise<void> {
	const jsonHeaders = { "Content-Type": "application/json" };
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
		request: (side) => ({ method: "PUT", path: `/api/chats/${teachIds[side]}`, headers: jsonHeaders, body: JSON.stringify({ title: "Renamed Parity Session" }) }),
	});
	const settingsBody = JSON.stringify({ model: { provider: "custom", id: "stub-model" }, thinkingLevel: "off" });
	await runParityRequest(h, {
		label: "row 9 PUT /api/chats/[id]/settings",
		pattern: "/api/chats/[id]/settings",
		isWrite: true,
		expectedStatus: 200,
		request: (side) => ({ method: "PUT", path: `/api/chats/${teachIds[side]}/settings`, headers: jsonHeaders, body: settingsBody }),
	});
	await runParityRequest(h, {
		label: "row 8 DELETE /api/chats/[id]?mode=preserve-graph",
		pattern: "/api/chats/[id]",
		isWrite: true,
		expectedStatus: 200,
		request: (side) => ({ method: "DELETE", path: `/api/chats/${dispIds[side]}?mode=preserve-graph` }),
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
