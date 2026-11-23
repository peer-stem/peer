import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { PassThrough } from "node:stream";
import { after, test } from "node:test";
import type { RunningApiServer } from "../src/api/main.ts";
import { DEFAULT_ADDON_PATH } from "../src/store/lumberjack/binding.ts";
import { installScratchProcessEnv, resolveScratchRoot } from "./api-test-helpers.ts";

const fileScratch = installScratchProcessEnv("api-substrate-module-");
const { createLogger } = await import("../src/api/log.ts");
const { startApiServer } = await import("../src/api/main.ts");
const { getActiveMfnRuntime, mintUuidV7 } = await import("../src/memory/mfn/index.ts");
const { getActiveLumberJackBundle, stores } = await import("../src/server/stores.ts");

after(() => {
	fileScratch.restore();
});

const SKIP_GUARD = {
	skip:
		!fs.existsSync(DEFAULT_ADDON_PATH) && process.env.PEER_REQUIRE_SUBSTRATE !== "1"
			? "lumberjack_peer.node not built"
			: false,
};

function findSparePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const srv = net.createServer();
		srv.once("error", reject);
		srv.listen(0, "127.0.0.1", () => {
			const port = (srv.address() as net.AddressInfo).port;
			srv.close((err) => (err ? reject(err) : resolve(port)));
		});
	});
}

interface MockMfnServer {
	endpoint: string;
	calls: Array<{ operation: string; poolId?: string }>;
	close: () => Promise<void>;
}

function handleMfnRequest(
	req: http.IncomingMessage,
	res: http.ServerResponse,
	expectedToken: string,
	calls: Array<{ operation: string; poolId?: string }>,
): void {
	if (req.headers.authorization !== `Bearer ${expectedToken}`) {
		res.writeHead(401, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ version: 2, request_id: "unauth", status: "error" }));
		return;
	}
	const chunks: Buffer[] = [];
	req.on("data", (c: Buffer) => chunks.push(c));
	req.on("end", () => {
		const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
			request?: { request_id?: string; operation?: string; pool_id?: string };
		};
		calls.push({ operation: parsed.request?.operation ?? "", poolId: parsed.request?.pool_id });
		const outcomes = [{ layer: 1, state: "ok" }];
		const reply = { version: 2, request_id: parsed.request?.request_id ?? "req-1", status: "committed", result: { complete: true, outcomes } };
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify(reply));
	});
}

function startMockMfnGateway(expectedToken: string): Promise<MockMfnServer> {
	const calls: Array<{ operation: string; poolId?: string }> = [];
	const srv = http.createServer((req, res) => handleMfnRequest(req, res, expectedToken, calls));
	return new Promise((resolve, reject) => {
		srv.once("error", reject);
		srv.listen(0, "127.0.0.1", () => {
			const port = (srv.address() as net.AddressInfo).port;
			const close = () => new Promise<void>((done) => srv.close(() => done()));
			resolve({ endpoint: `http://127.0.0.1:${port}`, calls, close });
		});
	});
}

interface SseWatcher {
	frames: () => string;
	waitFor: (needle: string, timeoutMs?: number) => Promise<void>;
	abort: () => void;
}

function attachSseStream(req: http.ClientRequest, res: http.IncomingMessage): SseWatcher {
	let buffer = "";
	const waiters = new Set<() => void>();
	res.setEncoding("utf8");
	res.on("data", (chunk: string) => {
		buffer += chunk;
		for (const fn of [...waiters]) fn();
	});
	return {
		frames: () => buffer,
		waitFor: (needle, timeoutMs = 4_000) => waitSseNeedle(() => buffer, waiters, needle, timeoutMs),
		abort: () => req.destroy(),
	};
}

function openSseWatcher(port: number): Promise<SseWatcher> {
	return new Promise((resolve, reject) => {
		const req = http.request({ hostname: "127.0.0.1", port, path: "/api/events", method: "GET" }, (res) => {
			resolve(attachSseStream(req, res));
		});
		req.once("error", reject);
		req.end();
	});
}

function waitSseNeedle(
	readBuf: () => string,
	waiters: Set<() => void>,
	needle: string,
	timeoutMs: number,
): Promise<void> {
	if (readBuf().includes(needle)) return Promise.resolve();
	return new Promise((resolve, reject) => {
		const check = () => {
			if (!readBuf().includes(needle)) return;
			clearTimeout(timer);
			waiters.delete(check);
			resolve();
		};
		const timer = setTimeout(() => {
			waiters.delete(check);
			reject(new Error(`Timed out waiting for SSE "${needle}". Buffer:\n${readBuf()}`));
		}, timeoutMs);
		waiters.add(check);
	});
}

