/**
 * The CLI registry and Antigravity's model listing. The listing runs a
 * scripted stand-in for `agy` from a private directory; no real CLI runs.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test, { after } from "node:test";

fs.mkdirSync("/tmp/peer", { recursive: true });
const root = fs.mkdtempSync("/tmp/peer/external-cli-sync-");
process.env.LH_DATA_DIR = path.join(root, "data");
after(() => fs.rmSync(root, { recursive: true, force: true }));

const { settingsStore } = await import("../src/store/settings.ts");
const { piModels } = await import("../src/agent/models.ts");
const { externalCliStatus, installExternalCliSource } = await import("../src/server/external-cli.ts");
const { discoveredCliModels, refreshAgyModels } = await import("../src/server/external-cli-models.ts");

const FAKE_AGY = `#!/bin/sh
marker="$(dirname "$0")/version-ran"
if [ "$1" = "--version" ]; then touch "$marker"; echo "agy 1.2.3"; exit 0; fi
if [ "$FAKE_AGY_WAIT" = "1" ]; then
	i=0
	while [ ! -e "$marker" ] && [ "$i" -lt 40 ]; do sleep 0.05; i=$((i + 1)); done
	if [ -e "$marker" ]; then printf 'concurrent\\tRan beside the version probe\\n'; else printf 'sequential\\tRan alone\\n'; fi
	exit 0
fi
printf 'Available models:\\n'
printf 'home\\t%s\\n' "$HOME"
printf 'secret-%s\\tServer secret\\n' "\${LH_DESKTOP_API_SECRET:-none}"
`;

const bin = path.join(root, "bin");
fs.mkdirSync(bin);
const agy = path.join(bin, "agy");
fs.writeFileSync(agy, FAKE_AGY, { mode: 0o755 });

function withEnv(values: Record<string, string>): () => void {
	const saved = Object.fromEntries(Object.keys(values).map((name) => [name, process.env[name]]));
	Object.assign(process.env, values);
	return () => {
		for (const [name, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	};
}

test("one registry sync reads the settings once", (t) => {
	installExternalCliSource();
	const read = settingsStore.readSettings;
	let reads = 0;
	settingsStore.readSettings = () => { reads++; return read(); };
	t.after(() => { settingsStore.readSettings = read; });
	piModels();
	assert.equal(reads, 1);
});

test("Antigravity lists its models under the configured home, without the server's own access", async (t) => {
	t.after(withEnv({ LH_DESKTOP_API_SECRET: "app-secret" }));
	const home = path.join(root, "second-login");
	await refreshAgyModels(agy, home);
	assert.deepEqual(discoveredCliModels("agy-cli", home), [{ id: "home", name: home }, { id: "secret-none", name: "Server secret" }]);
});

test("only one listing runs at a time", async () => {
	const first = refreshAgyModels(agy, undefined);
	assert.equal(refreshAgyModels(agy, undefined), first);
	await first;
	const next = refreshAgyModels(agy, undefined);
	assert.notEqual(next, first, "a finished listing does not block the next one");
	await next;
});

test("a status check runs the version probe beside the listing", async (t) => {
	t.after(withEnv({ PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`, FAKE_AGY_WAIT: "1" }));
	const status = await externalCliStatus("agy-cli");
	assert.equal(status.version, "1.2.3");
	assert.deepEqual(status.models, ["concurrent"]);
});
