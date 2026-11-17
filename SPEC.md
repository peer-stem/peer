# peer: specification

Status: updated 2026-11-17 to preserve the full Engine API specification (`§2.1–§2.11`), Phase Acceptance (`§7`), and Open Decisions (`§8`, including `D1–D6`, the 8 recorded parity differences, and the Governor review `§10` owner gates), alongside the owner-approved contracts (`pdl 1f0fed50e576`) for **Hardware Safety**, **LumberJack DAG Storage**, **MFN 2.0 Context Mapping**, **CloudCanvas Client**, and the **LearnHarness Importer**. Points marked **open** await Richard's decision; points marked **decided** were decided by Richard.

## 1. Hardware & Storage Safety Contract (`src/substrate/`)

1. **Permitted compute backends**: `"cpu"` (default) and `"vulkan"` (`Nova/Vulkan`).
2. **Forbidden backends**: `"cuda"`, `"rocm"`, `"hip"`, `"nvidia"`, `"amd"`, `"opencl"`, `"sycl"`, `"metal"`, `"auto"`, or any unknown token MUST throw immediately in `resolveComputeBackend`.
3. **Environment scrubbing (`src/substrate/gpu-policy.mjs`, `sanitizeComputeEnv`)**:
   - Every child process spawned by `peer` (`mfn-engine`, compilers, workers) runs with all `CUDA_*`, `NVIDIA_*`, `NVCC_*`, `NCCL_*`, `ROCR_*`, `ROCM_*`, `HIP_*`, `HSA_*`, `MIOPEN_*`, `GPU_*`, and `AMD_*` environment variables stripped, and with `CUDA_VISIBLE_DEVICES=""`, `ROCR_VISIBLE_DEVICES=""`, `HIP_VISIBLE_DEVICES=""`, `NVIDIA_VISIBLE_DEVICES="none"`.
   - `OLLAMA_LLM_LIBRARY` is set in spawned child environments to `"cpu"` (when `backend === "cpu"`) or `"vulkan"` with `OLLAMA_VULKAN="1"` (when `backend === "vulkan"`).
   - **Open (`M3`, §10.2)**: When MFN calls an already-running external Ollama service on `http://127.0.0.1:11434`, `peer`'s child-process environment does not govern that external daemon; how `peer` enforces CPU/Vulkan on the embedder (probe/refuse external GPU Ollama vs supervise a `peer`-owned Ollama under the guard) awaits owner decision `§10.2`.
4. **Native binary verification**: `ldd` on every built native artifact under `/usr/lib/persist/peer/build/` MUST match zero CUDA or ROCm shared libraries (`assertNoForbiddenGpuLibraries`), with SHA-256 digests recorded in `/usr/lib/persist/peer/build/substrate-manifest.json`.
5. **SSD & zero-`/tmp` rule**: All builds, Go/Cargo/Zig caches (`GOCACHE`, `GOMODCACHE`, `GOPATH`, `CARGO_HOME`), test fixtures, and runtime state reside under `/usr/lib/persist/peer/{build,scratch,state}` on SSD. Nothing writes to `/tmp` or pollutes `~/go` / `~/.cargo`.

## 2. Engine API Server (`src/api/`)