function seedFixtureDirectory(srcDir: string): { imgSha: string; imgBase64: string } {
	for (const rel of ["chats", "graph", "themes", "prompts/teacher"]) {
		fs.mkdirSync(path.join(srcDir, rel), { recursive: true, mode: 0o700 });
	}
	fs.writeFileSync(path.join(srcDir, "settings.json"), JSON.stringify({ version: 1, graph: { enabled: true } }));
	fs.writeFileSync(path.join(srcDir, "prompts", "teacher", "10-planning.md"), "Substrate prompt override");
	const themePayload = {
		name: "Forest Dusk",
		mode: "dark",
		colors: {
			background: "#101418", surface: "#182026", border: "#2c3842", text: "#e6edf3",
			textMuted: "#8b949e", accent: "#58a6ff", bold: "#ffffff", italic: "#d0d7de",
			code: "#79c0ff", error: "#f85149", success: "#3fb950", warning: "#d29922",
		},
	};
	fs.writeFileSync(path.join(srcDir, "themes", "forest-dusk.json"), JSON.stringify(themePayload));
	seedFixtureGraphAndChat(srcDir);
	const imgBytes = Buffer.from("substrate-wiring-png-payload-bytes");
	const imgBase64 = imgBytes.toString("base64");
	const imgSha = createHash("sha256").update(imgBytes).digest("hex");
	writeChatFixtureWithImage(srcDir, imgSha, imgBase64);
	return { imgSha, imgBase64 };
}

function seedFixtureGraphAndChat(srcDir: string): void {
	const srcMap = { src_alg: { id: "src_alg", filePath: "/notes/algebra.md", importedAt: "2026-11-19T00:00:00Z" } };
	fs.writeFileSync(path.join(srcDir, "graph", "sources.json"), JSON.stringify(srcMap));
	const n1 = {
		id: "n_group", name: "Group", statement: "Set with associative operation, identity, and inverses",
		aliases: [], createdAt: "2026-11-19T00:01:00Z", provenance: [{ chatId: "src_alg", messageId: "m1" }],
	};
	const n2 = {
		id: "n_abelian", name: "Abelian Group", statement: "Group whose operation is commutative",
		aliases: [], createdAt: "2026-11-19T00:02:00Z", provenance: [{ chatId: "chat_sub_1", messageId: "msg_1" }],
	};
	fs.writeFileSync(path.join(srcDir, "graph", "nodes.jsonl"), `${JSON.stringify(n1)}\n${JSON.stringify(n2)}\n`);
	const chain = {
		id: "ch_ab", premises: ["n_group"], conclusion: "n_abelian",
		createdAt: "2026-11-19T00:03:00Z", provenance: [{ chatId: "chat_sub_1", messageId: "msg_1" }],
	};
	fs.writeFileSync(path.join(srcDir, "graph", "chains.jsonl"), `${JSON.stringify(chain)}\n`);
	fs.writeFileSync(
		path.join(srcDir, "graph", "positions.json"),
		JSON.stringify({ positions: { n_abelian: { x: 12, y: 34 } }, updatedAt: "2026-11-19T00:03:30Z" }),
	);
}

function writeChatFixtureWithImage(srcDir: string, imgSha: string, imgBase64: string): void {
	const chatRecord = {
		version: 1,
		id: "chat_sub_1",
		title: "Substrate Lesson",
		createdAt: "2026-11-19T00:00:00Z",
		updatedAt: "2026-11-19T00:05:00Z",
		messages: [{ id: "msg_1", role: "user", content: "What is an abelian group?", timestamp: 1_000 }],
		imageSnapshots: { [imgSha]: { mimeType: "image/png", data: imgBase64, width: 64, height: 48 } },
	};
	fs.writeFileSync(path.join(srcDir, "chats", "chat_sub_1.json"), JSON.stringify(chatRecord));
}

async function postImport(baseUrl: string, bodyText: string): Promise<Response> {
	return fetch(`${baseUrl}/api/settings/import-learnharness`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: bodyText,
	});
}

async function assertImportValidationFailures(baseUrl: string, rootDir: string, fixtureDir: string): Promise<void> {
	assert.equal((await postImport(baseUrl, "{not-json")).status, 400);
	assert.equal((await postImport(baseUrl, JSON.stringify({ sourceDirectory: "   " }))).status, 400);
	const missingPath = path.join(rootDir, "does-not-exist");
	assert.equal((await postImport(baseUrl, JSON.stringify({ sourceDirectory: missingPath }))).status, 400);

	const fileTarget = path.join(rootDir, "regular-file.txt");
	fs.writeFileSync(fileTarget, "not a directory");
	assert.equal((await postImport(baseUrl, JSON.stringify({ sourceDirectory: fileTarget }))).status, 400);

	const symlinkDir = path.join(rootDir, "symlink-source");
	fs.symlinkSync(fixtureDir, symlinkDir);
	assert.equal((await postImport(baseUrl, JSON.stringify({ sourceDirectory: symlinkDir }))).status, 400);
}

