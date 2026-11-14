# Foundation investigation: peer on CloudCanvas

Date: 2026-11-14. Scope: project `peer` (`peer-stem/peer`). Role: Operator, foundation step.
Every figure below was measured in this session; the command or path that produced it is named.

## 1. The application as it stands

Measured on `master` at `cb25c8e` (identical to upstream `v0.6.1`), with `git grep -c ''` per path.

| Part | Files | Lines | Depends on |
|---|---|---|---|
| `src/` logic: `agent` 104, `core` 77, `server` 48, `store` 14 | 209 | 39,812 | no UI framework; `next.config.ts` states "Framework-free core lives in src/" |
| `app/api/**/route.ts` | 46 | 1,587 | Next route convention only |
| `app/**/page.tsx`, `app/layout.tsx` | 6 | 167 | Next pages |
| `components/**/*.tsx` | 132 | 31,023 | React |
| `components/**/*.ts` | 48 | 7,100 | 16 of these import React hooks; 32 do not |
| `tests/*.test.ts` | 284 | 60,082 | node:test; logic |
| `tests/*.test.tsx` | 135 | 27,994 | React + linkedom |
| `scripts/` | 28 | 6,600 | 11 files reference `.next` or `standalone` |
| `plugins/` | 152 | 18,014 | no React import in any plugin source |

Next-specific imports across `app`, `components`, `src`: `next/navigation` 10, `next/link` 3, `next/server` 2, `next` 1.

### How the layers meet

- A route file is a wrapper: `app/api/claude-code/route.ts` is five lines that call
  `claudeCodeInstallationResponse(request)` from `src/server`. Handlers take and return standard `Request`/`Response`.
- The request gate is one function: `apiRequestRefusal` in `src/server/desktop-access.ts`, called from `proxy.ts`.
- Plugins start from `instrumentation.ts`, which calls `initializePlugins` in `src/server/plugins.ts`.
- Streams are standard response bodies: `src/server/events-stream.ts`, `src/server/turn-runs.ts`,
  `src/server/pi/ui-stream.ts`.
- The client reaches the server only through `fetch("/api/…")` and by reading streams:
  `components/session-core.ts:716` (`res.body.getReader()`). Client fetch targets, by count: `api/chats` 19,
  `api/graph` 17, `api/settings` 16, `api/keys` 6, `api/custom-provider` 4, `api/themes` 3, `api/activity` 3.
- The desktop shell spawns one server entry: `electron/main.cjs:73` (`serverEntry`), today
  `resources/server/standalone/server.js`.
- The plugin frontend contract is framework-free: `src/core/plugins.ts:276` (`PluginFrontendContext`) and `:368`
  (`PluginFrontendModule`); the host side is `components/plugin-manager.ts` and `components/plugin-ui-host.tsx`.

### Interface by area

| Area | Lines | Largest files |
|---|---|---|
| `components/` top level | 29,432 | `chat.tsx` 2,996; `graph-canvas.ts` 1,753; `graph-view.tsx` 1,705; `session-core.ts` 1,257 |
| `components/settings` | 5,614 | `agent-section.tsx` 1,064; `keys-section.tsx` 1,055 |
| `components/artifacts` | 1,471 | |
| `components/ai-elements` | 906 | Markdown through `streamdown` |
| `components/ui` | 700 | |

React-free modules that carry over unchanged: `graph-canvas.ts` (1,753), `session-core.ts` (1,257),
`plugin-manager.ts` (666), `path-input-dom.ts` (282), `selection-text.ts` (206), `session-find-dom.ts` (156) and
about twenty smaller ones.

## 2. CloudCanvas as it stands

`CloudsEcosys/cloudcanvas` `main` at `c5e6e07` (2026-10-14), shallow-cloned and counted with `find … | xargs cat | wc -l`.

| Part | Files | Lines |
|---|---|---|
| `core/` | 11 | 1,439 |
| `addons/` | 49 | 9,939 |
| `ui/` | 103 | 14,144 |
| `graphics/` | 21 | 2,570 |

- `package.json`: name `cloudcanvas-base`, version 0.6.0, `private: true`, no dependencies, ES modules. It is not
  installable from a registry; a submodule or git reference is required.
- No `.d.ts` files and no test files in this repository.
- Control contract (`ui/index.js`): `create<Name>(host, callbacks)` mounts into `host` and returns
  `{ update(model), destroy() }`; plain data in, callbacks out; a control never owns application state; styles are
  injected once and themed through `--cc-*` tokens.
- Controls exported by `ui/index.js`: dialog, confirm, context actions, context window, drawer, tabs, menu, popover,
  splitter, results, status, badge, breadcrumbs, tree, progress, switch, icons, select, chips, navbar, empty state,
  combobox, toaster, composer, voice draft and input, markdown, kanban, calendar, timeline, graph.
- `ui/markdown.js`: a safe subset built with `createElement`/`createTextNode`, no HTML parser, input capped at
  100,000 characters and six nesting levels. No math, Mermaid, syntax highlighting or partial-text handling.
- `ui/graph/graph.js`: a mind map (a tree laid left to right with cross links), pannable and zoomable. Not a
  force-directed graph.
- `ui/voice.js`: uses the browser's speech service.
- Boards from data: `addons/xml.js` (`fromXml`, the whole document checked before anything is built),
  `addons/reactions.js` ("when A emits X, run action Y on B", stored with the root), `addons/own-canvas.js`.
- `ui/testing/dom.js`: a hand-written document for renderer tests under node.

A second repository, `CloudsEcosys/cc-main` (the local `~/cloudcanvas`, last commit 2026-11-11), has a newer engine
with a `panel` add-on and board save/load (`.addons/sandbox`) but no `ui/` kit. It is **not** the chosen source.

## 3. What was changed before this step

- Fork created: `peer-stem/peer`, linked to `amosblomqvist/learnharness`. Remotes: `origin` the fork, `upstream`
  the original. `master` created from `main` at `cb25c8e`.
- Pull request 1 (`feature/local-voice-cli-providers` into `master`, commit `8fc272e`): CLI bindings for Claudex,
  Codex and Antigravity, local dictation and read-aloud. It adds four routes, taking the count to 50.
- That build is installed at `/usr/lib/persist/peer/releases/v0.6.1-local.1`; live data is in
  `/usr/lib/persist/peer/state`, with a snapshot at `/usr/lib/persist/peer/state.backup-20261114T060153`.

## 4. Not verified

- The kit's implementation and behaviour beyond file headers and export lists.
- Whether the engine at `c5e6e07` and newer `cc-main` add-ons are compatible.
- Accessibility of kit controls against the app's current keyboard behaviour.
- The time any phase will take. Sizes above are line counts, not estimates.
