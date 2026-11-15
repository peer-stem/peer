import assert from "node:assert/strict";
import { it } from "node:test";
import { MAX_IMPORT_BODY_BYTES } from "../lib/notes-import-limits.ts";
import { bodyLimit, createRouter } from "../src/api/router.ts";
import type { Dispatch, Method, RouteHandler, RouteRecord } from "../src/api/types.ts";

const ORIGIN = "http://localhost";
const SECRET = "s".repeat(64);
const DESKTOP_HEADER = "x-learnharness-desktop";
const DESKTOP_FORBIDDEN = "Desktop API access requires the trusted LearnHarness window.";
const GATE_ENV_KEYS = ["LH_DESKTOP_SERVER", "LH_DESKTOP_API_SECRET", "LH_ALLOWED_HOSTS"] as const;

function rec(method: Method, pattern: string, handler: RouteHandler): RouteRecord {
	return { method, pattern, handler, file: `app${pattern}/route.ts` };
}

async function withGateEnv(
	overrides: Partial<Record<(typeof GATE_ENV_KEYS)[number], string | undefined>>,
	run: () => Promise<void>,
): Promise<void> {
	const before = new Map<string, string | undefined>(GATE_ENV_KEYS.map((k) => [k, process.env[k]]));
	try {
		for (const key of GATE_ENV_KEYS) {
			const val = overrides[key];
			if (val === undefined) delete process.env[key];
			else process.env[key] = val;
		}
		await run();
	} finally {
		for (const [key, val] of before) {
			if (val === undefined) delete process.env[key];
			else process.env[key] = val;
		}
	}
}

async function assertDesktopRefusal(router: Dispatch, path: string, method: string): Promise<void> {
	const res = await router(new Request(`${ORIGIN}${path}`, { method }));
	assert.equal(res.status, 403, `${method} ${path}`);
	assert.equal(res.headers.get("Cache-Control"), "no-store");
	assert.deepEqual(await res.json(), { error: DESKTOP_FORBIDDEN });
}

function makeCancelSpyStream(onCancel: () => void): Response {
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(new TextEncoder().encode("chunk"));
		},
		cancel() {
			onCancel();
		},
	});
	return new Response(stream, {
		status: 206,
		statusText: "Partial Content",
		headers: { "Content-Type": "text/plain", "X-Stream": "yes" },
	});
}

it("delegates non-/api paths to fallback ungated while keeping /api and /api/* in the router", async () => {
	const seen: string[] = [];
	const fallback: Dispatch = async (req) => {
		seen.push(new URL(req.url).pathname);
		return new Response("static-ok", { status: 200 });
	};
	const router = createRouter([rec("GET", "/api/ping", () => Response.json({ ok: true }))], { fallback });
	await withGateEnv({ LH_DESKTOP_SERVER: "1", LH_DESKTOP_API_SECRET: SECRET }, async () => {
		for (const path of ["/", "/chat/new", "/apix", "/api-other/plugins/x/documents/markdown"]) {
			const res = await router(new Request(`http://evil.example${path}`));
			assert.equal(res.status, 200, path);
			assert.equal(await res.text(), "static-ok", path);
		}
		assert.deepEqual(seen, ["/", "/chat/new", "/apix", "/api-other/plugins/x/documents/markdown"]);
		for (const apiPath of ["/api", "/api/", "/api?q=1", "/api/ping"]) {
			const blocked = await router(new Request(`${ORIGIN}${apiPath}`));
			assert.equal(blocked.status, 403, apiPath);
		}
		assert.equal(seen.length, 4, "no /api path may reach fallback");
	});
});

it("enforces desktop secret gate across all methods and /api paths before 404, 400, 405, or handler", async () => {
	let calls = 0;
	const countOk: RouteHandler = () => {
		calls++;
		return new Response("ok");
	};
	const router = createRouter([
		rec("POST", "/api/plugins/[id]/documents/markdown", countOk),
		rec("GET", "/api/keys/[id]", countOk),
	]);
	const paths = ["/api", "/api/", "/api/unknown", "/api/keys/%E0%A4%A", "/api/plugins/doc-1/documents/markdown"];
	const methods = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "PROPFIND"];
	await withGateEnv({ LH_DESKTOP_SERVER: "1", LH_DESKTOP_API_SECRET: SECRET }, async () => {
		for (const path of paths) {
			for (const method of methods) await assertDesktopRefusal(router, path, method);
		}
		assert.equal(calls, 0);
		const ok = await router(new Request(`${ORIGIN}/api/keys/k1`, { headers: { [DESKTOP_HEADER]: SECRET } }));
		assert.equal(ok.status, 200);
		assert.equal(calls, 1);
	});
});

