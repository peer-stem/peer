# peer: architecture

Status: foundation draft, 2026-11-14; §1 to §4, §7 and §8 corrected the same day to the owner's model (DESIGN §3),
and again the same day to the owner's decisions on the client's files, the CloudCanvas split and the execution plan
(DESIGN §3, §3.1). This describes the target and how the fork gets there. The engine's own
runtime flows are in [`docs/architecture.md`](docs/architecture.md), which upstream maintains. Points marked
**open** are not decided.

## 1. Components

The client is the host (the owner, 2026-11-14; DESIGN §3). The CloudCanvas client is static native modules that run
in the window, draw everything there and fetch all data. No server renders the interface. In CloudCanvas,
"host" means the client side, a control's host element. The Node process is the engine's API server and is never
called host.

```
Electron shell (electron/; changes only in Phase 4)
   │ opens the window          │ spawns the engine's API server on loopback
   v                           v
window                                         Node process
src/client   CloudCanvas client:   ── HTTP ──>  src/api   the engine's API server:
             native ES modules,    same origin  route table, gate, stream passthrough; hands out
             runs and draws in                  the client's files unchanged. Renders nothing
             the window                               │ calls, unchanged
   state/    TypeScript: API client, stores           v
   views/    plain JavaScript: one view per    src/server → src/agent, src/core, src/store   tracks upstream
             screen or panel
   blocks/   application Markdown blocks (math, Mermaid, highlighted code)
extern/cloudcanvas       git submodule: the engine. At c5e6e07 (v0.6.0) until sprint B0 moves it to 0.7.x
extern/cloudcanvas-lib   git submodule, added in sprint B0: widgets, board components, archetypes, the board

Until Phase 5: app/ + components/ on Next   the old React interface and Next's own /api layer, untouched
```

The client's files reach the window from the process that answers the API, unchanged and on the same origin
(DESIGN §3). In development they sit under Next's `public/`; the path `/client/` is **proposed**. This was a Phase 2
decision until the owner decided it on 2026-11-14. Facts recorded while it was open: the shell adds the desktop
secret only to `/api` requests whose target and main-frame origin are the server's own
(`electron/desktop-api.cjs:12-20`), and `EventSource` cannot set headers (`components/server-events.tsx:39`; route
inventory §2.1).

| Component | Responsibility | Owns | Must not |
|---|---|---|---|
| `src/server`, `agent`, `core`, `store` | Everything the app does: turns, tools, jobs, graph, settings, plugins | The records on disk | Import from `src/api` or `src/client` |
| `src/api` | The engine's HTTP API without Next: map a method and path to the existing route handler, apply the gate, pass streams through (SPEC §2). Hand out the client's files unchanged, outside the gate, in `src/api/static.ts` (SPEC §2.11) | No state | Contain application logic; render anything; change the files it hands out |
| `app/`, `components/`, Next | The old React interface and Next's API layer, until Phase 5 | Nothing new | Be changed by Phases 1 to 4 |
| `src/client/state` | Talk to the engine API, hold the working copy of server state, expose plain models | Working copy only | Touch the DOM |
| `src/client/views` | Draw a model and report what the person did | Its own DOM subtree | Fetch, or keep application state |
| `src/client/blocks` | Render application content inside Markdown | Its own DOM subtree | Reach outside its block |
| `extern/cloudcanvas` | The engine. Since the split of 2026-11-14 its `main` has no `ui/` kit | Nothing of ours | Know anything about peer |
| `extern/cloudcanvas-lib` (from sprint B0) | The widget kit, board components, archetypes and the board, as `widget()` types created on a board | Nothing of ours | Know anything about peer |

What goes where follows the owner's placement rule (DESIGN §3): fundamental to the engine → `cloudcanvas`; agnostic
to peer → `cloudcanvas-lib`; application-specific → peer. Changes to either CloudCanvas repo go as pull requests from
this project's own clones under `/usr/lib/persist/peer/work/` (§6).

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
  Paths outside `/api` are not gated, as today.
- **Client files.** `src/api/static.ts` hands out the client's files unchanged, same origin (SPEC §2.11). Paths and
  answers beyond that are frozen with the client build and delivery paths in sprint B1.
- **Start-up.** `initializePlugins()` from `src/server/plugins.ts`, called directly before listening, since
  `instrumentation.ts` runs it only inside Next (SPEC §2.8).
- **Client to engine.** `fetch` and response streams over HTTP to the API server (decided, DESIGN §3.1). The
  router's entry is a plain `Request → Response` function, so Electron's own channel stays possible later.
- **View.** **Superseded:** `create(host: Element, callbacks) => { update(model), destroy() }`, with `host` the
  control's host element, came from the v0.6.0 `ui/` kit. The view contract is re-derived from `cloudcanvas-lib`'s
  `widget()` model in sprint B1. Models are plain data.
- **Markdown block.** A registration `{ match, render(host, source) => destroy }` for a fenced block or an inline
  span (**proposed**; the block registration is frozen in sprint B1). Placing the extension point on the CloudCanvas
  side comes from the superseded v0.6.0 discovery and is re-checked in sprint B0 (**open**, DESIGN §7).
