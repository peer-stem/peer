# peer: architecture

Status: foundation draft, 2026-11-14; §1 to §4, §7 and §8 corrected the same day to the owner's model (DESIGN §3).
This describes the target and how the fork gets there. The engine's own
runtime flows are in [`docs/architecture.md`](docs/architecture.md), which upstream maintains. Points marked
**open** are not decided.

## 1. Components

The client is the host (the owner, 2026-11-14; DESIGN §3). The CloudCanvas client is static native modules that run
in the window, draw everything there and fetch all data. No server serves or renders the interface. In CloudCanvas,
"host" means the client side, a control's host element. The Node process is the engine's API server and is never
called host.

```
Electron shell (electron/; changes only in Phase 4)
   │ opens the window          │ spawns the engine's API server on loopback
   v                           v
window                                         Node process
src/client   CloudCanvas client:   ── HTTP ──>  src/api (name proposed)   the engine's API server:
             native ES modules,    (assumed;    route table, gate, stream passthrough. Serves no interface
             runs and draws in     open, §8)          │ calls, unchanged
             the window                               v
   state/    TypeScript: API client, stores     src/server → src/agent, src/core, src/store   tracks upstream
   views/    plain JavaScript: one control per screen or panel
   blocks/   application Markdown blocks (math, Mermaid, highlighted code)
extern/cloudcanvas   git submodule, pinned commit

Until Phase 5: app/ + components/ on Next   the old React interface and Next's own /api layer, untouched
```

How the client's own files reach the window is a Phase 2 decision (§8).

| Component | Responsibility | Owns | Must not |
|---|---|---|---|
| `src/server`, `agent`, `core`, `store` | Everything the app does: turns, tools, jobs, graph, settings, plugins | The records on disk | Import from `src/api` or `src/client` |
| `src/api` (name **proposed**) | The engine's HTTP API without Next: map a method and path to the existing route handler, apply the gate, pass streams through (SPEC §2) | No state | Contain application logic; serve, render or hand out the interface (Phase 1) |
| `app/`, `components/`, Next | The old React interface and Next's API layer, until Phase 5 | Nothing new | Be changed by Phases 1 to 4 |
| `src/client/state` | Talk to the engine API, hold the working copy of server state, expose plain models | Working copy only | Touch the DOM |
| `src/client/views` | Draw a model and report what the person did | Its own DOM subtree | Fetch, or keep application state |
| `src/client/blocks` | Render application content inside Markdown | Its own DOM subtree | Reach outside its block |
| `extern/cloudcanvas` | Engine and kit | Nothing of ours | Know anything about peer |

## 2. Interfaces

- **API route.** `{ method, pattern, handler, file }`, where
  `handler(request: Request, context: { params: Promise<Params> }) => Response | Promise<Response>` is the function
  the route file exports today (SPEC §2.2; route inventory §1.1 items 3-4). The table lists the existing route
  modules and derives methods from their exports, and a test compares it with `app/api/**/route.ts`, so the two
  servers cannot drift while both exist (SPEC §2.4).
- **Dispatch.** `(request: Request) => Promise<Response>`: gate, match, call. Independent of `node:http`; the HTTP
  adapter `serveHttp(message, res, dispatch)` is one transport for it (SPEC §2.3).
- **Gate.** `apiRequestRefusal(request)` from `src/server/desktop-access.ts`, over every `/api` path and method before
  any 404 or 405, the documents route included (**proposed**; SPEC §2.4). Next applies it through `proxy.ts`.
- **Start-up.** `initializePlugins()` from `src/server/plugins.ts`, called directly before listening, since
  `instrumentation.ts` runs it only inside Next (SPEC §2.8).
- **Client to engine.** `fetch` and response streams over HTTP to the API server. Assumed, not confirmed (§8).
- **View.** `create(host: Element, callbacks) => { update(model), destroy() }`. `host` is the control's host element,
  the CloudCanvas sense of the word. Models are plain data.
- **Markdown block.** A registration `{ match, render(host, source) => destroy }` for a fenced block or an inline
  span. The extension point is agnostic and proposed for the CloudCanvas side (**open**, DESIGN §7.1).
- **Plugin host.** The existing contract in `src/core/plugins.ts` (`PluginFrontendContext`,
  `PluginFrontendModule`). The new client implements its `mount*` widgets with kit controls; plugins do not change.

## 3. Data flow

1. A view reports an action through a callback.
2. A store in `src/client/state` sends it to the engine API with `fetch`.
3. The API server applies the gate and calls the route handler, which calls `src/server`.
4. The handler answers, or streams events; the store reads the stream (`session-core.ts` does this today) and
   produces the next model.
5. The view receives `update(model)`.

Nothing skips a step: a view never fetches, and a store never touches the DOM.

## 4. Repository layout