it("enforces browser-only Host, dynamic LH_ALLOWED_HOSTS, and cross-site write checks", async () => {
	const router = createRouter([
		rec("GET", "/api/items", () => Response.json({ ok: true })),
		rec("POST", "/api/items", () => Response.json({ created: true })),
	]);
	await withGateEnv({}, async () => {
		const badHost = await router(new Request(`${ORIGIN}/api/items`, { headers: { host: "evil.example" } }));
		assert.equal(badHost.status, 403);
		assert.equal(badHost.headers.get("Cache-Control"), "no-store");

		process.env.LH_ALLOWED_HOSTS = "Allowed.Example, second.example";
		const allowedGet = await router(new Request("http://allowed.example:8080/api/items"));
		assert.equal(allowedGet.status, 200);

		const badOrigin = new Request(`${ORIGIN}/api/items`, { method: "POST", headers: { Origin: "https://evil.example" } });
		const crossOrigin = await router(badOrigin);
		assert.equal(crossOrigin.status, 403);
		assert.deepEqual(await crossOrigin.json(), { error: "Cross-site requests to the LearnHarness API are not allowed." });

		const badSite = new Request(`${ORIGIN}/api/items`, { method: "POST", headers: { "Sec-Fetch-Site": "cross-site" } });
		assert.equal((await router(badSite)).status, 403);

		const sameHeaders = { Origin: ORIGIN, "Sec-Fetch-Site": "same-origin" };
		const sameOrigin = await router(new Request(`${ORIGIN}/api/items`, { method: "POST", headers: sameHeaders }));
		assert.equal(sameOrigin.status, 200);
	});
});

it("applies static > dynamic > catch-all precedence and backtracks regardless of record order", async () => {
	const router = createRouter([
		rec("POST", "/api/settings/[...rest]", async (_req, ctx) => Response.json({ hit: "catch-all", p: await ctx.params })),
		rec("PUT", "/api/settings/[section]", async (_req, ctx) => Response.json({ hit: "dynamic", p: await ctx.params })),
		rec("GET", "/api/settings/prompts", () => Response.json({ hit: "static" })),
		rec("GET", "/api/a/[id]/z", async (_req, ctx) => Response.json({ hit: "backtracked", p: await ctx.params })),
		rec("GET", "/api/a/x/y", () => Response.json({ hit: "axy" })),
	]);
	await withGateEnv({}, async () => {
		const getPrompts = await router(new Request(`${ORIGIN}/api/settings/prompts`));
		assert.deepEqual(await getPrompts.json(), { hit: "static" });

		// Must match static /api/settings/prompts (GET-only -> 405), NOT /api/settings/[section]!
		const putPrompts = await router(new Request(`${ORIGIN}/api/settings/prompts`, { method: "PUT" }));
		assert.equal(putPrompts.status, 405);

		const putGeneral = await router(new Request(`${ORIGIN}/api/settings/general`, { method: "PUT" }));
		assert.deepEqual(await putGeneral.json(), { hit: "dynamic", p: { section: "general" } });

		const postGeneral = await router(new Request(`${ORIGIN}/api/settings/general`, { method: "POST" }));
		assert.equal(postGeneral.status, 405);

		const postNested = await router(new Request(`${ORIGIN}/api/settings/a/b`, { method: "POST" }));
		assert.deepEqual(await postNested.json(), { hit: "catch-all", p: { rest: ["a", "b"] } });

		const backtracked = await router(new Request(`${ORIGIN}/api/a/x/z`));
		assert.deepEqual(await backtracked.json(), { hit: "backtracked", p: { id: "x" } });
	});
});

it("rejects trailing slashes, empty segments, and unmatched /api paths with 404", async () => {
	const router = createRouter([
		rec("GET", "/api/settings", () => new Response("ok")),
		rec("PUT", "/api/settings/[section]", () => new Response("ok")),
		rec("GET", "/api/chats/[id]/settings", () => new Response("ok")),
		rec("GET", "/api/plugins/[id]/assets/[...file]", () => new Response("ok")),
	]);
	const notFoundPaths = [
		"/api",
		"/api/",
		"/api/unknown",
		"/api/settings/",
		"/api/chats//settings",
		"/api/plugins/p1/assets",
		"/api/plugins/p1/assets/",
		"/api/plugins/p1/assets/a/b/",
		"/api/plugins/p1/assets/a//b",
	];
	await withGateEnv({}, async () => {
		for (const path of notFoundPaths) {
			const res = await router(new Request(`${ORIGIN}${path}`));
			assert.equal(res.status, 404, path);
			assert.equal(res.body, null, path);
		}
	});
});

