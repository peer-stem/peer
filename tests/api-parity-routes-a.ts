import assert from "node:assert/strict";
import { tinyPdf } from "./helpers/tiny-pdf.ts";
import { runParityRequest, type ParityHarness } from "./api-parity-compare.ts";
import type { ServerSide } from "./api-parity-stubs.ts";
import {
	CONCRETE_ROUTE_PATHS,
	DOC_MARKDOWN_PATH,
	encodeMultipartRequest,
} from "./api-test-helpers.ts";

async function runUnconfiguredChecks(h: ParityHarness): Promise<void> {
	await runParityRequest(h, {
		label: "row 43 GET /api/stt/token (no key)",
		pattern: "/api/stt/token",
		expectedStatus: 503,
		request: { method: "GET", path: "/api/stt/token" },
	});
	await runParityRequest(h, {
		label: "row 44 POST /api/stt/transcribe (unconfigured)",
		pattern: "/api/stt/transcribe",
		isWrite: true,
		expectedStatus: 409,
		request: { method: "POST", path: "/api/stt/transcribe", body: Buffer.from("RIFF") },
	});
	await runParityRequest(h, {
		label: "row 49 POST /api/tts/speak (unconfigured)",
		pattern: "/api/tts/speak",
		isWrite: true,
		expectedStatus: 409,
		request: {
			method: "POST",
			path: "/api/tts/speak",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ text: "hello" }),
		},
	});
	await runParityRequest(h, {
		label: "row 50 GET /api/tts/voices (unconfigured)",
		pattern: "/api/tts/voices",
		expectedStatus: 409,
		request: { method: "GET", path: "/api/tts/voices" },
	});
	await runParityRequest(h, {
		label: "row 16 GET /api/claude-code (disabled)",
		pattern: "/api/claude-code",
		expectedStatus: 403,
		request: { method: "GET", path: "/api/claude-code", headers: { "x-learnharness-claude-code": "1" } },
	});
	await runParityRequest(h, {
		label: "row 19 GET /api/external-cli (disabled)",
		pattern: "/api/external-cli",
		expectedStatus: 403,
		request: { method: "GET", path: "/api/external-cli?id=codex-cli", headers: { "x-learnharness-external-cli": "1" } },
	});
}

async function runKeysAndSearch(h: ParityHarness): Promise<void> {
	await runParityRequest(h, {
		label: "row 31 GET /api/keys",
		pattern: "/api/keys",
		expectedStatus: 200,
		request: { method: "GET", path: "/api/keys" },
	});
	await runParityRequest(h, {
		label: "row 38 GET /api/search (empty)",
		pattern: "/api/search",
		expectedStatus: 200,
		request: { method: "GET", path: "/api/search" },
	});
	await runParityRequest(h, {
		label: "row 30 PUT /api/keys/BRAVE_API_KEY",
		pattern: "/api/keys/[id]",
		isWrite: true,
		expectedStatus: 200,
		request: {
			method: "PUT",
			path: "/api/keys/BRAVE_API_KEY",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ value: "brave_parity_dummy_key_123456" }),
		},
	});
	await runParityRequest(h, {
		label: "row 38 GET /api/search (with Brave key)",
		expectedStatus: 200,
		request: { method: "GET", path: "/api/search" },
	});
	await runParityRequest(h, {
		label: "row 30 DELETE /api/keys/BRAVE_API_KEY",
		pattern: "/api/keys/[id]",
		isWrite: true,
		expectedStatus: 200,
		request: { method: "DELETE", path: "/api/keys/BRAVE_API_KEY" },
	});
}

async function fetchCustomProviderEtags(h: ParityHarness): Promise<Record<ServerSide, string>> {
	const { nextRes, apiRes } = await runParityRequest(h, {
		label: "row 17 GET /api/custom-provider",
		pattern: "/api/custom-provider",
		customProviderEtag: true,
		expectedStatus: 200,
		request: { method: "GET", path: "/api/custom-provider" },
	});
	return { next: nextRes.headers.etag ?? "", api: apiRes.headers.etag ?? "" };
}

function customProviderReq(method: string, port: number, etag: string, bodyObj: unknown) {
	return {
		method,
		path: "/api/custom-provider",
		headers: { "Content-Type": "application/json", Origin: `http://127.0.0.1:${port}`, "If-Match": etag },
		body: JSON.stringify(bodyObj),
	};
}

