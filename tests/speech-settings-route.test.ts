/**
 * The settings route refuses a speech write that carries no same-origin proof,
 * and leaves every other section's gate as it was.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

// Every app import follows isolation: a private data root, no keys, browser-only mode.
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lh-speech-route-"));
process.env.LH_DATA_DIR = directory;
process.env.LH_AUTH_FILE = path.join(directory, "auth.json");
process.env.LH_IGNORE_ENV_KEYS = "1";
delete process.env.LH_DESKTOP_SERVER;
delete process.env.LH_DESKTOP_API_SECRET;
fs.writeFileSync(process.env.LH_AUTH_FILE, "{}");

const { PUT } = await import("../src/api/handlers/settings/[section]/route.ts");
const { readSettings } = await import("../src/server/stores.ts");

after(() => fs.rmSync(directory, { recursive: true, force: true }));

const SPEECH = { dictation: "local", endpoint: "http://127.0.0.1:3901/v1" };

function put(section: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
	const request = new Request(`http://localhost:3000/api/settings/${section}`, {
		method: "PUT",
		headers: { "Content-Type": "application/json", ...headers },
		body: JSON.stringify(body),
	});
	return PUT(request, { params: Promise.resolve({ section }) });
}

test("a speech write with no Origin is refused and stores nothing", async () => {
	const response = await put("speech", SPEECH);
	assert.equal(response.status, 403);
	assert.equal(readSettings(), null);
});

test("a speech write from another origin is refused", async () => {
	const response = await put("speech", SPEECH, { Origin: "http://attacker.example" });
	assert.equal(response.status, 403);
});

test("the app's own same-origin speech write is stored", async () => {
	const response = await put("speech", SPEECH, { Origin: "http://localhost:3000" });
	assert.equal(response.status, 200);
	const stored = readSettings();
	assert.equal(stored?.speech?.endpoint, SPEECH.endpoint);
});

test("other sections keep their own gate: no Origin is still accepted", async () => {
	const response = await put("dictation", { language: "en" });
	assert.notEqual(response.status, 403);
});
