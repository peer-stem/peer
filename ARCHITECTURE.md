# peer: architecture

Status: updated 2026-11-16 for the approved **CloudCanvas + LumberJack DAG + MFN 2.0** architecture (`.context/logs/plans/2026-11-16-lumberjack-mfn-cloudcanvas-integration-plan.md`).

## 1. System Topology

In CloudCanvas, the browser window is the **host** (`src/client/`). The Node process serves `/api/**` and static client modules (`src/api/`), drives the learning agents (`src/agent/`, `src/core/`, `src/server/`), embeds **LumberJack** for persistent DAG/event/object storage, and supervises **MFN 2.0** for learned context mapping.

```text
Electron shell (electron/)
   │ opens window                     │ spawns peer API + substrate on loopback
   v                                  v
Browser Window (Client = Host)     Node Process (src/api -> src/server)
  src/client/                        ├── src/substrate/hardware-guard.ts (CPU / Nova-Vulkan only; blocks CUDA/ROCm)
    state/   TS stores & SSE         ├── src/store/lumberjack/ ──(N-API C-ABI v2)──> liblumberjack.a
    views/   CloudCanvas widgets     │     └── /usr/lib/persist/peer/state/lumberjack (DAG, Events, /objects, slots)
    blocks/  KaTeX, Mermaid, code    └── src/memory/mfn/ ──(HTTP 127.0.0.1)──> mfn-engine (6 CPU native owners)
    graph/   graph-canvas.ts                   ├── /usr/lib/persist/peer/state/mfn/{data,runtime,secrets}
                                               └── loopback Ollama (127.0.0.1:11434, nomic-embed-text, CPU/Vulkan)
```

## 2. Component Boundaries

| Component | Responsibility | Owns | Must not |
|---|---|---|---|
| `src/substrate/` | Hardware guardrail (`cpu` / `vulkan` only), child env scrubbing, native build & runtime path helpers | Env & binary safety checks | Allow CUDA/ROCm or `/tmp` paths |
| `src/store/lumberjack/` | Implement engine storage ports + multi-parent DAG, `/objects` attachments, `ic_lj_stream_poll` SSE feed, and explicit LearnHarness importer | `/usr/lib/persist/peer/state/lumberjack` | Write raw JSON/JSONL state files or import `src/client` |
| `src/memory/mfn/` | Supervise MFN 2.0 (`ifr`, `dsr`, `alm`, `cpe`, `psr`, `mfn-gateway`), manage `0600` `MFN_EMBEDDERS_FILE`, execute `turn.recall` & `turn.ingest` | `/usr/lib/persist/peer/state/mfn` | Use LLM compaction summaries or expose non-loopback ports |
| `src/core`, `src/agent`, `src/server` | Pedagogical loops (`Prober`, `Teacher`, `Practitioner`, `Extractor`, `Auditor`), FSRS-6, speech, CLI/API providers | Domain types & turn orchestration | Import `src/api` or `src/client` |
| `src/api/` | Standalone `node:http` + Web `Request -> Response` router, desktop gate, stream passthrough, static asset delivery (`src/api/static.ts`) | HTTP transport only | Render HTML or hold application state |
| `src/client/` | Native ES module CloudCanvas UI: stores (`state/`), views (`views/`), markdown blocks (`blocks/`), interactive DAG (`graph-canvas.ts`) | Browser DOM & working view models | Import React/Next or call storage directly |
| `extern/cloudcanvas` | CloudCanvas DOM runtime engine (`69076f7`, v0.7.1) | Submodule (read-only) | Be modified in-place |
| `extern/cloudcanvas-lib` | CloudCanvas widgets, archetypes, and board (`155271b`, v0.7.1) | Submodule (read-only) | Be modified in-place |
| `extern/lumberjack` | LumberJack DAG & event engine (`f4e8055`, C-ABI v2) | Submodule (read-only) | Be modified in-place |
| `extern/mfn` | Multi-Focal Network 2.0 (`489ca2f`, 5 layers + gateway) | Submodule (read-only) | Be modified in-place |

## 3. LumberJack Forest & Multi-Parent DAG Layout