it("percent-decodes [name] and [...name] per segment and returns 400 on malformed URI sequences", async () => {
	const router = createRouter([
		rec("GET", "/api/keys/[id]", async (_req, ctx) => Response.json(await ctx.params)),
		rec("GET", "/api/plugins/[id]/assets/[...file]", async (_req, ctx) => Response.json(await ctx.params)),
	]);
	await withGateEnv({}, async () => {
		const single = await router(new Request(`${ORIGIN}/api/keys/k%2D1%2Fsub%2520%E5%AD%97`));
		assert.equal(single.status, 200);
		assert.deepEqual(await single.json(), { id: "k-1/sub%20字" });

		const assetUrl = `${ORIGIN}/api/plugins/plug%2D1/assets/dir%2Fsub/file%25name-%E5%AD%97.txt`;
		const multi = await router(new Request(assetUrl));
		assert.equal(multi.status, 200);
		assert.deepEqual(await multi.json(), { id: "plug-1", file: ["dir/sub", "file%name-字.txt"] });

		for (const bad of ["/api/keys/%E0%A4%A", "/api/keys/%ZZ", "/api/plugins/p1/assets/ok/%E0%A4%A"]) {
			const res = await router(new Request(`${ORIGIN}${bad}`));
			assert.equal(res.status, 400, bad);
			assert.equal(res.body, null, bad);
		}

		const unmatched = await router(new Request(`${ORIGIN}/api/nonexistent/%E0%A4%A`));
		assert.equal(unmatched.status, 404);
	});
});

it("handles auto-OPTIONS, explicit OPTIONS, 405 without Allow, and 400 on non-standard methods", async () => {
	const router = createRouter([
		rec("GET", "/api/get-only", () => new Response("g")),
		rec("POST", "/api/post-only", () => new Response("p")),
		rec("PUT", "/api/multi", () => new Response("u")),
		rec("DELETE", "/api/multi", () => new Response("d")),
		rec("GET", "/api/multi", () => new Response("g")),
		rec("GET", "/api/with-head", () => new Response("g")),
		rec("HEAD", "/api/with-head", () => new Response(null, { status: 200 })),
		rec("POST", "/api/custom-opt", () => new Response("p")),
		rec("OPTIONS", "/api/custom-opt", () => new Response(null, { status: 204, headers: { "X-Opt": "custom" } })),
	]);
	await withGateEnv({}, async () => {
		const optGet = await router(new Request(`${ORIGIN}/api/get-only`, { method: "OPTIONS" }));
		assert.equal(optGet.status, 204);
		assert.equal(optGet.body, null);
		assert.equal(optGet.headers.get("Allow"), "GET, HEAD, OPTIONS");
		assert.equal((await router(new Request(`${ORIGIN}/api/post-only`, { method: "OPTIONS" }))).headers.get("Allow"), "OPTIONS, POST");
		assert.equal((await router(new Request(`${ORIGIN}/api/multi`, { method: "OPTIONS" }))).headers.get("Allow"), "DELETE, GET, HEAD, OPTIONS, PUT");
		assert.equal((await router(new Request(`${ORIGIN}/api/with-head`, { method: "OPTIONS" }))).headers.get("Allow"), "GET, HEAD, OPTIONS");
		assert.equal((await router(new Request(`${ORIGIN}/api/custom-opt`, { method: "OPTIONS" }))).headers.get("X-Opt"), "custom");

		const disallowed = await router(new Request(`${ORIGIN}/api/get-only`, { method: "DELETE" }));
		assert.equal(disallowed.status, 405);
		assert.equal(disallowed.body, null);
		assert.equal(disallowed.headers.get("Allow"), null);

		for (const badMethod of ["PROPFIND", "MKCOL", "FOO", "PURGE"]) {
			const res = await router(new Request(`${ORIGIN}/api/get-only`, { method: badMethod }));
			assert.equal(res.status, 400, badMethod);
			assert.equal(res.body, null, badMethod);
		}
	});
});

it("implements auto-HEAD from GET with stream cancellation while honoring explicit HEAD and 405", async () => {
	let cancelled = false;
	const router = createRouter([
		rec("GET", "/api/streamed", () => makeCancelSpyStream(() => { cancelled = true; })),
		rec("GET", "/api/explicit-head", () => new Response("get-body", { headers: { "X-From": "GET" } })),
		rec("HEAD", "/api/explicit-head", () => new Response(null, { headers: { "X-From": "HEAD" } })),
		rec("POST", "/api/no-get", () => new Response("post")),
	]);
	await withGateEnv({}, async () => {
		const headRes = await router(new Request(`${ORIGIN}/api/streamed`, { method: "HEAD" }));
		assert.equal(cancelled, true, "auto-HEAD must cancel GET response body stream");
		assert.equal(headRes.status, 206);
		assert.equal(headRes.statusText, "Partial Content");
		assert.equal(headRes.headers.get("X-Stream"), "yes");
		assert.equal(headRes.body, null);

		const explicit = await router(new Request(`${ORIGIN}/api/explicit-head`, { method: "HEAD" }));
		assert.equal(explicit.headers.get("X-From"), "HEAD");

		const noGet = await router(new Request(`${ORIGIN}/api/no-get`, { method: "HEAD" }));
		assert.equal(noGet.status, 405);
	});
});

