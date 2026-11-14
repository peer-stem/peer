# peer: specification

Status: foundation draft, 2026-11-14; §2, §6 and §7 corrected the same day to the owner's model (DESIGN §3: the
client is the host, and the Node process is only the engine's API). This states what must be true of the rewrite.
Points marked **open** are not decided, and points marked **proposed** await the owner.

## 1. Parity

The first release has every screen the current app has, with the same data and the same server behaviour.

| Screen | Route today | Current source (lines) |
|---|---|---|
| Home and session list | `/` | `home.tsx` 351, `sidebar.tsx` 971, `new-session.tsx` 398 |
| Session: transcript, composer, steering, side thread, activity, stats | `/chat/[id]`, `/chat/new` | `chat.tsx` 2,996, `session-core.ts` 1,257, `activity-dock.tsx` 540, `side-thread.tsx` 288, `composer.tsx` 242, `stats-bar.tsx` 213 |
| Questions, plan, practice | inside the session | `question-dock.tsx` 991, `plan-block.tsx` 984, `practice-cards.tsx` 300, `practice-dock.tsx` 218, `answered-card.tsx` 240 |
| Knowledge graph | inside the app shell | `graph-view.tsx` 1,705, `graph-canvas.ts` 1,753, `chain-table.tsx` 894, `extraction-coverage.tsx` 411 |
| Settings and first-run setup | `/settings` | `components/settings` 5,614, `setup-dialog.tsx` 610, `model-picker.tsx` 350 |
| Plugin views | `/plugins/[pluginId]/[viewId]` | `plugin-manager.ts` 666, `plugin-ui-host.tsx` 364 |
| Artifacts: demos, jobs, images | inside the session | `components/artifacts` 1,471 |
| Dictation and read-aloud | inside composers and replies | `dictation.tsx` 865, plus pull request 1 |

A screen has parity when its checklist passes. Each checklist is written in that screen's Definition sprint from
the current behaviour and the existing render tests, and is approved before development starts.

## 2. Engine API server

Status: **proposed** contract (sprint 1.1, item 1.4), awaiting the owner's approval. The directory name `src/api` is
**proposed**. The interface runs in the window (DESIGN §3); this server only answers the engine's API. It does not
serve, render or hand out the interface. Sources: **R** = `.context/logs/reports/2026-11-14-host-route-inventory.md`,
**St** = `.context/logs/reports/2026-11-14-host-static-surface.md`, **N** = Next 16.4.3's compiled source, read and
not run, at `/usr/lib/persist/peer/work/pr1/node_modules/next/dist/`.

### 2.1 Scope

| In | Out |
|---|---|
| The 50 route files, 73 exported methods and 5 streams under `/api` (R §1.4), plugin assets included (row 33) | Pages, `public/`, `/_next/**`, the client's own files: not Phase 1. How the client's files reach the window is a Phase 2 decision (**open**, ARCHITECTURE §8) |
| Calling the existing handlers in `app/api/**/route.ts` as they are | Editing anything under `app/`, `src/{agent,core,server,store}`, `proxy.ts` or `instrumentation.ts` |
| Running beside Next | Replacing Next for the old interface: it stays on Next, untouched, until Phase 5 |

### 2.2 Route record and handler

```ts
type Method = "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS";
type Params = Record<string, string | string[]>;
type RouteHandler = (request: Request, context: { params: Promise<Params> }) => Response | Promise<Response>;
interface RouteRecord { method: Method; pattern: string; handler: RouteHandler; file: string }
type Dispatch = (request: Request) => Promise<Response>;
```

- `RouteHandler` is the real shape: the second argument is a context object whose `params` is a `Promise`, and two
  handlers return synchronously, row 18 and row 17's `GET` (R §1.1 items 3-4). The server awaits the result either way.
- `pattern` keeps Next's folder syntax, for example `/api/chats/[id]/side-chats/[threadId]`. `[name]` gives a
  `string`, `[...name]` a `string[]` of at least one element (R §2.4). `file` is the route file it came from.
- The handler is the module's exported function, called unwrapped with a web `Request`. Handlers use only `Request`
  members (R §1.1 item 2).
