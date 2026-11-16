# Sprint A1: build the engine API server

Directive from the Governor (Claude session, 2026-11-14) to the Coordinator of this sprint. One sprint, one
branch, one worktree. The owner is Richard: only he signs off and merges.

## Your role

Coordinator (`~/COORDINATOR.md`): you delegate the tracks below to Operators, check their work against this
directive, and report back. You do not change the contract or the plan; a needed change is a question to the
Governor, not an edit.

## Read first, in this order

1. `~/AGENTS.md`, `~/COORDINATOR.md`.
2. In this worktree: `SPEC.md` §2 (the contract), §5 (code rules), §7 (acceptance); `PLAN.md` "Rules for every
   stage" and Stream A; `ARCHITECTURE.md` §1 to §4.
3. `.context/logs/reports/2026-11-14-host-route-inventory.md` (the 50 routes and what Next does for them),
   `2026-11-14-host-static-surface.md`, `2026-11-14-api-parity-method.md` (how the parity test works).

## Where

- Worktree: `/usr/lib/persist/peer/work/1.2-engine-api`, branch `feature/1.2-engine-api`, cut from `master`
  `193f241`. `npm ci` has been run. `npm run plugins:setup` has not; the parity test needs it.
- pdl project `peer` is bound at `/home/persist/peer`. Run `pdl` from there. Never build, install or test there:
  it is on a slow disk.

## What to build

The goal: a plain Node server in `src/api/` that answers every API route and stream the Next layer answers
today, identically, and hands out the client's files unchanged. Next stays installed and untouched.

First, alone, before any track starts: `src/api/types.ts` with the frozen shapes from `SPEC.md` §2.2 and §2.3
(`Method`, `Params`, `RouteHandler`, `RouteRecord`, `Dispatch`, the `serveHttp` signature). Tracks import from
it and do not redefine them.

| Track | Owns | Delivers | Runs |
|---|---|---|---|
| R Routes and router | `src/api/routes.ts`, `src/api/router.ts`, `tests/api-routes.test.ts`, `tests/api-router.test.ts` | The route list by static import of the 50 `app/api/**/route.ts` modules; a test that fails if the list and the files differ; `Dispatch` with the order of checks in SPEC §2.4 (gate, 404, methods, handler) | In parallel |
| T Transport | `src/api/server.ts`, `src/api/static.ts`, `tests/api-server.test.ts`, `tests/api-static.test.ts` | The `node:http` adapter of SPEC §2.3, §2.6, §2.7 (streams unbuffered, headers flushed first, disconnect cancels the body and aborts the signal, the body cap); the client's files handed out unchanged per SPEC §2.11 | In parallel |
| O Operations | `src/api/config.ts`, `src/api/log.ts`, `src/api/main.ts`, `tests/api-config.test.ts`, `tests/api-log.test.ts` | Explicit configuration from the environment of SPEC §2.8 (`PORT` required); a non-blocking, configurable logger; the entry that imports the routes, calls `initializePlugins()`, then listens on loopback | In parallel |
| P Parity | `tests/api-parity.test.ts` and helper files named `tests/api-parity-*.ts` | Every route and the five streams compared on both servers, as the parity method report describes, including each item of SPEC §2.10 as a named test | After R, T and O |

## Limits

- Edit only the files named above. Never `app/`, `components/`, `src/server/`, `src/agent/`, `src/core/`,
  `src/store/`, `electron/`, `extern/`, or the docs, except the "Expected and actual" row for A1 in `PLAN.md`.
  If the contract cannot be met without touching one of them, stop that item and report it.
- No new dependencies, settings or options. `tsx` runs the TypeScript.
- Code rules: at most 500 lines per file, 50 per function or class, 3 levels of indentation (the definition is
  level 0, its body level 1). Tests in the same change. No placeholders.
- The owner's running app is never touched: `/usr/lib/persist/peer/{state,releases,current}`,
  `~/.local/bin/peer`, `~/.config/LearnHarness`, ports 3000 and 3901. Every server or test run uses a private
  directory under `/tmp/peer` for `LH_DATA_DIR` and `LH_AUTH_FILE` and a spare port. Stop processes by pid only.
- One heavy job at a time (install, build, full suite).
- Git: commit on `feature/1.2-engine-api` as `alephpt1@gmail.com`, short messages, no co-author lines. Never
  commit to or push `master` or `main`. Never merge.

## Quality gates, all before you report

1. `node_modules/.bin/tsc --noEmit --incremental false`: 0 errors.
2. `node_modules/.bin/eslint` on every changed file: clean.
3. `NODE_ENV=test node_modules/.bin/tsx --test tests/api-*.test.ts`: all pass.
4. The parity test passes for all 50 routes and the 5 streams, or each difference is listed with the request,
   both responses, and whether SPEC §2 calls for it.
5. `NODE_ENV=test npm test` once: the counts, and every failure explained (three tests in
   `tests/headless-helper-lifecycle.test.ts` time out under load and pass alone).
6. The code rules measured, not estimated: the longest file, the longest definition, the deepest level.

## Report back, then stop

- Push the branch and open a pull request into `master` on `peer-stem/peer` (the owner pre-authorised pushing
  sprint branches). Do not merge it.
- In pdl, in the Coordinator role: an evidence record with the gate results, and a handoff note with expected
  versus actual per track, what was not verified, and open questions. Link both to the roadmap
  `8c0c6fc070dc`.
- The review of this sprint is the Governor's and the sign-off is the owner's. Do not review or sign off your
  own work.

## If something is unclear

Do not guess a design decision. Write the question in your report and in pdl, and carry on with what does not
depend on it.
