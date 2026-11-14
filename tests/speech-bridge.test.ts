/**
 * The TWM speech bridge's request handling, run against a stub TWM root (no
 * real speech models): who may call it, what media types it takes, that a
 * stalled or slow request does not block others, that failures do not leak
 * their detail, and that a request's language does not stick.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import { request as httpRequest } from "node:http";
import { connect, createServer, type AddressInfo, type Socket } from "node:net";
import path from "node:path";
import { after, before, test } from "node:test";

const BRIDGE = path.resolve(import.meta.dirname, "../tools/twm-speech-bridge/bridge.py");
const PYTHON = spawnSync("python3", ["--version"]).status === 0;
const skip = PYTHON ? false : "python3 is not available";

const STUBS: Record<string, string> = {
	"shell/__init__.py": "",
	"shell/inputs/__init__.py": "",
	"shell/inputs/voice.py": [
		"import os, time",
		"def generate(text, choice, destination, progress, cancel):",
		"    if text == 'slow': time.sleep(1.5)",
		"    if text == 'explode': raise FileNotFoundError('/home/someone/.cache/model.pt')",
		"    destination.write_bytes(b'RIFF' + text.encode())",
		"def transcribe(source):",
		"    return os.environ.get('TWM_SPEECH_LANGUAGE', 'auto')",
	].join("\n"),
	"shell/inputs/voices.py": "def catalog():\n    return {'voices': [{'provider': 'piper', 'voice': 'a', 'name': 'A', 'available': True}]}\n",
	"shell/inputs/voice_choices.py": "def validate(choice):\n    return choice\n",
	"shell/inputs/isolated_runtime.py": "def synthesize(*args):\n    raise RuntimeError('not used')\n",
	"shell/inputs/local_speech.py": "_model = None\n",
};

let root = "";
let port = 0;
let bridge: ChildProcess | undefined;
let stderr = "";
const stalled: Socket[] = [];

async function sparePort(): Promise<number> {
	const server = createServer();
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port: free } = server.address() as AddressInfo;
	await new Promise((resolve) => server.close(resolve));
	return free;
}

type Reply = { status: number; type: string; text: string; ms: number };

function call(pathname: string, options: { method?: string; headers?: Record<string, string>; body?: Buffer } = {}): Promise<Reply> {
	const started = Date.now();
	const headers = { Host: `127.0.0.1:${port}`, ...options.headers, ...(options.body ? { "Content-Length": String(options.body.length) } : {}) };
	return new Promise((resolve, reject) => {
		const outgoing = httpRequest({ host: "127.0.0.1", port, path: pathname, method: options.method ?? "GET", headers }, (incoming) => {
			const chunks: Buffer[] = [];
			incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
			incoming.on("end", () => resolve({ status: incoming.statusCode ?? 0, type: incoming.headers["content-type"] ?? "", text: Buffer.concat(chunks).toString(), ms: Date.now() - started }));
		});
		outgoing.on("error", reject);
		outgoing.end(options.body);
	});
}

const json = (value: unknown) => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: Buffer.from(JSON.stringify(value)) });

/** 0.1 s of silent 16 kHz mono PCM16 WAV in a multipart form, as LearnHarness sends it. */
async function transcription(language?: string) {
	const pcm = 3200;
	const wav = Buffer.alloc(44 + pcm);
	wav.write("RIFF", 0); wav.writeUInt32LE(36 + pcm, 4); wav.write("WAVEfmt ", 8);
	wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
	wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
	wav.write("data", 36); wav.writeUInt32LE(pcm, 40);
	const form = new FormData();
	form.set("model", "tiny");
	if (language) form.set("language", language);
	form.set("file", new Blob([wav], { type: "audio/wav" }), "speech.wav");
	const encoded = new Response(form);
	return { method: "POST", headers: { "Content-Type": encoded.headers.get("content-type")! }, body: Buffer.from(await encoded.arrayBuffer()) };
}

