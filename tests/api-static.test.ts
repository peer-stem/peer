import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { after, before, test } from "node:test";
import { ROOT } from "@/config.ts";
import { createApiHttpServer, type ApiHttpServer } from "../src/api/server.ts";
import { createStaticHandler, serveStatic } from "../src/api/static.ts";
import { createScratchDir } from "./api-test-helpers.ts";

let scratchBase = "";
let publicScratch = "";
let outsideScratch = "";
let apiServer: ApiHttpServer;
let baseUrl = "";

function populateScratchFiles(pubDir: string, outDir: string): void {
	fs.mkdirSync(path.join(pubDir, "sub"), { recursive: true });
	fs.writeFileSync(path.join(pubDir, "sub", "index.html"), "<h1>index</h1>");
	fs.writeFileSync(path.join(pubDir, "sub", ".secret"), "dotfile-sub");
	fs.writeFileSync(path.join(pubDir, ".gitignore"), "node_modules/\n");
	fs.writeFileSync(path.join(pubDir, "raw.bin"), Buffer.from([0x00, 0xff, 0xfe, 0x80, 0x41]));
	fs.writeFileSync(path.join(pubDir, "template.html"), "<div>{{unchanged}}</div>");
	fs.writeFileSync(path.join(pubDir, "space file-é.txt"), "utf8 name");
	fs.writeFileSync(path.join(outDir, "secret.txt"), "top-secret");
	fs.symlinkSync(path.join(outDir, "secret.txt"), path.join(pubDir, "escape-file.txt"));
	fs.symlinkSync(outDir, path.join(pubDir, "escape-dir"));
	fs.symlinkSync(path.join(pubDir, "template.html"), path.join(pubDir, "inside-link.html"));
}

function populateMimeFixtures(pubDir: string): Array<[string, string]> {
	const cases: Array<[string, string]> = [
		["a.html", "text/html; charset=utf-8"],
		["a.HTML", "text/html; charset=utf-8"],
		["a.js", "text/javascript; charset=utf-8"],
		["a.mjs", "text/javascript; charset=utf-8"],
		["a.css", "text/css; charset=utf-8"],
		["a.json", "application/json; charset=utf-8"],
		["a.map", "application/json; charset=utf-8"],
		["a.txt", "text/plain; charset=utf-8"],
		["a.svg", "image/svg+xml"],
		["a.png", "image/png"],
		["a.jpg", "image/jpeg"],
		["a.jpeg", "image/jpeg"],
		["a.gif", "image/gif"],
		["a.webp", "image/webp"],
		["a.ico", "image/x-icon"],
		["a.ttf", "font/ttf"],
		["a.woff", "font/woff"],
		["a.woff2", "font/woff2"],
		["a.wasm", "application/wasm"],
		["a.zip", "application/zip"],
		["a.unknown", "application/octet-stream"],
	];
	const mimeDir = path.join(pubDir, "mime");
	fs.mkdirSync(mimeDir, { recursive: true });
	for (const [name] of cases) fs.writeFileSync(path.join(mimeDir, name), "x");
	return cases;
}

function populateRepoMountFixtures(repoDir: string, outDir: string): { pubDir: string; indexBytes: Buffer } {
	const pubDir = path.join(repoDir, "public");
	const indexBytes = Buffer.from("<!doctype html><title>Peer SPA</title>", "utf8");
	fs.mkdirSync(path.join(pubDir, "client"), { recursive: true });
	fs.writeFileSync(path.join(pubDir, "client", "index.html"), indexBytes);
	const srcClient = path.join(repoDir, "src", "client");
	fs.mkdirSync(path.join(srcClient, "views"), { recursive: true });
	fs.writeFileSync(path.join(srcClient, "app.js"), "export const ok = 1;\n");
	fs.writeFileSync(path.join(srcClient, "views", "THEME.CSS"), ":root {}\n");
	fs.writeFileSync(path.join(srcClient, "manifest.json"), '{"v":1}\n');
	fs.writeFileSync(path.join(srcClient, "icon.svg"), "<svg></svg>");
	fs.writeFileSync(path.join(srcClient, "types.d.ts"), "export type X = 1;\n");
	fs.writeFileSync(path.join(srcClient, "raw.ts"), "export const x = 1;\n");
	fs.writeFileSync(path.join(srcClient, "view.tsx"), "export const v = null;\n");
	fs.writeFileSync(path.join(srcClient, "extra.mjs"), "export default 1;\n");
	fs.writeFileSync(path.join(srcClient, ".hidden.js"), "secret();\n");
	fs.symlinkSync(path.join(outDir, "secret.txt"), path.join(srcClient, "escape.js"));
	fs.symlinkSync(path.join(srcClient, "raw.ts"), path.join(srcClient, "sneaky.js"));
	populateScratchVendorFixture(repoDir, outDir);
	return { pubDir, indexBytes };
}

