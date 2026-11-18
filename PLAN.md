# peer: plan

Status: updated 2026-11-17 to reflect merged sprints `A1–A2`, `S0`, `S1`, `S2` on `master` (`8b2b718`), Sprint `S3` (`5ad6577` + second pass executing Governor re-review `§8`), and the open `§9` / `§10` owner decisions gating PR sign-off and `C1`.

## 1. Execution Roadmap & Required Gate Commands

```text
A1–A2 Engine API (PR #5, 4fc52b3) ──────────────────────────────────────────────────────────────┐
S0 Substrate (PR #6) ──> S1 LumberJack Store (PR #7) ──> S2 MFN 2.0 Memory (PR #8) ──> S3 (2p) ─┼──> [Owner Gates] ──> C1–C2 CloudCanvas App ──> C3 Cutover & Removal
```

- **Required test gates**: `npm run test:gate` (`NODE_ENV=test PEER_REQUIRE_SUBSTRATE=1 tsx --test tests/*.test.ts tests/*.test.tsx`), `npm run test:substrate`, `npm run typecheck`, `npm run lint`, and API parity (`npm run build && NODE_ENV=test PEER_API_PARITY=1 tsx --test tests/api-parity.test.ts`).

| Phase / Sprint | Branch / PR | Scope | Gate / Standing |
|---|---|---|---|
| **A: Engine API (`A1–A2`)** | `feature/1.2-engine-api` (PR #5, `4fc52b3`) + `S3` | Standalone `src/api` server (50 routes, 73 methods, 5 streams, static delivery), A2 review fixes + 8 follow-up items | Verified in Governor re-review (`24/24` parity + `long-stream` pass, `84/84` unit+chat); awaits owner decision on `D1–D6` + 8 parity differences (`SPEC §8.1–§8.2`) |
| **Phase 1 (`S0`)** | `feature/s0-substrate-foundation` (PR #6, `8d555dd`) + `S3` (`F1–F6`, `N13`) | Pin 4 submodules; root docs; `gpu-policy.mjs` + `hardware-guard.ts` + `build-substrate.mjs` (SSD caches + manifest hashes); `PEER_REQUIRE_SUBSTRATE=1` gate scripts | Accepted (`7/7` substrate tests, 10/10 binary hashes match `substrate-manifest.json`, zero GPU `.so`) |
| **Phase 2 (`S1`)** | `feature/s1-lumberjack-dag-store` (PR #7, `d47294a`) + `S3` (`L1–L4,L8–L11`, `N8,N10`) | N-API C-ABI v2 binding + Go extension; LumberJack stores (`node_path` SSE, durable `learner/progress/*`, `delete_node` tree-parent unlink); `importLearnHarnessData` (`O_NOFOLLOW`, ID/read/`updatedAt` guards) | `L1–L4, L8–L11, N8, N10` remediated & rebuilt; `L5` (`/objects`), `L6/L7` (`Event`/`Entry` vs slots), `N9`, `N11` await owner decisions |
| **Phase 3 (`S2`)** | `feature/s2-mfn-context-mapping` (PR #8, `8b2b718`) + `S3` (`M1,M2,M6–M8,M10–M13`, `N1,N2,N4,N6,N7`) | MFN 2.0 supervisor (`/proc` child tracking) + `/v2/execute` client + `0600` embedder pin; `chat-handler.ts`/`mfn-turn-bridge.ts` recall & ingest + age/backoff dead-letter outbox (`memory.put` + `turn.ingest`) | `M1, M2, M6–M8, M10–M13, N1, N2, N4, N6, N7` remediated; `M3` (embedder GPU check), `M4/M5` (fence/cap), `N3` (MFN-down tail vs compaction), `N5` await owner decisions |
| **Correction Sprint (`S3`)** | `feature/s3-governor-review-fixes` | Pass 1 (`5ad6577`: `§9` of `8b2b718` review) + Pass 2 (`§8` of `5ad6577` re-review: `N1,N2,N4,N6,N7,N8,N10,N13`, `§6` doc corrections, `health.get`-verified pause & positive-control tests) | Ready for Governor verification & Richard's sign-off |
| **Phase 4 (`C1–C2`)** | `feature/c1-cloudcanvas-app` | Build `src/client/` on CloudCanvas `0.7.1` + `cloudcanvas-lib` `0.7.1` + `src/api`; wire `stores.ts`, LumberJack outbox + `startAutoFlush`, MFN runtime, and SSE bridge | Blocked on `SPEC §8.3` owner decisions and Governor acceptance of `S3` |
| **Phase 5 (`C3`)** | `feature/c3-cutover-and-removal` | Wire `electron/main.cjs` to `src/api` + LumberJack + MFN; remove `app/`, React `components/`, Next.js, Tailwind, raw-file store adapters, and `compaction.ts` | Consolidated QA, full E2E suite, Richard's Trial & sign-off |

## 2. Standing Operating Rules

1. **Hardware Crash Guardrail**: Never probe, compile, link, or expose CUDA or ROCm anywhere. Only CPU-only or Nova/Vulkan is permitted.
2. **SSD Storage & Zero `/tmp`**: All builds, Go/Cargo/Zig caches (`GOCACHE`, `GOMODCACHE`, `GOPATH`, `CARGO_HOME`), and scratch directories live under `/usr/lib/persist/peer/{build,scratch}`; never write to `/tmp` or `~/go` / `~/.cargo`.
3. **Submodule Integrity**: Never modify files inside `extern/*`; each pin move is its own commit; native build outputs go to `/usr/lib/persist/peer/build/`.
4. **Running-App Guard**: Never touch `/usr/lib/persist/peer/{current,releases,state}`, `~/.local/bin/peer`, or `~/.config/LearnHarness` until Richard signs off cutover.
5. **Context & PDL Persistence**: Record plans, requirements, restrictions, and sprint reports in `.context` (`ctx vcs commit`) and checkpoints/evidence in `pdl` via MCP (claiming only completed steps, never Launch/Growth or self-verification).

## 3. Expected and Actual

| Stage / Sprint | Expected | Actual |
|---|---|---|
| `0 Foundation` & `1.1` | Initial docs, cleanup, route inventory, static surface, SPEC §2 API contract (`PR #1–#3`) | Delivered & merged (`master` `193f241`) |
| `Stream A` (`A1 + A2`, `PR #5`) | Standalone `src/api` server, parity suite vs Next standalone, A2 review fixes | Merged `4fc52b3`; all 8 A2 follow-ups fixed in `S3` and confirmed by Governor parity run (`24/24` + `long-stream` pass); awaits owner decision on `D1–D6` + 8 `approved: false` parity differences |
| `Architecture Pivot` (2026-11-16) | Align on CloudCanvas-native app + LumberJack DAG + MFN 2.0 learned memory | Visual maps archived; requirements, hardware restriction, and 5-phase plan approved by Richard (`pdl 1f0fed50e576`) |
| `Phase 1 (S0)` (`PR #6`) | Pin 4 submodules, update docs, build CPU-only LumberJack & MFN, verify hardware guard & smoke tests | Merged `8d555dd`; `F1–F6` and `N13` (`PEER_REQUIRE_SUBSTRATE=1` gate scripts) completed in `S3` |
| `Phase 2 (S1)` (`PR #7`) | N-API C-ABI v2 binding, LumberJack DAG stores, `/objects` attachments, `ic_lj_stream_poll` SSE, read-only `importLearnHarnessData` | Merged `d47294a` (inactive on `master` until `C1`). `L1–L4, L8–L11` plus re-review `N8` (`.`/`..`/empty ID guard, `O_NOFOLLOW` & read-error isolation, missing `updatedAt`) and `N10` (`delete_node` tree-parent unlink on `clear_parents` plan nodes) fixed in `S3`; `L5`, `L6/L7`, `N9`, `N11` await owner decisions |
| `Phase 3 (S2)` (`PR #8`) | MFN 2.0 supervisor, `/v2/execute` client, `0600` embedder pin, `turn.recall` & `turn.ingest` + LumberJack outbox, retire compaction | Merged `8b2b718` (inactive on `master` until `C1`; recall/ingest in `chat-handler.ts` + `mfn-turn-bridge.ts`, `M9`). Pass 1 (`5ad6577`) fixed `M1,M2,M7,M8` (`/proc` child tracking), `M10–M13`, and provoked `503 admission_paused`, but introduced `N1/N2` (flush-count/systemic-error deletion) and `N3` (live-tail-only when MFN down; uncompacted fallback on prep throw). Pass 2 fixes `N1,N2,N4,N6,N7` (persisted `dead_letter`, age+backoff retry, stop-on-systemic-error, remove-by-`operationId`, `<=2` peek concurrency) and tests `health.get`-verified `dispatch_paused: true` before writing; `M3, M4/M5, N3, N5` await owner decisions |
| `Sprint S3` (`feature/s3-governor-review-fixes`) | Pass 1 (`§9` of `8b2b718` review) + Pass 2 (`§8` of `5ad6577` re-review), native rebuild, leave `§9`/`§10` owner items untouched | Pass 1 (`5ad6577`) + Pass 2 committed on `feature/s3-governor-review-fixes` with rebuilt native artifacts and `§6` doc corrections; awaiting Governor re-review & Richard's sign-off |

## 4. Open Owner Decisions (`SPEC §8.3`)

1. **`§10.2` (`M3`)**: Embedder GPU enforcement on external vs `peer`-owned Ollama.
2. **`§10.3` (`L5`, `L6`, `L7`)**: `/objects` images and canonical `Event`/`Entry` conversations/jobs vs node slots/attachments.
3. **`§10.4` + `§9.2` (`M4`, `M5`, `N3`)**: Recalled block fence & size cap, plus MFN-down live-tail-only vs compaction fallback.
4. **`§10.5`**: Client contract for `C1` (`B1` contracts vs new derivation).
5. **`§10.6` & `§9.3–§9.4` & `§8.5`**: `D1–D6` + 8 parity differences, PDL claim verification (`§9.3`), Next 16.4.3 advisory (`N15`), and deferred minor items (`N5, N9, N11, N14`).

Signature: Google gemini-4-carbon high - 04da2a6d-9328-4ad4-b892-398e4c39b74c
