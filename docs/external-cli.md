# CLI bindings: Claudex, Codex and Antigravity

LearnHarness can use further installed command-line agents as model providers, beside [Claude Code](claude-code.md). As with Claude Code, the CLI owns sign-in, routing, model access and billing; LearnHarness owns the prompts, tools, questions and saved history.

| Binding | Command | Its own configuration | Models |
| --- | --- | --- | --- |
| Claude Code | `claude` | launch environment (default `~/.claude`) | `opus`, `sonnet`, `haiku`, `fable` |
| Claudex | `claude` | `CLAUDE_CONFIG_DIR`, default `~/.claudeex` | same aliases |
| Codex | `codex` | `CODEX_HOME`, default `~/.codex` | the account's list in `models_cache.json` |
| Antigravity | `agy` | the home whose `.gemini` holds the sign-in, default `~` | `agy models`, run under that home |

Enable each one in **Settings → Providers → External CLI**. All are off by default. Each added row also takes a **configuration directory** (another sign-in of the same CLI) and **extra model IDs** for models the listing does not offer; Claude Code takes extra model IDs only. These settings live in `settings.json` under `externalCli`, except Claude Code's on/off switch, which stays `claudeCode.enabled`.

Claudex is a second binding of the Claude Code CLI under another configuration directory, so two sign-ins can be used side by side.

## Without your own agent setup

A tutor turn must not inherit the instructions, skills, plugins or tools you have set up for your own work:

- **Claude Code / Claudex** — unchanged from [Claude Code](claude-code.md): system prompt replaced, built-in tools, hooks, slash commands and `CLAUDE.md` loading off, MCP restricted to LearnHarness's bridge.
- **Codex** — `codex exec --ignore-user-config --ignore-rules --ephemeral` in an empty directory with a read-only sandbox; shell, apps, hooks, sub-agents and plugins are disabled. The tutor prompt replaces Codex's base instructions (`model_instructions_file`).
- **Antigravity** — its print mode cannot relocate `~/.gemini`, so each turn runs with a private temporary `HOME` holding a link to the sign-in token (and to `oauth_creds.json` when that exists), a `settings.json` carrying only the `security` block of your own Antigravity settings, and that turn's bridge configuration. Its system prompt cannot be replaced; the tutor prompt leads the conversation instead. Headless mode denies every tool that is not explicitly allowed, and only the bridge's tools are.

For all of them the only tools are LearnHarness's own, served over a token-protected loopback MCP bridge for that turn. These are integration boundaries, **not an OS sandbox**.

## Limits

- Codex and Antigravity turns pass **text only**; an image in the conversation is replaced by a placeholder.
- Codex reports whole messages, not token-by-token text.
- A turn replays the saved conversation as labelled text, as Claude Code does after a restart. It is not a native session resume.
- Costs are never estimated for a CLI binding.
- The checks in Settings show installation, version and model list only: not sign-in, quota or model access.
- Antigravity's model list comes from `agy models`, which runs under the configured home's sign-in: in the background once per server start after the binding is enabled (and again when its binary or home changes), and on every check in Settings. The last list is saved in the app's data directory.

Verification: `tests/external-cli-dialects.test.ts` pins the launch arguments and output parsing; `tests/external-cli-prepare.test.ts` checks what each Codex and Antigravity turn is given (environment, home, files) and that it is removed afterwards; `tests/external-cli-stream.test.ts` runs the engine against the real bridge with a scripted child in place of the CLI. No test runs a real CLI.
