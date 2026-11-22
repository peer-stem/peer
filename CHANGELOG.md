# Changelog

Changes in the `peer` fork. Upstream LearnHarness historyprior to fork is at
[amosblomqvist/learnharness](https://github.com/amosblomqvist/learnharness).

## Unreleased

### Added
- Synced upstream LearnHarness `v0.7.0` (`cb25c8e..069a6a11`): `@earendil-works/pi-ai` & `pi-agent-core` `1.5.2`, `DELETE /api/graph/sources/folders/[id]` and `POST /api/models` (`52` routes / `76` methods in `src/api/routes.ts`), LumberJack `config/model-catalog` persistence, shared session folders, adaptive question layout, PDF figure annotations, and startup announcements.
- Standalone `src/api` Engine API server, LumberJack N-API C-ABI v2 multi-parent DAG store (`src/store/lumberjack/`), read-only LearnHarness importer (`POST /api/settings/import-learnharness`), opt-in MFN 2.0 runtime & outbox (`src/memory/mfn/`, `PEER_MFN_ENABLED=1` while keeping `compaction.ts` LLM summarization as default), and CloudCanvas `C1` client base (`src/client/`).
- Submodule `extern/cloudcanvas-lib` pinned at `d5a5fa1` (`v0.7.1+`).
- Submodule `extern/lumberjack` (`NeoTecDigital/LumberJack`) pinned at `f4e8055` for the multi-parent DAG database, event log, and `/objects` store.
- Submodule `extern/mfn` (`NeoTecDigital/MFN`) pinned at `489ca2f` (`v2.0.0`) for spreading-activation learned memory (`turn.recall` / `turn.ingest`).
- Hardware safety guard (`src/substrate/hardware-guard.ts`), reproducible SSD native builder (`scripts/build-substrate.mjs`), and foundation verification suite (`tests/substrate-foundation.test.ts`) enforcing Nova/Vulkan or CPU-only execution (blocking CUDA and ROCm).
- Foundation documents (`DESIGN.md`, `ARCHITECTURE.md`, `SPEC.md`, `PLAN.md`) updated for the CloudCanvas + LumberJack + MFN 2.0 architecture.

### Changed
- Moved `extern/cloudcanvas` submodule pin from `c5e6e07` (`v0.6.0`) to `69076f7` (`v0.7.1`, `c5e6e07..69076f7`).

## Fork point

- 2026-11-14: forked from upstream `v0.6.1` (`cb25c8e`) as `peer-stem/peer`. `master` is the integration
  branch and `main` receives releases.