function populateScratchVendorFixture(repoDir: string, outDir: string): void {
	const ccDir = path.join(repoDir, "extern", "cloudcanvas");
	fs.mkdirSync(path.join(ccDir, "core"), { recursive: true });
	fs.mkdirSync(path.join(ccDir, "scripts"), { recursive: true });
	fs.mkdirSync(path.join(ccDir, "tests"), { recursive: true });
	fs.writeFileSync(path.join(ccDir, "package.json"), JSON.stringify({ files: ["index.js", "core"] }));
	fs.writeFileSync(path.join(ccDir, "index.js"), "export const cc = true;\n");
	fs.writeFileSync(path.join(ccDir, "core", "blit.js"), "export const blit = true;\n");
	fs.writeFileSync(path.join(ccDir, "core", ".dot.js"), "hidden\n");
	fs.writeFileSync(path.join(ccDir, "scripts", "build.js"), "console.log('nope');\n");
	fs.writeFileSync(path.join(ccDir, "tests", "unit.js"), "console.log('test');\n");
	fs.symlinkSync(path.join(outDir, "secret.txt"), path.join(ccDir, "core", "outside.js"));
	fs.symlinkSync(path.join(ccDir, "package.json"), path.join(ccDir, "core", "pkg-leak.js"));
}

function rawHttpGet(
	port: number,
	rawPath: string,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
	return new Promise((resolve, reject) => {
		const req = http.request({ host: "127.0.0.1", port, method: "GET", path: rawPath }, (res) => {
			const chunks: Buffer[] = [];
			res.on("data", (chunk: Buffer) => chunks.push(chunk));
			res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
		});
		req.on("error", reject);
		req.end();
	});
}

let mimeCases: Array<[string, string]> = [];
let repoMountDir = "";
let spaPublicDir = "";
let spaIndexBytes: Buffer = Buffer.alloc(0);

before(async () => {
	scratchBase = createScratchDir("api-static-");
	publicScratch = path.join(scratchBase, "public");
	outsideScratch = path.join(scratchBase, "outside");
	repoMountDir = path.join(scratchBase, "repo");
	fs.mkdirSync(publicScratch, { recursive: true, mode: 0o700 });
	fs.mkdirSync(outsideScratch, { recursive: true, mode: 0o700 });
	populateScratchFiles(publicScratch, outsideScratch);
	mimeCases = populateMimeFixtures(publicScratch);
	const repoFixtures = populateRepoMountFixtures(repoMountDir, outsideScratch);
	spaPublicDir = repoFixtures.pubDir;
	spaIndexBytes = repoFixtures.indexBytes;
	apiServer = createApiHttpServer(createStaticHandler(publicScratch));
	await new Promise<void>((resolve) => {
		apiServer.server.listen(0, "127.0.0.1", () => resolve());
	});
	const addr = apiServer.server.address() as AddressInfo;
	baseUrl = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
	if (apiServer) await apiServer.close();
	if (scratchBase) fs.rmSync(scratchBase, { recursive: true, force: true });
});

