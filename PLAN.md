# peer: plan

Status: updated 2026-11-16 to execute the owner-approved **LumberJack DAG + MFN 2.0 Learned Memory + CloudCanvas App** roadmap (`.context/logs/plans/2026-11-16-lumberjack-mfn-cloudcanvas-integration-plan.md`), superseding the earlier raw-file + 1:1 legacy React parity waves.

## 1. Execution Roadmap

```text
A1–A2 Engine API (PR #5, verified) ──────────────────────────────────────────────┐
S0 Submodules, Docs, Hardware Guard & Native Build ──> S1 LumberJack DAG Store ──┼──> C1–C2 CloudCanvas peer App ──> C3 Electron Cutover & Removal
                                                   └──> S2 MFN 2.0 Memory ───────┘
```

| Phase | Sprint / Branch | Scope | Quality Gate |
|---|---|---|---|
| **A: Engine API** | `feature/1.2-engine-api` (PR #5) | Standalone `src/api` server (50 routes, 73 methods, 5 streams, static file delivery, QA fixes) | Complete & verified (`308fd36`: 53/53 unit, 25/25 parity, 5,460/5,465 suite) |
| **Phase 1 (`S0`)** | `feature/s0-substrate-foundation` | Pin `cloudcanvas` (`69076f7`), `cloudcanvas-lib` (`155271b`), `lumberjack` (`f4e8055`), `mfn` (`489ca2f`) in separate commits; update root docs; implement `src/substrate/hardware-guard.ts` + `scripts/build-substrate.mjs`; compile CPU-only LumberJack & MFN into `/usr/lib/persist/peer/build/` | All 4 submodules clean; `nm` 19-export & C11 SSD smoke green; MFN 6 binaries `ldd`-clean (zero CUDA/ROCm) & `ping`/`health.get` green |
| **Phase 2 (`S1`)** | `feature/s1-lumberjack-dag-store` | N-API C-ABI v2 binding + LumberJack product extension; multi-parent DAG stores (`ChatStore`, `GraphStore`, `PlanTree`, `Learner`, `JobStore`, `SettingsStore`, `ThemeStore`, `PromptOverrideStore`, `PluginStore`, `/objects` attachments, `ic_lj_stream_poll` SSE); read-only `importLearnHarnessData(sourceDir)` | Unit + integration tests on SSD scratch; round-trip import of LearnHarness snapshot (nodes, multi-parent chains, chats, side-chats, images, FSRS) |
| **Phase 3 (`S2`)** | `feature/s2-mfn-context-mapping` | `src/memory/mfn/` supervisor + `/v2/execute` client + `0600` `MFN_EMBEDDERS_FILE` (Ollama `nomic-embed-text` digest pin, CPU or Nova/Vulkan); wire `turn.recall` (`turn-preparation.ts`) & `turn.ingest` + LumberJack outbox retry; retire 20k LLM compaction | Cross-session Hebbian recall tests, zero duplicate live-tail memories, degraded `hash_v1` fallback when embedder stopped, zero CUDA/ROCm env leakage |
| **Phase 4 (`C1–C2`)** | `feature/c1-cloudcanvas-app` | Build `src/client/` natively on CloudCanvas `0.7.1` + `cloudcanvas-lib` `0.7.1` + `src/api`: Knowledge & Mastery DAG canvas (`graph-canvas.ts` + widgets), Lesson/Practice workspace with MFN theme/recall visibility, Flashcards FSRS view, Settings/Models/Voice, and LearnHarness Import UI | Linkedom view unit tests + `puppeteer-core` E2E tests against live `src/api` + LumberJack + MFN on SSD scratch |
| **Phase 5 (`C3`)** | `feature/c3-cutover-and-removal` | Wire `electron/main.cjs` to launch `src/api` + LumberJack + MFN under `/usr/lib/persist/peer/state/{lumberjack,mfn}`; delete `app/`, React `components/`, Next.js, Tailwind, raw-file store adapters, and compaction code; package release | Consolidated QA (security, efficiency, <=500/50/3 code bounds), full test suite green, Richard's Trial & sign-off |

## 2. Standing Operating Rules

1. **Hardware Crash Guardrail**: Never probe, compile, link, or expose CUDA or ROCm anywhere. Only CPU-only or Nova/Vulkan is permitted.
2. **SSD Storage & Zero `/tmp`**: Builds, caches, and scratch directories live under `/usr/lib/persist/peer/{build,scratch}`; never write to `/tmp`.
3. **Submodule Integrity**: Never modify files inside `extern/*`; each pin move is its own commit; native build outputs go to `/usr/lib/persist/peer/build/`.
4. **Running-App Guard**: Never touch `/usr/lib/persist/peer/{current,releases,state}`, `~/.local/bin/peer`, or `~/.config/LearnHarness` until Richard signs off cutover.
5. **Context & PDL Persistence**: Record plans, requirements, restrictions, and sprint reports in `.context` (committed via `ctx vcs commit`) and checkpoints/evidence in `pdl`.

## 3. Expected and Actual

| Stage / Sprint | Expected | Actual |
|---|---|---|
| 0 Foundation & Stage 0 | Initial docs, cleanup, PR #1 & #2 review and merge | Delivered 2026-11-14 (`master` `5d5b6e2`) |
| Sprint 1.1 (`PR #3`) | Route inventory, static surface, SPEC §2 API contract, initial submodule | Delivered & merged (`master` `193f241`) |
| Stream A (`A1` + `A2`, `PR #5`) | Standalone `src/api` server, parity suite vs Next standalone, 3-angle QA & fixes | Delivered on `feature/1.2-engine-api` (`308fd36`): all 18 QA fixes verified, 53/53 unit, 25/25 parity, 5,460/5,465 full suite green |
| Architecture Pivot (2026-11-16) | Align on CloudCanvas-native app + LumberJack DAG + MFN 2.0 learned memory | Visual maps archived in `.context/base/resources/` and `~/Documents/learningHarness-*.html`; requirements, hardware restriction, and 5-phase plan approved by Richard |
| Phase 1 (`S0`) | Pin 4 submodules (`cloudcanvas` `69076f7`, `cloudcanvas-lib` `155271b`, `lumberjack` `f4e8055`, `mfn` `489ca2f`), update docs, build CPU-only LumberJack & MFN, verify hardware guard & smoke tests | Delivered on `feature/s0-substrate-foundation`: 4 separate submodule pin commits, root docs updated, `src/substrate/hardware-guard.ts` + `scripts/build-substrate.mjs` + `tests/substrate-foundation.test.ts` verified (`tsc`, `eslint`, 6/6 substrate tests in 0.79 s, zero CUDA/ROCm libraries, zero `/tmp` writes) |

Signature: Google gemini-4-carbon high - 04da2a6d-9328-4ad4-b892-398e4c39b74c
