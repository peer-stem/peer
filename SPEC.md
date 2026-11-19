# peer: specification

Status: updated 2026-11-18 for Sprint `S4` pre-`C1` alignment, preserving the Engine API specification (`§2.1–§2.11`), Phase Acceptance (`§7`), and Decision Ledger (`§8`), alongside the owner-approved contracts (`pdl 1f0fed50e576`) for **Hardware Safety**, **LumberJack DAG Storage**, **MFN 2.0 Context Mapping** (`2026-11-18` benching decision recorded in `§4`), **CloudCanvas Client**, and the **LearnHarness Importer**. Points marked **open** await Richard's decision; points marked **decided** or **benched** were ruled by Richard.

## 1. Hardware & Storage Safety Contract (`src/substrate/`)

1. **Permitted compute backends**: `"cpu"` (default) and `"vulkan"` (`Nova/Vulkan`).
2. **Forbidden backends**: `"cuda"`, `"rocm"`, `"hip"`, `"nvidia"`, `"amd"`, `"opencl"`, `"sycl"`, `"metal"`, `"auto"`, or any unknown token MUST throw immediately in `resolveComputeBackend`.
3. **Environment scrubbing (`src/substrate/gpu-policy.mjs`, `sanitizeComputeEnv`)**:
   - Every child process spawned by `peer` (`mfn-engine`, compilers, workers) runs with all `CUDA_*`, `NVIDIA_*`, `NVCC_*`, `NCCL_*`, `ROCR_*`, `ROCM_*`, `HIP_*`, `HSA_*`, `MIOPEN_*`, `GPU_*`, and `AMD_*` environment variables stripped, and with `CUDA_VISIBLE_DEVICES=""`, `ROCR_VISIBLE_DEVICES=""`, `HIP_VISIBLE_DEVICES=""`, `NVIDIA_VISIBLE_DEVICES="none"`.
   - `OLLAMA_LLM_LIBRARY` is set in spawned child environments to `"cpu"` (when `backend === "cpu"`) or `"vulkan"` with `OLLAMA_VULKAN="1"` (when `backend === "vulkan"`).
   - **Decided (`M3`, 2026-11-17)**: `peer` uses the owner's system loopback Ollama service (`http://127.0.0.1:11434`, `nomic-embed-text:latest`, verified by 64-hex `model_digest`); the CPU-only hardware guarantee on that external daemon is enforced by the owner's systemd unit override (`/etc/systemd/system/ollama.service.d/zzzz-dirty-cpu-only.conf`: `OLLAMA_VULKAN=0`, `GGML_VK_VISIBLE_DEVICES=-1`, `ROCR_VISIBLE_DEVICES=-1`, `HIP_VISIBLE_DEVICES=-1`, `CUDA_VISIBLE_DEVICES=-1`, `OLLAMA_IGPU_ENABLE=0`, `OLLAMA_NO_CLOUD=1`).
4. **Native binary verification**: `ldd` on every built native artifact under `/usr/lib/persist/peer/build/` MUST match zero CUDA or ROCm shared libraries (`assertNoForbiddenGpuLibraries`), with SHA-256 digests recorded in `/usr/lib/persist/peer/build/substrate-manifest.json`.
5. **SSD & zero-`/tmp` rule**: All builds, Go/Cargo/Zig caches (`GOCACHE`, `GOMODCACHE`, `GOPATH`, `CARGO_HOME`), test fixtures, and runtime state reside under `/usr/lib/persist/peer/{build,scratch,state}` on SSD (`D5`, **decided**). Nothing writes to `/tmp` or pollutes `~/go` / `~/.cargo`.

## 2. Engine API Server (`src/api/`)

