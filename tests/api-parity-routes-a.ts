import { runParityRequest, type ParityHarness } from "./api-parity-compare.ts";
import type { ServerSide } from "./api-parity-stubs.ts";
import {
	runAutoOptionsAndHeadSweep,
	runPluginsSuite,
	runPromptsSuite,
	runSpeechConfigured,
	runSubscriptionsSuite,
	runThemesSuite,
} from "./api-parity-routes-a-ext.ts";

export { runAutoOptionsAndHeadSweep };

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
