import { createProvider, type Api, type Model, type Provider, type SimpleStreamOptions, type StreamFunction } from "@earendil-works/pi-ai";

import { CLAUDE_CODE_API, CLAUDE_CODE_PROVIDER } from "./constants.ts";

const SHARED_MODEL_FIELDS = {
	api: CLAUDE_CODE_API,
	provider: CLAUDE_CODE_PROVIDER,
	baseUrl: "",
	input: ["text", "image"],
	// Pi-required placeholders, not prices: the CLI's own auth/routing
	// determines charges. Server pricing and the client catalog report unpriced.
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	reasoning: true,
	// The CLI has no thinking-off switch; effort low is the floor.
	thinkingLevelMap: { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
	contextWindow: 1_000_000,
	maxTokens: 128_000,
} satisfies Omit<Model<Api>, "id" | "name">;

/** The one list of aliases the installed CLI resolves itself; full model
 * names can be added in settings. */
export const CLAUDE_ALIASES: readonly { id: string; name: string }[] = [
	{ id: "opus", name: "Claude Opus" },
	{ id: "sonnet", name: "Claude Sonnet" },
	{ id: "haiku", name: "Claude Haiku" },
	{ id: "fable", name: "Claude Fable" },
];

const ALIAS_NAMES = new Map(CLAUDE_ALIASES.map(({ id, name }) => [id, name]));

/** The CLI accepts aliases and full model names alike; an ID it does not
 * know fails in the CLI, not here. */
export function claudeCodeModels(ids: readonly string[], provider: string = CLAUDE_CODE_PROVIDER): Model<Api>[] {
	return ids.map((id) => ({ ...SHARED_MODEL_FIELDS, provider, id, name: ALIAS_NAMES.get(id) ?? id }));
}

export const CLAUDE_CODE_MODELS: readonly Model<Api>[] = claudeCodeModels(CLAUDE_ALIASES.map(({ id }) => id));

export type ClaudeCodeProfile = { id: string; name: string; models: readonly Model<Api>[] };

/** `profile` names a second binding of the same CLI, e.g. another login. */
export function createClaudeCodeProvider(streamSimple: StreamFunction<Api, SimpleStreamOptions>, profile?: ClaudeCodeProfile): Provider {
	return createProvider({
		id: profile?.id ?? CLAUDE_CODE_PROVIDER,
		name: profile?.name ?? "Claude Code",
		auth: { apiKey: { name: "Claude Code CLI", resolve: async () => ({ auth: {}, source: "claude CLI" }) } },
		models: profile?.models ?? CLAUDE_CODE_MODELS,
		api: { stream: streamSimple, streamSimple },
	});
}
