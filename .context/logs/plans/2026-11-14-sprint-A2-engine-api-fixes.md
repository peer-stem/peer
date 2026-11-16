# Sprint A2: fix the review findings on the engine API server

Directive from the Governor (Claude session, 2026-11-14) to the Coordinator of sprint A1. Same branch
(`feature/1.2-engine-api`), same worktree, same pull request 5. The owner is Richard: only he signs off and merges.

## What the review found

Three independent reviewers read commit `ce11140`. Their reports are in this worktree, not committed:
`.context/logs/reports/2026-11-14-a1-review-{security,efficiency,quality}.md`. Ids below are theirs: `S` security,
`E` efficiency (written `F-nn` in that report), `Q` quality (written `Fnn` there).

- 55 findings with overlaps: 0 blockers, 11 major, 30 minor, 14 notes. Contract conformance: 61 of 86 rows met.
- The Governor re-ran the gates on `ce11140`: typecheck 0 errors; lint 26 files clean; API tests 44 of 45 pass,
  1 skipped; parity 24 of 25 pass, 1 skipped. They match your report.
- The Governor checked each finding in "Fix" below against the code before listing it.

Phase 1 acceptance (SPEC §7) is not met yet: the owner has not approved the recorded differences, `long-stream`
has not run, and SPEC §2.10 does not yet state each result. The second and third are the Governor's to close.

## Fix, in this order (each with its test in the same change)

| # | Finding | What to do | Files |
|---|---|---|---|
| 1 | Q-F05 major. Failures outside a route handler end as a bare 500 or a destroyed socket with no log; `onError` in `createApiHttpServer` can never be called | Report every caught failure in `serveHttp` and in the stream pump through `options.onError`; a test for each of: request build throws, dispatch throws, the body stream errors mid-way | `src/api/server.ts`, `tests/api-server.test.ts` |
| 2 | S2 major. No `uncaughtException` or `unhandledRejection` handler, so a stray rejection in any route exits the process; Next logs and keeps serving (`node_modules/next/dist/server/lib/router-server.js:720-727`) | Register both in `main.ts`: log through the logger, keep serving. A CLI test proves the process survives one | `src/api/main.ts`, `tests/api-config.test.ts` |
| 3 | E-F01, Q-F06 major. `tests/api-parity.test.ts` imports `api-parity-compare.ts`, which imports `src/api/routes.ts`, so every `npm test` loads all 50 route modules with the caller's environment even when the suite is skipped (the Governor's run created `data/chats` in the worktree) | Load `routes.ts` only inside the suite, after the environment is set to scratch, as `api-routes.test.ts:28-36` does | `tests/api-parity.test.ts`, `tests/api-parity-compare.ts` |
| 4 | E-F03, S7 major. The two SIGTERM cases start a server pair with no `try/finally`; a failed assertion leaves two servers, two ports and a scratch directory | `try/finally` with `stopAll()`; replace the fixed 80 ms sleep before `waitHeaders` with an event | `tests/api-parity-cases-b.ts` |
| 5 | E-F02 major. The parity file boots 11 server pairs one after another; the four encoded-path pairs repeat the four gate-mode configurations, and "browser" mode equals the main pair | Reuse pairs: at most 5 for the whole file. Report the pair count and the wall time before and after | `tests/api-parity-gate.ts`, `tests/api-parity-cases-b.ts`, `tests/api-parity.test.ts` |
| 6 | Q-F03 major. The list is named `APPROVED_RECORDED_DIFFERENCES`; nobody approved it, and the audit test checks the list against itself | Rename to `RECORDED_DIFFERENCES`; each rule carries `approved: false` until the owner approves it (the Governor sets it); the audit fails on an observed difference with no rule and reports unapproved ones | `tests/api-parity-compare.ts`, `tests/api-parity.test.ts` |
| 7 | S3 minor. `requestTimeout = 0` removes the bound on a slow sender; Next leaves Node's default | Restore Node's default, then run `long-stream` once (`PEER_API_PARITY_LONG=1`). If the stream survives, keep the default; if not, report it and stop this item | `src/api/server.ts`, `tests/api-server.test.ts` |
| 8 | Q-F09, E-F06 minor. `close()` waits for in-flight work with no deadline, and the force-close timer starts only afterwards | Arm the timer first; log when a close was forced; the tests assert the clean path, not only "under 3 s" | `src/api/server.ts`, `src/api/main.ts`, tests |
| 9 | Q-F08, S10 minor. A second copy of the body cap and a lazy import with an `ERR_MODULE_NOT_FOUND` fallback | Delete them; import `bodyLimit` statically | `src/api/server.ts` |
| 10 | S4, E-F10 minor. The logger expands any object without a depth or size cap (a `Buffer` index by index) and logs the request URL with its query string | Cap depth and line size; write a typed array as its length; log the path without the query | `src/api/log.ts`, `src/api/main.ts`, `tests/api-log.test.ts` |
| 11 | E-F04, S6 minor. The CLI tests spawn the `tsx` wrapper and kill the wrapper's pid, which can orphan the server; the child inherits the caller's `HOME`, keys and `LH_DESKTOP_*` | Spawn `node --import tsx` directly so the pid is the server's; give the child a scratch `HOME` and `XDG_*`, `LH_IGNORE_ENV_KEYS=1`, and a timeout on every wait | `tests/api-config.test.ts` |
| 12 | E-F05, E-F11 minor. One-shot pulses after fixed 40 or 80 ms sleeps, and wall-clock assertions a loaded machine breaks | Wait on an event where one exists (the efficiency report lists every sleep); keep only the SPEC's 3 s bound as a clock assertion | parity helpers, `tests/api-server.test.ts` |
| 13 | Q-F11 to Q-F16, Q-F20, Q-F22 minor. Tests that cannot fail or prove less than their name | Per the quality report's "Fix" column: a golden list of the 50 patterns; pinned statuses in `param-decoding`; the cap tested at 27,262,976 and compared across both servers; `isWrite` on the 13 non-GET cases or a reason; assert Next's TRACE headers | the test files named there |
| 14 | Q-F17, Q-F23 minor. Duplicated constants and header code; the scratch root hard-coded in four files | One constants module, one scratch helper | test helpers |
| 15 | Q-F19 minor. Untested: plugin-init failure, the reporters, absolute-form targets | Add the tests; one reporter per call shape | `src/api/main.ts`, tests |
| 16 | S11 note. A gate refusal leaves no log line | `logger.warn` with method and path only | `src/api/router.ts` or `main.ts` |
| 17 | E-F07, E-F08 minor. `realpath` of the root on every static request; body listeners not removed when a handler stops reading | Resolve the root once; cancel the body in `finally` | `src/api/static.ts`, `src/api/server.ts` |
| 18 | Q-F25 note. `PLAN.md` row: "173 pairs" is 171; "44 API tests" is 43 new plus one older file | Correct the row | `PLAN.md` (the A1 row only) |