test("serveStatic delivers real public/ assets unchanged with expected headers", async () => {
	const realAssets: Array<[string, string]> = [
		["fonts/cmunbx.ttf", "font/ttf"],
		["plugin-loader.js", "text/javascript; charset=utf-8"],
		["worklets/pcm-capture.js", "text/javascript; charset=utf-8"],
		["siwc/chatgpt-logo-white.svg", "image/svg+xml"],
	];
	for (const [relPath, expectedMime] of realAssets) {
		const diskBytes = fs.readFileSync(path.join(ROOT, "public", relPath));
		const res = await serveStatic(new Request(`http://127.0.0.1/${relPath}`));
		assert.equal(res.status, 200, relPath);
		assert.equal(res.headers.get("content-type"), expectedMime, relPath);
		assert.equal(res.headers.get("cache-control"), "no-cache", relPath);
		assert.equal(res.headers.get("x-content-type-options"), "nosniff", relPath);
		assert.equal(res.headers.get("content-length"), String(diskBytes.byteLength), relPath);
		const bodyBytes = Buffer.from(await res.arrayBuffer());
		assert.equal(Buffer.compare(bodyBytes, diskBytes), 0, relPath);
	}
});

test("delivers raw binary, template text, encoded names, and in-root symlinks unchanged", async () => {
	const rawRes = await fetch(`${baseUrl}/raw.bin`);
	assert.equal(rawRes.status, 200);
	assert.equal(rawRes.headers.get("cache-control"), "no-cache");
	assert.deepEqual(Buffer.from(await rawRes.arrayBuffer()), Buffer.from([0x00, 0xff, 0xfe, 0x80, 0x41]));

	const tplRes = await fetch(`${baseUrl}/template.html`);
	assert.equal(tplRes.status, 200);
	assert.equal(await tplRes.text(), "<div>{{unchanged}}</div>");

	const encRes = await fetch(`${baseUrl}/space%20file-%C3%A9.txt`);
	assert.equal(encRes.status, 200);
	assert.equal(await encRes.text(), "utf8 name");

	const linkRes = await fetch(`${baseUrl}/inside-link.html`);
	assert.equal(linkRes.status, 200);
	assert.equal(await linkRes.text(), "<div>{{unchanged}}</div>");
});

test("maps extensions case-insensitively to exact Content-Type values", async () => {
	const handler = createStaticHandler(publicScratch);
	for (const [name, expectedMime] of mimeCases) {
		const res = await handler(new Request(`http://127.0.0.1/mime/${name}`));
		assert.equal(res.status, 200, name);
		assert.equal(res.headers.get("content-type"), expectedMime, name);
	}
});

test("HEAD returns headers and Content-Length with empty body", async () => {
	const diskBytes = fs.readFileSync(path.join(ROOT, "public", "fonts", "cmunbx.ttf"));
	const direct = await serveStatic(new Request("http://127.0.0.1/fonts/cmunbx.ttf", { method: "HEAD" }));
	assert.equal(direct.status, 200);
	assert.equal(direct.body, null);
	assert.equal(direct.headers.get("content-type"), "font/ttf");
	assert.equal(direct.headers.get("cache-control"), "no-cache");
	assert.equal(direct.headers.get("content-length"), String(diskBytes.byteLength));

	const wire = await fetch(`${baseUrl}/template.html`, { method: "HEAD" });
	assert.equal(wire.status, 200);
	assert.equal(wire.headers.get("content-length"), "24");
	assert.equal((await wire.arrayBuffer()).byteLength, 0);
});

test("returns 404 with Cache-Control no-store for missing client/index.html, directories, and missing files", async () => {
	const missingTargets = [
		"/",
		"//",
		"/chat/new",
		"/chat/abc",
		"/plugins/p1/v1",
		"/settings",
		"/sub",
		"/sub/",
		"/missing.txt",
		"/sub/missing.js",
	];
	for (const target of missingTargets) {
		const res = await fetch(`${baseUrl}${target}`);
		assert.equal(res.status, 404, target);
		assert.equal(res.headers.get("cache-control"), "no-store", target);
		assert.equal((await res.arrayBuffer()).byteLength, 0, target);
	}
});