async function runCustomProviderConnectAndPatch(h: ParityHarness): Promise<Record<ServerSide, string>> {
	let etags = await fetchCustomProviderEtags(h);
	let out = await runParityRequest(h, {
		label: "row 17 POST /api/custom-provider",
		pattern: "/api/custom-provider",
		isWrite: true,
		customProviderEtag: true,
		expectedStatus: 200,
		request: (side, port) => customProviderReq("POST", port, etags[side], { baseUrl: h.stub.baseUrlFor(side), authMode: "keyless" }),
	});
	etags = { next: out.nextRes.headers.etag ?? "", api: out.apiRes.headers.etag ?? "" };
	out = await runParityRequest(h, {
		label: "row 17 PATCH /api/custom-provider",
		pattern: "/api/custom-provider",
		isWrite: true,
		customProviderEtag: true,
		expectedStatus: 200,
		request: (side, port) => customProviderReq("PATCH", port, etags[side], { overrides: { "stub-model": { context: 16384 } } }),
	});
	return { next: out.nextRes.headers.etag ?? "", api: out.apiRes.headers.etag ?? "" };
}

async function runCustomProviderDeleteAndRestore(h: ParityHarness, startEtags: Record<ServerSide, string>): Promise<void> {
	let etags = startEtags;
	const out = await runParityRequest(h, {
		label: "row 17 DELETE /api/custom-provider",
		pattern: "/api/custom-provider",
		isWrite: true,
		customProviderEtag: true,
		expectedStatus: 200,
		request: (side, port) => customProviderReq("DELETE", port, etags[side], {}),
	});
	etags = { next: out.nextRes.headers.etag ?? "", api: out.apiRes.headers.etag ?? "" };
	await runParityRequest(h, {
		label: "row 17 re-POST /api/custom-provider",
		isWrite: true,
		customProviderEtag: true,
		expectedStatus: 200,
		request: (side, port) => customProviderReq("POST", port, etags[side], { baseUrl: h.stub.baseUrlFor(side), authMode: "keyless" }),
	});
}

async function runSettingsWrites(h: ParityHarness): Promise<void> {
	await runParityRequest(h, {
		label: "row 41 GET /api/settings",
		pattern: "/api/settings",
		expectedStatus: 200,
		request: { method: "GET", path: "/api/settings" },
	});
	const slot = { model: { provider: "custom", id: "stub-model" }, thinkingLevel: "off" };
	await runParityRequest(h, {
		label: "row 42 PUT /api/settings/models",
		pattern: "/api/settings/[section]",
		isWrite: true,
		expectedStatus: 200,
		request: {
			method: "PUT",
			path: "/api/settings/models",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ strong: slot, cheap: slot, vision: slot }),
		},
	});
	await runParityRequest(h, {
		label: "row 42 PUT /api/settings/speech",
		isWrite: true,
		expectedStatus: 200,
		request: (side, port) => ({
			method: "PUT",
			path: "/api/settings/speech",
			headers: { "Content-Type": "application/json", Origin: `http://127.0.0.1:${port}` },
			body: JSON.stringify({ endpoint: h.stub.baseUrlFor(side), dictation: "local", speak: "button" }),
		}),
	});
}

async function runCliSettingsAndReads(h: ParityHarness): Promise<void> {
	await runParityRequest(h, {
		label: "row 42 PUT /api/settings/claudeCode",
		isWrite: true,
		expectedStatus: 200,
		request: { method: "PUT", path: "/api/settings/claudeCode", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: true }) },
	});
	await runParityRequest(h, {
		label: "row 42 PUT /api/settings/externalCli",
		isWrite: true,
		expectedStatus: 200,
		request: {
			method: "PUT",
			path: "/api/settings/externalCli",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ "codex-cli": { enabled: true, models: ["codex-stub"] }, "agy-cli": { enabled: true } }),
		},
	});
	await runParityRequest(h, {
		label: "row 16 GET /api/claude-code (enabled)",
		expectedStatus: 200,
		request: { method: "GET", path: "/api/claude-code", headers: { "x-learnharness-claude-code": "1" } },
	});
	await runParityRequest(h, {
		label: "row 19 GET /api/external-cli?id=codex-cli (enabled)",
		expectedStatus: 200,
		request: { method: "GET", path: "/api/external-cli?id=codex-cli", headers: { "x-learnharness-external-cli": "1" } },
	});
	await runParityRequest(h, {
		label: "row 19 GET /api/external-cli?id=agy-cli (enabled)",
		isWrite: true,
		expectedStatus: 200,
		request: { method: "GET", path: "/api/external-cli?id=agy-cli", headers: { "x-learnharness-external-cli": "1" } },
	});
	await runParityRequest(h, { label: "row 32 GET /api/models", pattern: "/api/models", expectedStatus: 200, request: { method: "GET", path: "/api/models" } });
}

