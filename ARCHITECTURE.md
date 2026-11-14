# peer: architecture

Status: foundation draft, 2026-11-14. This describes the target and how the fork gets there. The engine's own
runtime flows are in [`docs/architecture.md`](docs/architecture.md), which upstream maintains. Points marked
**open** are not decided.

## 1. Components

```
Electron shell (electron/, unchanged)
      │ spawns one server entry on loopback
      v
src/host        plain Node HTTP server: route table, static files, stream passthrough
      │ calls, unchanged
      v
src/server  →  src/agent, src/core, src/store        TypeScript, tracks upstream

browser window ── fetch + streams ──> src/host
src/client      CloudCanvas client, native ES modules
   state/       TypeScript: API client, session store, settings and catalog stores
   views/       plain JavaScript: one control per screen or panel
   blocks/      application Markdown blocks (math, Mermaid, highlighted code)
extern/cloudcanvas      git submodule, pinned commit
```

| Component | Responsibility | Owns | Must not |
|---|---|---|---|
| `src/server`, `agent`, `core`, `store` | Everything the app does: turns, tools, jobs, graph, settings, plugins | The records on disk | Import from `src/host` or `src/client` |
| `src/host` | HTTP transport: map a method and path to a `src/server` handler, apply the gate, serve the client's files, pass streams through | No state | Contain application logic |
| `src/client/state` | Talk to the host, hold the working copy of server state, expose plain models | Working copy only | Touch the DOM |
| `src/client/views` | Draw a model and report what the person did | Its own DOM subtree | Fetch, or keep application state |
| `src/client/blocks` | Render application content inside Markdown | Its own DOM subtree | Reach outside its block |
| `extern/cloudcanvas` | Engine and kit | Nothing of ours | Know anything about peer |

## 2. Interfaces

- **Host route.** `{ method, pattern, handler }`, where `handler(request: Request, params) => Promise<Response>`
  is the function the Next route file calls today. The table is built from the existing route files, so the
  two servers cannot drift apart while both exist.
- **Gate.** `apiRequestRefusal(request)` from `src/server/desktop-access.ts`, applied before every `/api` route,
  exactly as `proxy.ts` does now.
- **Start-up.** `initializePlugins()` from `src/server/plugins.ts`, called once, as `instrumentation.ts` does now.
- **View.** `create(host: Element, callbacks) => { update(model), destroy() }`. Models are plain data.
- **Markdown block.** A registration `{ match, render(host, source) => destroy }` for a fenced block or an inline
  span. The extension point is agnostic and proposed for the CloudCanvas side (**open**, DESIGN §7.1).
- **Plugin host.** The existing contract in `src/core/plugins.ts` (`PluginFrontendContext`,
  `PluginFrontendModule`). The new client implements its `mount*` widgets with kit controls; plugins do not change.

## 3. Data flow

1. A view reports an action through a callback.
2. A store in `src/client/state` sends it to the host with `fetch`.
3. The host applies the gate and calls the `src/server` handler.
4. The handler answers, or streams events; the store reads the stream (`session-core.ts` does this today) and
   produces the next model.
5. The view receives `update(model)`.

Nothing skips a step: a view never fetches, and a store never touches the DOM.

## 4. Repository layout

| Path | Status | Contents |
|---|---|---|
| `src/{agent,core,server,store}` | upstream's, merged from `upstream/main` | the engine |
| `src/host/` | new | the Node server |
| `src/client/` | new | the CloudCanvas client |
| `extern/cloudcanvas` | new, submodule | pinned at `c5e6e07` to begin with |
| `app/`, `components/` | upstream's, kept until the removal phase | the React and Next.js interface |
| `tests/` | flat, as upstream keeps it | new files prefixed `host-` and `client-` |
| `tools/` | ours | `twm-speech-bridge` |
| `docs/` | upstream's guides plus ours | |
| `.context/` | ours | plans, notes and reports |

New directories are ones upstream does not have, so merges into the engine do not conflict with our work.

## 5. Stack

| Concern | Choice | Note |
|---|---|---|
| Server runtime | Node 26, `node:http` | what CI and releases already use |
| Client | CloudCanvas engine and kit, native ES modules | no bundler for view code |
| Client TypeScript | compiled to ES modules, not bundled into views | tool **open**; `esbuild` is already in the lockfile |
| Styling | the kit's stylesheet and `--cc-*` tokens | app themes (`src/core/themes.ts`) map onto the tokens |
| Tests | `node:test`; linkedom and the kit's `ui/testing` for views; a browser driver for the desktop window | linkedom is already a dependency. Driver **open**: Playwright is proposed and would be added; `puppeteer-core` is already a dependency and drives `scripts/smoke-plugin-browser.mjs` today |
| Desktop | Electron 44, electron-builder | unchanged |

## 6. Alternatives weighed

| Alternative | Why not |
|---|---|
| Keep Next.js as the server under a CloudCanvas client | It keeps the slow builds, the cache failures and the file-tracing configuration for the sake of 46 thin wrappers |
| Mount old React screens inside the new client during migration | The owner ruled it out: the new client contains no React |
| Remove the old interface first | The fork would ship nothing until parity; the owner chose to keep it shipping |
| Rewrite the logic too | It is already framework-free and sits on TypeScript agent libraries; nothing is gained |
| Vendor CloudCanvas into the repository | Fixes would drift from the framework's own repository; the owner chose a submodule |

## 7. Foundation the first phases build

1. The submodule and the rule for moving its pin.
2. Type definitions for the CloudCanvas surface peer uses.
3. The host skeleton, with the route table and a parity test against the Next routes.
4. A non-blocking, configurable logger and pluggable configuration for host and client.
5. The three test layers: unit, integration (route parity), end to end (desktop window).
6. A build for host and client that does not involve Next, beside the existing build.

## 8. Open

- The tool that compiles the client's TypeScript (§5).
- Whether the Markdown block extension point is accepted into CloudCanvas, and in what form (§2).
- How the new client is reached during coexistence: a second port, or a path on the same server. Proposed: the
  new host on its own port in development; the desktop app ships one of the two, chosen at build time.
