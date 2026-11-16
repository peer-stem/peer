# Changelog

Changes in the `peer` fork. Upstream LearnHarness historyprior to fork is at
[amosblomqvist/learnharness](https://github.com/amosblomqvist/learnharness).

## Unreleased

### Added
- Submodule `extern/cloudcanvas-lib` pinned at `155271b` (`v0.7.1`).
- Submodule `extern/lumberjack` (`NeoTecDigital/LumberJack`) pinned at `f4e8055` for the multi-parent DAG database, event log, and `/objects` store.
- Submodule `extern/mfn` (`NeoTecDigital/MFN`) pinned at `489ca2f` (`v2.0.0`) for spreading-activation learned memory (`turn.recall` / `turn.ingest`).
- Hardware safety guard (`src/substrate/hardware-guard.ts`), reproducible SSD native builder (`scripts/build-substrate.mjs`), and foundation verification suite (`tests/substrate-foundation.test.ts`) enforcing Nova/Vulkan or CPU-only execution (blocking CUDA and ROCm).
- Foundation documents (`DESIGN.md`, `ARCHITECTURE.md`, `SPEC.md`, `PLAN.md`) updated for the CloudCanvas + LumberJack + MFN 2.0 architecture.

### Changed
- Moved `extern/cloudcanvas` submodule pin from `c5e6e07` (`v0.6.0`) to `69076f7` (`v0.7.1`, `c5e6e07..69076f7`).

## Fork point

- 2026-11-14: forked from upstream `v0.6.1` (`cb25c8e`) as `peer-stem/peer`. `master` is the integration
  branch and `main` receives releases.