async function runPromptsSuite(h: ParityHarness): Promise<void> {
	const promptsOut = await runParityRequest(h, {
		label: "row 39 GET /api/settings/prompts",
		pattern: "/api/settings/prompts",
		expectedStatus: 200,
		request: { method: "GET", path: "/api/settings/prompts" },
	});
	const parsed = JSON.parse(promptsOut.nextRes.text) as { teacher?: { path: string }[] };
	const segPath = parsed.teacher?.[0]?.path;
	assert.ok(segPath, "Expected at least one teacher prompt segment");
	await runParityRequest(h, {
		label: "row 40 PUT /api/settings/prompts/[...segment]",
		pattern: "/api/settings/prompts/[...segment]",
		isWrite: true,
		expectedStatus: 200,
		request: { method: "PUT", path: `/api/settings/prompts/${segPath}`, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "Parity prompt override content." }) },
	});
	await runParityRequest(h, {
		label: "row 40 DELETE /api/settings/prompts/[...segment]",
		pattern: "/api/settings/prompts/[...segment]",
		isWrite: true,
		expectedStatus: 200,
		request: { method: "DELETE", path: `/api/settings/prompts/${segPath}` },
	});
}

async function runThemesSuite(h: ParityHarness): Promise<void> {
	await runParityRequest(h, { label: "row 48 GET /api/themes", pattern: "/api/themes", expectedStatus: 200, request: { method: "GET", path: "/api/themes" } });
	const themeBody = {
		name: "Parity Custom",
		mode: "dark",
		colors: {
			background: "#111111", surface: "#1b1b1b", border: "#333333", text: "#eeeeee",
			textMuted: "#888888", accent: "#4488ff", bold: "#ffffff", italic: "#dddddd",
			code: "#aaddff", error: "#ff4444", success: "#22cc66", warning: "#ffaa22",
		},
	};
	await runParityRequest(h, {
		label: "row 48 POST /api/themes",
		pattern: "/api/themes",
		isWrite: true,
		expectedStatus: 201,
		request: { method: "POST", path: "/api/themes", headers: { "Content-Type": "application/json" }, body: JSON.stringify(themeBody) },
	});
	await runParityRequest(h, {
		label: "row 47 DELETE /api/themes/parity-custom",
		pattern: "/api/themes/[id]",
		isWrite: true,
		expectedStatus: 200,
		request: { method: "DELETE", path: "/api/themes/parity-custom" },
	});
}

async function runPluginsSuite(h: ParityHarness): Promise<void> {
	await runParityRequest(h, { label: "row 37 GET /api/plugins", pattern: "/api/plugins", expectedStatus: 200, request: { method: "GET", path: "/api/plugins" } });
	await runParityRequest(h, {
		label: "row 37 POST /api/plugins (refresh)",
		pattern: "/api/plugins",
		isWrite: true,
		expectedStatus: 200,
		request: { method: "POST", path: "/api/plugins", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "refresh" }) },
	});
	await runParityRequest(h, {
		label: "row 36 PUT /api/plugins/document-one (enable)",
		pattern: "/api/plugins/[id]",
		isWrite: true,
		expectedStatus: 200,
		request: { method: "PUT", path: "/api/plugins/document-one", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: true }) },
	});
	await runParityRequest(h, {
		label: "row 33 GET /api/plugins/document-one/assets/assets/nested/info.txt",
		pattern: "/api/plugins/[id]/assets/[...file]",
		expectedStatus: 200,
		request: { method: "GET", path: "/api/plugins/document-one/assets/assets/nested/info.txt" },
	});
	await runParityRequest(h, {
		label: "row 34 POST /api/plugins/document-one/call",
		pattern: "/api/plugins/[id]/call",
		isWrite: true,
		expectedStatus: 200,
		request: { method: "POST", path: "/api/plugins/document-one/call", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ operation: "echo", input: { k: 7 } }) },
	});
	await runPluginDocumentMethods(h);
}

async function runPluginDocumentMethods(h: ParityHarness): Promise<void> {
	const pat = "/api/plugins/[id]/documents/markdown";
	const formTxt = new FormData();
	formTxt.append("file", new File(["Parity markdown text\n"], "small.txt", { type: "text/plain" }));
	const mpTxt = await encodeMultipartRequest(formTxt);
	await runParityRequest(h, {
		label: "row 35 POST /api/plugins/document-one/documents/markdown (txt)",
		pattern: pat,
		isWrite: true,
		expectedStatus: 200,
		request: { method: "POST", path: DOC_MARKDOWN_PATH, headers: { "Content-Type": mpTxt.contentType }, body: mpTxt.body },
	});
	const pdfBytes = tinyPdf([{ runs: [{ text: "Parity PDF line.", x: 72, y: 700 }] }]);
	const formPdf = new FormData();
	formPdf.append("file", new File([pdfBytes], "tiny.pdf", { type: "application/pdf" }));
	const mpPdf = await encodeMultipartRequest(formPdf);
	await runParityRequest(h, {
		label: "row 35 POST /api/plugins/document-one/documents/markdown (pdf)",
		isWrite: true,
		expectedStatus: 200,
		request: { method: "POST", path: DOC_MARKDOWN_PATH, headers: { "Content-Type": mpPdf.contentType }, body: mpPdf.body },
	});
	await runParityRequest(h, { label: "row 35 OPTIONS", pattern: pat, expectedStatus: 204, request: { method: "OPTIONS", path: DOC_MARKDOWN_PATH } });
	for (const method of ["GET", "HEAD", "PUT", "PATCH", "DELETE"] as const) {
		await runParityRequest(h, {
			label: `row 35 ${method}`,
			pattern: pat,
			expectedStatus: 405,
			request: { method, path: DOC_MARKDOWN_PATH },
		});
	}
}