LumberJack nodes (`core.Node`) support multi-parent links (`Parents`), `Kind`, colocated `Metadata` (including canvas coordinates and FSRS-6 state), `Events` with ranked/threaded `Entries` (`ID`, `ParentID`, `Rank`), SHA-256 `/objects` attachments, and `slots`:

- `knowledge/sources/<id>`: `Kind: "source" | "folder"` (hierarchical/DAG parent links).
- `knowledge/propositions/<n_id>`: `Kind: "proposition"`, `Parents` pointing to contributing sources and prerequisite chain conclusions; `Metadata` carrying statement, aliases, `{ canvas: { x, y } }`, mastery, and FSRS-6 card state.
- `knowledge/chains/<arg_id>`: `Kind: "chain"`, multi-parent `Parents` naming every joint premise proposition and linking to its derived conclusion, with provenance (`eventId`, `entryId`).
- `plans/<chat_id>/<plan_node_id>`: `Kind: "plan_node"`, `Parents` encoding prerequisite plan nodes as a true LumberJack DAG.
- `learner/profile` & `learner/decks/<deck_id>`: persistent learner goals, communication preferences, confidence calibration, and practice cues.
- `sessions/<chat_id>`: `Kind: "session"`, `Events["main"]` holding conversation `Entries` (side-chats anchored via `ParentID = anchorEntryId`), `Events["turn:<id>"]` for token/cost usage, and `Events["job:<id>"]` for background worker jobs.
- `config/{settings,prompts/*,themes/*,plugins/*}`: structured configuration replacing flat JSON files (`0600` credentials stay in `/usr/lib/persist/peer/state/auth.json`).

**Single Go Runtime Rule (`ffi/lumberjack.h`)**: Only one Go `c-archive` may ever be linked into the Node process (`liblumberjack.a` or `peer`'s single superset product archive registered via `extension.Spec`); MFN's Go `alm` owner runs out-of-process under `mfn-engine.py`.

## 4. MFN 2.0 Context Mapping Flow

1. **Pre-turn (`prepareTurnContext`)**:
   - Read the compact live tail (`~4k–6k` tokens: active `PlanTree` neighborhood, open tool calls, pending check, and watermarked side-question entries) from LumberJack so recent messages keep byte-stable provider KV-cache prefixes.
   - Query MFN `POST /v2/execute` (`op: "turn.recall"`) with `window.memory_ids` / `exclude_memory_ids` set to the live tail IDs.
   - Inject recalled spreading-activation memories (`top_k`), L5 `themes`, and L4 `anticipations` at prompt slot `[1]` between the synthetic system prompt `[0]` and the live tail `[2..N]`.
2. **Post-turn / settlement (`ingestSettledTurn`)**:
   - Emit idempotent MFN `POST /v2/execute` (`op: "turn.ingest"`, UUIDv7 `operation_id`) for settled propositions, probe/check assessments, misconceptions, and learner observations.
   - If the loopback Ollama embedder is temporarily unavailable (`503 embedder_unavailable`), `turn.recall` falls back to `hash_v1` / lexical cues while LumberJack's outbox retries queued `turn.ingest` operations when ready.

## 5. Repository & SSD Layout

| Path | Role |
|---|---|
| `src/api/`, `src/client/`, `src/substrate/`, `src/store/lumberjack/`, `src/memory/mfn/` | `peer` native implementation |
| `extern/{cloudcanvas,cloudcanvas-lib,lumberjack,mfn}` | Pinned upstream git submodules (never dirtied by builds) |
| `/usr/lib/persist/peer/build/{lumberjack,mfn}` | Compiled native CPU artifacts (`liblumberjack.a`, `lumberjack.h`, `ifr`, `dsr`, `alm`, `cpe`, `psr`, `mfn-gateway`) |
| `/usr/lib/persist/peer/state/{lumberjack,mfn}` | Dedicated runtime databases & `0600` secrets (`auth.json`, `mfn/secrets/api-token`, `mfn/embedders.json`) |
| `/usr/lib/persist/peer/scratch/` | Ephemeral build/test `TMPDIR` on SSD (`/tmp` is never written) |

Signature: Google gemini-4-carbon high - 04da2a6d-9328-4ad4-b892-398e4c39b74c
