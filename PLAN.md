# peer: plan

Status: updated 2026-11-17 to reflect merged sprints `A1–A2`, `S0`, `S1`, `S2` on `master` (`8b2b718`), execution of Sprint `S3` (Governor review `§9` remediation), and the open `§10` owner decisions gating `C1`.

## 1. Execution Roadmap

```text
A1–A2 Engine API (PR #5, 4fc52b3) ──────────────────────────────────────────────────────────────┐
S0 Substrate (PR #6) ──> S1 LumberJack Store (PR #7) ──> S2 MFN 2.0 Memory (PR #8) ──> S3 (§9) ─┼──> [§10 Owner Gates] ──> C1–C2 CloudCanvas App ──> C3 Cutover & Removal
```

| Phase / Sprint | Branch / PR | Scope | Gate / Standing |
|---|---|---|---|
| **A: Engine API (`A1–A2`)** | `feature/1.2-engine-api` (PR #5, `4fc52b3`) + `S3` (§8) | Standalone `src/api` server (50 routes, 73 methods, 5 streams, static delivery), A2 review fixes + §8 follow-ups 1–8 | Implementation & §8 follow-ups complete; Phase 1 sign-off awaits owner decision on `D1–D6` + 8 parity differences (`SPEC §8.1–§8.2`, `§10.6`) |
| **Phase 1 (`S0`)** | `feature/s0-substrate-foundation` (PR #6, `8d555dd`) + `S3` (`F1–F6`) | Pin `cloudcanvas` (`69076f7`), `cloudcanvas-lib` (`155271b`), `lumberjack` (`f4e8055`), `mfn` (`489ca2f`); root docs; `gpu-policy.mjs` + `hardware-guard.ts` + `build-substrate.mjs` (SSD-only caches + full manifest hashes) | Accepted by Governor with `F1–F6` remediated in `S3` |
| **Phase 2 (`S1`)** | `feature/s1-lumberjack-dag-store` (PR #7, `d47294a`) + `S3` (`L1–L4,L8–L11`) | N-API C-ABI v2 binding + Go extension; LumberJack stores (`ChatStore`, `GraphStore`, `PlanTree`, `Learner`, `JobStore`, config/plugin stores, `ic_lj_stream_poll` `node_path` SSE); read-only `importLearnHarnessData(sourceDir)` | `L1–L4, L8–L11` remediated in `S3`; `L5` (`/objects` images) & `L6/L7` (`Event`/`Entry` vs slots) await owner decision `§10.3` |
| **Phase 3 (`S2`)** | `feature/s2-mfn-context-mapping` (PR #8, `8b2b718`) + `S3` (`M1,M2,M6–M8,M10–M13`) | `src/memory/mfn/` supervisor + `/v2/execute` client + `0600` `MFN_EMBEDDERS_FILE`; `chat-handler.ts` / `mfn-turn-bridge.ts` recall & ingest + `admission_paused` retry + LumberJack/atomic outbox | `M1, M2, M6–M8, M10–M13` remediated & `M9` documented in `S3`; `M3` (embedder GPU check) & `M4/M5` (recalled block fence/cap) await `§10.2, §10.4` |
| **Correction Sprint (`S3`)** | `feature/s3-governor-review-fixes` | Execute Governor review (`2026-11-17-governor-review-of-master-8b2b718-sprints-s0-s1-s2.md`) §9 items across S2, S1, S0, §8 (A2 follow-ups), native rebuild (`F4`), and §7 documents/records | Ready for Governor re-review & Richard's sign-off |
| **Phase 4 (`C1–C2`)** | `feature/c1-cloudcanvas-app` | Build `src/client/` on CloudCanvas `0.7.1` + `cloudcanvas-lib` `0.7.1` + `src/api`, wire `src/server/stores.ts` + MFN runtime + LumberJack SSE bridge | Blocked on §10 owner decisions (`§10.2–§10.5`) and Governor acceptance of `S3` |
| **Phase 5 (`C3`)** | `feature/c3-cutover-and-removal` | Wire `electron/main.cjs` to `src/api` + LumberJack + MFN; remove `app/`, React `components/`, Next.js, Tailwind, raw-file store adapters, and `compaction.ts` | Consolidated QA, full E2E suite, Richard's Trial & sign-off |

## 2. Standing Operating Rules

1. **Hardware Crash Guardrail**: Never probe, compile, link, or expose CUDA or ROCm anywhere. Only CPU-only or Nova/Vulkan is permitted.
2. **SSD Storage & Zero `/tmp`**: All builds, Go/Cargo/Zig caches (`GOCACHE`, `GOMODCACHE`, `GOPATH`, `CARGO_HOME`), and scratch directories live under `/usr/lib/persist/peer/{build,scratch}`; never write to `/tmp` or `~/go` / `~/.cargo`.
3. **Submodule Integrity**: Never modify files inside `extern/*`; each pin move is its own commit; native build outputs go to `/usr/lib/persist/peer/build/`.
4. **Running-App Guard**: Never touch `/usr/lib/persist/peer/{current,releases,state}`, `~/.local/bin/peer`, or `~/.config/LearnHarness` until Richard signs off cutover.
5. **Context & PDL Persistence**: Record plans, requirements, restrictions, and sprint reports in `.context` (committed via `ctx vcs commit`) and checkpoints/evidence in `pdl` (claiming only completed steps, never Launch/Growth or self-verification).

## 3. Expected and Actual

| Stage / Sprint | Expected | Actual |
|---|---|---|
| `0 Foundation` | Initial docs, cleanup, PR #1 & #2 review and merge | Delivered 2026-11-14 (`master` `5d5b6e2`) |
| `Sprint 1.1` (`PR #3`) | Route inventory, static surface, SPEC §2 API contract, initial submodule | Delivered & merged (`master` `193f241`) |
| `Stream A` (`A1 + A2`, `PR #5`) | Standalone `src/api` server, parity suite vs Next standalone, A2 review fixes | Merged `4fc52b3` (`308fd36`: 53/53 unit, 25/25 parity). Governor review noted 8 A2 follow-up items (`§8`, fixed in `S3`) and open owner sign-off on `D1–D6` + 8 `approved: false` parity differences (`SPEC §8.1–§8.2`) |
| `Architecture Pivot` (2026-11-16) | Align on CloudCanvas-native app + LumberJack DAG + MFN 2.0 learned memory | Visual maps archived in `.context/base/resources/` and `~/Documents/learningHarness-*.html`; requirements, hardware restriction, and 5-phase plan approved by Richard (`pdl 1f0fed50e576`) |
| `Phase 1 (S0)` (`PR #6`) | Pin 4 submodules, update docs, build CPU-only LumberJack & MFN, verify hardware guard & smoke tests | Merged `8d555dd`. Governor accepted `S0` with 6 minor items (`F1–F6`: cache redirection, shared GPU policy, `GPU_*`/`AMD_*` prefix strip, end-to-end manifest addon hashes, test timeouts/SIGTERM exit check, prebuilt skip guards), all resolved in `S3` |
| `Phase 2 (S1)` (`PR #7`) | N-API C-ABI v2 binding, LumberJack DAG stores, `/objects` attachments, `ic_lj_stream_poll` SSE, read-only `importLearnHarnessData` | Merged `d47294a` (`79d6575`, inactive on `master` until `C1`). Governor review did not accept `S1` (`L1–L11`): `L1–L4, L8–L11` (`node_path` stream field, `positions.json` `{positions,updatedAt}`, corrupt-record & symlink guards, ledger FSRS preservation, source usage log preservation, plugin record validation, bidirectional `delete_node`, class/file bounds, store & snapshot round-trip tests) fixed in `S3`; `L5` (`/objects` vs node attachments) and `L6/L7` (`Event`/`Entry` vs slot blobs) await owner decision `§10.3` |
| `Phase 3 (S2)` (`PR #8`) | MFN 2.0 supervisor, `/v2/execute` client, `0600` embedder pin, `turn.recall` & `turn.ingest` + LumberJack outbox, retire compaction | Merged `8b2b718` (`dafc5e3`, inactive on `master` until `C1`). Delivered recall/ingest via `chat-handler.ts` + `mfn-turn-bridge.ts` (bypassing compaction when active rather than deleting `compaction.ts`, `M9`). Governor review did not accept `S2` (`M1–M13`): `M1, M2, M6–M8, M10–M13` (`503 admission_paused` lexical/ingest retry + deterministic live capture test, MFN-down fail-open chat turn, poison-entry eviction + LumberJack/atomic `0600` outbox + startup/timer flush, child health watch + process-group cleanup, allow-list env, hard request deadlines, real `handleChatInput` + `exclude_memory_ids` + Hebbian recall tests) fixed in `S3`; `M3` (external Ollama GPU guard) and `M4/M5` (recalled block fence & size cap) await owner decisions `§10.2, §10.4` |
| `Sprint S3` (`feature/s3-governor-review-fixes`) | Remediate all Governor review `§9` findings (`M1,M2,M6–M8,M10–M13`, `L1–L4,L8–L11`, `F1–F6`, `§7`, `§8` rows 1–8), run `build-substrate.mjs` end-to-end, leave `§10` items untouched | Implemented on `feature/s3-governor-review-fixes` with failing-without-fix tests, end-to-end native rebuild + `substrate-manifest.json` verification, reconciled `SPEC.md`/`PLAN.md`/`.context`, and stale local branches removed; awaiting Governor re-review & Richard's sign-off |

## 4. Open Owner Decisions Before `C1` (`SPEC §8.3`)

1. **`§10.2` (`M3`)**: Embedder GPU enforcement — probe/refuse external GPU Ollama vs supervise a `peer`-owned Ollama under `hardware-guard.ts`.
2. **`§10.3` (`L5`, `L6`)**: Move images to `/objects` and conversations/jobs canonically to `Event`/`Entry` records before `C1`, or accept slot blobs/attachments and amend `SPEC §3.3`.
3. **`§10.4` (`M4`, `M5`)**: Untrusted fencing/framing and size cap of the recalled MFN memory block.
4. **`§10.5`**: Client contract for `C1` (`feature/2.1-client-base-definition` `f7b3a62` B1 contracts vs new derivation).
5. **`§10.6`**: Disposition of `D1–D6` and the 8 `approved: false` parity differences in `tests/api-parity-compare.ts`.

Signature: Google gemini-4-carbon high - 04da2a6d-9328-4ad4-b892-398e4c39b74c