Status: implemented on `src/api` (merged in PR #5 `4fc52b3`, with A2 follow-up items 1–8 remediated in Sprint `S3`). Sources: **R** = `.context/logs/reports/2026-11-14-host-route-inventory.md`, **St** = `.context/logs/reports/2026-11-14-host-static-surface.md`, **N** = Next 16.4.3 compiled server modules.

### 2.1 Scope

| In | Out |
|---|---|
| The 50 route files, 73 exported methods, and 5 streams under `/api` (R §1.4), plugin assets included (row 33) | Pages, `/_next/**`, server-side rendering |
| Serving the client's static files unchanged on the same origin (§2.11) | Modifying static client files in transit |
| Calling existing route handlers in `app/api/**/route.ts` unwrapped with a web `Request` | Removing Next.js before Phase 5 (`C3`) cutover |

### 2.2 Route record and handler

```ts
type Method = "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS";
type Params = Record<string, string | string[]>;
type RouteHandler = (request: Request, context: { params: Promise<Params> }) => Response | Promise<Response>;
interface RouteRecord { method: Method; pattern: string; handler: RouteHandler; file: string }
type Dispatch = (request: Request) => Promise<Response>;
```

- `RouteHandler` passes `{ params: Promise<Params> }` and awaits both synchronous and async handlers.
- `pattern` preserves `[name]` (`string`) and `[...name]` (`string[]` of >= 1 element).
- `Dispatch` is transport-agnostic (`(request: Request) => Promise<Response>`); **decided**: client reaches engine over HTTP (`DESIGN §3.1`).

### 2.3 Adapter

```ts
function serveHttp(message: IncomingMessage, res: ServerResponse, dispatch: Dispatch, options?: ServeHttpOptions): Promise<void>;
```

- Note (`D6`, **open**): `serveHttp` accepts an optional 4th `options` parameter (`onError`, body/header hooks), whereas the initial draft listed 3 arguments.
- `url`: `http://<bound address>:<port>` plus raw path and query (not re-encoded); absolute-form request targets are normalized to path+query.
- `headers`: client headers verbatim (`Host` preserved for `apiRequestRefusal` and same-origin checks).
- `body`: `null` for `GET` and `HEAD`; otherwise unbuffered socket `ReadableStream` behind `bodyLimit(pathname)` (§2.6).
- `signal`: aborted when client disconnects before response finishes.
- `HEAD` responses write headers without body and cancel `response.body`.

### 2.4 Route table and order of checks

- `src/api/routes.ts` statically imports all 50 route modules; `tests/api-routes.test.ts` enforces 1:1 parity with `app/api/**/route.ts`. Where handlers move when `app/` is removed in `C3` remains a cutover detail.
- Static segments outrank dynamic `[id]`, which outrank catch-all `[...path]`; parameters are percent-decoded per segment (`400` on malformed `%` sequences).
- **Order for every request**:
  1. Path neither `/api` nor under `/api/` -> handed to `src/api/static.ts` (§2.11), ungated.
  2. `apiRequestRefusal(request)` returns refusal text -> `403`, `Cache-Control: no-store`, `{"error":"<text>"}` before any `404` or `405` (and logged via `onRefusal`).
  3. No pattern matches -> `404` with empty body (`0` bytes; recorded difference `unknown-api-path-404` vs Next HTML 404).
  4. Pattern matches, method not exported -> `OPTIONS`: `204` with sorted `Allow` (`OPTIONS`, exported methods, plus `HEAD` if `GET` exported); `HEAD`: runs `GET` handler and strips body; other 7-method verbs: `405` empty body, no `Allow`. Methods outside the 7: `TRACE` returns `500` `text/plain` before gate (matching Next); unknown tokens (`FOO`, `PURGE`) return `400`.
  5. Handler found -> invoked; uncaught throw logs `[api] Unhandled route error` with route path and returns `500` empty body.
- `/api/plugins/[id]/documents/markdown` (row 35) passes through router gate and its own handler gate identically without body cloning.

### 2.5 Gate inputs

`apiRequestRefusal` reads `process.env` dynamically per call (`LH_DESKTOP_SERVER`, `LH_DESKTOP_API_SECRET`, `LH_ALLOWED_HOSTS`); `src/api` never caches those variables.

### 2.6 Request bodies

- **Decided**: `/api/plugins/[id]/documents/markdown` has no router cap (`bodyLimit === null`, self-bounded at `27,262,976` bytes); every other `/api` route caps the request stream at `27,262,976` bytes (silent stream cut + warning log, matching Next `proxyClientMaxBodySize`).

### 2.7 Streams

1. Status and headers flush immediately (`res.flushHeaders()`) upon `Response` resolution before the first body byte (recorded difference `events-header-flush-timing` vs Next buffering `/api/events` headers).
2. Chunks write unbuffered without gzip or `Content-Length`, honoring socket `drain` back-pressure.
3. Client disconnect aborts `request.signal` and cancels `response.body` so bus listeners and timers clean up immediately.

### 2.8 Start-up, environment, binding

1. Reads `PORT` (**decided**: required, no default) and `HOSTNAME` (defaults to `127.0.0.1`; `D3` **open** on non-loopback values).
2. Imports route modules (running import-time auth/worker/provider/turn-runner registration) and calls `await initializePlugins()` (logging and continuing on plugin init failure).
3. Registers `uncaughtException` and `unhandledRejection` handlers (logging via structured JSON logger with `timestamp`/`message` keys, keeping server alive).
4. `SIGTERM` / `SIGINT`: arms force-close deadline (`3 s`), closes listener, cancels open streams, logs forced-exit with `{ timestamp, level, message }` if forced, and exits within `3 s` (recorded difference `sigterm-open-sse-exit` vs Next hanging past 3 s on open SSE).

### 2.9 Not done by this server

No `x-powered-by`, no Next `RSC` `Vary` header (`next-app-route-vary`, `next-proxy-vary`), no gzip, no ETag generation outside route handlers, no trailing-slash `308` redirect (`D1` / `trailing-slash-redirect-vs-gate-and-404`), no caching, no CORS headers. Structured non-blocking logger configured via `LH_LOG_LEVEL` (`D2`, **open**).

### 2.10 Settled by parity & unit tests (`tests/api-parity*.ts`, `tests/api-*.test.ts`)

| Case | Verified wire outcome (`src/api` vs Next 16.4.3 standalone) |
|---|---|
| `head-on-get-route` | Both run `GET`, send matching headers/`content-type`, and send `0` body bytes |
| `405-shape`, `auto-options`, `static-before-dynamic`, `unknown-method` | `405` has `0`-byte body and no `Allow`; `OPTIONS` returns `204` + sorted `Allow`; `PUT /api/settings/prompts` hits static `405` (not `[section]`); `FOO`/`PURGE` -> `400`, `TRACE` -> `500` (`trace-method-500-headers`) |
| `param-decoding` | Single-segment and catch-all `[...path]` decode `%2D`, `%2E`, `%2F`, `%25`, UTF-8 `%C3%A9` identically |
| `request-url-and-host` | Handlers see `http:` protocol and verbatim `Host` header |
| `abort-on-disconnect`, `cancel-on-disconnect` | Both abort `request.signal` and cancel `response.body` SSE readers on socket close |
| `default-headers`, `gzip` | Next adds `vary` (`next-app-route-vary`, `next-proxy-vary`); `src/api` omits Next's `vary` and serves uncompressed bodies |
| `trailing-slash` | Next `308` redirects pre-gate; `src/api` gates first (`403`) or returns `404` (`trailing-slash-redirect-vs-gate-and-404`, `D1`) |
| `handler-throws`, `unknown-api-path` | Throw -> `500` empty body + `[api] Unhandled route error` naming route path; unmatched `/api/*` -> `404` empty body vs Next HTML (`unknown-api-path-404`) |
| `bodiless-shape`, `body-cap` | Bodiless `POST`/`DELETE` match (`400` on routes requiring JSON); cap cuts cleanly at byte `27,262,976` while row 35 passes `27,262,977`-byte payloads |
| `shared-registries`, `outbound-fetch-uncached`, `routes-import` | Single module registry shared across all 50 routes; outbound `fetch` uncached; all 50 route files load cleanly under `tsx` |
| `sigterm-stop`, `long-stream`, `matcher-encoded-paths` | `src/api` exits `< 3 s` on `SIGTERM` with open SSE (`sigterm-open-sse-exit`); streams survive past idle defaults; percent-encoded gate paths match |

### 2.11 The client's files

**Decided** (2026-11-14): `src/api/static.ts` serves static client assets unchanged on the same origin for non-`/api` paths, ungated, resolving the static root once at startup and preventing path traversal. Exact client bundle paths/headers are finalized with `C1` (§8).

## 3. LumberJack Forest & Multi-Parent DAG Contract (`src/store/lumberjack/`)

1. **ABI & Single Go Archive**: Links against LumberJack C-ABI v2 (`LJ_ABI_VERSION == 2u`, `LJ_MUTATION_OUT_MIN == 16384`, `LJ_MAX_PATH == 4096`) in a single Go `c-archive` (`liblumberjack_peer.a` + `lumberjack_peer.node`).
2. **Locking & Adoption**: Honors `LJ_LOCKED` vs `LJ_UNGUARDED` (never auto-adopted without explicit human command).
3. **Domain Mapping & Current `S1/S3` Standing**:
   - Knowledge propositions (`knowledge/propositions/<id>`), derivation chains (`knowledge/chains/<id>`), sources/folders (`knowledge/sources/<id>`), lesson plan trees (`plans/<chat_id>/<node_id>`), learner progress (`learner/*`), settings, themes, prompt overrides, and validated plugin records are stored as LumberJack `Node`s with multi-parent `Parents` (`delete_node` severs both target-to-parent and child-to-target links) and typed `Metadata`. Ledger rewrites preserve FSRS/mastery state on propositions and preserve existing source usage logs.
   - Live mutations stream to `/api/events` via `ic_lj_stream_poll` parsing LumberJack's `node_path` wire field (`epoch` + `after` cursor, re-deriving state on `LJ_GAP`).
   - **Open (`L5`, `L6`, §10.3)**: Target contract places conversations/billing/jobs solely in LumberJack `Event`/`Entry` records and binary images/PDFs solely in `/objects` (`ic_lj_application_call`). In `S1/S3`, `chat-store.ts` and `job-store.ts` store canonical JSON in node slots alongside an `Event`/`Entry` mirror, and `ops_objects.go` stores images as node attachments while `/objects` HTTP passthrough is exposed. Moving canonical storage to `/objects` and `Event`/`Entry` before `C1` vs amending `§3.3` awaits owner decision `§10.3`.
4. **Secrets Isolation**: API keys and tokens remain in `0600` files (`state/auth.json`, `state/mfn/secrets/api-token`) outside forest projections.

## 4. MFN 2.0 Learned Memory & Context Mapping Contract (`src/memory/mfn/`)

1. **Dedicated Supervised Instance**: `peer` supervises its own MFN 2.0 controller (`ifr`, `dsr`, `alm`, `cpe`, `psr`, `mfn-gateway`) on `127.0.0.1` over `0700` sibling directories `state/mfn/data` and `state/mfn/runtime` with `0600` `state/mfn/secrets/api-token`, strict 13-key OS environment allow-listing, live child-exit readiness reset, `/proc` `(pid, starttime)` + `MFN_RUNTIME_DIR` detached-child cleanup on timeout/stop, and a clean-exit `process.on("exit")` `SIGTERM` hook (`N5` single-flight/cross-process lock awaits owner decision).
2. **Embedder Pin (`MFN_EMBEDDERS_FILE`)**: Atomic `0600` single-link file (`format_version: 1`) targeting loopback IP literal `http://127.0.0.1:11434`, `nomic-embed-text:latest` (`768` dims), and verified 64-hex `model_digest`.
3. **Context Assembly (`turn.recall`) & Current `S2/S3` Standing**:
   - Retains a compact exact live tail (`~4k–6k` tokens) and calls `POST /v2/execute` (`op: "turn.recall"`) under a hard wall-clock deadline with `window.memory_ids` and `exclude_memory_ids` (zero duplicate live-tail memories), hydrating lexical fallback hits at `<= 2` concurrent `memory.peek` calls (`<= mfn-gateway`'s 4-in-flight bound) without discarding sibling hits if one peek fails.
   - **Degraded behavior & `N3` (**open**, §9.2)**: When MFN is unreachable or returns a recall error (`ECONNREFUSED`, timeout, `409`, `404`, `401`), `prepareTurnContextWithMfn` degrades to the `~5k`-token live tail without recall or LLM compaction (because compaction is bypassed while MFN is registered); if `prepareTurnContextWithMfn` throws outside recall, `prepareMfnTurnBridge` falls back to the raw uncompacted transcript (which on a long chat can exceed a model's context window). Whether MFN-down turns keep live-tail-only or fall back to compaction awaits owner decision `§9.2`.
   - **Current wiring (`M9`)**: Recall and ingest currently execute in `src/server/chat-handler.ts` via `src/server/mfn-turn-bridge.ts` when an MFN runtime is registered (`master` registers none until `C1`). Extraction/check-resolution ingest hooks, importer backfill, and deletion of `src/core/compaction.ts` + `src/server/compaction.ts` complete during `C1–C3`.
   - **Open (`M4`, `M5`, §10.4)**: Untrusted fencing/role framing of recalled text (`M4`) and maximum character/token size caps on ingested and recalled memory blocks (`M5`) await owner decision `§10.4`.
4. **Settlement (`turn.ingest`), `memory.put`, Backoff & Dead-Letter Outbox**:
   - Calls `POST /v2/execute` (`op: "turn.ingest"` on main pool and `op: "memory.put"` on lexical pool) with idempotent UUIDv7 `operation_id` and `< 2^62` memory IDs. Batch or lexical failures never abort remaining batches or lexical puts of the turn (`N6`).
   - Both `turn.ingest` and `memory.put` treat `503 admission_paused` and `503 embedder_unavailable` as retryable and queue failed writes into `MfnIngestOutbox` (`src/memory/mfn/outbox.ts`), removing entries by `operationId` rather than queue position (`N4`).
   - Retries are bounded by age (`maxAgeMs`, default 7 days) with exponential backoff (`nextRetryAtMs`), never by flush count (`N1`). Systemic replay errors (`401`/`403`, `409 embedder_mismatch`, `404` missing pool, `5xx`/network) stop the drain and preserve queued entries intact (`N2`), while per-item poison errors (`400`/`413`/`415`/`422`) and age-expired entries move into a persisted `dead_letter` list (`format_version: 3`).
   - `createLumberJackOutboxPersistence` (`"memory/outbox"` node slot), atomic `0600` file persistence (with `.corrupt.*` backup and `.tmp.*` sweep), and `startAutoFlush` are implemented on `MfnIngestOutbox`; wiring them into server startup occurs in `C1` (without options, `new MfnIngestOutbox()` is in-memory and unscheduled).

## 5. Explicit LearnHarness Importer (`src/store/import-learnharness.ts`)

1. `peer` starts with a clean forest (zero automatic startup migration).
2. `importLearnHarnessData(sourceDir)` reads a LearnHarness directory strictly read-only (rejecting symlinks and opening regular files with `O_NOFOLLOW`, guarding directory/file read errors without aborting healthy files, rejecting `""`/`.`/`..` IDs, normalizing missing chat `updatedAt`, unwrapping `{ positions, updatedAt }` from `positions.json`, validating ledger shapes, preserving flashcard `reviews`, and retaining existing higher-rep/newer FSRS schedules) into LumberJack.

## 6. CloudCanvas Client & Code Standards

1. **Client (`src/client/`)**: Zero React, Next.js, or Tailwind. Built with CloudCanvas (`0.7.1`) + `cloudcanvas-lib` (`0.7.1`); exact view/widget contract awaits owner decision `§10.5`. Model-produced text never enters the DOM as raw HTML; Mermaid runs with `securityLevel: "strict"`; interactive demos run in opaque-origin sandboxed frames.
2. **Code Bounds**: Max `500` lines per file, `50` lines per definition (function, method, or class), `3` levels of tab indentation (`N14` line-density cleanup awaits owner decision).
3. **Tests & Gate Commands (`tests/`, `package.json`)**:
   - Required substrate gate command: `npm run test:gate` (`NODE_ENV=test PEER_REQUIRE_SUBSTRATE=1 tsx --test tests/*.test.ts tests/*.test.tsx`) and `npm run test:substrate`.
   - Default `npm test` skips prebuilt-binary suites cleanly when native artifacts are absent (`F6`); setting `PEER_REQUIRE_SUBSTRATE=1` enforces their execution (`N13`).
   - Engine API parity gate: `npm run build && NODE_ENV=test PEER_API_PARITY=1 tsx --test tests/api-parity.test.ts` (plus `PEER_API_PARITY_LONG=1` for `long-stream`).

## 7. Acceptance by Phase

| Phase | Accepted when |
|---|---|
| **A: Engine API (`A1–A2`)** | All 50 routes / 73 methods / 5 streams pass parity against Next standalone, all §2.10 cases are recorded, §8 A2 follow-up items 1–8 pass tests, and Richard approves or closes `D1–D6` + the 8 recorded parity differences (§8.1–§8.2) |
| **S0–S3: Native Substrate, LumberJack & MFN** | Submodules clean & pinned; `build-substrate.mjs` runs end-to-end with `substrate-manifest.json` SHA-256 verification and SSD-only caches; zero CUDA/ROCm libs/env; Governor review §9 findings (`M1,M2,M6–M8,M10–M13`, `L1–L4,L8–L11`, `F1–F6`, `§7`, `§8`) resolved with regression tests; §10 owner decisions settled before `C1` |
| **C1–C2: CloudCanvas `peer` App** | Knowledge/Mastery DAG canvas, Lesson/Practice workspace with MFN recall/theme visibility, Flashcards FSRS, Settings/Models/Voice, Plugins, and LearnHarness Import UI pass linkedom unit tests and `puppeteer-core` E2E against live `src/api` + LumberJack + MFN |
| **C3: Desktop Cutover & Removal** | Packaged Electron app runs `src/api` + LumberJack + MFN + CloudCanvas client end-to-end; `app/`, React `components/`, Next.js, Tailwind, raw-file store adapters, and LLM compaction are removed; full QA passes and Richard signs off Trial |

## 8. Open Items & Owner Decisions

### 8.1 Engine API Decisions (`D1–D6`, from Sprint A2 Review)

| ID | Open point | Status |
|---|---|---|
| `D1` | `/api/x/` trailing slash: Next answers `308` before gate; `src/api` answers `403` (refused) or `404` (gate first) | **Open** (§10.6) |
| `D2` | `LH_LOG_LEVEL` introduced as explicit logger configuration environment variable (§2.9) | **Open** (§10.6) |
| `D3` | `HOSTNAME` is bound as given (`127.0.0.1` default), allowing non-loopback binding when explicitly set | **Open** (§10.6) |
| `D4` | Owner approval of the 8 `RECORDED_DIFFERENCES` in `tests/api-parity-compare.ts` (§8.2; all remain `approved: false`) | **Open** (§10.6) |
| `D5` | Canonical SSD scratch root: `/usr/lib/persist/peer/scratch` (used across tests and build scripts) | **Open** (§10.6) |
| `D6` | `serveHttp` optional 4th `options?: ServeHttpOptions` parameter vs 3-parameter draft in §2.3 | **Open** (§10.6) |

### 8.2 Recorded Engine API Parity Differences (`tests/api-parity-compare.ts`, all `approved: false`)

1. `next-app-route-vary`: Next adds `vary: "rsc, next-router-state-tree, ..."`; `src/api` omits it (§2.9).
2. `next-proxy-vary`: Next `proxy.ts` adds `vary: "Accept-Encoding"` on `403`; `src/api` omits it (§2.9).
3. `custom-provider-per-process-etag`: `/api/custom-provider` computes HMAC ETag from a per-process 32-byte startup key.
4. `unknown-api-path-404`: Unmatched `/api/*` post-gate returns `404` empty body on `src/api` vs HTML `_not-found` on Next (§2.4).
5. `trailing-slash-redirect-vs-gate-and-404`: Trailing-slash `/api/.../` returns `403`/`404` on `src/api` vs pre-gate `308` on Next (`D1`).
6. `trace-method-500-headers`: `TRACE /api/...` returns `500` on both; Next adds `vary`/`cache-control`/`etag`, `src/api` sends `text/plain; charset=utf-8`.
7. `events-header-flush-timing`: `GET /api/events` flushes headers immediately (`< 50 ms`) on `src/api` vs Next buffering until first SSE frame (§2.7).
8. `sigterm-open-sse-exit`: `SIGTERM` with `/api/events` open exits `< 3 s` on `src/api` vs Next waiting past `3 s` (§2.8).

### 8.3 Governor Review & Re-Review Owner Decisions (`§10` of `8b2b718` review; `§8.5` & `§9` of `5ad6577` re-review)

| # | Decision | Waiting items |
|---|---|---|
| `§10.1` / `§9.1` | Correction sprint (`S3`) + second pass (`§8` of re-review) before PR / `C1` — authorized by Richard | Executing in `S3` |
| `§10.2` | `M3`: How `peer` guarantees CPU or Nova/Vulkan on the embedder — check running Ollama and refuse if it reports forbidden GPU use, or supervise a `peer`-owned Ollama under `hardware-guard.ts` | **Open** (`M3`) |
| `§10.3` | `L5`, `L6`: Move images through `/objects` and conversations/jobs canonically to `Event`/`Entry` records before `C1`, or accept JSON slots/attachments and amend `§3.3` | **Open** (`L5`, `L6`, `L7`) |
| `§10.4` + `§9.2` | `M4`, `M5`, `N3`: Untrusted fencing/framing (`M4`) and size cap (`M5`) of recalled memory blocks, plus MFN-down behavior (`N3`: live-tail-only vs compaction fallback, and bounding bridge fallback on long chats) | **Open** (`M4`, `M5`, `N3`) |
| `§10.5` | Client contract for `C1`: adopt/adapt the `feature/2.1-client-base-definition` (`f7b3a62`) B1 contracts, or derive anew for CloudCanvas + LumberJack + MFN | **Open** (blocks `C1`) |
| `§10.6` | `D1–D6` and the 8 recorded parity differences (§8.1–§8.2): approve/settle as open, or close by change of direction | **Open** (`D1–D6`) |
| `§9.3` | Whether the Governor marks supported Sprint `S0–S3` PDL step claims verified | **Open** (Governor / Owner) |
| `§9.4` | `N15`: Upgrade Next 16.4.3 now for its upstream advisory notice, or leave until `C3` removes Next.js | **Open** (`N15`) |
| `§8.5` (owner) | Deferred minor items reserved for owner decision: `N5` (`supervisor` single-flight/`/proc` scan), `N9` (orphaned progress records & ledger re-parse), `N11` (`stream-events` initial cursor & duplicate emit), `N14` (line-length density in 9 near-500-line files) | **Open** (`N5, N9, N11, N14`) |

Signature: Google gemini-4-carbon high - 04da2a6d-9328-4ad4-b892-398e4c39b74c
