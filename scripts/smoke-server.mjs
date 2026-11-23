/**
 * smoke-server.mjs — boot the packaged standalone server and prove it serves
 * CloudCanvas, LumberJack persistence, core plugins, and external plugins.
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import { createRequire } from "node:module";
import * as net from "node:net";
import * as path from "node:path";
import { verifyCorePlugins } from "./smoke-core-plugins.mjs";
import { probeEnv, resolveSmokeScratchBase, resolveStandaloneRoot, verifyDemoRuntime } from "./smoke-demo-runtime.mjs";
import { verifyImageRuntime } from "./smoke-image-runtime.mjs";
import { createPluginSmokeFixture, verifyPluginServer } from "./smoke-plugin-runtime.mjs";
import { verifyProviderRuntime } from "./smoke-provider-runtime.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const standaloneArgIdx = process.argv.indexOf("--standalone");
const SOURCE_STANDALONE = resolveStandaloneRoot(
	standaloneArgIdx >= 0 && process.argv[standaloneArgIdx + 1]
		? process.argv[standaloneArgIdx + 1]
		: path.join(ROOT, "dist", "server-payload", "standalone"),
);
const ISOLATED_MODE = process.argv.includes("--isolated");
let isolatedRoot;
const ELECTRON_MODE = process.argv.includes("--electron");
const RUNTIME = ELECTRON_MODE ? createRequire(import.meta.url)("electron") : process.execPath;

const POLL_MS = 500;
const BOOT_TIMEOUT_MS = 30_000;
const PROBES = ["/api/graph", "/api/models", "/api/settings", "/api/plugins"];

if (!fs.existsSync(path.join(SOURCE_STANDALONE, "server.js"))) {
	console.error("[smoke-server] dist/server-payload/standalone/server.js missing — run npm run build first.");
	process.exit(1);
}

function freePort() {
	return new Promise((resolve, reject) => {
		const srv = net.createServer();
		srv.listen(0, "127.0.0.1", () => {
			const { port } = srv.address();
			srv.close(() => resolve(port));
		});
		srv.on("error", reject);
	});
}

function get(url) {
	return new Promise((resolve) => {
		const req = http.get(url, (res) => {
			res.resume();
			resolve(res.statusCode ?? 0);
		});
		req.on("error", () => resolve(0));
		req.setTimeout(5000, () => {
			req.destroy();
			resolve(0);
		});
	});
}

function createImportGuardFile(home, standalone) {
	const guard = path.join(home, "payload-import-guard.mjs");
	const allowedRoots = [standalone, path.join(home, "data", "plugins")];
	fs.writeFileSync(
		guard,
		`import {registerHooks} from 'node:module'; import {realpathSync} from 'node:fs'; import path from 'node:path'; import {fileURLToPath} from 'node:url';
const roots = ${JSON.stringify(allowedRoots)}.map(p=>realpathSync(p));
registerHooks({resolve(specifier,context,next){ const result=next(specifier,context); if(result.url.startsWith('file:')) { const file=realpathSync(fileURLToPath(result.url)); if(!roots.some(root=>file===root || file.startsWith(root+path.sep))) throw new Error('Import escaped standalone/plugin payload: '+file); } return result; }});`,
	);
	return guard;
}

function createLogTail() {
	const tail = [];
	let tailBytes = 0;
	return {
		keep(buf) {
			for (const line of buf.toString().split("\n")) {
				tail.push(line);
				tailBytes += line.length + 1;
			}
			while (tailBytes > 16_000 && tail.length > 2) {
				tailBytes -= tail[0].length + 1;
				tail.shift();
			}
		},
		dump() {
			console.error("--- server log tail " + "-".repeat(20));
			for (const line of tail.slice(-40)) if (line.trim()) console.error(`    ${line}`);
		},
	};
}

async function main() {
	const scratchBase = resolveSmokeScratchBase();
	if (ISOLATED_MODE) {
		isolatedRoot = fs.mkdtempSync(path.join(scratchBase, "peer-isolated-server-"));
		fs.cpSync(SOURCE_STANDALONE, path.join(isolatedRoot, "standalone"), { recursive: true, verbatimSymlinks: true });
	}
	const standalone = isolatedRoot ? path.join(isolatedRoot, "standalone") : SOURCE_STANDALONE;
	const server = path.join(standalone, "server.js");
	verifyDemoRuntime(standalone, RUNTIME);
	verifyImageRuntime(standalone, RUNTIME);
	verifyProviderRuntime(standalone, RUNTIME);
	const port = await freePort();
	const url = `http://127.0.0.1:${port}`;
	const home = fs.mkdtempSync(path.join(scratchBase, "peer-smoke-"));
	const dataDir = path.join(home, "data");
	const authFile = path.join(home, "auth.json");
	fs.writeFileSync(authFile, "{}\n", "utf-8");
	createPluginSmokeFixture(home);
	const imports = ISOLATED_MODE ? ["--import", createImportGuardFile(home, standalone)] : [];
	const logTail = createLogTail();

	console.log(`[smoke-server] runtime: ${ELECTRON_MODE ? "Electron bundled Node" : "host Node"}`);
	const child = spawn(RUNTIME, [...imports, server], {
		cwd: standalone,
		env: {
			...probeEnv(process.env, home),
			...(ELECTRON_MODE ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
			NODE_ENV: "production",
			PORT: String(port),
			HOSTNAME: "127.0.0.1",
			PEER_STATE_ROOT: home,
			PEER_FOREST_DIR: path.join(home, "lumberjack"),
			LH_DATA_DIR: dataDir,
			LH_AUTH_FILE: authFile,
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	let exited = false;
	child.stdout.on("data", logTail.keep);
	child.stderr.on("data", logTail.keep);
	child.on("exit", () => {
		exited = true;
	});

	const kill = () =>
		new Promise((resolve) => {
			if (exited) return resolve();
			const done = () => resolve();
			child.once("exit", done);
			child.kill("SIGTERM");
			setTimeout(() => {
				if (!exited) {
					try {
						child.kill("SIGKILL");
					} catch {
						/* already gone */
					}
				}
				done();
			}, 3000);
		});

	let failed = null;
	try {
		let boot = 0;
		const deadline = Date.now() + BOOT_TIMEOUT_MS;
		while (Date.now() < deadline) {
			if (exited) throw new Error(`server exited before answering on ${url}`);
			boot = await get(url);
			if (boot === 200) break;
			await new Promise((r) => setTimeout(r, POLL_MS));
		}
		if (boot !== 200) throw new Error(`server never answered 200 on ${url} (last status: ${boot})`);
		console.log(`[smoke-server] boot ok: GET / → 200 (${url})`);

		for (const route of PROBES) {
			const status = await get(url + route);
			if (status !== 200) throw new Error(`GET ${route} → ${status} (expected 200)`);
			console.log(`[smoke-server] GET ${route} → 200`);
		}
		await verifyCorePlugins({ root: ROOT, standalone, dataDirectory: dataDir, url });
		await verifyPluginServer(url, home);
	} catch (err) {
		failed = err;
	} finally {
		await kill();
		fs.rmSync(home, { recursive: true, force: true });
	}

	if (failed) {
		console.error(`[smoke-server] FAIL: ${failed.message}`);
		logTail.dump();
		throw failed;
	}
	console.log(`[smoke-server] smoke passed — the packaged server boots and serves${ISOLATED_MODE ? " outside the source checkout" : ""}.`);
}

main()
	.catch((err) => {
		console.error(`[smoke-server] FAIL: ${err.message}`);
		process.exitCode = 1;
	})
	.finally(() => {
		if (isolatedRoot) fs.rmSync(isolatedRoot, { recursive: true, force: true });
	});
