import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

await import("./helpers/client-env.ts");
const { buildClient } = await import("../scripts/client-build.mjs");
const nodeCryptoShim = await import("../public/client/shims/node-crypto.js");

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PKG = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as {
	version: string;
	homepage: string;
};

test("buildClient produces state, keyboard, vendor bundles, and KaTeX assets with zero server leaks", async () => {
	const { outdir, metafile } = await buildClient();
	const statePath = path.join(outdir, "state.js");
	assert.equal(fs.existsSync(statePath), true);
	assert.equal(fs.existsSync(path.join(outdir, "keyboard.js")), true);
	assert.equal(fs.existsSync(path.join(outdir, "blocks-math.js")), true);
	assert.equal(fs.existsSync(path.join(outdir, "blocks-code.js")), true);
	assert.equal(fs.existsSync(path.join(outdir, "blocks-mermaid.js")), true);
	assert.equal(fs.existsSync(path.join(outdir, "katex", "katex.min.css")), true);

	const fonts = fs.readdirSync(path.join(outdir, "katex", "fonts"));
	assert.equal(fonts.some((f) => f.endsWith(".woff2")), true);

	const stateCode = fs.readFileSync(statePath, "utf8");
	assert.equal(stateCode.includes(JSON.stringify(PKG.version)), true);
	assert.equal(stateCode.includes("process.env.APP_VERSION"), false);

	const jsFiles = fs.readdirSync(outdir).filter((f) => f.endsWith(".js"));
	const combinedJs = jsFiles.map((f) => fs.readFileSync(path.join(outdir, f), "utf8")).join("\n");
	assert.match(combinedJs, /from\s*["']cloudcanvas\/theme["']/);
	assert.match(combinedJs, /from\s*["']cloudcanvas-lib["']/);

	const inputs = Object.keys(metafile?.inputs ?? {});
	assert.equal(inputs.length > 0, true);
	assert.equal(inputs.some((p) => p.startsWith("src/store/")), false);
	assert.equal(inputs.some((p) => p.startsWith("src/agent/")), false);
	assert.equal(inputs.some((p) => p.startsWith("src/server/")), false);
	assert.equal(inputs.some((p) => p.startsWith("src/memory/")), false);
	assert.equal(inputs.some((p) => p.startsWith("extern/cloudcanvas")), false);
});

test("node:crypto browser shim refuses server hash primitives while delegating randomUUID", () => {
	assert.throws(() => nodeCryptoShim.createHash("sha256"), /node:crypto is unavailable/);
	assert.throws(() => nodeCryptoShim.randomBytes(16), /node:crypto is unavailable/);
	assert.throws(() => nodeCryptoShim.timingSafeEqual(), /node:crypto is unavailable/);
	assert.match(nodeCryptoShim.randomUUID(), /^[0-9a-f-]{36}$/i);
});
