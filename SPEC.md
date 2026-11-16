# peer: specification

Status: updated 2026-11-16 to incorporate the owner-approved contracts for **Hardware Safety**, **LumberJack DAG Storage**, **MFN 2.0 Context Mapping**, **CloudCanvas Client**, and the **LearnHarness Importer**, alongside the verified **Engine API (`src/api`)** contract.

## 1. Hardware & Storage Safety Contract (`src/substrate/`)

1. **Permitted compute backends**: `"cpu"` (default) and `"vulkan"` (`Nova/Vulkan`).
2. **Forbidden backends**: `"cuda"`, `"rocm"`, `"hip"`, `"nvidia"`, `"amd"`, `"opencl"`, `"auto"`, or any unknown token MUST throw immediately in `resolveComputeBackend`.
3. **Environment scrubbing (`sanitizeComputeEnv`)**:
   - Every child process (`mfn-engine`, `ollama` probes, compilers, workers) MUST run with all `CUDA_*`, `NVIDIA_*`, `NVCC_*`, `NCCL_*`, `ROCR_*`, `ROCM_*`, `HIP_*`, `HSA_*`, `MIOPEN_*`, `GPU_*`, and `AMD_*` environment variables stripped, and with `CUDA_VISIBLE_DEVICES=""`, `ROCR_VISIBLE_DEVICES=""`, `HIP_VISIBLE_DEVICES=""`, `NVIDIA_VISIBLE_DEVICES="none"`.
   - `OLLAMA_LLM_LIBRARY` is explicitly pinned to `"cpu"` (when `backend === "cpu"`) or `"vulkan"` with `OLLAMA_VULKAN="1"` (when `backend === "vulkan"`), bypassing `/usr/local/lib/ollama/{cuda_*,rocm_*}` autodetection.
4. **Native binary verification**: `ldd` on every built native artifact under `/usr/lib/persist/peer/build/` MUST match zero CUDA or ROCm shared libraries (`assertNoForbiddenGpuLibraries`).
5. **SSD & zero-`/tmp` rule**: All builds, caches, test fixtures, and runtime state reside under `/usr/lib/persist/peer/{build,scratch,state}`. Nothing writes to `/tmp`.

## 2. Engine API Server (`src/api/`)

1. **Entry & Dispatch**: `Dispatch = (request: Request) => Promise<Response>` behind `serveHttp(message, res, dispatch)` on `node:http`.
2. **Binding**: `HOSTNAME` defaults to `127.0.0.1`; `PORT` is required with no default; `SIGTERM` closes listener and open streams within 3 s.
3. **Gate & Routing Order**:
   - Non-`/api` paths route to `src/api/static.ts` (ungated static client assets, served unchanged on the same origin).
   - Every `/api` path runs `apiRequestRefusal(request)` first (`403`, `Cache-Control: no-store`, `{"error":"..."}`), before `404` or `405`.
   - Static segments outrank dynamic (`[id]`), which outrank catch-all (`[...path]`); `OPTIONS` and `HEAD` follow HTTP/Next semantics.
4. **Body Cap & Streams**: Request bodies cap at `27,262,976` bytes except `/api/plugins/[id]/documents/markdown`; SSE and binary response streams flush headers immediately, honor socket back-pressure (`drain`), and cancel/abort on client disconnect.

## 3. LumberJack Forest & Multi-Parent DAG Contract (`src/store/lumberjack/`)