test("serves SPA HTML routes when client/index.html exists and rejects double-slash or invalid SPA shapes", async () => {
	const handler = createStaticHandler(spaPublicDir, { repoRoot: repoMountDir });
	const validSpaPaths = [
		"/",
		"/chat/new",
		"/chat/new/",
		"/chat/session_42",
		"/chat/session_42/",
		"/plugins/flashcards/review",
		"/plugins/flashcards/review/",
		"/settings",
		"/settings/",
	];
	for (const routePath of validSpaPaths) {
		const res = await handler(new Request(`http://127.0.0.1${routePath}`));
		assert.equal(res.status, 200, routePath);
		assert.equal(res.headers.get("content-type"), "text/html; charset=utf-8", routePath);
		assert.equal(res.headers.get("cache-control"), "no-cache", routePath);
		assert.equal(res.headers.get("x-content-type-options"), "nosniff", routePath);
		assert.equal(res.headers.get("content-length"), String(spaIndexBytes.byteLength), routePath);
		assert.equal(Buffer.compare(Buffer.from(await res.arrayBuffer()), spaIndexBytes), 0, routePath);
	}
	const headSpa = await handler(new Request("http://127.0.0.1/chat/new", { method: "HEAD" }));
	assert.equal(headSpa.status, 200);
	assert.equal(headSpa.body, null);

	for (const rejected of ["//", "/chat", "/chat/", "/chat//new", "/plugins/only-one", "/plugins/a/b/c", "/chat/.dot"]) {
		const res = await handler(new Request(`http://127.0.0.1${rejected}`));
		assert.equal(res.status, 404, rejected);
		assert.equal(res.headers.get("cache-control"), "no-store", rejected);
	}
	const badSpaPct = await handler(new Request("http://127.0.0.1/chat/%E0%A4%A"));
	assert.equal(badSpaPct.status, 400);
});

test("enforces package.json files allowlist and realpath containment on /client/vendor mounts", async () => {
	const realHandler = createStaticHandler(publicScratch, { repoRoot: ROOT });
	const allowedReal = [
		"/client/vendor/cloudcanvas/index.js",
		"/client/vendor/cloudcanvas/core/index.js",
		"/client/vendor/cloudcanvas-lib/index.js",
		"/client/vendor/cloudcanvas-lib/ui/index.js",
	];
	for (const urlPath of allowedReal) {
		const res = await realHandler(new Request(`http://127.0.0.1${urlPath}`));
		assert.equal(res.status, 200, urlPath);
		assert.equal(res.headers.get("cache-control"), "no-cache", urlPath);
		assert.equal(res.headers.get("content-type"), "text/javascript; charset=utf-8", urlPath);
	}
	const blockedReal = [
		"/client/vendor/cloudcanvas/package.json",
		"/client/vendor/cloudcanvas/scripts/build.js",
		"/client/vendor/cloudcanvas-lib/package.json",
		"/client/vendor/unknown/index.js",
		"/client/vendor/cloudcanvas",
	];
	for (const urlPath of blockedReal) {
		const res = await realHandler(new Request(`http://127.0.0.1${urlPath}`));
		assert.equal(res.status, 404, urlPath);
		assert.equal(res.headers.get("cache-control"), "no-store", urlPath);
	}
	const scratchHandler = createStaticHandler(spaPublicDir, { repoRoot: repoMountDir });
	assert.equal((await scratchHandler(new Request("http://127.0.0.1/client/vendor/cloudcanvas/core/blit.js"))).status, 200);
	for (const blocked of [
		"/client/vendor/cloudcanvas/package.json",
		"/client/vendor/cloudcanvas/scripts/build.js",
		"/client/vendor/cloudcanvas/tests/unit.js",
		"/client/vendor/cloudcanvas/core/outside.js",
		"/client/vendor/cloudcanvas/core/pkg-leak.js",
	]) {
		const res = await scratchHandler(new Request(`http://127.0.0.1${blocked}`));
		assert.equal(res.status, 404, blocked);
	}
});

