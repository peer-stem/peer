/** Offline synthetic CloudCanvas UI + actual Electron preload file-path smoke.
 * Run: node scripts/smoke-file-paths.mjs [--desktop-only]
 * App/profile/auth/OS-backed fixture files are temporary under scratch; only
 * this script's processes are stopped. Browser requests outside the owned
 * loopback origin are blocked; agent POSTs are intercepted and refused offline.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import net from "node:net";
import { createRequire } from "node:module";
import path from "node:path";
import puppeteer from "puppeteer-core";
import { probeEnv, resolveSmokeScratchBase } from "./smoke-demo-runtime.mjs";

const root = path.resolve(import.meta.dirname, "..");
const tsxCli = path.join(root, "node_modules", "tsx", "dist", "cli.mjs");
const home = fs.mkdtempSync(path.join(resolveSmokeScratchBase(), "peer-file-paths-"));
const require = createRequire(import.meta.url);

const checks = [];
const errors = [];
const posts = [];
const blocked = [];
const networkFailures = [];
const consoleErrors = [];
const children = [];
const browsers = [];
let serverLogs = "";
let electronLogs = "";
let page;
let origin;
let shuttingDown = false;

const fixtureCatalog = (() => {
	const model = {
		id: "synthetic",
		name: "Synthetic (no calls)",
		provider: "fixture",
		input: ["text"],
		reasoning: false,
		supportedLevels: ["off"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 1024,
	};
	const slot = { model: { provider: model.provider, id: model.id }, thinkingLevel: "off" };
	return {
		models: [model],
		providers: [{ id: "fixture", label: "Fixture", keyPresent: true }],
		defaults: slot,
		slots: { strong: slot, cheap: slot, vision: slot },
		rolePins: {},
	};
})();

function resolveChromeBinary() {
	const candidates = [
		process.env.LH_TEST_CHROME,
		process.env.CHROME_PATH,
		"/opt/google/chrome/google-chrome",
		"/usr/bin/chromium",
		"/usr/bin/chromium-browser",
		"/usr/bin/google-chrome-stable",
		"/usr/bin/google-chrome",
		"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
	].filter(Boolean);
	for (const bin of candidates) {
		if (fs.existsSync(bin)) return bin;
	}
	return null;
}

async function freePort() {
	const listener = net.createServer();
	listener.listen(0, "127.0.0.1");
	await once(listener, "listening");
	const { port } = listener.address();
	await new Promise((resolve) => listener.close(resolve));
	return port;
}

async function stop(child) {
	if (!child || child.exitCode !== null || child.signalCode !== null) return;
	const exited = once(child, "exit");
	child.kill("SIGTERM");
	const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
	timer.unref();
	await exited;
	clearTimeout(timer);
}

async function startup(child, getLogs, marker, timeoutMs = 60000) {
	await new Promise((resolve, reject) => {
		const timer = setTimeout(() => finish(new Error(`Startup timed out: ${getLogs()}`)), timeoutMs);
		const inspect = () => { if (marker.test(getLogs())) finish(); };
		const exited = (code) => finish(new Error(`Process exited ${code}: ${getLogs()}`));
		function finish(error) {
			clearTimeout(timer);
			child.stdout.off("data", inspect);
			child.stderr.off("data", inspect);
			child.off("exit", exited);
			if (error) reject(error);
			else resolve();
		}
		child.stdout.on("data", inspect);
		child.stderr.on("data", inspect);
		child.once("exit", exited);
		inspect();
	});
}

async function instrument(target) {
	target.setDefaultTimeout(20000);
	target.on("pageerror", (error) => { if (!shuttingDown) errors.push(error.message); });
	target.on("requestfailed", (request) => {
		if (!shuttingDown) networkFailures.push({ url: request.url(), error: request.failure()?.errorText });
	});
	target.on("console", (message) => {
		if (message.type() === "error") consoleErrors.push(message.text());
	});
	await target.setRequestInterception(true);
	target.on("request", async (request) => {
		try {
			const url = new URL(request.url());
			if (url.protocol === "data:" || url.protocol === "about:") return await request.continue();
			if (url.origin !== origin) {
				blocked.push(request.url());
				return await request.abort();
			}
			const respond = (body, status = 200) => request.respond({
				status,
				contentType: "application/json",
				body: JSON.stringify(body),
			});
			if (url.pathname === "/api/models") return await respond(fixtureCatalog);
			if (url.pathname === "/api/events") return await request.respond({ status: 204 });
			if (request.method() === "POST" && (/^\/api\/(chat|answer)(\/|$)/.test(url.pathname) || /\/(answer|import|turn|retry)(\/|$)/.test(url.pathname))) {
				posts.push({ pathname: url.pathname, body: JSON.parse(request.postData() || "{}") });
				return await respond({ code: "models_not_configured", missing: ["strong"] }, 503);
			}
			if (/^\/api\/chats\/[^/]+\/stream$/.test(url.pathname)) return await request.respond({ status: 204 });
			return await request.continue();
		} catch (error) {
			if (!shuttingDown && !/Target closed|Session closed|Invalid InterceptionId|already handled/.test(String(error))) {
				errors.push(String(error));
			}
		}
	});
}

function seedLegacyChatFixture(dataDir) {
	const chatsDir = path.join(dataDir, "chats");
	fs.mkdirSync(chatsDir, { recursive: true });
	const slot = { model: { provider: "anthropic", id: "claude-sonnet-4-5" }, thinkingLevel: "off" };
	fs.writeFileSync(
		path.join(dataDir, "settings.json"),
		JSON.stringify({ version: 1, models: { strong: slot, cheap: slot, vision: slot } }),
	);
	const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
	const record = {
		id: "path_session",
		version: 1,
		title: "Synthetic path session",
		createdAt: "2026-10-28T00:00:00.000Z",
		updatedAt: "2026-10-28T00:00:00.000Z",
		messages: [
			{ id: "u_1", role: "user", content: "Attached `/synthetic/transcript notes.pdf`", timestamp: 1 },
			{
				id: "a_1",
				role: "assistant",
				api: "anthropic-messages",
				provider: "anthropic",
				model: "synthetic",
				timestamp: 2,
				stopReason: "stop",
				usage,
				content: [{ type: "text", text: "Ready to examine the attached notes." }],
			},
		],
	};
	fs.writeFileSync(path.join(chatsDir, "path_session.json"), JSON.stringify(record));
}

async function setTextareaValue(target, selector, nextValue) {
	await target.$eval(selector, (el, val) => {
		el.focus();
		el.value = val;
		el.dispatchEvent(new Event("input", { bubbles: true }));
	}, nextValue);
}

try {
	const dataDir = path.join(home, "data");
	const forestDir = path.join(home, "lumberjack");
	const authFile = path.join(home, "auth.json");
	fs.mkdirSync(dataDir, { recursive: true });
	fs.writeFileSync(authFile, "{}\n", { mode: 0o600 });
	seedLegacyChatFixture(dataDir);

	const port = await freePort();
	origin = `http://127.0.0.1:${port}`;
	const env = {
		...probeEnv(process.env, home),
		NODE_ENV: "development",
		HOSTNAME: "127.0.0.1",
		PORT: String(port),
		PEER_STATE_ROOT: home,
		PEER_FOREST_DIR: forestDir,
		LH_DATA_DIR: dataDir,
		LH_AUTH_FILE: authFile,
	};
	const server = spawn(process.execPath, [tsxCli, path.join(root, "src", "api", "main.ts")], {
		cwd: root,
		env,
		stdio: ["ignore", "pipe", "pipe"],
	});
	children.push(server);
	const captureServer = (data) => { serverLogs = (serverLogs + data).slice(-28000); };
	server.stdout.on("data", captureServer);
	server.stderr.on("data", captureServer);
	await startup(server, () => serverLogs, /Engine API server listening/);

	if (!process.argv.includes("--desktop-only")) {
		const chromeBin = resolveChromeBinary();
		assert.ok(chromeBin, "Chrome/Chromium binary required unless --desktop-only is passed.");
		const chrome = await puppeteer.launch({
			executablePath: chromeBin,
			headless: true,
			userDataDir: path.join(home, "chrome-profile"),
			env,
			args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-background-networking", "--disable-sync", "--no-first-run", "--disable-default-apps"],
		});
		browsers.push(chrome);
		page = await chrome.newPage();
		await page.setViewport({ width: 1280, height: 900 });
		await instrument(page);

		// 1. /chat/new in plain browser mode: no native desktop folder/file buttons,
		//    drops are prevented without staging non-OS paths, chips parse & remove cleanly.
		await page.goto(`${origin}/chat/new`, { waitUntil: "domcontentloaded", timeout: 60000 });
		await page.waitForSelector("[data-peer-draft-input]");
		await page.waitForFunction(() => {
			const el = document.querySelector("[data-peer-draft-input]");
			return el && !el.disabled;
		});
		assert.equal(await page.$("[data-peer-action='pick-directory']"), null, "Web mode hides Electron Folder button");
		assert.equal(await page.$("[data-peer-action='pick-files']"), null, "Web mode hides Electron Files button");

		const dropPrevented = await page.$eval(".peer-new-session-card", (card) => {
			const transfer = new DataTransfer();
			transfer.items.add(new File(["not uploaded"], "notes.pdf", { type: "application/pdf" }));
			const event = new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer });
			card.dispatchEvent(event);
			return event.defaultPrevented;
		});
		assert.equal(dropPrevented, true, "Browser drop onto composer card prevents file navigation");
		assert.equal(await page.$eval("[data-peer-draft-input]", (el) => el.value), "");

		const spacedToken = "`/synthetic/course notes.pdf`";
		await setTextareaValue(page, "[data-peer-draft-input]", `Explain @notes/svd.tex and ${spacedToken}`);
		await page.waitForSelector("[data-peer-path-chip='notes/svd.tex']");
		await page.waitForSelector("[data-peer-path-chip='/synthetic/course notes.pdf']");
		checks.push("/chat/new parses both @path and backtick-quoted path chips in browser mode");

		// Remove the @notes/svd.tex chip and verify Shift+Enter vs Enter
		await page.$eval("[data-peer-path-chip='notes/svd.tex'] button", (btn) => btn.click());
		assert.equal(await page.$eval("[data-peer-draft-input]", (el) => el.value), `Explain and ${spacedToken}`);
		await page.focus("[data-peer-draft-input]");
		await page.keyboard.down("Shift");
		await page.keyboard.press("Enter");
		await page.keyboard.up("Shift");
		await page.keyboard.type("second line");
		assert.equal(posts.length, 0, "Shift+Enter inserts newline without submitting");

		await page.keyboard.press("Enter");
		await page.waitForFunction(() => /^\/chat\/chat_/.test(location.pathname));
		await new Promise((resolve, reject) => {
			const deadline = Date.now() + 15000;
			const poll = () => {
				if (posts.length > 0) resolve();
				else if (Date.now() > deadline) reject(new Error("Enter did not dispatch /api/chat"));
				else setTimeout(poll, 50);
			};
			poll();
		});
		assert.equal(posts.length, 1);
		assert.match(posts[0].body.input.text, /`\/synthetic\/course notes\.pdf`\nsecond line/);
		checks.push("/chat/new chip removal, Shift+Enter newline, and Enter full-source submission verified");

		// 2. Seeded session (/chat/path_session) interactive composer
		await page.goto(`${origin}/chat/path_session`, { waitUntil: "domcontentloaded", timeout: 60000 });
		await page.waitForSelector("[data-peer-composer-input]");
		await page.waitForFunction(() => {
			const el = document.querySelector("[data-peer-composer-input]");
			return el && !el.disabled;
		});
		await setTextareaValue(page, "[data-peer-composer-input]", "Compare ``/synthetic/notes `v2`.pdf``");
		await page.waitForSelector('[data-peer-path-chip="/synthetic/notes `v2`.pdf"]');
		checks.push("/chat/:id session composer renders multi-backtick path chips");
	}

	// 3. Actual Electron main + actual sandboxed preload (contextIsolation + sandbox on).
	const debugPort = await freePort();
	const launcher = path.join(home, "electron-launcher.cjs");
	fs.mkdirSync(path.join(home, "desktop-profile"), { recursive: true });
	fs.mkdirSync(path.join(home, "desktop-profile-dev"), { recursive: true });
	fs.writeFileSync(
		launcher,
		`const {app,session}=require('electron');\n`
		+ `app.setPath('home',${JSON.stringify(home)});\n`
		+ `app.setPath('userData',${JSON.stringify(path.join(home, "desktop-profile"))});\n`
		+ `app.commandLine.appendSwitch('ozone-platform','headless');\n`
		+ `app.commandLine.appendSwitch('remote-debugging-port',${JSON.stringify(String(debugPort))});\n`
		+ `app.commandLine.appendSwitch('disable-background-networking');\n`
		+ `app.commandLine.appendSwitch('disable-sync');\n`
		+ `app.whenReady().then(()=>session.defaultSession.webRequest.onBeforeRequest((details,cb)=>{`
		+ `let u;try{u=new URL(details.url)}catch{return cb({cancel:true})}`
		+ `cb({cancel:!(${JSON.stringify(origin)}===u.origin||(u.protocol==='ws:'&&u.host===${JSON.stringify(new URL(origin).host)})||['about:','data:','devtools:'].includes(u.protocol))});`
		+ `}));\n`
		+ `require(${JSON.stringify(path.join(root, "electron", "main.cjs"))});\n`
		+ `console.log('PEER_FILE_PATH_PROFILE '+JSON.stringify({home:app.getPath('home'),userData:app.getPath('userData')}));\n`,
	);
	const electron = spawn(require("electron"), [launcher], {
		cwd: root,
		env: { ...env, PEER_DEV_URL: origin, LH_DEV_URL: origin },
		stdio: ["ignore", "pipe", "pipe"],
	});
	children.push(electron);
	const captureElectron = (data) => { electronLogs = (electronLogs + data).slice(-24000); };
	electron.stdout.on("data", captureElectron);
	electron.stderr.on("data", captureElectron);
	await startup(electron, () => electronLogs, /DevTools listening on (ws:\/\/[^\s]+)/, 45000);

	const profile = JSON.parse(electronLogs.match(/PEER_FILE_PATH_PROFILE ([^\r\n]+)/)[1]);
	assert.equal(profile.home, home);
	assert.equal(profile.userData, path.join(home, "desktop-profile-dev"));

	const endpoint = electronLogs.match(/DevTools listening on (ws:\/\/[^\s]+)/)[1];
	const desktop = await puppeteer.connect({ browserWSEndpoint: endpoint });
	browsers.push(desktop);
	const desktopPage = await desktop.waitForTarget((target) => target.type() === "page").then((target) => target.page());
	await instrument(desktopPage);
	page = desktopPage;

	await desktopPage.goto(`${origin}/chat/path_session`, { waitUntil: "domcontentloaded", timeout: 60000 });
	await desktopPage.waitForSelector("[data-peer-composer-input]");
	await desktopPage.waitForFunction(() => {
		const el = document.querySelector("[data-peer-composer-input]");
		return el && !el.disabled;
	});
	assert.equal(await desktopPage.evaluate(() => typeof window.lh?.getPathForFile), "function");
	assert.notEqual(await desktopPage.$("[data-peer-action='pick-directory']"), null, "Electron exposes Folder button");
	assert.notEqual(await desktopPage.$("[data-peer-action='pick-files']"), null, "Electron exposes Files button");

	const fixturePath = path.join(home, "actual OS-backed α `notes`.pdf");
	fs.writeFileSync(fixturePath, "%PDF-1.7\nsynthetic offline fixture\n");
	await desktopPage.evaluate(() => {
		const input = document.createElement("input");
		input.type = "file";
		input.id = "os-backed-fixture";
		document.body.append(input);
	});
	await (await desktopPage.$("#os-backed-fixture")).uploadFile(fixturePath);
	const resolved = await desktopPage.evaluate(() => {
		const input = document.querySelector("#os-backed-fixture");
		return {
			count: input.files.length,
			actual: window.lh.getPathForFile(input.files[0]),
			virtual: window.lh.getPathForFile(new File(["virtual"], "/not/a/backing/path.pdf")),
		};
	});
	assert.equal(resolved.count, 1);
	assert.equal(resolved.actual, fixturePath);
	assert.equal(resolved.virtual, "");

	await setTextareaValue(desktopPage, "[data-peer-composer-input]", "Read");
	const beforeDesktopDrop = posts.length;
	const dropped = await desktopPage.evaluate(() => {
		const file = document.querySelector("#os-backed-fixture").files[0];
		for (const method of ["text", "arrayBuffer", "stream"]) {
			Object.defineProperty(file, method, { value() { throw new Error("No file content read"); } });
		}
		const transfer = new DataTransfer();
		transfer.items.add(file);
		const event = new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer });
		document.querySelector("[data-peer-composer]").dispatchEvent(event);
		return event.defaultPrevented;
	});
	assert.equal(dropped, true);
	const expectedQuoted = `\`\`${fixturePath}\`\``;
	await desktopPage.waitForFunction(
		(expected) => document.querySelector("[data-peer-composer-input]")?.value.includes(expected),
		{},
		expectedQuoted,
	);
	assert.equal(
		await desktopPage.$eval("[data-peer-path-chips] [data-peer-path-chip]", (chip) => chip.getAttribute("title")),
		fixturePath,
	);
	assert.equal(posts.length, beforeDesktopDrop, "actual OS-backed desktop drop stages text only");
	assert.ok(fs.existsSync(fixturePath));
	checks.push("Actual Electron production preload: OS-backed File resolves exact Unicode/backtick full path and drop stages chip without file-byte reads or auto-submit");

	assert.deepEqual(errors, []);
	console.log(JSON.stringify({
		checks,
		postsIntercepted: posts.length,
		blockedExternalRequests: blocked,
		origin,
	}, null, 2));
} catch (error) {
	console.error(error);
	console.error(JSON.stringify({
		checks,
		errors,
		consoleErrors,
		networkFailures: networkFailures.slice(-30),
		posts,
		origin,
		url: page?.url(),
		serverLogs,
		electronLogs,
	}, null, 2));
	process.exitCode = 1;
} finally {
	shuttingDown = true;
	for (const browser of browsers.reverse()) {
		try { await browser.close(); } catch { /* ignore */ }
	}
	for (const child of children.reverse()) await stop(child);
	fs.rmSync(home, { recursive: true, force: true });
}