1. **ABI & Single Go Archive**: Links against LumberJack C-ABI v2 (`LJ_ABI_VERSION == 2u`, `LJ_MUTATION_OUT_MIN == 16384`, `LJ_MAX_PATH == 4096`). Never link more than one Go `c-archive` into a process.
2. **Locking & Adoption**: Honors `LJ_LOCKED` (transient sidecar flock) vs `LJ_UNGUARDED` (missing `.lock` sidecar — never auto-adopted without explicit human command).
3. **Domain Mapping**:
   - Knowledge propositions (`knowledge/propositions/<id>`), derivation chains (`knowledge/chains/<id>`), sources/folders (`knowledge/sources/<id>`), lesson plan trees (`plans/<chat_id>/<node_id>`), and learner progress (`learner/*`) are stored as LumberJack `Node`s with multi-parent `Parents` and typed `Metadata` (including canvas `{ x, y }` and FSRS-6 state).
   - Conversations, side-threads (`ParentID = anchorEntryId`), token/cost billing (`turn:<id>`), and background jobs (`job:<id>`) are stored as LumberJack `Event`s and ranked `Entry` records on `sessions/<chat_id>`.
   - Images, PDFs, and rendered visual artifacts are stored via LumberJack `/objects` (`ic_lj_application_call`, base64 envelope, SHA-256 content-addressed up to 64 MiB).
   - Live mutations stream to `/api/events` via `ic_lj_stream_poll` (`epoch` + `after` cursor, re-deriving state on `LJ_GAP`).
4. **Secrets Isolation**: API keys and tokens remain in `0600` files (`/usr/lib/persist/peer/state/auth.json`, `/usr/lib/persist/peer/state/mfn/secrets/api-token`) outside forest projections.

## 4. MFN 2.0 Learned Memory & Context Mapping Contract (`src/memory/mfn/`)

1. **Dedicated Instance**: `peer` supervises its own MFN 2.0 controller (`ifr`, `dsr`, `alm`, `cpe`, `psr`, `mfn-gateway`) on `127.0.0.1` over `0700` sibling directories `state/mfn/data` and `state/mfn/runtime` with `0600` `state/mfn/secrets/api-token`.
2. **Embedder Pin (`MFN_EMBEDDERS_FILE`)**: Regular single-link `0600` file (`format_version: 1`) targeting loopback IP literal `http://127.0.0.1:11434`, `nomic-embed-text:latest` (`768` dims), and verified 64-hex `model_digest`.
3. **Context Assembly (`turn.recall`)**:
   - Retains a compact exact live tail (`~4k–6k` tokens) from LumberJack for active tool/check continuity and KV-cache prefix stability.
   - Calls `POST /v2/execute` (`op: "turn.recall"`) passing live-tail memory IDs in `window.memory_ids` and `exclude_memory_ids` (guaranteeing zero duplicate memories).
   - Retires `src/core/compaction.ts` and `src/server/compaction.ts`.
4. **Settlement (`turn.ingest`) & Degraded Mode**:
   - Calls `POST /v2/execute` (`op: "turn.ingest"`) with idempotent UUIDv7 `operation_id` and `< 2^62` memory IDs mapped to LumberJack `Node`/`Entry` records.
   - When the embedder returns `503 embedder_unavailable`, `turn.recall` degrades cleanly to `hash_v1`/lexical cues while `turn.ingest` payloads queue in LumberJack's outbox until `ready`.

## 5. Explicit LearnHarness Importer (`src/store/import-learnharness.ts`)

1. `peer` starts with a clean forest (zero automatic startup migration).
2. `importLearnHarnessData(sourceDir)` reads a LearnHarness directory strictly read-only (never mutating `sourceDir`) and imports `chats/*.json` (including side-chats and `PlanTree`), `graph/{nodes,chains,sources}.jsonl`, `images/*`, and Flashcards FSRS state idempotently into LumberJack + MFN.

## 6. CloudCanvas Client & Code Standards

1. **Client (`src/client/`)**: Zero React, Next.js, or Tailwind. Built with CloudCanvas (`0.7.1`) + `cloudcanvas-lib` (`0.7.1`), reusing framework-free TypeScript (`graph-canvas.ts`, `fsrs.ts`) and rendering streaming Markdown, KaTeX, highlighted code, strict-mode Mermaid, and opaque-origin sandboxed demos.
2. **Code Bounds**: Max `500` lines per file, `50` lines per definition, `3` levels of indentation.
3. **Tests (`tests/`)**: Unit, integration, and end-to-end suites only, all executing against isolated SSD scratch directories.

Signature: Google gemini-4-carbon high - 04da2a6d-9328-4ad4-b892-398e4c39b74c
