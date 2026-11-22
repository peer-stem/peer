# peer: architecture

Status: updated 2026-11-21 for upstream `v0.7.0` (`069a6a11`) sync (`52` routes / `76` methods) and the `F0–F5` CloudCanvas finalization architecture (`src/client/kit/`, `src/client/engine/`, default LLM compaction with `PEER_MFN_ENABLED=1` opt-in, and `userData` `~/.config/peer` default desktop state root).

## 1. System Topology

In CloudCanvas, the browser window is the **host** (`src/client/`, booted from `public/client/index.html` -> `src/client/main.js`). The Node process serves `/api/**` and static client/vendor modules (`src/api/`), drives the learning agents (`src/agent/`, `src/core/`, `src/server/`), embeds **LumberJack** (`PEER_FOREST_DIR`) for persistent DAG/event/object storage + `/api/events` SSE streaming, and supervises **MFN 2.0** (`setActiveMfnRuntime` + durable outbox) for learned context mapping.

```text
Electron shell (electron/)
   │ opens window                     │ spawns peer API + substrate on loopback
   v                                  v
Browser Window (Client = Host)     Node Process (src/api/main.ts -> src/server/stores.ts)
  public/client/index.html           ├── src/substrate/hardware-guard.ts (CPU / Nova-Vulkan only; blocks CUDA/ROCm)
  src/client/main.js                 ├── src/store/lumberjack/ ──(N-API C-ABI v2, PEER_FOREST_DIR)──> liblumberjack_peer.a
    state/   TS stores, ApiClient    │     └── /usr/lib/persist/peer/state/lumberjack (DAG, Events, /objects, SSE)
    theme/   --cc-* & --peer-*       └── src/memory/mfn/ ──(HTTP 127.0.0.1 + outbox)──> mfn-engine (6 CPU owners)
    blocks/  KaTeX, Mermaid, shiki             ├── /usr/lib/persist/peer/state/mfn/{data,runtime,secrets}
    views/   CloudCanvas UI & DAG              └── loopback Ollama (127.0.0.1:11434, nomic-embed-text, CPU/Vulkan)
```

## 2. Component Boundaries

| Component | Responsibility | Owns | Must not |
|---|---|---|---|
| `src/substrate/` | Hardware guardrail (`cpu` / `vulkan` only), child env scrubbing, native build & runtime path helpers | Env & binary safety checks | Allow CUDA/ROCm or `/tmp` paths |
| `src/store/lumberjack/` | Implement engine storage ports + multi-parent DAG, `/objects` snapshots, `ic_lj_stream_poll` SSE feed, and explicit LearnHarness importer (`importLearnHarnessData`) | `PEER_FOREST_DIR` (`/usr/lib/persist/peer/state/lumberjack`) | Write raw JSON/JSONL state files or import `src/client` |
| `src/memory/mfn/` | Supervise opt-in MFN 2.0 (`PEER_MFN_ENABLED=1`: `ifr`, `dsr`, `alm`, `cpe`, `psr`, `mfn-gateway`), manage `0600` `MFN_EMBEDDERS_FILE`, execute `turn.recall` & `turn.ingest`, persist `MfnIngestOutbox` (`startAutoFlush`). LLM summarization (`compaction.ts`) remains the default when MFN is not explicitly enabled | `<stateRoot>/mfn` | Expose non-loopback ports |
| `src/core`, `src/agent`, `src/server` | Pedagogical loops (`Prober`, `Teacher`, `Practitioner`, `Extractor`, `Auditor`), default LLM compaction (`compaction.ts`), FSRS-6, speech, CLI/API providers (`pi-ai 1.5.2`), remote `pi.dev` catalog overlay (`config/model-catalog`), and `src/server/stores.ts` LumberJack/SSE/MFN startup composition | Domain types & turn orchestration | Import `src/api` or `src/client` |
| `src/api/` | Standalone `node:http` + Web `Request -> Response` router (`52` routes, `76` methods), desktop gate, `POST /api/settings/import-learnharness`, stream passthrough, and `src/api/static.ts` 5-item `C1` static delivery (`index.html` SPA routes, allowlisted `/client/vendor/**`, `/client/src/**`, dotfile `404`, `Cache-Control: no-cache`) | HTTP transport & static delivery | Render HTML or hold application state |
| `public/client/` | Static HTML entry (`index.html` with source-file `<script type="importmap">` and `[data-theme-pending]`), base styles (`peer.css`), committed OFL `fonts/`, `shims/node-crypto.js`, and gitignored `esbuild` `build/` outputs (`scripts/client-build.mjs`) | Static client assets & import map | Inline secrets or drift from `extern/cloudcanvas*/package.json` |
| `src/client/kit/` | Isolated product-agnostic CloudCanvas UI controls (`L-1..L-21` + `UI_LIGHT_THEME`, `create<Name>(host, callbacks) => { update, destroy }`, `--cc-*` tokens only), ready to PR upstream into `CloudsEcosys/cloudcanvas-lib` | Reusable CloudCanvas primitives | Import `peer` state, views, `src/core`, or `--peer-*` tokens |
| `src/client/engine/` | Relocated & modularized framework-free `.ts` algorithms and DOM/canvas renderers (`graph/`, `session/`, `plugins/`, `dom/`) compiled via `esbuild` | Pure client domain & canvas mechanics | Import React, Next.js, or `src/server` |
| `src/client/main.js` | Single client composition root (`R5`): wires `createState()`, `createBlockRegistry()`, `applyThemeTokens(document.documentElement, ...)`, and `createShell(document.body, ...)` | Client boot & root wiring | Put application state in views |
| `src/client/state/` | TypeScript `ApiClient` (`api.ts`), universal `Store<M, I>` (`1/microtask`), SSE/router/settings/appearance/shell/session stores, and `screens/*.ts` projections | All client `/api/**` I/O, SSE & app state | Import CloudCanvas or touch the DOM |
| `src/client/theme/` | Maps 12-colour `Theme` palettes onto `--cc-*` and `--peer-*` tokens (`tokens.ts`) and applies them to `<html>` (`apply.js`, `R6`) | `<html>` theme/typography tokens | Mutate body views or fetch `/api/**` |
| `src/client/blocks/` | Transcript Markdown pipeline (`markdown.js`), `PluginCodeBlockRenderer` `registry.js`, `shiki` code, KaTeX math, strict Mermaid, `[Image blocked: alt]` policy, callouts & copy corners | Markdown & code-fence DOM blocks | Allow raw HTML or unguarded remote images |
| `src/client/views/` | Plain JS ES module CloudCanvas controls (`create<Name>`) & route screens (`create<Screen>View`, `1/rAF` slot coalescing): `shell/`, `shared/`, `session/`, and (`C2`) `graph/` `peer-graph` widget hosting `components/graph-canvas.ts` | Browser DOM controls & route screens | Call `fetch`/`localStorage`, import `state/`, or touch outside `host` |
| `extern/cloudcanvas` | CloudCanvas DOM runtime engine (`69076f7`, v0.7.1) | Submodule (read-only) | Be modified in-place |
| `extern/cloudcanvas-lib` | CloudCanvas widgets, archetypes, and board (`d5a5fa1`, v0.7.1+) | Submodule (read-only) | Be modified in-place |
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

Signature: Google Gemini 4 Carbon High - ebb091ba-315a-46f2-8fa2-a62f9c138c72
