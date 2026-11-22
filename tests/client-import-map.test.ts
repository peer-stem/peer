import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { WORKTREE_ROOT } from "./api-test-helpers.ts";
import { buildClientImportMap, extractHtmlImportMap } from "./helpers/client-import-map.ts";

const INDEX_HTML_PATH = path.join(WORKTREE_ROOT, "public", "client", "index.html");

function resolveDiskPathForUrl(mappedUrl: string): string | null {
	if (mappedUrl.startsWith("/client/vendor/cloudcanvas/")) {
		const rel = mappedUrl.slice("/client/vendor/cloudcanvas/".length);
		return path.join(WORKTREE_ROOT, "extern", "cloudcanvas", rel);
	}
	if (mappedUrl.startsWith("/client/vendor/cloudcanvas-lib/")) {
		const rel = mappedUrl.slice("/client/vendor/cloudcanvas-lib/".length);
		return path.join(WORKTREE_ROOT, "extern", "cloudcanvas-lib", rel);
	}
	if (mappedUrl.startsWith("/client/shims/")) {
		const rel = mappedUrl.slice("/client/shims/".length);
		return path.join(WORKTREE_ROOT, "public", "client", "shims", rel);
	}
	if (mappedUrl.startsWith("/client/src/")) {
		const rel = mappedUrl.slice("/client/src/".length);
		return path.join(WORKTREE_ROOT, "src", "client", rel);
	}
	return null;
}

test("public/client/index.html has required dark theme-pending shell, stylesheets, and module boot ordering", () => {
	assert.equal(fs.existsSync(INDEX_HTML_PATH), true);
	const html = fs.readFileSync(INDEX_HTML_PATH, "utf8");
	assert.match(html, /^<!DOCTYPE html>/i);
	assert.match(html, /<html\s+lang="en"\s+class="dark"\s+data-theme-pending>/);
	assert.match(html, /<meta\s+charset="utf-8">/i);
	assert.match(html, /<meta\s+name="viewport"\s+content="width=device-width,\s*initial-scale=1">/i);
	assert.match(html, /<meta\s+name="color-scheme"\s+content="dark light">/i);
	assert.match(html, /<title>Peer<\/title>/);
	assert.match(html, /<link\s+rel="stylesheet"\s+href="\/client\/peer\.css">/);
	assert.match(html, /<link\s+rel="stylesheet"\s+href="\/client\/build\/katex\/katex\.min\.css">/);
	assert.match(html, /<script\s+type="module"\s+src="\/client\/src\/main\.js"><\/script>/);
	const importMapIdx = html.indexOf('<script type="importmap">');
	const moduleScriptIdx = html.indexOf('<script type="module"');
	assert.equal(importMapIdx >= 0, true);
	assert.equal(importMapIdx < moduleScriptIdx, true);
});

test("public/client/index.html import map matches buildClientImportMap() 1:1 without drift", () => {
	const html = fs.readFileSync(INDEX_HTML_PATH, "utf8");
	const actual = extractHtmlImportMap(html);
	const expected = buildClientImportMap(WORKTREE_ROOT);
	const actualKeys = Object.keys(actual.imports).sort();
	const expectedKeys = Object.keys(expected.imports).sort();
	assert.deepEqual(actualKeys, expectedKeys);
	assert.deepEqual(actual, expected);
});

test("every /client/vendor/** and /client/shims/** target in index.html exists on disk", () => {
	const html = fs.readFileSync(INDEX_HTML_PATH, "utf8");
	const { imports } = extractHtmlImportMap(html);
	let checkedCount = 0;
	for (const [specifier, targetUrl] of Object.entries(imports)) {
		const diskPath = resolveDiskPathForUrl(targetUrl);
		if (diskPath === null) continue;
		checkedCount++;
		assert.equal(fs.existsSync(diskPath), true, `Missing target on disk for "${specifier}": ${diskPath}`);
		assert.equal(fs.statSync(diskPath).isFile(), true, `Target is not a file for "${specifier}": ${diskPath}`);
	}
	assert.equal(checkedCount >= 60, true);
});