async function runImportAndAssertReport(baseUrl: string, fixtureDir: string): Promise<void> {
	const importRes = await postImport(baseUrl, JSON.stringify({ sourceDirectory: fixtureDir }));
	assert.equal(importRes.status, 200);
	const report = (await importRes.json()) as Record<string, unknown>;
	assert.equal(report.settingsImported, true);
	assert.equal(report.themesImported, 1);
	assert.equal(report.promptsImported, 1);
	assert.equal(report.sourcesImported, 1);
	assert.equal(report.nodesImported, 2);
	assert.equal(report.chainsImported, 1);
	assert.equal(report.positionsImported, 1);
	assert.equal(report.chatsImported, 1);
	assert.equal(report.objectsStored, 1);
	assert.equal(report.corruptFilesSkipped, 0);
}

async function assertImportedApiReads(
	baseUrl: string,
	dataDir: string,
	imgSha: string,
	imgBase64: string,
): Promise<void> {
	assert.equal(fs.existsSync(path.join(dataDir, "chats", "chat_sub_1.json")), false);

	const listRes = await fetch(`${baseUrl}/api/chats`);
	assert.equal(listRes.status, 200);
	const listBody = (await listRes.json()) as { chats: Array<{ id: string; title: string }> };
	const chats = listBody.chats;
	assert.equal(chats.length, 1);
	assert.equal(chats[0]?.id, "chat_sub_1");
	assert.equal(chats[0]?.title, "Substrate Lesson");

	const chatRes = await fetch(`${baseUrl}/api/chats/chat_sub_1`);
	assert.equal(chatRes.status, 200);
	const detail = (await chatRes.json()) as { chat?: { id: string; messages?: Array<{ id: string }> } };
	const full = detail.chat ?? (detail as unknown as { id: string; messages?: Array<{ id: string }> });
	assert.equal(full.id, "chat_sub_1");
	assert.equal(full.messages?.[0]?.id, "msg_1");

	const imgRes = await fetch(`${baseUrl}/api/chats/chat_sub_1/images/${imgSha}`);
	assert.equal(imgRes.status, 200);
	assert.equal(imgRes.headers.get("cache-control"), "private, no-store");
	const imgJson = (await imgRes.json()) as { mimeType: string; data: string; width: number; height: number };
	assert.equal(imgJson.mimeType, "image/png");
	assert.equal(imgJson.data, imgBase64);
	assert.equal(imgJson.width, 64);
	assert.equal(imgJson.height, 48);

	const settingsRes = await fetch(`${baseUrl}/api/settings`);
	assert.equal(settingsRes.status, 200);
	const settingsPayload = (await settingsRes.json()) as { settings?: { graph?: { enabled?: boolean } } };
	assert.equal(settingsPayload.settings?.graph?.enabled, true);

	const themesRes = await fetch(`${baseUrl}/api/themes`);
	assert.equal(themesRes.status, 200);
	assert.match(await themesRes.text(), /forest-dusk/);
}

async function assertLiveStreamAndMfnOutbox(sse: SseWatcher, mfnStub: MockMfnServer): Promise<void> {
	const bundle = getActiveLumberJackBundle();
	assert.notEqual(bundle, null);
	bundle!.forest.upsertNode({
		path: "sessions/chat_live_probe",
		type: "leaf",
		kind: "session",
		slot: { version: 1, id: "chat_live_probe", title: "Live", createdAt: "2026-11-19T00:00:00Z", updatedAt: "2026-11-19T00:00:00Z" },
	});
	await sse.waitFor("event: record-changed");
	await sse.waitFor('"chatId":"chat_live_probe"');

	const mfnRuntime = getActiveMfnRuntime();
	assert.notEqual(mfnRuntime, null);
	assert.equal(mfnRuntime?.mainPoolId, "peer-main");
	assert.equal(mfnRuntime?.lexicalPoolId, "peer-lexical");

	mfnRuntime!.outbox.enqueue({
		kind: "lexical_put",
		operationId: mintUuidV7(),
		poolId: "peer-lexical",
		lexicalPayload: { memory_id: "101", content: "Abelian groups commute", tags: ["math"] },
	});
	assert.notEqual(bundle!.forest.getNode("memory/outbox"), null);

	const flushRes = await mfnRuntime!.outbox.flush(mfnRuntime!.client, { force: true });
	assert.equal(flushRes.flushed, 1);
	assert.equal(flushRes.remaining, 0);
	const putCall = mfnStub.calls.find((c) => c.operation === "memory.put");
	assert.notEqual(putCall, undefined);
	assert.equal(putCall?.poolId, "peer-lexical");
	const postFlushSlot = bundle!.forest.getNode("memory/outbox")?.slot as { entries?: unknown[] } | undefined;
	assert.equal(postFlushSlot?.entries?.length, 0);
}