- **Plugin host.** The existing contract in `src/core/plugins.ts` (`PluginFrontendContext`,
  `PluginFrontendModule`). The new client implements its `mount*` widgets with CloudCanvas controls (which ones:
  sprint B1); plugins do not change.

## 3. Data flow

1. A view reports an action through a callback.
2. A store in `src/client/state` sends it to the engine API with `fetch`.
3. The API server applies the gate and calls the route handler, which calls `src/server`.
4. The handler answers, or streams events; the store reads the stream (`session-core.ts` does this today) and
   produces the next model.
5. The view receives the next model, through the view contract re-derived in sprint B1 (was `update(model)`,
   superseded with the contract, §2).

Nothing skips a step: a view never fetches, and a store never touches the DOM.

## 4. Repository layout

| Path | Status | Contents |
|---|---|---|
| `src/{agent,core,server,store}` | upstream's, merged from `upstream/main` | the engine |
| `src/api/` | new | the engine's API server: `routes.ts`, `router.ts`, `server.ts` (the `node:http` adapter), `static.ts` (the client's files), `config.ts`, `log.ts` and the entry file (PLAN, sprint A1) |
| `src/client/` | new | the CloudCanvas client |
| `public/` | upstream's | in development, the new client's files sit here; the path `/client/` is **proposed** (sprint B1) |
| `extern/cloudcanvas` | submodule, added 2026-11-14 | `CloudsEcosys/cloudcanvas` pinned at `c5e6e07` (v0.6.0); **to be moved** in sprint B0 to the 0.7.x commit the owner names |
| `extern/cloudcanvas-lib` | submodule, added in sprint B0 | `CloudsEcosys/cloudcanvas-lib` at the commit the owner names |
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
| Client | CloudCanvas engine (0.7.x from sprint B0) and `cloudcanvas-lib`, native ES modules | no bundler for view code |
| TypeScript outside Next | `tsx` for development and tests (decided, DESIGN §3.1) | the production build tool is chosen in the cutover sprint; esbuild is **proposed** and already in the lockfile. The client's build path is frozen in sprint B1 |
| Styling | app themes (`src/core/themes.ts`) mapped onto CloudCanvas tokens | the kit's stylesheet and `--cc-*` tokens are from the superseded v0.6.0 discovery, re-checked in sprint B0; the mapping is frozen in sprint B1 |
| Tests | `node:test`; linkedom for views; `puppeteer-core` for the desktop window | linkedom and `puppeteer-core` are already dependencies; `puppeteer-core` drives `scripts/smoke-plugin-browser.mjs` today and is **proposed**, confirmed in sprint B1. The kit's `ui/testing` is from the superseded v0.6.0 discovery; how `cloudcanvas-lib` runs in tests is re-checked in sprint B0 |
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

### CloudCanvas changes (the owner, 2026-11-14)

Changes go as pull requests to the public repos (`CloudsEcosys/cloudcanvas-lib`, `CloudsEcosys/cloudcanvas`) from
this project's own clones under `/usr/lib/persist/peer/work/`, each on a feature branch with tests in that repo's
own harness. The owner merges; peer then moves its pin in a commit of its own. The owner's `~/cloudcanvas`
workspace is never touched. This is Stream L in `PLAN.md`.

## 7. Foundation the first phases build

1. The submodule (done, 2026-11-14) and the rule for moving its pin (above). In sprint B0 `extern/cloudcanvas` moves
   to 0.7.x and `extern/cloudcanvas-lib` is added, each in its own commit.
2. Type definitions for the CloudCanvas surface peer uses (a Stream L candidate from the superseded discovery;
   placed by the rule in sprint B1).
3. The API server in `src/api` (Phase 1), with the route table, the client's files, and a parity test against Next's
   standalone `server.js` (`.context/logs/reports/2026-11-14-api-parity-method.md`).
4. A non-blocking, configurable logger and explicit configuration for the API server and the client.
5. The three test layers: unit, integration (route parity), end to end (desktop window).
6. A build for the API server and the client that does not involve Next, beside the existing build.

## 8. Open

Decided on 2026-11-14 and moved out of this list (DESIGN §3, §3.1): how the client reaches the engine (HTTP), how
the client's files reach the window (the API process, same origin), the name `src/api`, and how TypeScript runs
outside Next in development and tests (`tsx`).

| Open point | Falls due |
|---|---|
| The production build tool for the API server and the client (§5); esbuild proposed | Cutover sprint (C) |
| The client's build and delivery paths: `/client/` under `public/` is proposed; which of today's `public/` files the new client needs | Sprint B1 |
| How the client is reached in development while both interfaces exist (which port, which origin) | Sprint B1 (client build and delivery paths) |
| The view contract (§2) and the Markdown block registration | Sprint B1; the owner approves the contracts |
| Whether the Markdown block extension point goes into CloudCanvas, and in what form (§2) | Re-checked in B0; placed by the rule in B1; a Stream L pull request if placed there |
| Where the route handler modules live once `app/` is deleted | Removal (D, Phase 5) |