Status: implemented on `src/api` (merged in PR #5 `4fc52b3`, A2 follow-ups 1–8 merged in PR #9 `f767f64`, and `D1–D6` + all 8 recorded parity differences finalized in Sprint `S4`). Sources: **R** = `.context/logs/reports/2026-11-14-host-route-inventory.md`, **St** = `.context/logs/reports/2026-11-14-host-static-surface.md`, **N** = Next 16.4.3 compiled server modules.

### 2.1 Scope

| In | Out |
|---|---|
| The 50 route files, 73 exported methods, and 5 streams under `/api` (R §1.4), plugin assets included (row 33) | Pages, `/_next/**`, server-side rendering |
| Serving the client's static files unchanged on the same origin (§2.11) | Modifying static client files in transit |
| Calling existing route handlers in `app/api/**/route.ts` unwrapped with a web `Request` | Removing Next.js before Phase 5 (`C3`) cutover (`N15` closed) |

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

- **Decided (`D6`, 2026-11-17)**: `serveHttp(message, res, dispatch, options?: ServeHttpOptions)` accepts an optional 4th `options` parameter (`getBodyLimit`, `onWarn`, `onError`, `shutdownSignal`).
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
  3. No pattern matches -> `404` with empty body (`0` bytes; approved difference `unknown-api-path-404` vs Next HTML 404).
  4. Pattern matches, method not exported -> `OPTIONS`: `204` with sorted `Allow` (`OPTIONS`, exported methods, plus `HEAD` if `GET` exported); `HEAD`: runs `GET` handler and strips body; other 7-method verbs: `405` empty body, no `Allow`. Methods outside the 7: `TRACE` returns `500` `text/plain` before gate (matching Next); unknown tokens (`FOO`, `PURGE`) return `400`.
  5. Handler found -> invoked; uncaught throw logs `[api] Unhandled route error` with route path and returns `500` empty body.
- `/api/plugins/[id]/documents/markdown` (row 35) passes through router gate and its own handler gate identically without body cloning.

### 2.5 Gate inputs

`apiRequestRefusal` reads `process.env` dynamically per call (`LH_DESKTOP_SERVER`, `LH_DESKTOP_API_SECRET`, `LH_ALLOWED_HOSTS`); `src/api` never caches those variables.

### 2.6 Request bodies

- **Decided**: `/api/plugins/[id]/documents/markdown` has no router cap (`bodyLimit === null`, self-bounded at `27,262,976` bytes); every other `/api` route caps the request stream at `27,262,976` bytes (silent stream cut + warning log, matching Next `proxyClientMaxBodySize`).

### 2.7 Streams

1. Status and headers flush immediately (`res.flushHeaders()`) upon `Response` resolution before the first body byte (approved difference `events-header-flush-timing` vs Next buffering `/api/events` headers).
2. Chunks write unbuffered without gzip or `Content-Length`, honoring socket `drain` back-pressure.
3. Client disconnect aborts `request.signal` and cancels `response.body` so bus listeners and timers clean up immediately.

### 2.8 Start-up, environment, binding

1. Reads `PORT` (**decided**: required integer `1..65535`, no default) and `HOSTNAME` (**decided** `D3`, 2026-11-17: loopback-only — `127.0.0.0/8`, `::1`, `[::1]` unwrapped to `::1`, or `localhost`, defaulting to `127.0.0.1`; non-loopback values such as `0.0.0.0` or `::` are refused at startup before binding).
2. Imports route modules (running import-time auth/worker/provider/turn-runner registration) and calls `await initializePlugins()` (logging and continuing on plugin init failure).
3. Registers `uncaughtException` and `unhandledRejection` handlers (logging via structured JSON logger with `timestamp`/`message` keys, keeping server alive).
4. `SIGTERM` / `SIGINT`: arms force-close deadline (`3 s`), closes listener, cancels open streams, logs forced-exit with `{ timestamp, level, message }` if forced, and exits within `3 s` (approved difference `sigterm-open-sse-exit` vs Next hanging past 3 s on open SSE).

### 2.9 Not done by this server

No `x-powered-by`, no Next `RSC` `Vary` header (`next-app-route-vary`, `next-proxy-vary`), no gzip, no ETag generation outside route handlers, no trailing-slash `308` redirect (**decided** `D1` / `trailing-slash-redirect-vs-gate-and-404`), no caching, no CORS headers. Structured non-blocking logger configured via `LH_LOG_LEVEL` (**decided** `D2`, 2026-11-17: `debug | info | warn | error | silent`, default `info`).

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

**Decided** (`2026-11-14` & `C-11` `2026-11-19`): `src/api/static.ts` serves static client assets unchanged on the same origin for non-`/api` paths, ungated, resolving roots once at startup with `realpath` containment and rejecting dotfile segments (`404`). In `C1`, `src/api/static.ts` serves `public/client/index.html` (`Cache-Control: no-cache`) on SPA routes (`/`, `/chat/new`, `/chat/{seg}`, `/plugins/{seg}/{seg}`, `/settings`), allowlisted `/client/vendor/{cloudcanvas,cloudcanvas-lib}/**` mounts, and `/client/src/**` (`.js`, `.css`, `.json`, `.svg` only).

## 3. LumberJack Forest & Multi-Parent DAG Contract (`src/store/lumberjack/`)

1. **ABI & Single Go Archive**: Links against LumberJack C-ABI v2 (`LJ_ABI_VERSION == 2u`, `LJ_MUTATION_OUT_MIN == 16384`, `LJ_MAX_PATH == 4096`) in a single Go `c-archive` (`liblumberjack_peer.a` + `lumberjack_peer.node`).
2. **Locking & Adoption**: Honors `LJ_LOCKED` vs `LJ_UNGUARDED` (never auto-adopted without explicit human command).
3. **Domain Mapping & Canonical `S4` Storage**:
   - Knowledge propositions (`knowledge/propositions/<id>`), derivation chains (`knowledge/chains/<id>`), sources/folders (`knowledge/sources/<id>`), lesson plan trees (`plans/<chat_id>/<node_id>`), learner progress (`learner/*`), settings, themes, prompt overrides, and validated plugin records are stored as LumberJack `Node`s with multi-parent `Parents` (`delete_node` severs both target-to-parent and child-to-target links) and typed `Metadata`. Ledger rewrites preserve FSRS/mastery state on propositions and preserve existing source usage logs; orphaned `learner/progress/*` nodes are deleted on proposition removal, partial ledger writes are non-destructive, and root ledger reads are cached (`N9`).
   - Binary images are stored solely in LumberJack's BLAKE3-addressed `<name>.objects/` store via `ic_lj_application_configure` + `ic_lj_application_call` (`POST /objects`, `GET /objects/{id}`) with zero node attachments (`L5`).
   - Conversations, side-chats, turn/extraction usage, and jobs are stored canonically in LumberJack `Event`s (`main`, `side:<id>`, `turns`, `extractions`, `lifecycle`) and `Entry` records with incremental `ic_lj_event_append` (`L6`, `L7`).
   - Live mutations stream to `/api/events` via `ic_lj_stream_poll` parsing LumberJack's `node_path` wire field (`epoch` + `after` cursor, re-deriving state on `LJ_GAP`), with `stream-events.ts` synced to head cursor on attach, deduplicated to a single emitter, and stopped on `forest.close()` (`N11`).
4. **Secrets Isolation**: API keys and tokens remain in `0600` files (`state/auth.json`, `state/mfn/secrets/api-token`) outside forest projections.

## 4. MFN 2.0 Learned Memory & Context Mapping Contract (`src/memory/mfn/`)

1. **Owner Benching Ruling (`2026-11-18`, `owner-decision-bench-mfn-tuning-beyond-basic-wiring`)**: MFN implementation beyond basic turn-bridge/runtime wiring stays frozen at its Governor-verified `S3` state (PR #9 `f767f64`) while upstream MFN evolves. Fine-tuning of recall structure (`§3`), staleness rules, recall fencing/budget (`M4`, `M5`), recall fault/fallback behavior (`N3`), active daemon probes (`M3`), supervisor single-flight/lockfile (`N5`), outbox edge cases (`N17–N19`), and partial lexical hydration (`N22`) is **benched** for a dedicated MFN phase.
2. **Dedicated Supervised Instance**: `peer` supervises its own MFN 2.0 controller (`ifr`, `dsr`, `alm`, `cpe`, `psr`, `mfn-gateway`) on `127.0.0.1` over `0700` sibling directories `state/mfn/data` and `state/mfn/runtime` with `0600` `state/mfn/secrets/api-token`, strict 13-key OS environment allow-listing, live child-exit readiness reset, `/proc` `(pid, starttime)` + `MFN_RUNTIME_DIR` detached-child cleanup on timeout/stop, and a clean-exit `process.on("exit")` `SIGTERM` hook (`N5` benched).
3. **Embedder Pin (`MFN_EMBEDDERS_FILE`)**: Atomic `0600` single-link file (`format_version: 1`) targeting loopback IP literal `http://127.0.0.1:11434`, `nomic-embed-text:latest` (`768` dims), and verified 64-hex `model_digest`.
4. **Context Assembly (`turn.recall`) & Basic Turn-Bridge Wiring (`S3` Frozen Baseline)**:
   - Retains a compact exact live tail (`~4k–6k` tokens) and calls `POST /v2/execute` (`op: "turn.recall"`) under a hard wall-clock deadline with `window.memory_ids` and `exclude_memory_ids` (zero duplicate live-tail memories), hydrating lexical fallback hits at `<= 2` concurrent `memory.peek` calls without discarding sibling hits if one peek fails (`M4`, `M5`, `N3`, `N22` benched).
   - Recall and ingest execute in `src/server/chat-handler.ts` via `src/server/mfn-turn-bridge.ts` when an MFN runtime is registered (`master` registers none until `C1`, `M9`); extraction/check-resolution ingest hooks, importer backfill, and deletion of `src/core/compaction.ts` + `src/server/compaction.ts` complete during `C1–C3`.
5. **Settlement (`turn.ingest`), `memory.put`, Backoff & Dead-Letter Outbox (`S3` Frozen Baseline)**:
   - Calls `POST /v2/execute` (`op: "turn.ingest"` on main pool and `op: "memory.put"` on lexical pool) with idempotent UUIDv7 `operation_id` and `< 2^62` memory IDs without aborting sibling batches or lexical puts (`N6`).
   - Queues retryable `503 admission_paused` / `503 embedder_unavailable` writes in `MfnIngestOutbox` (evicting by `operationId`, `N4`), retries by age (`maxAgeMs`, default 7 days) + exponential backoff (`N1`), stops drain on systemic errors (`401`/`403`/`404`/`409`/`5xx`, `N2`), and quarantines per-item poison (`400`/`413`/`415`/`422`) + expired entries into persisted `dead_letter` (`format_version: 3`; `createLumberJackOutboxPersistence`, `0600` file persistence, and `startAutoFlush` wire into startup in `C1`; `N17–N19` benched).

## 5. Explicit LearnHarness Importer (`src/store/import-learnharness.ts`)

1. `peer` starts with a clean forest (zero automatic startup migration).
2. `importLearnHarnessData(sourceDir)` reads a LearnHarness directory strictly read-only (`O_NOFOLLOW`, symlink refusal, isolated file/dir read errors, ID validation against `""`/`.`/`..`, normalized missing `updatedAt`, unwrapped `positions.json`, validated ledger shapes, preserved flashcard `reviews`, and retained higher-rep/newer FSRS schedules) into LumberJack.
3. **Decided (`C-10`, `2026-11-19`)**: `POST /api/settings/import-learnharness` (gated by `apiRequestRefusal`, body `{ sourceDirectory: string }`) runs `importLearnHarnessData`, emits `chats-changed` and `sources-changed`, and returns `LearnHarnessImportReport` for Settings -> Data.

## 6. CloudCanvas Client & Code Standards

1. **Client (`src/client/`, Approved `C-01..C-18` on `2026-11-19`)**: Zero React, Next.js, or Tailwind. Built inside `peer` around pinned `extern/cloudcanvas` (`69076f7`, `0.7.1`) and `extern/cloudcanvas-lib` (`d5a5fa1`, `0.7.1+`) with zero `extern/` edits per `.context/logs/plans/2026-11-19-client-contract-{views,state,seams}.md` (`create<Name>(host, callbacks)` / `create<Screen>View(host, { send, navigate })`, single `Store<M, I>` interface, `src/client/main.js` composition root, `peer-graph` widget hosting `components/graph-canvas.ts`, `PluginCodeBlockRenderer` block registry, `display: false` MFN marker skip). Model-produced text never enters the DOM as raw HTML; Mermaid runs with `securityLevel: "strict"`; interactive demos run in opaque-origin sandboxed frames.
2. **Code Bounds**: Max `500` lines per file, `50` lines per definition (function, method, or class), `3` levels of tab indentation (`N14` near-500-line splits and `N20` single-condition test assertions + non-gate `memory.peek` skip coverage completed in `S4`).
3. **Tests & Gate Commands (`tests/`, `package.json`)**:
   - Substrate & unit gates (`./node_modules/.bin/tsx`): `npm run test:gate` (`NODE_ENV=test PEER_REQUIRE_SUBSTRATE=1 ./node_modules/.bin/tsx --test tests/*.test.ts tests/*.test.tsx`), `npm run test:substrate`, and `npm test` (skips native-binary suites cleanly unless `PEER_REQUIRE_SUBSTRATE=1`, `F6`/`N13`).
   - Engine API parity gate (`N21`): `npm run build` (note: Next 16.4.3's first-run advisory notice requires running `npm run build` twice if `.next/standalone` is absent) followed by `npm run test:parity` (`NODE_ENV=test PEER_API_PARITY=1 ./node_modules/.bin/tsx --test tests/api-parity.test.ts`; plus `PEER_API_PARITY_LONG=1` for `long-stream`).

## 7. Acceptance by Phase

| Phase | Accepted when |
|---|---|
| **A: Engine API (`A1–A2`, `S4`)** | All 50 routes / 73 methods / 5 streams pass parity against Next standalone, all §2.10 cases pass, A2 follow-ups 1–8 pass, and `D1–D6` + all 8 `RECORDED_DIFFERENCES` (`approved: true`) are settled (§8.1–§8.2) |
| **S0–S4: Substrate, LumberJack & MFN Baseline** | Submodules clean & pinned; `build-substrate.mjs` verifies SHA-256 hashes & zero CUDA/ROCm `.so`/env on SSD; Governor `S0–S3` findings + `S4` alignment (`D3,D4,L5–L7,N9,N11,N14,N20,N21`, `M3` spec) pass tests; Richard signs off `§10.5` client contracts |
| **C1–C2: CloudCanvas `peer` App** | Knowledge/Mastery DAG canvas, Lesson/Practice workspace with basic MFN wiring, Flashcards FSRS, Settings/Models/Voice, Plugins, and LearnHarness Import UI pass DOM-free store tests, `happy-dom 20.12.0` view unit tests (`C-14`), and `puppeteer-core` E2E against live `src/api` + LumberJack + MFN |
| **C3: Desktop Cutover & Removal** | Packaged Electron app runs `src/api` + LumberJack + MFN + CloudCanvas client end-to-end; `app/`, React `components/`, Next.js, Tailwind, raw-file store adapters, and LLM compaction are removed; full QA passes and Richard signs off Trial |

## 8. Decision Ledger & Remaining Gates

### 8.1 Engine API Decisions (`D1–D6`)

| ID | Point | Status |
|---|---|---|
| `D1` | `/api/x/` trailing slash: `src/api` gates first (`403`) or returns `404` post-gate (no pre-gate `308`) | **Approved / Decided (2026-11-17)** |
| `D2` | `LH_LOG_LEVEL` explicit logger configuration environment variable (`debug\|info\|warn\|error\|silent`) | **Approved / Decided (2026-11-17)** |
| `D3` | `HOSTNAME` restricted to loopback (`127.0.0.0/8`, `::1`, `[::1]`, `localhost`; non-loopback refused at startup) | **Approved / Decided (2026-11-17)** (`S4`) |
| `D4` | All 8 `RECORDED_DIFFERENCES` in `tests/api-parity-compare.ts` marked `approved: true` (§8.2) | **Approved / Decided (2026-11-17)** (`S4`) |
| `D5` | Canonical SSD scratch root `/usr/lib/persist/peer/scratch` across tests and build scripts | **Approved / Decided (2026-11-17)** |
| `D6` | `serveHttp(message, res, dispatch, options?: ServeHttpOptions)` 4-parameter signature (§2.3) | **Approved / Decided (2026-11-17)** |

### 8.2 Recorded Engine API Parity Differences (`tests/api-parity-compare.ts`, all `approved: true` — Approved 2026-11-17, `D4`)

1. `next-app-route-vary`: Next adds `vary: "rsc, next-router-state-tree, ..."`; `src/api` omits it (§2.9).
2. `next-proxy-vary`: Next `proxy.ts` adds `vary: "Accept-Encoding"` on `403`; `src/api` omits it (§2.9).
3. `custom-provider-per-process-etag`: `/api/custom-provider` computes HMAC ETag from a per-process 32-byte startup key.
4. `unknown-api-path-404`: Unmatched `/api/*` post-gate returns `404` empty body on `src/api` vs HTML `_not-found` on Next (§2.4).
5. `trailing-slash-redirect-vs-gate-and-404`: Trailing-slash `/api/.../` returns `403`/`404` on `src/api` vs pre-gate `308` on Next (`D1`).
6. `trace-method-500-headers`: `TRACE /api/...` returns `500` on both; Next adds `vary`/`cache-control`/`etag`, `src/api` sends `text/plain; charset=utf-8`.
7. `events-header-flush-timing`: `GET /api/events` flushes headers immediately (`< 50 ms`) on `src/api` vs Next buffering until first SSE frame (§2.7).
8. `sigterm-open-sse-exit`: `SIGTERM` with `/api/events` open exits `< 3 s` on `src/api` vs Next waiting past `3 s` (§2.8).

### 8.3 Governor Review & Pre-`C1` Standing

| # | Decision / Item | Standing |
|---|---|---|
| `§10.1` / `§9.1` | Correction sprint (`S3`, PR #9 `f767f64`) + pre-`C1` alignment (`S4`) | **Resolved in `S3`/`S4`** |
| `§10.2` (`M3`) | System loopback Ollama CPU-only guarantee enforced by owner's systemd override (§1.3); active daemon probes deferred | **Decided (2026-11-17)** / probes **Benched (2026-11-18)** |
| `§10.3` (`L5–L7`) | Canonical `/objects` binary images (`L5`) and canonical `Event`/`Entry` conversations, side-chats, usage & jobs (`L6`, `L7`) | **Resolved in `S4`** |
| `§10.4` + `§9.2` | MFN tuning beyond basic wiring (`§3` recall structure/staleness, `M4`, `M5`, `N3`, `N5`, `N17–N19`, `N22`) | **Benched (2026-11-18)** (`§4.1`) |
| `§10.5` | CloudCanvas client contracts (`C-01..C-18` in `2026-11-19-client-contract-{views,state,seams}.md`, built inside `peer` around `69076f7` + `d5a5fa1`) | **Approved / Decided (2026-11-19)** |
| `§10.6` | `D1–D6` and the 8 recorded parity differences (§8.1–§8.2) | **Approved / Decided (2026-11-17)** |
| `§9.3` | Governor verification of supported Sprint `S0–S4` PDL step claims | **Open** (Governor / Owner) |
| `§9.4` (`N15`) | Next 16.4.3 upstream advisory notice | **Closed (no Next upgrade; Next removed at `C3`)** |
| `§8.5` + `S4` | `N9` (ledger/progress hygiene), `N11` (`stream-events`), `N14` (file splits), `N20` (single-check asserts + peek skip), `N21` (`test:parity`) | **Resolved in `S4`** (`N5` **Benched 2026-11-18**) |

Signature: Google gemini-4-carbon high - 04da2a6d-9328-4ad4-b892-398e4c39b74c
