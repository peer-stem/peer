# peer: design

Status: foundation draft, 2026-11-14; updated 2026-11-16 with the owner's architectural shift to **CloudCanvas + LumberJack DAG + MFN 2.0 learned memory**, and updated 2026-11-21 with the owner's finalization rulings (`.context/logs/plans/2026-11-21-finalization-f0-f5-cloudcanvas-cutover-plan.md`): upstream `v0.7.0` parity, isolated `src/client/kit/` + `src/client/engine/`, LLM summarization retained as the default until MFN 2.0 is proven (`PEER_MFN_ENABLED=1`), and Electron `userData` (`~/.config/peer`) as the default desktop state root.

## 1. Purpose

`peer` is an autonomous learning environment derived from LearnHarness: agents probe what a learner understands, plan a multi-parent learning DAG toward a goal, teach and practice step by step, and persist knowledge, mastery, and associative context.

Instead of keeping raw JSON/JSONL files, 20k-token LLM compaction summaries, or 1:1 clones of upstream React screens, `peer` builds natively on three external foundations:

1. **CloudCanvas (`CloudsEcosys/cloudcanvas` + `cloudcanvas-lib`)**: treats the DOM as the runtime engine (`Client = Host`), enabling both native views and model-authored interactive visual surfaces.
2. **LumberJack (`NeoTecDigital/LumberJack`)**: replaces raw JSON/JSONL files with a persistent, multi-parent DAG forest (`Node`s, `Event`s, `Entry` records, `/objects` binary attachments, `slots`, and `ic_lj_stream_poll` mutation cursors).
3. **MFN 2.0 (`NeoTecDigital/MFN`)**: replaces lossy LLM compaction summaries with spreading-activation learned memory (`turn.recall` and `turn.ingest` across IFR, DSR, ALM, CPE, and PSR) paired with a compact live turn tail.

## 2. Who it serves

One learner on their own Linux desktop machine, running Electron with dedicated `peer`-owned LumberJack and MFN 2.0 runtimes, their own model providers, and local speech/embedding models.

## 3. Core Decisions (confirmed by the owner, 2026-11-14 and 2026-11-16)

| Topic | Decision |
|---|---|
| Repository & branches | `peer-stem/peer` (fork of `amosblomqvist/learnharness`). Feature branches merge via PR into `master`; `main` receives releases only |
| Application direction (2026-11-16) | Build `peer` natively out of **CloudCanvas** and migrate the LearnHarness engine pieces that work (`Prober`, `Teacher`, `Practitioner`, `Extractor`, `Auditor`, `FSRS-6`, `graph-canvas.ts`, local speech, CLI providers). Supersedes the earlier 1:1 legacy React screen parity gate |
| External submodules (`extern/`) | Four pinned submodules, never modified in-place: `extern/cloudcanvas` (`69076f7`, 0.7.1), `extern/cloudcanvas-lib` (`d5a5fa1`, 0.7.1+), `extern/lumberjack` (`f4e8055`), and `extern/mfn` (`489ca2f`, MFN 2.0.0). Each pin moves in a commit of its own |
| Database & DAG (`LumberJack`) | Dedicated `peer`-managed LumberJack forest under `<stateRoot>/lumberjack` (`~/.config/peer/lumberjack` on desktop by default, overridable via `PEER_STATE_ROOT` or `PEER_FOREST_DIR`; `tiered` persistence). Replaces all raw JSON/JSONL files in `LH_DATA_DIR` except `0600` credential files |
| Conversation compaction & learned memory (`compaction.ts` default, `MFN 2.0` opt-in) | **2026-11-21 owner ruling**: Keep LearnHarness LLM-summarization (`src/core/compaction.ts` + `src/server/compaction.ts`) as the **default** for long conversations until MFN 2.0 is proven and refined. MFN 2.0 (`POST /v2/execute`, `turn.recall` / `turn.ingest`) stays frozen at its `S3` baseline and activates only on explicit opt-in (`PEER_MFN_ENABLED=1`) |
| Agnostic UI kit & client engine (`src/client/{kit,engine}/`, 2026-11-21) | Missing product-agnostic CloudCanvas UI controls (`L-1..L-21` + `UI_LIGHT_THEME`) live in `src/client/kit/` (zero `peer` imports, `cloudcanvas-lib/ui` contract & `--cc-*` tokens, ready to PR upstream into `CloudsEcosys/cloudcanvas-lib`), while framework-free `.ts` algorithms/renderers live in `src/client/engine/` |
| Hardware guardrail (2026-11-16) | **CRITICAL**: Only **Nova/Vulkan** or **CPU-only** execution is permitted anywhere (`peer`, MFN, LumberJack, Ollama embedder, speech, builds). **CUDA and ROCm are strictly forbidden** — probing or loading either crashes the host computer |
| Embedder | Local loopback Ollama (`http://127.0.0.1:11434`, `nomic-embed-text:latest`, 768d) pinned by 64-hex `model_digest` in `0600` `MFN_EMBEDDERS_FILE` under CPU or Nova/Vulkan, with `hash_v1` degraded recall + durable LumberJack outbox retry when offline |
| Existing state & import (2026-11-16) | `peer` has **no pre-existing state** of its own. Provide an explicit read-only importer (`importLearnHarnessData`) to import upstream LearnHarness data directories (`chats/`, `graph/`, `images/`, Flashcards FSRS) into LumberJack + MFN on demand |
| Where the interface runs | Client is the host: static native ES modules in the browser window (`src/client/`), handed out unchanged on the same origin by `src/api/static.ts`. Nothing renders server-side |
| Engine API (`src/api`) | Standalone `node:http` + Web `Request -> Response` server (`PORT` required, no default), serving `/api/**` and static client assets without Next.js |
| Placement rule | Fundamental to CloudCanvas engine -> `cloudcanvas`; project-agnostic widgets/board -> `cloudcanvas-lib`; `peer`-specific views, DAG stores, and MFN memory -> `peer` |
| Storage & `/tmp` rule | Runtime state, native builds, and scratch directories live on SSD under `/usr/lib/persist/peer/{state,build,scratch}`. Never write to `/tmp` (`tmpfs` RAM) |

