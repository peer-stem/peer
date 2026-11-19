import assert from "node:assert/strict";
import test from "node:test";

await import("./helpers/client-env.ts");
const {
	ApiError,
	apiPath,
	createApiClient,
} = await import("../src/client/state/index.ts");

test("apiPath encodes interpolated segments and enforces /api/ prefix", () => {
	const path = apiPath`/api/chats/${"chat/1?x=2"}/images/${"ab cd"}`;
	assert.equal(path, "/api/chats/chat%2F1%3Fx%3D2/images/ab%20cd");
	assert.throws(
		() => apiPath`${"/other"}/chats` as unknown,
		/API path must start with "\/api\/"/,
	);
});

test("ApiClient.url serializes query params, omits undefined, and rejects non-api paths", () => {
	const api = createApiClient({ fetch: async () => new Response("{}") });
	const built = api.url("/api/jobs", { chatId: "c_1", limit: 10, active: true, cursor: undefined });
	assert.equal(built, "/api/jobs?chatId=c_1&limit=10&active=true");
	const appended = api.url("/api/jobs?existing=1", { next: "two" });
	assert.equal(appended, "/api/jobs?existing=1&next=two");
	assert.throws(
		() => api.url("/health" as "/api/health"),
		/API path must start with "\/api\/"/,
	);
});

test("ApiClient.json sends JSON body with Content-Type and parses 200 payload", async () => {
	let seenUrl = "";
	let seenMethod = "";
	let seenCt = "";
	let seenBody = "";
	const api = createApiClient({
		fetch: async (input, init) => {
			seenUrl = String(input);
			seenMethod = init?.method ?? "";
			const headers = (init?.headers ?? {}) as Record<string, string>;
			seenCt = headers["Content-Type"] ?? "";
			seenBody = String(init?.body ?? "");
			return Response.json({ ok: true, count: 3 });
		},
	});
	const data = await api.json<{ ok: boolean; count: number }>("/api/settings", {
		method: "PUT",
		query: { dryRun: false },
		json: { theme: "ivory" },
	});
	assert.equal(seenUrl, "/api/settings?dryRun=false");
	assert.equal(seenMethod, "PUT");
	assert.equal(seenCt, "application/json");
	assert.equal(seenBody, '{"theme":"ivory"}');
	assert.deepEqual(data, { ok: true, count: 3 });
});

test("ApiClient.request forwards FormData without forcing Content-Type and rejects json+body", async () => {
	let seenHeaders: Record<string, string> | undefined;
	let seenBody: unknown;
	const api = createApiClient({
		fetch: async (_input, init) => {
			seenHeaders = init?.headers as Record<string, string> | undefined;
			seenBody = init?.body;
			return new Response("ok", { status: 200 });
		},
	});
	const form = new FormData();
	form.set("note", "hello");
	const res = await api.request("/api/sources", { method: "POST", body: form });
	assert.equal(res.status, 200);
	assert.equal(seenHeaders, undefined);
	assert.equal(seenBody, form);
	await assert.rejects(
		() => api.request("/api/sources", { method: "POST", json: { a: 1 }, body: form }),
		/cannot specify both json and body/,
	);
});

test("ApiClient rejects client-supplied x-learnharness-desktop header case-insensitively", async () => {
	const api = createApiClient({ fetch: async () => new Response("{}") });
	await assert.rejects(
		() => api.request("/api/settings", { headers: { "x-learnharness-desktop": "secret" } }),
		/x-learnharness-desktop header is forbidden/,
	);
	await assert.rejects(
		() => api.json("/api/settings", { headers: { "X-LearnHarness-Desktop": "secret" } }),
		/x-learnharness-desktop header is forbidden/,
	);
});

test("ApiClient.json parses error and code fields into ApiError on non-2xx responses", async () => {
	const api = createApiClient({
		fetch: async () =>
			Response.json(
				{ error: "No model configured — set up your models first", code: "models_not_configured" },
				{ status: 503 },
			),
	});
	let caught: unknown;
	try {
		await api.json("/api/chat", { method: "POST", json: {} });
	} catch (err) {
		caught = err;
	}
	assert.ok(caught instanceof ApiError);
	assert.equal(caught.status, 503);
	assert.equal(caught.method, "POST");
	assert.equal(caught.path, "/api/chat");
	assert.equal(caught.code, "models_not_configured");
	assert.equal(caught.message, "No model configured — set up your models first");
});

test("ApiClient wraps network failures with status 0 and passes AbortError through untouched", async () => {
	const networkApi = createApiClient({
		fetch: async () => {
			throw new TypeError("fetch failed");
		},
	});
	let netErr: unknown;
	try {
		await networkApi.json("/api/settings");
	} catch (err) {
		netErr = err;
	}
	assert.ok(netErr instanceof ApiError);
	assert.equal(netErr.status, 0);
	assert.equal(netErr.message, "fetch failed");

	const abortSignalErr = new DOMException("The operation was aborted.", "AbortError");
	const abortApi = createApiClient({
		fetch: async () => {
			throw abortSignalErr;
		},
	});
	let caughtAbort: unknown;
	try {
		await abortApi.request("/api/settings");
	} catch (err) {
		caughtAbort = err;
	}
	assert.equal(caughtAbort, abortSignalErr);
});

test("ApiClient.fetch binds globalThis receiver so detached callers never throw Illegal invocation", async () => {
	let receiver: unknown;
	function browserWindowFetch(this: unknown): Promise<Response> {
		receiver = this;
		if (this !== globalThis) {
			return Promise.reject(new TypeError("Illegal invocation"));
		}
		return Promise.resolve(Response.json({ bound: true }));
	}
	const api = createApiClient({ fetch: browserWindowFetch as typeof globalThis.fetch });
	const detached = api.fetch;
	const res = await detached("/api/settings");
	const payload = (await res.json()) as { bound: boolean };
	assert.equal(receiver, globalThis);
	assert.equal(payload.bound, true);
});