## Wait for the owner's answer (do not change these yet)

| Decision | Finding |
|---|---|
| D1 | Q-F02. `/api/x/`: Next answers 308 before the gate; this server answers 403 or 404, gate first |
| D2 | Q-F01. `LH_LOG_LEVEL` is a new environment variable |
| D3 | S1. `HOSTNAME` is used as given, so a non-loopback value binds off loopback |
| D4 | SPEC §7. Approval of each recorded difference |
| D5 | S8, Q-F23, E-F17. The scratch root: `/usr/lib/persist/peer/scratch` (your tests) or `/usr/lib/persist/peer/work/scratch` (PLAN) |
| D6 | Q-F07. `serveHttp` has a fourth, optional parameter; SPEC §2.3 froze three |

## Not to be changed in this sprint

- Q-F10, S5: methods outside the seven answer 400, and TRACE 500 before the gate, as Next does. The Governor
  records the result in SPEC §2.10.
- S12, E-F15, Q-F18: which static paths and headers. Settled by sprint B1's delivery contract, then sprint A3.
- E-F09, E-F12 to E-F14, E-F16, S9, Q-F21, Q-F24, Q-F26: noted, no change.

## Limits, gates, report

As in the A1 directive (`2026-11-14-sprint-A1-engine-api.md`), with these changes:

- Scratch never goes under `/tmp` (it is held in memory): use the SSD root already in your tests, and set `TMPDIR`
  there for every run.
- One heavy job at a time across every agent on this machine; check the load before a full suite or a parity run,
  and cap the full suite at `--test-concurrency=6`.
- Edit only `src/api/**`, `tests/api-*`, and the A1 row of `PLAN.md`. Do not commit the review reports.
- Report as before: push to pull request 5, do not merge; a pdl evidence record with the gates, and a handoff note
  with fixed, not fixed and why, per row number above.

Anthropic claude-fable-5-2 - ff1eb25d-2b67-4147-87d4-38b6fda370ce