| Path | Status | Contents |
|---|---|---|
| `src/{agent,core,server,store}` | upstream's, merged from `upstream/main` | the engine |
| `src/api/` | new; name **proposed** | the engine's API server: `routes.ts`, `router.ts`, `adapter.ts`, `server.ts`, `log.ts`, `config.ts` (PLAN Phase 1) |
| `src/client/` | new | the CloudCanvas client |
| `extern/cloudcanvas` | submodule, added 2026-11-14 | `CloudsEcosys/cloudcanvas` pinned at `c5e6e07` (v0.6.0) |
| `app/`, `components/` | upstream's, kept until the removal phase | the React and Next.js interface. `src/api` imports the handlers in `app/api/**/route.ts` until then |
| `tests/` | flat, as upstream keeps it | new files prefixed `api-` and `client-`; helpers in `tests/helpers/` |
| `tools/` | ours | `twm-speech-bridge` |
| `docs/` | upstream's guides plus ours | |
| `.context/` | ours | plans, notes and reports |

New directories are ones upstream does not have, so merges into the engine do not conflict with our work.

## 5. Stack

| Concern | Choice | Note |
|---|---|---|
| API server runtime | Node 26, `node:http` | what CI and releases already use; the packaged app runs the server on Electron's bundled Node (`electron/main.cjs:13-14, 216-217`; route inventory §2.11) |
| Client | CloudCanvas engine and kit, native ES modules | no bundler for view code |
| Client TypeScript | compiled to ES modules, not bundled into views | tool **open**; `esbuild` is already in the lockfile |
| Styling | the kit's stylesheet and `--cc-*` tokens | app themes (`src/core/themes.ts`) map onto the tokens |
| Tests | `node:test`; linkedom and the kit's `ui/testing` for views; a browser driver for the desktop window | linkedom is already a dependency. Driver **open**: Playwright is proposed and would be added; `puppeteer-core` is already a dependency and drives `scripts/smoke-plugin-browser.mjs` today |
| Desktop | Electron 44, electron-builder | unchanged |

## 6. Alternatives weighed

| Alternative | Why not |
|---|---|
| Keep Next.js as the engine's API server for the CloudCanvas client | It keeps the slow builds, the cache failures and the file-tracing configuration for the sake of 50 route files that import nothing from Next (route inventory §1.1 item 2, §1.4) |
| Mount old React screens inside the new client during migration | The owner ruled it out: the new client contains no React |
| Remove the old interface first | The fork would ship nothing until parity; the owner chose to keep it shipping |
| Rewrite the logic too | It is already framework-free and sits on TypeScript agent libraries; nothing is gained |
| Vendor CloudCanvas into the repository | Fixes would drift from the framework's own repository; the owner chose a submodule |

### Moving the CloudCanvas pin (proposed)

The pin moves only in a commit of its own, on its own branch, never as a side effect of other work. That commit
states the CloudCanvas range it moves across (`old..new`), and it merges only with the client tests green on the
new pin and a line in `CHANGELOG.md`. A fix peer needs in CloudCanvas is made in CloudCanvas first, then the pin
moves to it; peer does not patch the submodule in place. After cloning: `git submodule update --init`.

## 7. Foundation the first phases build

1. The submodule (done, 2026-11-14) and the rule for moving its pin (above).
2. Type definitions for the CloudCanvas surface peer uses.
3. The API server in `src/api` (Phase 1), with the route table and a parity test against the Next routes
   (`.context/logs/reports/2026-11-14-api-parity-method.md`).
4. A non-blocking, configurable logger and explicit configuration for the API server and the client.
5. The three test layers: unit, integration (route parity), end to end (desktop window).
6. A build for the API server and the client that does not involve Next, beside the existing build.

## 8. Open

- The tool that compiles the client's TypeScript (§5), and how the API server's TypeScript and the `@/` alias run
  outside Next (SPEC §2.8).
- Whether the Markdown block extension point is accepted into CloudCanvas, and in what form (§2).
- **How the client reaches the engine.** Assumed, not confirmed by the owner: HTTP to the API server. Alternative:
  Electron's own channel between window and main process, with no HTTP server in the desktop app. The router's
  `Dispatch` takes a `Request` and returns a `Response` with no `node:http` in it (SPEC §2.2), so the Phase 1 route
  table and gate serve either transport (**proposed**).
- **How the client's own files, and the `public/` files it needs, reach the window** (Phase 2): the API server hands
  them out, or the Electron window loads them from disk. To weigh: the shell adds the desktop secret only to `/api`
  requests whose target and main-frame origin are the server's own (`electron/desktop-api.cjs:12-20`), and
  `EventSource` cannot set headers (`components/server-events.tsx:39`; route inventory §2.1).
- How the client is reached in development while both interfaces exist (which port, which origin).
- Where the route handler modules live once `app/` is deleted (Phase 5).
- The name `src/api` (**proposed**).