it("supports sync and async handlers and turns sync/async throws into 500 with onError", async () => {
	const errors: Array<{ error: unknown; url: string }> = [];
	const throwSync: RouteHandler = () => { throw new Error("sync-boom"); };
	const throwAsync: RouteHandler = async () => { throw new Error("async-boom"); };
	const router = createRouter(
		[
			rec("GET", "/api/sync", () => new Response("sync-ok")),
			rec("GET", "/api/async", async () => new Response("async-ok")),
			rec("GET", "/api/throw-sync", throwSync),
			rec("GET", "/api/throw-async", throwAsync),
		],
		{ onError: (error, req) => errors.push({ error, url: req.url }) },
	);
	await withGateEnv({}, async () => {
		assert.equal(await (await router(new Request(`${ORIGIN}/api/sync`))).text(), "sync-ok");
		assert.equal(await (await router(new Request(`${ORIGIN}/api/async`))).text(), "async-ok");

		for (const path of ["/api/throw-sync", "/api/throw-async"]) {
			const res = await router(new Request(`${ORIGIN}${path}`));
			assert.equal(res.status, 500, path);
			assert.equal(res.headers.get("Content-Type"), null, path);
			assert.equal(await res.text(), "", path);
		}
		assert.equal(errors.length, 2);
		assert.equal((errors[0]?.error as Error).message, "sync-boom");
		assert.equal((errors[1]?.error as Error).message, "async-boom");
	});
});

it("validates pattern syntax at createRouter construction time", () => {
	assert.throws(() => createRouter([rec("GET", "api/no-leading-slash", () => new Response())]), /must start with/);
	assert.throws(
		() => createRouter([rec("GET", "/api/[...mid]/tail", () => new Response())]),
		/Catch-all must be last/,
	);
});

it("computes bodyLimit across non-/api, standard /api, exempt, and percent-encoded paths", () => {
	assert.equal(MAX_IMPORT_BODY_BYTES, 27_262_976);
	for (const nonApi of ["/", "/chat/new", "/apix", "/api-other/plugins/doc/documents/markdown"]) {
		assert.equal(bodyLimit(nonApi), null, nonApi);
	}
	const capped = [
		"/api", "/api/", "/api/chat", "/api/graph/import", "/api/plugins",
		"/api/plugins/doc/call", "/api/plugins/doc/documents", "/api/plugins/doc/documents/other",
		"/api/plugins/doc/documents/markdown/extra", "/api/plugins/doc/documents/markdown.json",
		"/api/plugins/documents/markdown", "/api/plugins/doc%2Fone/documents/markdown",
		"/api/plugins/doc/documents%2Fmarkdown", "/api/chat/%E0%A4%A",
		"/api/plugins/bad%E0%A4%A/documents/markdown",
	];
	for (const path of capped) assert.equal(bodyLimit(path), MAX_IMPORT_BODY_BYTES, path);
	const exempt = [
		"/api/plugins/document-one/documents/markdown",
		"/api/plugins/document-one/documents/markdown/",
		"/api/plugins/document%2Done/documents/markdown",
		"/api/plugins/%64ocument-one/documents/markdown/",
		"/api/plugins/%E5%AD%97/documents/markdown",
	];
	for (const path of exempt) assert.equal(bodyLimit(path), null, path);
});

it("reports gate refusals via onRefusal with method and pathname only", async () => {
	const refusals: Array<{ method: string; pathname: string }> = [];
	const router = createRouter(
		[rec("POST", "/api/keys/[id]", () => Response.json({ ok: true }))],
		{ onRefusal: (method, pathname) => refusals.push({ method, pathname }) },
	);
	await withGateEnv({ LH_DESKTOP_SERVER: "1", LH_DESKTOP_API_SECRET: SECRET }, async () => {
		const badReq = new Request(`${ORIGIN}/api/keys/BRAVE?secret=leak`, { method: "POST", headers: { [DESKTOP_HEADER]: "wrong-secret" } });
		const bad = await router(badReq);
		assert.equal(bad.status, 403);
		const okReq = new Request(`${ORIGIN}/api/keys/BRAVE?secret=keep`, { method: "POST", headers: { [DESKTOP_HEADER]: SECRET } });
		const ok = await router(okReq);
		assert.equal(ok.status, 200);
	});
	assert.deepEqual(refusals, [{ method: "POST", pathname: "/api/keys/BRAVE" }]);
});
