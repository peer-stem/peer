# peer: plan

Status: the owner approved the execution plan in session on 2026-11-14: Stage 0 first, then sprint by sprint
behind sign-offs. The pdl records stay `idea` until the owner moves them.
Phases follow the PDL steps (Discovery, Definition, Design, Development, Testing, Launch, Growth) as sprints.
Each sprint is a feature branch, each phase ends in one consolidated QA, and nothing reaches `master` without
the owner's sign-off on the quality gates.

## Roadmap

| Phase | Outcome | Depends on |
|---|---|---|
| 0 Foundation | Supporting docs, the investigation report, this roadmap in pdl, handoff | — |
| 1 Engine API | A plain Node server (`src/api`, name proposed) answers every `/api` route and stream the Next layer answers, without Next. The old interface stays on Next | 0 |
| 2 Client base | Shell, router, theme tokens, stores, Markdown pipeline, test harness | 1 |
| 3 Screens | Every screen at parity in the CloudCanvas client | 2 |
| 4 Cutover | The desktop app ships the API server and the new client | 3 |
| 5 Removal | React, Next.js, Tailwind and the old render tests are gone | 4 |
| 6 Canvases | Model-built graphs, SVG, dashboards, richer knowledge graphs | 5 |
| 7 Learner features | Onboarding, a knowledge base about the learner, visual assessment, topic linking, skills dashboard, thinking, masterclass mode, seams between domains, mastery and mystery, chained learning, learning style and confidence | 5; some items need 6 |

## Stage 0: cleanup and close-out

Runs before any rebuild work.

| Step | Work |
|---|---|
| 0.1 | These docs record the decisions of 2026-11-14 |
| 0.2 | The earlier session's leftovers removed: the `feature/1.1-host-definition` worktree and branch (a local merge of both unmerged pull requests, never pushed), its scratch files, and the build output in the home-disk checkout |
| 0.3 | Pull request 1 reviewed for code quality, security and efficiency; confirmed findings fixed |
| 0.4 | The owner signs off pull requests 2 and 1, and moves the pdl records out of `idea` |
| 0.5 | Handoff |

## Rules for every stage

- **The running app is not touched.** `/usr/lib/persist/peer/{state,releases,current}`, the `peer` launcher and
  `~/.config/LearnHarness` change only on the owner's word. Every server or test run uses a scratch data
  directory and a spare port. A packaged build is started only with `XDG_CONFIG_HOME` pointed at scratch.
- **One sprint, one branch, one worktree.** Each sprint's branch is cut from `master` into
  `/usr/lib/persist/peer/work/<branch>`, where installs, builds and tests run. Nothing is built on an unmerged
  branch. While a sign-off is pending, only the next sprint's read-only Discovery may run.
- **Review is independent.** One consolidated QA per phase, by reviewers that did not write the code; each finding
  is checked against the code before it is acted on.

## Phase 1: Engine API

The pdl record is still titled "Phase 1 Host"; renaming it is the owner's call. Corrected 2026-11-14 to the owner's
model (DESIGN §3): no server serves the interface, and this phase moves only the engine's API off Next.

Goal: `src/api` (name **proposed**) answers every `/api` route and method the Next layer answers, with the same
status, headers, body and streams, without Next (SPEC §2). The old interface stays on Next, untouched; Next stays
installed and buildable. No pages, `public/` files or client files are served by this phase (a Phase 2 decision).
Plugin assets are an API route (row 33) and are included.

