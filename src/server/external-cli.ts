import { createProvider, type Api, type MutableModels, type Provider, type SimpleStreamOptions, type StreamFunction } from "@earendil-works/pi-ai";

import { createClaudeLauncher } from "../agent/claude-code/launch.ts";
import { createClaudeCodeProvider } from "../agent/claude-code/provider.ts";
import { createClaudeCodeStreamFunction, streamClaudeCode } from "../agent/claude-code/stream.ts";
import { agyDialect } from "../agent/external-cli/agy.ts";
import { readCliVersion } from "../agent/external-cli/binary.ts";
import { codexDialect } from "../agent/external-cli/codex.ts";
import { createLineCliStreamFunction } from "../agent/external-cli/stream.ts";
import { configureCliSource } from "../agent/models.ts";
import { CLAUDE_CODE_PROVIDER } from "../core/contracts/claude-code.ts";
import { EXTERNAL_CLIS, externalCli, type AddedCliId, type ExternalCliId, type ExternalCliStatus } from "../core/contracts/external-cli.ts";
import {
	cliBinary, externalCliAvailable, externalCliEnabled, externalCliHome, externalCliSettings, forgetCliBinary, readCliSettings, type CliSettingsSnapshot,
} from "./external-cli-config.ts";
import { discoveredCliModels, mergeCliModels, refreshAgyModels, toCliModels, type CliModelEntry } from "./external-cli-models.ts";
import { subscriptionRequestOrigin } from "./web-subscription-http.ts";

type CliStream = StreamFunction<Api, SimpleStreamOptions>;

const STATUS_HEADER = "x-learnharness-external-cli";

function cliModels(id: ExternalCliId, settings: CliSettingsSnapshot = readCliSettings()) {
	return mergeCliModels(discoveredCliModels(id, externalCliHome(id, settings)), externalCliSettings(id, settings).models);
}

const STREAMS: Record<AddedCliId, CliStream> = {
	claudex: createClaudeCodeStreamFunction(createClaudeLauncher(), () => ({ CLAUDE_CONFIG_DIR: externalCliHome("claudex")! })),
	"codex-cli": createLineCliStreamFunction(codexDialect, { home: () => externalCliHome("codex-cli") }),
	"agy-cli": createLineCliStreamFunction(agyDialect, { home: () => externalCliHome("agy-cli") }),
};

function buildProvider(id: ExternalCliId, entries: CliModelEntry[]): Provider {
	const { label, family } = externalCli(id)!;
	const models = toCliModels(id, entries);
	if (id === CLAUDE_CODE_PROVIDER) return createClaudeCodeProvider(streamClaudeCode, { id, name: label, models });
	const stream = STREAMS[id];
	if (family === "claude") return createClaudeCodeProvider(stream, { id, name: label, models });
	return createProvider({
		id,
		name: label,
		auth: { apiKey: { name: `${label} CLI`, resolve: async () => ({ auth: {}, source: `${label} CLI` }) } },
		models,
		api: { stream, streamSimple: stream },
	});
}

/** Claude Code stays registered while off (its saved selections resolve to an
 * honest "unavailable"); the added bindings exist only while usable. */
function syncProvider(models: MutableModels, id: ExternalCliId, fingerprints: Map<string, string>, settings: CliSettingsSnapshot): void {
	const present = id === CLAUDE_CODE_PROVIDER || externalCliAvailable(id, settings);
	const entries = present ? cliModels(id, settings) : undefined;
	const next = entries ? JSON.stringify(entries) : "absent";
	if (fingerprints.get(id) === next) return;
	fingerprints.set(id, next);
	if (entries) models.setProvider(buildProvider(id, entries));
	else if (models.getProvider(id)) models.deleteProvider(id);
}

/** An enabled Antigravity binding lists its models once per binary and home, in the background. */
function discoverInBackground(started: Set<string>, settings: CliSettingsSnapshot): void {
	const binary = externalCliEnabled("agy-cli", settings) ? cliBinary("agy-cli") : null;
	const home = externalCliHome("agy-cli", settings);
	const key = `${binary}\n${home ?? ""}`;
	if (!binary || started.has(key)) return;
	started.add(key);
	void refreshAgyModels(binary, home);
}

/** One settings read per sync, shared by every check in it. */
export function installExternalCliSource(): void {
	const fingerprints = new Map<string, string>();
	const started = new Set<string>();
	configureCliSource({
		sync(models) {
			const settings = readCliSettings();
			discoverInBackground(started, settings);
			for (const cli of EXTERNAL_CLIS) syncProvider(models, cli.id, fingerprints, settings);
		},
	});
}

/** Installation, version and model list only: no sign-in check, no model call.
 * The caller initializes key provenance before any child environment is copied. */
export async function externalCliStatus(id: ExternalCliId): Promise<ExternalCliStatus> {
	forgetCliBinary(id);
	const binary = cliBinary(id);
	if (!binary) return { id, state: "not-found", version: null, models: [] };
	// The probe and the listing run side by side; the listing is single-flight.
	const listing = id === "agy-cli" ? refreshAgyModels(binary, externalCliHome(id)) : undefined;
	const [version] = await Promise.all([readCliVersion(binary), listing]);
	return { id, state: "found", version, models: cliModels(id).map((model) => model.id) };
}

/** Same-origin browser intent, not user authentication. No CORS grants. */
export async function externalCliStatusResponse(request: Request, inspect = externalCliStatus): Promise<Response> {
	const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
	const origin = subscriptionRequestOrigin(request);
	const supplied = request.headers.get("origin");
	if (request.method !== "GET" || !origin || request.headers.get(STATUS_HEADER) !== "1"
		|| request.headers.get("sec-fetch-site") === "cross-site" || (supplied !== null && supplied !== origin)) {
		return Response.json({ error: "CLI checks require a same-origin LearnHarness request." }, { status: 403, headers });
	}
	const cli = externalCli(new URL(request.url).searchParams.get("id") ?? "");
	if (!cli) return Response.json({ error: "Unknown CLI." }, { status: 404, headers });
	if (!externalCliEnabled(cli.id)) return Response.json({ error: `${cli.label} is disabled.` }, { status: 403, headers });
	return Response.json(await inspect(cli.id), { headers });
}
