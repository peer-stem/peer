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

export const CLAUDE_CODE_MODELS: readonly Model<Api>[] = [
	{ ...SHARED_MODEL_FIELDS, id: "opus", name: "Claude Opus" },
	{ ...SHARED_MODEL_FIELDS, id: "sonnet", name: "Claude Sonnet" },
	{ ...SHARED_MODEL_FIELDS, id: "haiku", name: "Claude Haiku" },
];

const ALIAS_NAMES: Record<string, string> = { fable: "Claude Fable", opus: "Claude Opus", sonnet: "Claude Sonnet", haiku: "Claude Haiku" };

/** The CLI accepts aliases and full model names alike; an ID it does not
 * know fails in the CLI, not here. */
export function claudeCodeModels(ids: readonly string[], provider: string = CLAUDE_CODE_PROVIDER): Model<Api>[] {
	return ids.map((id) => ({ ...SHARED_MODEL_FIELDS, provider, id, name: ALIAS_NAMES[id] ?? id }));
}

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
