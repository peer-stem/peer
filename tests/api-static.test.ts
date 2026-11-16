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
	for (const [name] of cases) {
		fs.writeFileSync(path.join(mimeDir, name), "x");
	}
	return cases;
}

function rawHttpGet(port: number, rawPath: string): Promise<{ status: number; body: Buffer }> {
	return new Promise((resolve, reject) => {
		const req = http.request({ host: "127.0.0.1", port, method: "GET", path: rawPath }, (res) => {
			const chunks: Buffer[] = [];
			res.on("data", (chunk: Buffer) => chunks.push(chunk));
			res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
		});
		req.on("error", reject);
		req.end();
	});
}

let mimeCases: Array<[string, string]> = [];

before(async () => {
	scratchBase = createScratchDir("api-static-");
	publicScratch = path.join(scratchBase, "public");
	outsideScratch = path.join(scratchBase, "outside");
	fs.mkdirSync(publicScratch, { recursive: true, mode: 0o700 });
	fs.mkdirSync(outsideScratch, { recursive: true, mode: 0o700 });
	populateScratchFiles(publicScratch, outsideScratch);
	mimeCases = populateMimeFixtures(publicScratch);
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
		assert.equal(res.headers.get("cache-control"), "public, max-age=0", relPath);
		assert.equal(res.headers.get("x-content-type-options"), "nosniff", relPath);
		assert.equal(res.headers.get("content-length"), String(diskBytes.byteLength), relPath);
		const bodyBytes = Buffer.from(await res.arrayBuffer());
		assert.equal(Buffer.compare(bodyBytes, diskBytes), 0, relPath);
	}
});

test("delivers raw binary, template text, encoded names, and in-root symlinks unchanged", async () => {
	const rawRes = await fetch(`${baseUrl}/raw.bin`);
	assert.equal(rawRes.status, 200);
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
	assert.equal(direct.headers.get("content-length"), String(diskBytes.byteLength));

	const wire = await fetch(`${baseUrl}/template.html`, { method: "HEAD" });
	assert.equal(wire.status, 200);
	assert.equal(wire.headers.get("content-length"), "24");
	assert.equal((await wire.arrayBuffer()).byteLength, 0);
});

test("returns 404 for root, directories, and missing files", async () => {
	for (const target of ["/", "//", "/sub", "/sub/", "/missing.txt", "/sub/missing.js"]) {
		const res = await fetch(`${baseUrl}${target}`);
		assert.equal(res.status, 404, target);
		assert.equal((await res.arrayBuffer()).byteLength, 0, target);
	}
});

test("blocks dot-dot, percent-encoded traversal, separators, and symlink escapes with 404", async () => {
	const addr = apiServer.server.address() as AddressInfo;
	const traversalPaths = [
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
		assert.equal(res.body.byteLength, 0, rawPath);
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