before(async () => {
	if (!PYTHON) return;
	fs.mkdirSync("/tmp/peer", { recursive: true });
	root = fs.mkdtempSync("/tmp/peer/speech-bridge-");
	for (const [file, source] of Object.entries(STUBS)) {
		fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
		fs.writeFileSync(path.join(root, file), source);
	}
	port = await sparePort();
	const env: NodeJS.ProcessEnv = { ...process.env, TWM_WHISPER_CACHE: path.join(root, "cache"), PYTHONDONTWRITEBYTECODE: "1" };
	delete env.TWM_SPEECH_LANGUAGE;
	bridge = spawn("python3", [BRIDGE, "--twm", root, "--port", String(port)], { env, stdio: ["ignore", "ignore", "pipe"] });
	bridge.stderr!.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
	for (let attempt = 0; attempt < 100; attempt++) {
		if (await call("/health").then((reply) => reply.status === 200, () => false)) return;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error(`the bridge did not start: ${stderr}`);
});

after(() => {
	for (const socket of stalled) socket.destroy();
	if (bridge?.pid) process.kill(bridge.pid);
	if (root) fs.rmSync(root, { recursive: true, force: true });
});

test("health reports no device it did not check", { skip }, async () => {
	assert.deepEqual(JSON.parse((await call("/health")).text), { status: "ok" });
});

test("web pages and other host names are refused; local callers are not", { skip }, async () => {
	assert.equal((await call("/health", { headers: { Origin: "http://evil.example" } })).status, 403);
	assert.equal((await call("/health", { headers: { "Sec-Fetch-Site": "cross-site" } })).status, 403);
	assert.equal((await call("/v1/audio/voices", { headers: { Host: `evil.example:${port}` } })).status, 403);
	assert.equal((await call("/v1/audio/voices", { headers: { Host: "127.0.0.1:1" } })).status, 403);
	const fromPage = { ...json({ input: "hi" }), headers: { "Content-Type": "application/json", Origin: "http://evil.example" } };
	assert.equal((await call("/v1/audio/speech", fromPage)).status, 403);
	assert.equal((await call("/health", { headers: { Host: `localhost:${port}` } })).status, 200);
});

test("each route takes only its own media type", { skip }, async () => {
	const plain = { ...json({ input: "hi" }), headers: { "Content-Type": "text/plain" } };
	assert.equal((await call("/v1/audio/speech", plain)).status, 415);
	assert.equal((await call("/v1/audio/transcriptions", json({}))).status, 415);
	const spoken = await call("/v1/audio/speech", json({ input: "hi" }));
	assert.deepEqual([spoken.status, spoken.type, spoken.text], [200, "audio/wav", "RIFFhi"]);
});

test("a stalled body holds no lock, and the voice list does not wait for a job", { skip, timeout: 15_000 }, async () => {
	const socket = connect(port, "127.0.0.1");
	stalled.push(socket);
	await new Promise((resolve) => socket.once("connect", resolve));
	socket.write(`POST /v1/audio/speech HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Type: application/json\r\nContent-Length: 1000\r\n\r\n`);
	await new Promise((resolve) => setTimeout(resolve, 200));
	assert.equal((await call("/v1/audio/speech", json({ input: "after" }))).status, 200);
	const slow = call("/v1/audio/speech", json({ input: "slow" }));
	await new Promise((resolve) => setTimeout(resolve, 300));
	const voices = await call("/v1/audio/voices");
	assert.equal(voices.status, 200);
	assert.ok(voices.ms < 1000, `voices took ${voices.ms} ms`);
	assert.equal((await slow).status, 200);
});

test("an engine failure answers generically and logs its detail locally", { skip }, async () => {
	const failed = await call("/v1/audio/speech", json({ input: "explode" }));
	assert.equal(failed.status, 500);
	assert.doesNotMatch(failed.text, /someone|FileNotFoundError/);
	assert.match(stderr, /FileNotFoundError: \/home\/someone\/\.cache\/model\.pt/);
});

test("a request's language does not carry over to the next request", { skip }, async () => {
	assert.deepEqual(JSON.parse((await call("/v1/audio/transcriptions", await transcription("es"))).text), { text: "es" });
	assert.deepEqual(JSON.parse((await call("/v1/audio/transcriptions", await transcription())).text), { text: "auto" });
});
