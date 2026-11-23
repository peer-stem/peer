/**
 * build-server.mjs — bundle & curate the self-contained server payload at
 * dist/server-payload/standalone/ (shipped via extraResources in Electron).
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { validateCorePackages } from "./build-core-plugins.mjs";
import { buildPluginAuthoring } from "./build-plugin-authoring.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const PAYLOAD = path.join(ROOT, "dist", "server-payload");
const STANDALONE = path.join(PAYLOAD, "standalone");

const SERVER_RUNTIME_PACKAGES = [
	"@earendil-works/pi-ai",
	"@earendil-works/pi-agent-core",
	"@napi-rs/canvas",
	"@resvg/resvg-js",
	"@silvia-odwyer/photon-node",
	"pdfjs-dist",
	"puppeteer-core",
	"undici",
	"linkedom",
	"turndown",
	"@mozilla/readability",
	"@modelcontextprotocol/sdk",
	"tokenlens",
	"jose",
	"typebox",
	"zod",
	"nanoid",
];

const SERVER_EXTERNALS = [
	...SERVER_RUNTIME_PACKAGES,
	"@earendil-works/pi-ai/*",
	"@earendil-works/pi-agent-core/*",
	"@modelcontextprotocol/sdk/*",
	"pdfjs-dist/*",
	"electron",
];

const BUILD_ONLY_PACKAGES = new Set([
	"electron",
	"electron-builder",
	"esbuild",
	"eslint",
	"typescript",
	"tsx",
	"happy-dom",
	"@happy-dom/global-registrator",
]);

const ALLOWED_CLIENT_SRC_EXTS = new Set([".js", ".css", ".json", ".svg"]);
const FORBIDDEN_GPU_LIB_RE =
	/lib(?:cuda|cudart|cublas|cudnn|cufft|curand|cusolver|cusparse|nccl|nvrtc|amdhip64|hiprtc|rocblas|MIOpen|rocm_smi|hsa-runtime64)\.so/i;
const DEFAULT_ADDON_PATH = path.join(
	process.env.PEER_PERSIST_ROOT ?? "/usr/lib/persist/peer",
	"build",
	"lumberjack",
	"lumberjack_peer.node",
);

function fail(message, detail) {
	console.error(message);
	if (detail !== undefined) console.error(detail);
	process.exit(1);
}

function assertNoLeakedSecrets(standaloneDir) {
	if (!fs.existsSync(standaloneDir)) return;
	if (fs.existsSync(path.join(standaloneDir, "data"))) {
		fail("[build-server] REFUSING: standalone contains a data/ directory — repo session data would ship in the app.");
	}
	const subscriptionSecrets = fs
		.readdirSync(standaloneDir)
		.filter((name) => /^(chatgpt|github-copilot|xai)-credentials\.json/.test(name));
	for (const secret of ["auth.json", ...subscriptionSecrets, ".env", ".env.local"]) {
		if (fs.existsSync(path.join(standaloneDir, secret))) {
			fail(`[build-server] REFUSING: standalone contains ${secret} — dev secrets would ship in the app.`);
		}
	}
}

function findInstalledPackage(pkgName, startDir, rootDir) {
	let current = path.resolve(startDir);
	const boundary = path.resolve(rootDir);
	for (;;) {
		const candidate = path.join(current, "node_modules", ...pkgName.split("/"));
		if (fs.existsSync(path.join(candidate, "package.json"))) {
			return fs.realpathSync(candidate);
		}
		if (current === boundary) return null;
		const parent = path.dirname(current);
		if (parent === current) return null;
		current = parent;
	}
}

function collectRuntimePackageDirs(rootDir) {
	const realRoot = fs.realpathSync(rootDir);
	const nodeModulesPrefix = path.join(realRoot, "node_modules") + path.sep;
	const visited = new Set();
	const queue = SERVER_RUNTIME_PACKAGES.map((name) => ({ name, from: realRoot }));
	while (queue.length > 0) {
		const { name, from } = queue.shift();
		if (BUILD_ONLY_PACKAGES.has(name)) continue;
		const found = findInstalledPackage(name, from, realRoot);
		if (!found || !found.startsWith(nodeModulesPrefix) || visited.has(found)) continue;
		visited.add(found);
		const pkg = JSON.parse(fs.readFileSync(path.join(found, "package.json"), "utf8"));
		const childDeps = [
			...Object.keys(pkg.dependencies ?? {}),
			...Object.keys(pkg.optionalDependencies ?? {}),
			...Object.keys(pkg.peerDependencies ?? {}),
		];
		for (const dep of childDeps) queue.push({ name: dep, from: found });
	}
	return { realRoot, dirs: visited };
}

function copyDirectoryWithoutNestedModules(srcDir, destDir) {
	fs.mkdirSync(destDir, { recursive: true });
	for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
		if (entry.name === "node_modules") continue;
		const srcPath = path.join(srcDir, entry.name);
		const destPath = path.join(destDir, entry.name);
		if (entry.isDirectory()) copyDirectoryWithoutNestedModules(srcPath, destPath);
		else if (entry.isFile() || entry.isSymbolicLink()) fs.cpSync(srcPath, destPath, { dereference: true });
	}
}

function copyRuntimeNodeModules(rootDir, standaloneDir) {
	const { realRoot, dirs } = collectRuntimePackageDirs(rootDir);
	for (const pkgDir of dirs) {
		const rel = path.relative(realRoot, pkgDir);
		copyDirectoryWithoutNestedModules(pkgDir, path.join(standaloneDir, rel));
	}
}

function copyFilteredClientSrc(fromDir, toDir) {
	if (!fs.existsSync(fromDir)) return;
	for (const entry of fs.readdirSync(fromDir, { withFileTypes: true })) {
		const srcPath = path.join(fromDir, entry.name);
		const destPath = path.join(toDir, entry.name);
		if (entry.isDirectory()) {
			copyFilteredClientSrc(srcPath, destPath);
		} else if (entry.isFile()) {
			const lower = entry.name.toLowerCase();
			if (lower.endsWith(".ts") || lower.endsWith(".tsx")) continue;
			if (!ALLOWED_CLIENT_SRC_EXTS.has(path.extname(lower))) continue;
			fs.mkdirSync(path.dirname(destPath), { recursive: true });
			fs.copyFileSync(srcPath, destPath);
		}
	}
}

function copyAllowlistedVendors(rootDir, standaloneDir) {
	for (const vendor of ["cloudcanvas", "cloudcanvas-lib"]) {
		const srcVendor = path.join(rootDir, "extern", vendor);
		const pkgFile = path.join(srcVendor, "package.json");
		if (!fs.existsSync(pkgFile)) continue;
		const destVendor = path.join(standaloneDir, "extern", vendor);
		fs.mkdirSync(destVendor, { recursive: true });
		fs.copyFileSync(pkgFile, path.join(destVendor, "package.json"));
		const pkg = JSON.parse(fs.readFileSync(pkgFile, "utf8"));
		for (const rawEntry of Array.isArray(pkg.files) ? pkg.files : []) {
			if (typeof rawEntry !== "string") continue;
			const clean = rawEntry.trim().replace(/^(?:\.\/)+/, "").replace(/\/+$/, "");
			if (!clean || clean.includes("..") || clean.includes("*")) continue;
			const srcItem = path.join(srcVendor, clean);
			if (fs.existsSync(srcItem)) {
				fs.cpSync(srcItem, path.join(destVendor, clean), { recursive: true, dereference: true });
			}
		}
	}
}

function stageNativeAddon(standaloneDir) {
	const addonSrc = process.env.PEER_LUMBERJACK_ADDON_PATH?.trim() || DEFAULT_ADDON_PATH;
	if (!fs.existsSync(addonSrc)) {
		fail(`[build-server] REFUSING: LumberJack native addon missing at ${addonSrc}. Run npm run lumberjack:addon first.`);
	}
	if (process.platform === "linux") {
		const ldd = spawnSync("ldd", [addonSrc], { encoding: "utf8" });
		if (ldd.status === 0 && FORBIDDEN_GPU_LIB_RE.test(ldd.stdout)) {
			fail(`[build-server] REFUSING: ${addonSrc} links forbidden CUDA/ROCm libraries:\n${ldd.stdout}`);
		}
	}
	const dest = path.join(standaloneDir, "native", "lumberjack_peer.node");
	fs.mkdirSync(path.dirname(dest), { recursive: true });
	fs.copyFileSync(addonSrc, dest);
}

async function bundleApplicationServer() {
	const clientBundle = path.join(ROOT, "public", "client", "build", "state.js");
	if (!fs.existsSync(clientBundle)) {
		fail("[build-server] public/client/build/state.js missing — run `npm run client:build` first.");
	}
	const esbuild = await import("esbuild");
	fs.mkdirSync(STANDALONE, { recursive: true });
	await esbuild.build({
		absWorkingDir: ROOT,
		entryPoints: [path.join(ROOT, "src", "api", "main.ts")],
		outfile: path.join(STANDALONE, "server.js"),
		bundle: true,
		platform: "node",
		format: "esm",
		target: "node24",
		sourcemap: false,
		external: SERVER_EXTERNALS,
		banner: {
			js: 'import { createRequire as __peerCreateRequire } from "node:module"; const require = __peerCreateRequire(import.meta.url);',
		},
	});
	fs.writeFileSync(
		path.join(STANDALONE, "package.json"),
		`${JSON.stringify({ name: "peer-server-payload", private: true, type: "module" }, null, "\t")}\n`,
	);
	fs.writeFileSync(path.join(STANDALONE, "server.mjs"), 'import "./server.js";\n');
	fs.writeFileSync(
		path.join(PAYLOAD, "server.mjs"),
		'import { runCli } from "./standalone/server.js";\nrunCli().catch((err) => { process.stderr.write(`${err?.message ?? err}\\n`); process.exit(1); });\n',
	);
	copyRuntimeNodeModules(ROOT, STANDALONE);
	stageNativeAddon(STANDALONE);
	copyFilteredClientSrc(path.join(ROOT, "src", "client"), path.join(STANDALONE, "src", "client"));
	copyAllowlistedVendors(ROOT, STANDALONE);
	for (const rel of [
		"core-plugins.json",
		path.join("src", "agent", "system-prompt.md"),
		path.join("src", "agent", "prompts"),
		path.join("src", "agent", "image-processing"),
	]) {
		const srcPath = path.join(ROOT, rel);
		if (fs.existsSync(srcPath)) fs.cpSync(srcPath, path.join(STANDALONE, rel), { recursive: true });
	}
}

async function main() {
	assertNoLeakedSecrets(STANDALONE);
	if (fs.existsSync(path.join(ROOT, "src", "api", "main.ts"))) {
		await bundleApplicationServer();
	} else if (!fs.existsSync(path.join(STANDALONE, "server.js"))) {
		fail("[build-server] dist/server-payload/standalone/server.js missing — run `npm run build` first.");
	}
	if (fs.existsSync(path.join(ROOT, "public"))) {
		fs.cpSync(path.join(ROOT, "public"), path.join(STANDALONE, "public"), { recursive: true });
	}
	assertNoLeakedSecrets(STANDALONE);
	fs.cpSync(path.join(ROOT, "scripts", "plugin-loader.cjs"), path.join(STANDALONE, "scripts", "plugin-loader.cjs"), { recursive: true });
	try {
		const core = path.join(ROOT, "core-plugins");
		const packagedCore = path.join(STANDALONE, "core-plugins");
		validateCorePackages(ROOT, core);
		fs.rmSync(packagedCore, { recursive: true, force: true });
		fs.cpSync(core, packagedCore, { recursive: true });
		validateCorePackages(ROOT, packagedCore);
	} catch (error) {
		fail("[build-server] REFUSING: Core plugin payload is missing or unsafe. Run npm run plugins:build-core.", error);
	}
	buildPluginAuthoring({ root: ROOT, standalone: true });
	for (const extra of ["plugins", "dist", path.join("node_modules", "electron")]) {
		const target = path.join(STANDALONE, extra);
		if (fs.existsSync(target)) {
			fs.rmSync(target, { recursive: true, force: true });
			console.log(`[build-server] removed build-only payload: ${extra}`);
		}
	}
	for (const asset of [
		path.join("scripts", "plugin-loader.cjs"),
		path.join("public", "plugin-loader.js"),
		path.join("src", "agent", "system-prompt.md"),
		path.join("src", "agent", "prompts", "teacher", "20-teaching.md"),
		path.join("src", "agent", "prompts", "side-chat", "00-base.md"),
		path.join("src", "agent", "prompts", "side-chat", "90-style.md"),
	]) {
		if (!fs.existsSync(path.join(STANDALONE, asset))) {
			fail(`[build-server] prompt asset missing from the trace: ${asset}`);
		}
	}
	console.log("[build-server] server payload ready:", STANDALONE);
}

await main();