## 4. Principles

1. **The DOM is the client runtime.** No React, Next.js, or virtual DOM in `src/client/`. Views are CloudCanvas controls/widgets receiving plain models and emitting intents via callbacks.
2. **Graph-native state, not flat files.** Knowledge propositions, joint-premise derivation chains, lesson `PlanTree`s, sources, and learner mastery/FSRS schedules are first-class nodes and edges in LumberJack's multi-parent DAG.
3. **Associative recall over lossy compaction.** Exact recent messages stay untouched for tool continuity and KV-cache stability; older and cross-session context is retrieved dynamically by MFN spreading activation (`turn.recall`) and reinforced on settlement (`turn.ingest`).
4. **Hardware safety by construction.** Every child environment passes through `src/substrate/hardware-guard.ts` to scrub CUDA/ROCm variables before process spawn, and native binaries are verified free of CUDA/ROCm shared objects.
5. **Data, not executable script, from the model.** Model-authored canvases and diagrams are validated data documents or sandboxed opaque-origin frames.
6. **House engineering laws.** Maintainability -> Correctness -> Efficiency; max 500 lines/file, 50 lines/definition, 3 indentation levels; unit, integration, and end-to-end tests in `tests/`.

## 5. Learner Capabilities Enabled by LumberJack + MFN

The LumberJack multi-parent DAG + MFN 2.0 substrate directly supports the learner capabilities recorded on 2026-11-14:

| Capability | Substrate Home |
|---|---|
| Persistent learner profile (goals, interests, style, confidence) | LumberJack `learner/profile` node + MFN `tags: ["kind:learner"]` memories |
| Mastery, mystery, and ongoing skill ranking | LumberJack `proposition` node metadata (`mastery`, `fsrs`) + multi-parent gap traversal |
| Cross-subject linking, seams, and chained learning | LumberJack multi-parent `Parents` across sources/domains + MFN L5 `echo_of` & L3 Hebbian co-activation |
| Masterclass multi-session roadmaps | LumberJack `plans/<id>/<node>` DAGs linked across sessions + MFN L5 theme centroids |
| Model-generated assessment visuals & dashboards | CloudCanvas widget/board documents + LumberJack `/objects` BLAKE3 attachments |

## 6. Later Learner Design Points (Phase 6–7 Backlog, Recorded 2026-11-14)

Folded from `docs/design-points-2026-11-14` (`4c6cb42`); each opens with its own Discovery sprint after parity/cutover:

| Design Point | LumberJack + MFN + CloudCanvas Substrate Mapping |
|---|---|
| **Learn more (`+`) on a section** | Learner adds `(+)` on a section and tells the model where to expound; extends `plans/<chat_id>/*` and `knowledge/*` DAG nodes dynamically beyond author-once `plan_init` |
| **Quizzes graded on ability** | Grades quiz responses on ability to calibrate higher-order/degree follow-up quizzes over `learner/progress/*` mastery & FSRS state |
| **Expand a set of topics in conversation** | Synthesizes mastered vs struggled propositions and MFN recall across curriculum/interests/goals to generate new learning paths |
| **Skill tree** | Model-built CloudCanvas visual stage (Phase 6) mapping cross-session successes and failures onto the multi-parent proposition/plan DAG |
| **Definitions & learning levels** | Structured definition field + metadata hierarchy (`lesson`, `topic`, `unit`, `subject`, `discipline` — nesting **open**) on `knowledge/propositions/*` and `sessions/*` |
| **Notes and a notebook** | Post-teaching section notes (`"notes don't require me to write a comment"`; model-authored notes **open**) aggregated by metadata/tags into a cross-session notebook in LumberJack |
| **Key Points** | Inline section links saved without required comment as a personal study guide & interactive notebook; flagged in LumberJack as active practice targets with back-navigation and single/all/mixed practice launch (model-marked key points **open**) |

Signature: Google Gemini 4 Carbon High - ebb091ba-315a-46f2-8fa2-a62f9c138c72