| Track | Owns | Delivers | Tests |
|---|---|---|---|
| A Routes and gate | `src/api/routes.ts`, `src/api/router.ts` | The list of route modules; records derived from their exports; matching and parameters; gate and order of checks; automatic OPTIONS, HEAD and 405; `bodyLimit` (SPEC §2.2, §2.4, §2.6) | `tests/api-routes.test.ts`: list against `app/api/**/route.ts`, every module imports. `tests/api-router.test.ts`: matching, parameters, check order, OPTIONS/HEAD/405 on fake handlers |
| B Transport | `src/api/adapter.ts`, `src/api/server.ts` | `serveHttp`: `IncomingMessage` to `Request`, `Response` to `ServerResponse`; body cap; streams flushed, back-pressured, cancelled on close; `request.signal` aborted; start-up, binding, stop (SPEC §2.3, §2.6 to §2.8) | `tests/api-adapter.test.ts`: fake streams for headers before the first byte, back-pressure, cancel, abort, cap. `tests/api-server.test.ts`: start on a spare port with scratch data, plugins started once, loopback only, SIGTERM |
| C Operations | `src/api/log.ts`, `src/api/config.ts` | Non-blocking logger; explicit configuration of `PORT`, `HOSTNAME` and logging; nothing else copied from the environment (SPEC §2.5, §2.8) | `tests/api-log.test.ts`, `tests/api-config.test.ts` |
| D Parity | `tests/api-parity*.test.ts`, `tests/helpers/api-parity-*.ts` | Every route and method on both servers, compared by the method in `.context/logs/reports/2026-11-14-api-parity-method.md`; the cases of SPEC §2.10 | itself |

Contract frozen before development: `RouteRecord`, `RouteHandler`, `Dispatch` and `serveHttp` (SPEC §2.2, §2.3),
`bodyLimit(pathname)` (SPEC §2.6), the configuration shape and the logger interface (Track C, frozen in its first
commit). B depends on A only through `Dispatch` and `bodyLimit`. QA gate: SPEC §7, Phase 1. Packaging scripts are
**not** changed in this phase.

### First sprint: Discovery and Definition

| Item | Acceptance | Depends on | Effort |
|---|---|---|---|
| 1.1 Route inventory | A table of all routes on `master` after pull request 1 merges: method, path, handler, whether it streams, whether it reads a body | pull request 1 | low |
| 1.2 Next behaviours the routes rely on | A list, with evidence, of what Next does for these routes that the API server must reproduce: parameter decoding, body size limit (`proxyClientMaxBodySize`), the one route exempt from the proxy, header defaults | 1.1 | medium |
| 1.3 Static surface | A list of every non-API path served today: pages, `public/`, plugin assets, the authoring download. Input to Phase 2, since Phase 1 serves no static files | — | low |
| 1.4 Contract | The route record and adapter signature written into `SPEC.md` §2 and approved | 1.1, 1.2 | medium |
| 1.5 Parity method | The comparison rules for `tests/api-parity.test.ts`: which headers are compared, how streams are compared, which fixtures are used | 1.2 | medium |
| 1.6 Submodule | `extern/cloudcanvas` added at `c5e6e07`; the rule for moving the pin written into `ARCHITECTURE.md` | — | low |

Models follow DESIGN §7.3: Sonnet for items 1.1 to 1.3, Opus for 1.4 and 1.5.

## Phase 2: Client base

| Track | Delivers |
|---|---|
| A Shell and router | The window frame and the five pages as empty views; navigation without Next |
| B State | API client and stores in TypeScript; `session-core.ts` consumed as is |
| C Markdown | The pipeline on the kit's renderer, the block extension point, and the math, Mermaid and code blocks |
| D Theming and types | App themes mapped to `--cc-*` tokens; type definitions for the CloudCanvas surface in use |
| E Test harness | linkedom and `ui/testing` wired into `node:test`; the end-to-end driver chosen |

Contract frozen first: the view contract, the store interfaces, the block registration.

### First sprint: Discovery

Open for this phase, decided by the owner: how the client's own files and the `public/` files it needs reach the
window, and how the client reaches the engine (ARCHITECTURE §8).

| Item | Acceptance |
|---|---|
| 2.1 Data the pages embed server-side that the client must fetch | The table below confirmed against `master`, with a decision for each gap |

Starting table, 2026-11-14. Embedded data from the static-surface report §1; routes from the route inventory §1.2.