async function runSpeechConfigured(h: ParityHarness): Promise<void> {
	await runParityRequest(h, {
		label: "row 44 POST /api/stt/transcribe (configured)",
		isWrite: true,
		expectedStatus: 200,
		request: { method: "POST", path: "/api/stt/transcribe?language=en-US", headers: { "Content-Type": "audio/wav" }, body: Buffer.from("RIFF_WAV_STUB") },
	});
	await runParityRequest(h, {
		label: "row 49 POST /api/tts/speak (configured)",
		isWrite: true,
		expectedStatus: 200,
		request: { method: "POST", path: "/api/tts/speak", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "Parity spoken sentence." }) },
	});
	await runParityRequest(h, { label: "row 50 GET /api/tts/voices (configured)", expectedStatus: 200, request: { method: "GET", path: "/api/tts/voices" } });
}

async function runSubscriptionsSuite(h: ParityHarness): Promise<void> {
	await runParityRequest(h, {
		label: "row 46 GET /api/subscriptions",
		pattern: "/api/subscriptions",
		expectedStatus: 200,
		request: { method: "GET", path: "/api/subscriptions", headers: { "x-learnharness-subscriptions": "1" } },
	});
	await runParityRequest(h, {
		label: "row 46 POST /api/subscriptions (unsupported control)",
		pattern: "/api/subscriptions",
		isWrite: true,
		expectedStatus: 400,
		request: (_side, port) => ({
			method: "POST",
			path: "/api/subscriptions",
			headers: { "Content-Type": "application/json", "x-learnharness-subscriptions": "1", Origin: `http://127.0.0.1:${port}` },
			body: JSON.stringify({ providerId: "chatgpt", op: "unknown-op" }),
		}),
	});
	const browserUrl = "/api/subscriptions/browser?id=00000000-0000-0000-0000-000000000000";
	await runParityRequest(h, {
		label: "row 45 GET /api/subscriptions/browser",
		pattern: "/api/subscriptions/browser",
		expectedStatus: 410,
		request: { method: "GET", path: browserUrl, headers: { "sec-fetch-site": "same-origin" } },
	});
	await runParityRequest(h, {
		label: "row 45 POST /api/subscriptions/browser",
		pattern: "/api/subscriptions/browser",
		isWrite: true,
		expectedStatus: 410,
		request: (_side, port) => ({
			method: "POST",
			path: browserUrl,
			headers: { "x-learnharness-subscriptions": "1", Origin: `http://127.0.0.1:${port}` },
		}),
	});
}

export async function runAutoOptionsAndHeadSweep(h: ParityHarness): Promise<void> {
	for (const [pattern, concretePath] of Object.entries(CONCRETE_ROUTE_PATHS)) {
		await runParityRequest(h, {
			label: `auto OPTIONS ${pattern}`,
			pattern,
			coverageMethod: "OPTIONS",
			expectedStatus: 204,
			request: { method: "OPTIONS", path: concretePath },
		});
		const isCustomProvider = pattern === "/api/custom-provider";
		await runParityRequest(h, {
			label: `auto HEAD ${pattern}`,
			pattern,
			coverageMethod: "HEAD",
			customProviderEtag: isCustomProvider,
			request: { method: "HEAD", path: concretePath },
		});
	}
}

export async function runRoutesGroupA(h: ParityHarness): Promise<void> {
	await runUnconfiguredChecks(h);
	await runKeysAndSearch(h);
	const etags = await runCustomProviderConnectAndPatch(h);
	await runCustomProviderDeleteAndRestore(h, etags);
	await runSettingsWrites(h);
	await runCliSettingsAndReads(h);
	await runPromptsSuite(h);
	await runThemesSuite(h);
	await runPluginsSuite(h);
	await runSpeechConfigured(h);
	await runSubscriptionsSuite(h);
}