- `Dispatch` is the router's single entry: gate, match and call (§2.4). It knows nothing about `node:http`, so the
  same table can sit behind another transport (**open** point on Electron's channel, ARCHITECTURE §8).

### 2.3 Adapter

```ts
function serveHttp(message: IncomingMessage, res: ServerResponse, dispatch: Dispatch): Promise<void>;
```

| `Request` property | Built from | Why |
|---|---|---|
| `url` | `http://<bound address>:<port>` plus the raw path and query, not re-encoded | Handlers parse it with `new URL` (R §2.7); the gate needs protocol `http:` (R §2.1) |
| `headers` | the client's headers verbatim, `Host` included | The gate and four same-origin checks read `Host` first (R §2.7) |
| `method` | as received | |
| `body` | `null` for GET and HEAD; otherwise the socket as a `ReadableStream`, unread and unbuffered, behind the cap in §2.6 | Seven routes read the raw stream (R §1.4) |
| `signal` | aborted when the client disconnects before the response is finished | Rows 35, 44, 49 and 50 rely on it (R §2.7) |

The response is written with its status and headers as given; a `null`, byte or stream body is written as §2.7 says.
A HEAD response is written without a body, and its body stream is cancelled.

### 2.4 Route table and order of checks

**Table (proposed).** `src/api/routes.ts` lists every route module once, by static import, with its file path. The
records are derived at start-up: each module's exported function named after a method in §2.2 becomes one
`RouteRecord`; other exports (`dynamic`, `runtime`) are ignored, since no route is cached under Next (R §2.6) and this
server caches nothing. `tests/api-routes.test.ts` walks `app/api/**/route.ts` and fails when a file is missing from
the list, the list names a file that does not exist, or a pattern differs from the one its path gives. Methods are
never listed by hand, so they cannot drift. Alternatives: discover the files at start-up (needs `app/` on disk at run
time), or generate the list with a script (a build step). Where the handlers live once `app/` is deleted is a Phase 5
point (**open**).

**Matching (proposed).** Static segments outrank dynamic ones and dynamic outrank catch-alls, as the repo states for
its one sibling pair (`app/api/settings/[section]/route.ts:28-30`; R §2.4). Parameters are percent-decoded per segment
(the repo's model of Next, `tests/plugin-document-integration.test.ts:42`); row 40 decodes again itself
(`route:41`). Both are settled by test (§2.10).

**Order, for every request:**

| Step | Condition | Answer |
|---|---|---|
| 1 | Path is neither `/api` nor under `/api/` | 404, no gate (**proposed**: Next serves pages there; this server serves none) |
| 2 | `apiRequestRefusal(request)` returns text (`src/server/desktop-access.ts:59-62`) | 403, `Cache-Control: no-store`, body `{"error":"<text>"}`, as `proxy.ts:9-14`. Every method, every `/api` path, known or not, before any 404 or 405 (R §2.1, §2.5) |
| 3 | No pattern matches | 404; headers and body settled by test (§2.10) |
| 4 | Pattern matches, method not exported | OPTIONS: 204 with `Allow` = the exported methods plus `OPTIONS`, plus `HEAD` when `GET` is exported, sorted and comma-joined (N `server/route-modules/app-route/helpers/auto-implement-methods.js:49-73`). HEAD: the route's `GET` handler, body not sent (same file, :39-46). Any other method: 405 with no body and no `Allow` (same file, :16-20). Wire details settled by test |
| 5 | Handler found | Call it. If it throws, 500; status, body and logging settled by test (R §2.10) |

**The exempt route.** Next exempts only `/api/plugins/[id]/documents/markdown` (row 35) from Proxy, because Proxy's
body clone truncates (`proxy.ts:4-6`, R §2.1). This server does not clone bodies, so (**proposed**) it gates row 35
like every other path. The route's own gate (`src/server/plugin-transport.ts:66-78`) stays and runs a second time:
same function, same request, same environment read per call (R §2.1), so the same verdict and the same response.
Alternative: copy Next's matcher exemption. The difference is not observable on the wire.

### 2.5 Gate inputs

The gate reads `process.env` on every call (`src/server/desktop-access.ts:59`; R §2.1). The server must not copy or
cache `LH_DESKTOP_SERVER`, `LH_DESKTOP_API_SECRET` or `LH_ALLOWED_HOSTS`. It supplies the client's `Host` header and
an `http:` URL (§2.3).

### 2.6 Request bodies

| Routes | Today under Next | This server |
|---|---|---|
| Row 35 | Not behind Proxy, never truncated; bounds itself at 27,262,976 bytes (R §1.3 row 35) | Body handed through unread, no cap |
| Every other `/api` route | Behind Proxy: beyond 27,262,976 bytes (`proxyClientMaxBodySize`, `next.config.ts:13`, `lib/notes-import-limits.ts:3`) the handler gets the first 27,262,976 bytes, a warning is logged and the client gets no error (R §2.2) | **Proposed**: the same cap, applied the same way. The body stream ends at byte 27,262,976 and a warning is logged |

Why the cap is kept: Phase 1 is accepted on parity, and the 20 routes that read `json()` have no byte bound of their
own (R §2.2), so dropping the cap would let them buffer bodies of any size. The six other raw-stream routes (17, 22,
27, 44, 46, 49) bound themselves below or at the cap (R §2.2). Replacing the silent cut with a 413 would be better
behaviour but is a change. **Open** for the owner. The cut point is decided by `bodyLimit(pathname): number | null`
in `src/api/router.ts`, the one place that knows the exemption. Settled by test: whether `content-length`
survives, what happens to the bytes past the cap, and whether a bodiless request gives `null` or an empty stream
(R Not verified 9).

### 2.7 Streams

Applies to every stream body: the 5 streamed routes (rows 10 POST, 11 GET, 14, 18, 49; R §1.4), the fixed-body SSE
answers (row 3, row 14 with no turn running) and anything else that returns a stream.

1. Status and headers are written and flushed as soon as the handler's `Response` resolves, before the first body
   byte. Row 18 writes nothing until an event or the 25 s ping, and `EventSource` opens only on headers (R §2.7).
2. Each chunk is written as it arrives. No buffering, no compression (**proposed**), no `Content-Length`. When the
   socket asks for back-pressure, reading waits for `drain`.
3. If the socket closes before the body ends, `response.body` is cancelled. That runs the `cancel()` hooks that remove
   bus listeners and timers (`src/server/events-stream.ts:68-72`, `src/server/pi/ui-stream.ts:350-355`,
   `src/server/side-chat.ts:108`; R §2.7). `request.signal` is aborted at the same time.

### 2.8 Start-up, environment, binding

| Step | What | Evidence |
|---|---|---|
| 1 | Read `PORT` and `HOSTNAME` (the only variables the server itself reads) | Next's `server.js` reads them today, not repo code (R §2.11) |
| 2 | Import the route modules. This runs their import-time effects: `initAuthEnv()`, `configureWorkerRequestAdmission`, `syncCustomProvider()`, `setTurnRunner`/`setJobRespawn`/`setFileAccessPolicy` | R §2.3 |
| 3 | `await initializePlugins()` from `src/server/plugins.ts`, called directly. A failure logs `[plugins] Initialization failed; plugin management will report the error:` and start-up continues | `instrumentation.ts:3-7`. Its `NEXT_RUNTIME` guard is false outside Next, so it cannot be reused (R §2.3) |
| 4 | Listen on `HOSTNAME`:`PORT`. **Proposed**: `HOSTNAME` defaults to `127.0.0.1`; `PORT` has no default, and the server refuses to start without it, so it never takes Next's 3000 while both exist | `next start -H localhost` and the shell's `HOSTNAME=127.0.0.1` (R §2.11) |
| 5 | Stop on `SIGTERM`: close the listener, end open streams, exit within 3 s | The shell sends `SIGKILL` 3 s after `SIGTERM` (`electron/main.cjs:279-292`) |

- **Working directory**: the directory holding `scripts/plugin-loader.cjs` and `core-plugins/`
  (`src/server/plugin-host.ts:329`, `src/server/plugins.ts:28-32`; St §6).
- **Variables read by engine code, passed through untouched**: `LH_DATA_DIR`, `LH_AUTH_FILE`, `LH_ALLOWED_HOSTS`,
  `LH_DESKTOP_SERVER`, `LH_DESKTOP_API_SECRET`, `LH_IGNORE_ENV_KEYS`, `LH_UPDATE_FLUSH_MS`, `LH_PROVIDER_EVENTS`,
  `LH_BACKGROUND_CAPTURE`, `NODE_ENV`, `CHROME_PATH`, `LOCALAPPDATA`, `PROGRAMFILES`, and the managed provider key names
  (R §2.11). The server does not set `NODE_ENV`; its caller does, as the shell does today (`electron/main.cjs:225-238`).
- **Desktop app (Phase 4)**: the server must be the shell's direct child with the `ipc` channel, since the ChatGPT and
  subscription bridges use `process.send` (R §2.11).
- How the TypeScript sources and the `@/` alias run outside Next (a bundle or a loader) is **open** (R Not verified
  14). The test runner already imports route modules under `tsx` (`package.json:19`,
  `tests/file-access-settings.test.ts:27`).

### 2.9 Not done by this server (proposed)

No `x-powered-by`, no gzip, no ETag of its own, no trailing-slash redirect unless §2.10 shows Next applies one to
`/api`, no caching, no CORS headers. Logging is non-blocking and configured explicitly; its variable names are
**open**.

### 2.10 To be settled by a test

Each line is a named case in `tests/api-parity.test.ts`. The method is in
`.context/logs/reports/2026-11-14-api-parity-method.md` §8. Until a case has run, the behaviour above is a proposal.

| Case | Question (R "Not verified" item) |
|---|---|
| `head-on-get-route` | HEAD on a GET-only route: GET handler run, headers, `content-length` (1) |
| `405-shape`, `auto-options`, `static-before-dynamic`, `unknown-method` | 405 headers and body; automatic OPTIONS on the wire; `PUT /api/settings/prompts` gives 405, not `[section]`; a method outside the seven (2) |
| `param-decoding` | `%2D`, `%2F`, `%25`, non-ASCII in `[id]` and catch-alls (3) |
| `request-url-and-host` | Host and protocol handlers see (4) |
| `abort-on-disconnect`, `cancel-on-disconnect` | `request.signal` aborted and `response.body` cancelled when the client leaves (5) |
| `default-headers`, `gzip` | Headers Next adds to route answers; gzip with `Accept-Encoding: gzip` (6) |
| `trailing-slash` | `/api/x/` redirect: status, query kept, order against the gate (7) |
| `handler-throws`, `unknown-api-path` | 500 shape; 404 shape when the gate passes (8) |
| `bodiless-shape`, `body-cap` | `null` or empty stream; `content-length` and the bytes past 27,262,976 (9) |
| `shared-registries` | One module instance across routes: a turn started on row 3 is seen by row 8 (10) |
| `outbound-fetch-uncached` | Server-side `fetch` not cached: two calls to row 50 see a changed upstream (11) |
| `sigterm-stop`, `long-stream` | Exit within 3 s on SIGTERM; a stream held past Node's default timeouts (12) |
| `matcher-encoded-paths` | Encoded forms of the exempt path (13) |
| `routes-import` (in `tests/api-routes.test.ts`) | Every route module loads under the chosen runtime (14) |

## 3. Client

1. Contains no React, no Next.js and no Tailwind.
2. Every view follows `create(host, callbacks) => { update(model), destroy() }` and keeps no application state.
3. Only `src/client/state` calls the engine API.
4. Markdown renders everything `streamdown` renders for the tutor today, including code with highlighting, LaTeX
   math, Mermaid diagrams and text that is still streaming.
5. Model-produced text never reaches the DOM as markup. Where a diagram library returns SVG, it is inserted under
   the same restrictions the app applies today (`securityLevel: "strict"` for Mermaid).
6. Interactive demos stay in a sandboxed frame with an opaque origin.
7. Keyboard behaviour matches the current shortcuts (`docs/keyboard.md`).
8. The plugin frontend contract in `src/core/plugins.ts` is met without changing any plugin.

## 4. Data

1. Storage formats do not change. A state directory written by the current app opens in the new one, and the
   reverse, for as long as both exist.
2. No migration runs at cutover.

## 5. Code

1. At most 500 lines per file, 50 per definition, three levels of indentation.
2. Every unit has tests in the same change.
3. No secret, credential or learning record is committed.
4. Logging is non-blocking and configurable; configuration is explicit.
5. Changes inside `src/{agent,core,server,store}` are kept small and separable, because that tree merges from upstream.

## 6. Tests

| Layer | What it covers | Tooling |
|---|---|---|
| Unit | stores, views, blocks; the API router and adapter (`tests/api-*.test.ts`) | `node:test`, linkedom, the kit's `ui/testing` |
| Integration | every `/api` route and method answers the same under Next and under the API server: status, headers, body, streams, gate (`.context/logs/reports/2026-11-14-api-parity-method.md`) | `node:test` against both servers on scratch data; run on request, because it needs a Next build (**proposed**) |
| End to end | each screen's parity checklist in the real desktop window, on a copy of real state | browser driver **open** (ARCHITECTURE §5) |
| Regression | the existing logic suite (`tests/*.test.ts`) stays green throughout | `npm test` |

## 7. Acceptance by phase

| Phase | Accepted when |
|---|---|
| 1 Engine API | The integration layer passes for every route and method, and the owner has approved each recorded difference; every case in §2.10 has run and the contract states its result; the logic suite is green. The old interface is not moved: it stays on Next |
| 2 Client base | A saved session opens read-only in the new client from live data; the unit layer exists and passes |
| 3 Screens | Every screen's checklist passes end to end in the new client |
| 4 Cutover | The packaged desktop app runs the API server and the new client and passes end to end on a copy of real state |
| 5 Removal | No React, Next.js or Tailwind remains in the dependency tree; one upstream merge has been rehearsed and documented |
| 6 Canvases | Defined in that phase's Definition sprint |

## 8. Open

- The parity checklists themselves (§1).
- Whether the session stream protocol needs any change for the new client. Proposed: none.
- Accessibility targets beyond matching current behaviour.
- §2: the name `src/api`; the body cap (keep Next's silent cut, or answer 413); `PORT` with no default; the
  logging variables; how the TypeScript runs outside Next; where the handlers live after Phase 5.
- How the client reaches the engine: HTTP (assumed, not confirmed) or Electron's own channel (ARCHITECTURE §8).