| Page | Embeds at request time | API route that returns it |
|---|---|---|
| Layout, `app/layout.tsx` | `readThemeBoot()` (:30): the settings record's `appearance`, the active theme (a preset, or the one selected custom file) and its CSS variables, put on `<html>` (`src/server/theme-boot.ts:23-29`) | Inputs only. `GET /api/settings` (row 41) returns the same record: `settingsStore.readSettings` is `readSettings` (`src/store/settings.ts:86, 128`). `GET /api/themes` (row 48) returns presets and customs. The resolution (`resolveTheme`, `effectiveColors`, `themeVars`) is in `src/core` (`theme-boot.ts:10`). No route returns the resolved variables. The first paint without a wrong theme (`app/layout.tsx:25-28`) is a design point |
| Layout, other | Title and description (`:19-22`), fonts and stylesheets (`:2-5`, `:16-17`): build-time, not request data | not applicable |
| `/` | `slotsConfigured(record.models)` and `resolveSettings(record).graph.rendering` (`app/page.tsx:14-20`) | `GET /api/settings` (row 41) returns the record; both functions are in `src/core` (`app/page.tsx:3`) |
| `/chat/[id]` | The chat's id, title, kind and messages; `turnFailure`, `isTurnRunning`, `compactionInFlight`; `slotsConfigured`; query `prompt`; `notFound()` when the chat is missing (`app/chat/[id]/page.tsx:8-41`) | `GET /api/chats/[id]` (row 8) returns the record without `imageSnapshots`, plus `messages`, `turnError`, `turnInFlight`, `compacting`, or JSON 404 (`app/api/chats/[id]/route.ts:4-46`). `slotsConfigured` from `GET /api/settings`. `prompt` is in the URL |
| `/chat/new` | `slotsConfigured`; query `mode` (`app/chat/new/page.tsx:18-30`) | `GET /api/settings`; `mode` is in the URL |
| `/plugins/[pluginId]/[viewId]` | Path parameters only (`page.tsx:3-6`) | none needed |
| `/settings` | Nothing; redirects to `/chat/new` (`app/settings/page.tsx:10`) | none needed |
| Build-time values | `LH_VERSION`, `LH_HOMEPAGE`, inlined by `next.config.ts:9`, read by `components/settings/update-settings.tsx:15-16` and `plugins-section.tsx:30` | **none found**: no `src/`, `lib/` or `app/api` file reads them (route inventory §2.2) |

## Phase 3: Screens

One track per row of SPEC §1, in parallel after the contracts between screens are frozen: session and chat;
questions, plan and practice; knowledge graph; settings and setup; home, sidebar and navigation; plugin host;
artifacts; dictation and read-aloud. Each track starts with a Definition sprint that writes its parity checklist.

## Phase 4: Cutover

Packaging (`electron-builder.yml`, `electron/main.cjs` `serverEntry`), the build and smoke scripts that assume
Next's output, and a data-compatibility check on a copy of real state. The installed app switches release
directories under `/usr/lib/persist/peer/releases`; the state directory does not move.

## Phase 5: Removal

Delete `app/`, the React files in `components/`, the Next configuration, Tailwind and the React render tests.
Move the shared modules into `src/client`. Rehearse one upstream merge and write the procedure down.

## Phase 6: Canvases

Defined after parity. Starting points already known: the board document format, how the model is told what it may
build, how a document is validated, and whether panels and board save/load come from CloudCanvas (DESIGN §7.2).

## Phase 7: Learner features

The owner's list of 2026-11-14, recorded in DESIGN §6. Not designed and not sequenced. Each item opens with a
Discovery sprint that states what exists, what it changes in the engine, and what it needs from the interface.

| Item | Needs Phase 6 |
|---|---|
| Onboarding: interests and goal assessment, with suggestions | no |
| A knowledge base about the learner: goals, experience, interests, facts, memories | no |
| Model-generated visuals for tests and assessment: diagrams, geometry, interactive puzzles | yes |
| Linking similar and overlapping topics by keyword and metadata | no |
| Ongoing skills assessment and ranking, with a progression dashboard | yes, for the dashboard |
| Thinking: show what the model is thinking, in every binding | no |
| Masterclass mode beside single lessons: refinement rounds that draft a roadmap to complete knowledge of a domain, place the learner in each sub-domain, and sew successions of lessons together. Single lessons stay and cluster | open |
| Seams between domains: learned topics that are connected group and connect in the graph; gaps between related or cross-domain topics are identified, tested and taught. Placed last by the owner, after everything else | open |
| Mastery and mystery: identify areas of mastery and areas of mystery, and the topics in the map that bridge from what is held into a target area | open |
| Chained learning across subjects: relate the areas the learner is working through, teach a missing foundation inside the subject that needs it, and credit progress in both | open |
| Learning style and confidence: learn the individual's learning style, how they grade their own confidence, and their styles of communication | open |