test("startApiServer wires LumberJack substrate, LearnHarness import, /objects images, SSE, and MFN outbox", SKIP_GUARD, async (t) => {
	const scratch = installScratchProcessEnv("api-substrate-");
	const mfnToken = "substrate_test_mfn_bearer_token_0123456789abcdef";
	const mfnStub = await startMockMfnGateway(mfnToken);
	let running: RunningApiServer | null = null;
	let sse: SseWatcher | null = null;
	t.after(async () => {
		sse?.abort();
		if (running) await running.close();
		await mfnStub.close();
		scratch.restore();
	});

	assert.equal(scratch.rootDir.startsWith(resolveScratchRoot()), true);
	const forestDir = path.join(scratch.rootDir, "peer-forest");
	const fixtureDir = path.join(scratch.rootDir, "lh-fixture");
	const { imgSha, imgBase64 } = seedFixtureDirectory(fixtureDir);
	const port = await findSparePort();
	const logger = createLogger({ level: "silent", stream: new PassThrough() });
	running = await startApiServer(
		{
			PORT: String(port),
			HOSTNAME: "127.0.0.1",
			PEER_FOREST_DIR: forestDir,
			PEER_MFN_ENDPOINT: mfnStub.endpoint,
			PEER_MFN_TOKEN: mfnToken,
		},
		{ logger, streamIntervalMs: 25, mfnAutoFlushMs: 200 },
	);

	const baseUrl = `http://127.0.0.1:${running.port}`;
	await assertImportValidationFailures(baseUrl, scratch.rootDir, fixtureDir);
	sse = await openSseWatcher(running.port);
	await runImportAndAssertReport(baseUrl, fixtureDir);
	await sse.waitFor("event: chats-changed");
	await sse.waitFor("event: sources-changed");
	await assertImportedApiReads(baseUrl, scratch.dataDir, imgSha, imgBase64);
	await assertLiveStreamAndMfnOutbox(sse, mfnStub);

	sse.abort();
	sse = null;
	await running.close();
	await running.close();
	running = null;
	assert.equal(getActiveLumberJackBundle(), null);
	assert.equal(getActiveMfnRuntime(), null);
	assert.deepEqual(stores.chatStore.listChats(), []);
});

test("startApiServer tears down LumberJack substrate if HTTP bind fails and supports legacy import fallback", SKIP_GUARD, async (t) => {
	const scratch = installScratchProcessEnv("api-substrate-fallback-");
	const blocker = net.createServer();
	await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", () => resolve()));
	const occupiedPort = (blocker.address() as net.AddressInfo).port;
	let fallbackSrv: RunningApiServer | null = null;
	t.after(async () => {
		if (fallbackSrv) await fallbackSrv.close();
		await new Promise<void>((resolve) => blocker.close(() => resolve()));
		scratch.restore();
	});

	const failForest = path.join(scratch.rootDir, "bind-fail-forest");
	const logger = createLogger({ level: "silent", stream: new PassThrough() });
	await assert.rejects(() =>
		startApiServer({ PORT: String(occupiedPort), HOSTNAME: "127.0.0.1", PEER_FOREST_DIR: failForest }, { logger }),
	);
	assert.equal(getActiveLumberJackBundle(), null);
	assert.equal(getActiveMfnRuntime(), null);

	const fixtureDir = path.join(scratch.rootDir, "legacy-lh-fixture");
	seedFixtureDirectory(fixtureDir);
	const freePort = await findSparePort();
	fallbackSrv = await startApiServer(
		{ PORT: String(freePort), HOSTNAME: "127.0.0.1", PEER_STATE_ROOT: scratch.dataDir },
		{ logger },
	);
	assert.notEqual(getActiveLumberJackBundle(), null, "LumberJack activates by default without PEER_FOREST_DIR");
	assert.equal(getActiveMfnRuntime(), null, "LLM compaction stays default until MFN is explicitly enabled");
	const res = await postImport(`http://127.0.0.1:${fallbackSrv.port}`, JSON.stringify({ sourceDirectory: fixtureDir }));
	assert.equal(res.status, 200);
	const report = (await res.json()) as { chatsImported?: number };
	assert.equal(report.chatsImported, 1);
	assert.equal(fs.existsSync(path.join(scratch.dataDir, "lumberjack")), true);
	assert.equal(fs.existsSync(path.join(scratch.dataDir, "boot-appearance.json")), true);
});
