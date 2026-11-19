# peer: plan

Status: updated 2026-11-18 to reflect Sprint `S3` merged on `master` in PR #9 (`f767f64`), Sprint `S4` (`s4-pre-c1-alignment`) executing Richard's `2026-11-17` decisions (`D1–D6`, `M3`, `L5–L7`, `N9, N11, N14, N15, N20, N21`, adapted `§10.5` client contracts), and Richard's `2026-11-18` ruling (`owner-decision-bench-mfn-tuning-beyond-basic-wiring`) benching MFN fine-tuning beyond basic turn-bridge/runtime wiring.

## 1. Execution Roadmap & Required Gate Commands

```text
A1–A2 Engine API (PR #5, 4fc52b3) ───────────────────────────────────────────────────────────────────────────┐
S0 Substrate (PR #6) ──> S1 LumberJack (PR #7) ──> S2 MFN (PR #8) ──> S3 Fixes (PR #9, f767f64) ──> S4 ─────┼──> C1–C2 CloudCanvas App ──> C3 Cutover & Removal
```

- **Required test gates**: `npm run test:gate` (`NODE_ENV=test PEER_REQUIRE_SUBSTRATE=1 ./node_modules/.bin/tsx --test tests/*.test.ts tests/*.test.tsx`), `npm run test:substrate`, `npm run typecheck`, `npm run lint`, and API parity (`npm run build` — run twice if `.next/standalone` is absent due to Next 16.4.3's first-run advisory notice — followed by `npm run test:parity` / `NODE_ENV=test PEER_API_PARITY=1 ./node_modules/.bin/tsx --test tests/api-parity.test.ts`).

| Phase / Sprint | Branch / PR | Scope | Gate / Standing |
|---|---|---|---|
| **A: Engine API (`A1–A2`)** | `feature/1.2-engine-api` (PR #5, `4fc52b3`) + `S3` + `S4` | Standalone `src/api` server (50 routes, 73 methods, 5 streams, static delivery), A2 follow-ups 1–8, `D3` loopback-only `HOSTNAME`, `D4` `approved: true` | `D1–D6` + all 8 recorded parity differences approved (`2026-11-17`); `D3`/`D4` & `N21` (`test:parity`) completed in `S4` |
| **Phase 1 (`S0`)** | `feature/s0-substrate-foundation` (PR #6, `8d555dd`) + `S3` (`F1–F6`, `N13`) | Pin 4 submodules; root docs; `gpu-policy.mjs` + `hardware-guard.ts` + `build-substrate.mjs` (SSD caches + manifest hashes); `PEER_REQUIRE_SUBSTRATE=1` gate scripts | Accepted (`7/7` substrate tests across split suites, 10/10 binary hashes match `substrate-manifest.json`, zero GPU `.so`) |
| **Phase 2 (`S1`)** | `feature/s1-lumberjack-dag-store` (PR #7, `d47294a`) + `S3` + `S4` | N-API C-ABI v2 binding + Go extension; canonical `/objects` images (`L5`), canonical `Event`/`Entry` chats/side-chats/usage/jobs (`L6/L7`), ledger/progress hygiene (`N9`), `stream-events` (`N11`) | `L1–L11` and `N8–N11` remediated in `S3`/`S4` |
| **Phase 3 (`S2`)** | `feature/s2-mfn-context-mapping` (PR #8, `8b2b718`) + `S3` | MFN 2.0 supervisor (`/proc` child tracking) + `/v2/execute` client + `0600` embedder pin; `chat-handler.ts`/`mfn-turn-bridge.ts` basic recall & ingest + age/backoff dead-letter outbox | Frozen at Governor-verified `S3` baseline (`f767f64`); `M3` systemd CPU-only Ollama documented (`SPEC §1.3`); fine-tuning beyond basic wiring **benched** (`2026-11-18`) |
| **Correction Sprint (`S3`)** | `feature/s3-governor-review-fixes` (PR #9, `f767f64`) | Pass 1 (`5ad6577`) + Pass 2 (`N1,N2,N4,N6,N7,N8,N10,N13`, `§6` doc corrections, `health.get`-verified pause & positive-control tests) | Merged to `master` (`f767f64`) |
| **Pre-`C1` Alignment (`S4`)** | `feature/s4-pre-c1-alignment` | `L5–L7, N9, N11` canonical LumberJack stores; `D3` loopback `HOSTNAME`, `D4` `approved: true`, `M3` spec wording, `N14/N20/N21` splits + single-check asserts + `test:parity`; `§10.5` client contracts (`C-01..C-18`) + `DESIGN §6` later design points | QA passed (`5,510` gate, `44/44` substrate, `24/24` parity); `C-01..C-18` & merge approved by Richard (`2026-11-19`) |
| **Phase 4 (`C1–C2`)** | `feature/c1-client-base` -> `feature/c2-screens` | Build `src/client/` inside `peer` around `cloudcanvas` `69076f7` + `cloudcanvas-lib` `d5a5fa1` + `src/api`; wire `stores.ts`, LumberJack outbox + `startAutoFlush`, basic MFN runtime, SSE bridge, and `POST /api/settings/import-learnharness` | `C1` unblocked (`C-01..C-18` approved `2026-11-19`); upstream `cloudcanvas-lib` PRs queued separately |
| **Phase 5 (`C3`)** | `feature/c3-cutover-and-removal` | Wire `electron/main.cjs` to `src/api` + LumberJack + MFN; remove `app/`, React `components/`, Next.js, Tailwind, raw-file store adapters, and `compaction.ts` | Consolidated QA, full E2E suite, Richard's Trial & sign-off |
| **Phases 6–7 (`Later`)** | Per-feature Discovery branches | Model-built CloudCanvas stages + the learner design points in `DESIGN §5–§6` (`Learn more (+)`, ability-graded quizzes, topic expansion, skill tree, definitions/levels, notebook, Key Points) | Opens per item with Discovery after `C3` cutover |

## 2. Standing Operating Rules

1. **Hardware Crash Guardrail**: Never probe, compile, link, or expose CUDA or ROCm anywhere. Only CPU-only or Nova/Vulkan is permitted; external system Ollama runs CPU-only under `/etc/systemd/system/ollama.service.d/zzzz-dirty-cpu-only.conf` (`SPEC §1.3`).
2. **SSD Storage & Zero `/tmp`**: All builds, Go/Cargo/Zig caches (`GOCACHE`, `GOMODCACHE`, `GOPATH`, `CARGO_HOME`), and scratch directories live under `/usr/lib/persist/peer/{build,scratch}`; never write to `/tmp` or `~/go` / `~/.cargo`.
3. **Submodule & Benched-MFN Guard**: Never modify files inside `extern/*` or alter `src/memory/mfn/**` beyond basic runtime wiring while MFN fine-tuning is benched (`2026-11-18`).
4. **Running-App Guard**: Never touch `/usr/lib/persist/peer/{current,releases,state}`, `~/.local/bin/peer`, or `~/.config/LearnHarness` until Richard signs off cutover.
5. **Context & PDL Persistence**: Record plans, requirements, restrictions, and sprint reports in `.context` (`ctx vcs commit`) and checkpoints/evidence in `pdl` via MCP (claiming only completed steps, never Launch/Growth or self-verification).

## 3. Expected and Actual

| Stage / Sprint | Expected | Actual |
|---|---|---|
| `0 Foundation` & `1.1` | Initial docs, cleanup, route inventory, static surface, SPEC §2 API contract (`PR #1–#3`) | Delivered & merged (`master` `193f241`) |
| `Stream A` (`A1 + A2`, `PR #5`) | Standalone `src/api` server, parity suite vs Next standalone, A2 review fixes | Merged `4fc52b3`; A2 follow-ups 1–8 merged in `f767f64`; `D1–D6` + 8 parity differences approved (`2026-11-17`) and enforced in `S4` |
| `Architecture Pivot` (2026-11-16) | Align on CloudCanvas-native app + LumberJack DAG + MFN 2.0 learned memory | Visual maps archived; requirements, hardware restriction, and 5-phase plan approved by Richard (`pdl 1f0fed50e576`) |
| `Phase 1 (S0)` (`PR #6`) | Pin 4 submodules, update docs, build CPU-only LumberJack & MFN, verify hardware guard & smoke tests | Merged `8d555dd`; `F1–F6` and `N13` completed in `S3` (`f767f64`) |
| `Phase 2 (S1)` (`PR #7`) | N-API C-ABI v2 binding, LumberJack DAG stores, `/objects`, `ic_lj_stream_poll` SSE, read-only `importLearnHarnessData` | Merged `d47294a`; `L1–L4, L8–L11, N8, N10` fixed in `S3`; canonical `/objects` (`L5`), canonical `Event`/`Entry` (`L6/L7`), `N9`, and `N11` completed in `S4` |
| `Phase 3 (S2)` (`PR #8`) | MFN 2.0 supervisor, `/v2/execute` client, `0600` embedder pin, `turn.recall` & `turn.ingest` + LumberJack outbox | Merged `8b2b718`; `M1,M2,M6–M8,M10–M13,N1,N2,N4,N6,N7` merged in `S3` (`f767f64`); fine-tuning beyond basic wiring benched `2026-11-18` |
| `Sprint S3` (`PR #9`, `f767f64`) | Pass 1 + Pass 2 Governor review fixes, native rebuild, `§6` doc corrections | Merged to `master` (`f767f64`) |
| `Sprint S4` (`s4-pre-c1-alignment`) | Implement `D3, D4, L5–L7, N9, N11, N14, N20, N21`, `M3` spec wording, bench MFN tuning, adapt `§10.5` client contracts | Implemented across parallel tracks; ready for consolidated QA, Governor review & owner sign-off |

## 4. Settled, Benched & Remaining Pre-`C1` Gates (`SPEC §8.3`)

1. **Settled (`2026-11-17` / `S4`)**: `D1–D6` + all 8 parity differences (`approved: true`), `M3` systemd CPU-only Ollama guarantee (`SPEC §1.3`), `L5–L7` canonical LumberJack `/objects` + `Event`/`Entry`, `N9` + `N11` store/stream hygiene, `N14` + `N20` + `N21` code/test hygiene & `npm run test:parity`, and `N15` closed (Next removed at `C3`).
2. **Benched (`2026-11-18`, `owner-decision-bench-mfn-tuning-beyond-basic-wiring`)**: MFN fine-tuning beyond basic turn-bridge/runtime wiring (`§3` recall structure/staleness, `M4`, `M5`, `N3`, active `M3` daemon probes, `N5`, `N17–N19`, `N22`).
3. **Approved for `C1` (`2026-11-19`)**: Richard approved `C-01..C-18` (`2026-11-19-client-contract-{views,state,seams}.md`) to build `C1` inside `peer` around `cloudcanvas` (`69076f7`) and `cloudcanvas-lib` (`d5a5fa1`) with zero `extern/` edits (upstream `L-1..L-4`/`L-16` PRs queued separately); Governor PDL verification (`§9.3`) paused while no governing model is running.

Signature: Google gemini-4-carbon high - 04da2a6d-9328-4ad4-b892-398e4c39b74c
