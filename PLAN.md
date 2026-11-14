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
| 1 Host | A plain Node server serves every route and stream the Next layer serves | 0 |
| 2 Client base | Shell, router, theme tokens, stores, Markdown pipeline, test harness | 1 |
| 3 Screens | Every screen at parity in the CloudCanvas client | 2 |
| 4 Cutover | The desktop app ships the new host and client | 3 |
| 5 Removal | React, Next.js, Tailwind and the old render tests are gone | 4 |
| 6 Canvases | Model-built graphs, SVG, dashboards, richer knowledge graphs | 5 |
| 7 Learner features | Onboarding, a knowledge base about the learner, visual assessment, topic linking, skills dashboard, thinking, masterclass mode | 5; some items need 6 |

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

## Phase 1: Host

Goal: the current interface runs on `src/host` with no behaviour change. Next stays installed and buildable.

| Track | Owns | Delivers |
|---|---|---|
| A Router | `src/host/router.ts`, `src/host/routes.ts`, `tests/host-router.test.ts` | Route table built from `app/api/**/route.ts`; gate applied; parameters decoded as Next does |
| B Transport | `src/host/server.ts`, `src/host/static.ts`, `tests/host-server.test.ts` | `node:http` to `Request`/`Response` adapter; streams passed through; static and plugin assets |
| C Operations | `src/host/log.ts`, `src/host/config.ts`, `tests/host-config.test.ts` | Non-blocking logger; explicit configuration from the existing environment variables |
| D Parity | `tests/host-parity.test.ts` | Every route called on both servers and compared: status, headers, body, stream events |

Contract frozen before development: the route record `{ method, pattern, handler }` and the adapter signature.
QA gate: SPEC §7, Phase 1. Packaging scripts are **not** changed in this phase.

### First sprint: Discovery and Definition

| Item | Acceptance | Depends on | Effort |
|---|---|---|---|
| 1.1 Route inventory | A table of all routes on `master` after pull request 1 merges: method, path, handler, whether it streams, whether it reads a body | pull request 1 | low |
| 1.2 Next behaviours the routes rely on | A list, with evidence, of what Next does for these routes that the host must reproduce: parameter decoding, body size limit (`proxyClientMaxBodySize`), the one route exempt from the proxy, header defaults | 1.1 | medium |
| 1.3 Static surface | A list of every non-API path served today: pages, `public/`, plugin assets, the authoring download | — | low |
| 1.4 Contract | The route record and adapter signature written into `SPEC.md` §2 and approved | 1.1, 1.2 | medium |
| 1.5 Parity method | The comparison rules for `tests/host-parity.test.ts`: which headers are compared, how streams are compared, which fixtures are used | 1.2 | medium |
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
| Phase 1 Host | `3f9061f1eb66` | idea |
| Phase 2 Client base | `806407aca194` | idea |
| Phase 3 Screens | `99b1b0182cd6` | idea |
| Phase 4 Cutover | `e959a14ac928` | idea |
| Phase 5 Removal | `19b0df95dd9f` | idea |
| Phase 6 Canvases | `a2568e7b53fd` | idea |
| Phase 7 Learner features | `f9e5019c03f3` | idea |
| Sprint "1.1 Host discovery and definition" | `90a6ffc9748d` | idea |
| Evidence: the investigation report | `54fd2ef38b26` | linked to the roadmap |

The sprint's six work items are tasks tagged `proposed` and `skill:foundation`, each with acceptance,
constraints, effort and its dependencies (`pdl find --kind task --tags proposed`).

## Expected and actual

| Phase | Expected | Actual |
|---|---|---|
| 0 Foundation | Docs, report, proposed roadmap, handoff | delivered 2026-11-14 in pull request 2; awaiting the owner's sign-off |
| Stage 0 | Leftovers removed; pull request 1 reviewed and fixed; both pull requests signed off; handoff | in progress. 0.1 and 0.2 done 2026-11-14; the 0.3 review is running |