test("serves only .js, .css, .json, and .svg under /client/src and rejects .ts/.d.ts/.tsx and escapes", async () => {
	const handler = createStaticHandler(spaPublicDir, { repoRoot: repoMountDir });
	const passCases: Array<[string, string]> = [
		["/client/src/app.js", "text/javascript; charset=utf-8"],
		["/client/src/views/THEME.CSS", "text/css; charset=utf-8"],
		["/client/src/manifest.json", "application/json; charset=utf-8"],
		["/client/src/icon.svg", "image/svg+xml"],
	];
	for (const [urlPath, mime] of passCases) {
		const res = await handler(new Request(`http://127.0.0.1${urlPath}`));
		assert.equal(res.status, 200, urlPath);
		assert.equal(res.headers.get("content-type"), mime, urlPath);
		assert.equal(res.headers.get("cache-control"), "no-cache", urlPath);
	}
	const rejectCases = [
		"/client/src",
		"/client/src/types.d.ts",
		"/client/src/raw.ts",
		"/client/src/view.tsx",
		"/client/src/extra.mjs",
		"/client/src/escape.js",
		"/client/src/sneaky.js",
	];
	for (const urlPath of rejectCases) {
		const res = await handler(new Request(`http://127.0.0.1${urlPath}`));
		assert.equal(res.status, 404, urlPath);
		assert.equal(res.headers.get("cache-control"), "no-store", urlPath);
	}
});

test("rejects dotfile segments, dot-dot traversal, separators, and symlink escapes with 404", async () => {
	const addr = apiServer.server.address() as AddressInfo;
	const traversalPaths = [
		"/.gitignore",
		"/%2egitignore",
		"/sub/.secret",
		"/../outside/secret.txt",
		"/sub/../../outside/secret.txt",
		"/%2e%2e/secret.txt",
		"/%2E%2E/outside/secret.txt",
		"/sub/%2e%2e/%2e%2e/outside/secret.txt",
		"/..%2ftemplate.html",
		"/%2e%2e%2foutside/secret.txt",
		"/sub%2findex.html",
		"/sub%5cindex.html",
		"/%00.txt",
		"/escape-file.txt",
		"/escape-dir/secret.txt",
	];
	for (const rawPath of traversalPaths) {
		const res = await rawHttpGet(addr.port, rawPath);
		assert.equal(res.status, 404, rawPath);
		assert.equal(res.headers["cache-control"], "no-store", rawPath);
		assert.equal(res.body.byteLength, 0, rawPath);
	}
	const mountHandler = createStaticHandler(spaPublicDir, { repoRoot: repoMountDir });
	for (const dotMountPath of ["/client/src/.hidden.js", "/client/vendor/cloudcanvas/core/.dot.js"]) {
		const res = await mountHandler(new Request(`http://127.0.0.1${dotMountPath}`));
		assert.equal(res.status, 404, dotMountPath);
		assert.equal(res.headers.get("cache-control"), "no-store", dotMountPath);
	}
});

test("returns 400 for malformed percent-encoding in pathname", async () => {
	const addr = apiServer.server.address() as AddressInfo;
	const badUri = await rawHttpGet(addr.port, "/%E0%A4%A");
	assert.equal(badUri.status, 400);
	assert.equal(badUri.body.byteLength, 0);

	const handler = createStaticHandler(publicScratch);
	const badDirect = await handler(new Request("http://127.0.0.1/%E0%A4%A"));
	assert.equal(badDirect.status, 400);
});

test("resolves static root realpath once lazily across repeated requests", async (t) => {
	let rootCalls = 0;
	const origRealpath = fs.promises.realpath.bind(fs.promises);
	const expectedRoot = path.resolve(publicScratch);
	t.mock.method(fs.promises, "realpath", async (target: fs.PathLike) => {
		if (String(target) === expectedRoot) rootCalls += 1;
		return origRealpath(target);
	});
	const handler = createStaticHandler(publicScratch);
	for (let i = 0; i < 4; i++) {
		const res = await handler(new Request("http://127.0.0.1/template.html", { method: "HEAD" }));
		assert.equal(res.status, 200);
	}
	assert.equal(rootCalls, 1);
});

test("answers OPTIONS with 204 Allow and rejects unsupported methods with 405", async () => {
	const optRes = await fetch(`${baseUrl}/template.html`, { method: "OPTIONS" });
	assert.equal(optRes.status, 204);
	assert.equal(optRes.headers.get("allow"), "GET, HEAD, OPTIONS");
	assert.equal((await optRes.arrayBuffer()).byteLength, 0);

	for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
		const res = await fetch(`${baseUrl}/template.html`, { method });
		assert.equal(res.status, 405, method);
		assert.equal((await res.arrayBuffer()).byteLength, 0, method);
	}
});