Items that touch `src/{agent,core,store}` change upstream's engine, so each is designed to stay separable from
it (SPEC §5.5).

## Quality gates, every phase

1. The acceptance in SPEC §7 for that phase, demonstrated by tests and a worked example.
2. The existing logic suite is green.
3. Code-quality, security and efficiency review of the phase's diff against `master`.
4. Docs and this plan updated with what was expected and what was actually built.
5. The owner's sign-off.

## Risks

| Risk | Handling |
|---|---|
| Upstream changes a screen while we rebuild it | Parity is fixed to the upstream commit named in each checklist; later upstream interface changes are re-decided, not merged |
| A kit control lacks behaviour a screen needs | Found in that screen's Definition sprint; resolved by the rule in DESIGN §3 (agnostic goes to CloudCanvas, application stays in peer) |
| The engine at the pinned commit lacks something the newer `cc-main` has | Recorded as it is found; DESIGN §7.2 |
| The machine's home disk is slow for builds | Builds and installs for this project run from `/usr/lib/persist/peer` or `/tmp/peer`, not the home disk |

## Records in pdl

Project `peer`. Everything except phase 0 is in the `idea` state: proposed, and only the owner approves it.

| Record | Id (first 12) | State |
|---|---|---|
| Roadmap "peer on CloudCanvas" | `8c0c6fc070dc` | idea |
| Phase 0 Foundation | `3a12ed02487c` | active |
| Phase 1, titled "Host" in pdl (Engine API here) | `3f9061f1eb66` | idea |
| Phase 2 Client base | `806407aca194` | idea |
| Phase 3 Screens | `99b1b0182cd6` | idea |
| Phase 4 Cutover | `e959a14ac928` | idea |
| Phase 5 Removal | `19b0df95dd9f` | idea |
| Phase 6 Canvases | `a2568e7b53fd` | idea |
| Phase 7 Learner features | `f9e5019c03f3` | idea |
| Sprint 1.1, titled "Host discovery and definition" in pdl | `90a6ffc9748d` | idea |

The pdl titles predate the owner's correction of 2026-11-14 (DESIGN §3); renaming them is the owner's.
| Evidence: the investigation report | `54fd2ef38b26` | linked to the roadmap |

The sprint's six work items are tasks tagged `proposed` and `skill:foundation`, each with acceptance,
constraints, effort and its dependencies (`pdl find --kind task --tags proposed`).

## Expected and actual

| Phase | Expected | Actual |
|---|---|---|
| 0 Foundation | Docs, report, proposed roadmap, handoff | delivered 2026-11-14 in pull request 2; awaiting the owner's sign-off |
| Stage 0 | Leftovers removed; pull request 1 reviewed and fixed; both pull requests signed off; handoff | 0.1 to 0.3 done 2026-11-14. Pull request 1 was reviewed by three independent reviewers (45 findings, with overlaps) and fixed in commit `3fa3928`: typecheck and lint clean, full suite 5,405 of 5,412 with 4 skipped and 3 load timeouts in `headless-helper-lifecycle` that pass alone. Different from expected: three fix agents, not one; nine findings are left as owner decisions and two were declined. Not done: the owner's sign-offs (0.4), and hands-on checks of microphone dictation, read-each-reply-aloud and the desktop window |
| Sprint 1.1 | Inventory, Next behaviours, static surface, contract, parity method, submodule | 1.1 to 1.3: two discovery reports, 2026-11-14. 1.6: submodule and pin rule. 1.4 and 1.5 drafted 2026-11-14 (SPEC §2, `.context/logs/reports/2026-11-14-api-parity-method.md`), awaiting approval. Different from expected: the owner corrected the model the same day (the client is the host; the Node server is only the engine's API), so Phase 1 no longer serves static files or runs the old interface |
