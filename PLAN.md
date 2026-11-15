# peer: plan

Status: the owner approved the execution plan for peer on CloudCanvas on 2026-11-14; this file records it. Two
streams run in parallel (A Engine API, B Client) with a third for CloudCanvas contributions (L), then Cutover,
Removal and the later features. The decisions the approval carries are in DESIGN §3.1. The pdl records stay `idea`
until the owner moves them. Each sprint is a feature branch, each phase ends in one consolidated QA, and nothing
reaches `master` without the owner's sign-off on the quality gates.

## Roadmap

| Phase | Stream and sprints | Outcome | Depends on |
|---|---|---|---|
| 0 Foundation | — | Supporting docs, the investigation report, this roadmap in pdl, handoff | — |
| 1 Engine API | A: A1, A2, A3 | `src/api` answers every `/api` route and stream the Next layer answers, without Next, and hands out the client's files unchanged. The old interface stays on Next | 0; A3 on B1 |
| 2 Client base, 3 Screens | B: B0 to B4 | The CloudCanvas client: re-baseline, definition, base, every screen at parity | 0; B0 on the owner naming the CloudCanvas commits |
| — CloudCanvas contributions | L | Pull requests to `cloudcanvas-lib` and `cloudcanvas`, as B1 lists them | B1 |
| 4 Cutover | C | The desktop app ships the API server and the new client without Next | A3, B4, L |
| 5 Removal | D | React, Next.js, Tailwind and the old render tests are gone | C |
| 6 Canvases, 7 Learner features | E | Model-built canvases, then the design points in DESIGN §6 | D |

```
A  Engine API     A1 build ─ A2 QA ─────────────── A3 API additions ─┐
B  Client         B0 re-baseline ─ B1 definition ─ B2 base ─ B3 screens (3 waves) ─ B4 parity QA ─┤
L  CloudCanvas    pull requests to cloudcanvas-lib / cloudcanvas, as B1 lists them ───────────────┤
                                                                       C cutover ─ D removal ─ E later features
```

The client only needs `/api`, and Next already answers the same 50 routes, so the API work and the client work do
not depend on each other until cutover.

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
- **One sprint, one branch from `master`, one worktree.** Each sprint's branch is cut from `master` into
  `/usr/lib/persist/peer/work/<branch>`, where installs, builds and tests run. Nothing is built on an unmerged
  branch, in peer or in a CloudCanvas repo. Streams A, B and L run in parallel, each on its own branches
  from `master`. Within a stream, a sprint's development starts only after the previous sprint is merged;
  read-only Discovery may run ahead.
- **CloudCanvas.** Changes go as pull requests to the public repos from this project's own clones under
  `/usr/lib/persist/peer/work/`; the owner merges; peer then moves its pin in a commit of its own. The owner's
  `~/cloudcanvas` workspace is never touched (DESIGN §3).
- **Delegation.** Every agent gets a brief with role, line items, the files it owns, limits and quality gates. At
  most three development agents at once, plus up to two read-only researchers or reviewers. Models per DESIGN §3.1.
- **Review is independent.** One consolidated QA per phase (code quality, security, efficiency), by reviewers that
  did not write the code; each finding is checked against the code before it is acted on.
- **The owner's only.** Merges into `master`, contract approvals, the cutover, the removal, pdl approval states.
- **Records.** pdl notes and evidence, this file's expected and actual after each sprint, a handoff note each
  session.
- **Guard, every sprint.** The running app's pid, `current`, both installed AppImages and the launcher unchanged.

## Stream A: Engine API (Phase 1). Contract: SPEC §2

The pdl record is still titled "Phase 1 Host"; renaming it is the owner's call.

| Sprint | Work | Who | Gate |
|---|---|---|---|
| A1 Build | Track R: `src/api/routes.ts`, `router.ts` (route list by static import, gate order, methods) with `tests/api-routes.test.ts`, `api-router.test.ts`. Track T: `src/api/server.ts` (the `node:http` adapter: streams, disconnects, body cap) and `src/api/static.ts` (hands out the client's files) with `tests/api-server.test.ts`. Track O: `src/api/config.ts`, `log.ts` (non-blocking), the entry file, with `tests/api-config.test.ts`. Then Track P: `tests/api-parity.test.ts` per the parity method report, every route on both servers | Three Opus agents in parallel, then one for P | All tracks green; parity passes for all 50 routes |
| A2 QA | Three Sonnet reviewers; confirmed findings fixed; full suite | Sonnet, then Opus | Owner's sign-off, merge |
| A3 API additions | Routes for data the pages hand the client today that have no endpoint (the table below, from pull request 3), as defined by B1 | One Opus agent | Owner's sign-off, merge |

Track T's `src/api/static.ts` hands out the client's files unchanged, same origin; paths outside `/api` are not
gated, as today (SPEC §2.11). This was "a Phase 2 decision" until the owner decided it on 2026-11-14.

Contract frozen before development: `RouteRecord`, `RouteHandler`, `Dispatch` and `serveHttp` (SPEC §2.2, §2.3),
`bodyLimit(pathname)` (SPEC §2.6), the configuration shape and the logger interface (track O, frozen in its first
commit). T depends on R only through `Dispatch` and `bodyLimit`. Packaging scripts are **not** changed in this
stream; the old interface stays on Next, untouched; Next stays installed and buildable.

### Sprint 1.1: Discovery and Definition (pull request 3)

| Item | Acceptance | Depends on | Effort |
|---|---|---|---|
| 1.1 Route inventory | A table of all routes on `master` after pull request 1 merges: method, path, handler, whether it streams, whether it reads a body | pull request 1 | low |
| 1.2 Next behaviours the routes rely on | A list, with evidence, of what Next does for these routes that the API server must reproduce: parameter decoding, body size limit (`proxyClientMaxBodySize`), the one route exempt from the proxy, header defaults | 1.1 | medium |
| 1.3 Static surface | A list of every non-API path served today: pages, `public/`, plugin assets, the authoring download. Input to Phase 2, since Phase 1 serves no static files | — | low |
| 1.4 Contract | The route record and adapter signature written into `SPEC.md` §2 and approved | 1.1, 1.2 | medium |
| 1.5 Parity method | The comparison rules for `tests/api-parity.test.ts`: which headers are compared, how streams are compared, which fixtures are used | 1.2 | medium |
| 1.6 Submodule | `extern/cloudcanvas` added at `c5e6e07`; the rule for moving the pin written into `ARCHITECTURE.md` | — | low |

Item 1.3's "Phase 1 serves no static files" was superseded on 2026-11-14: the API server hands out the client's
files (track T). Item 1.6's pin, `c5e6e07` (v0.6.0), is to be moved in sprint B0.

### Data the pages hand the client today (input to B1 and A3)

Starting table, 2026-11-14. Embedded data from the static-surface report §1; routes from the route inventory §1.2.
B1 confirms it against `master` and defines the endpoints A3 must add.

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

## Stream B: Client (Phases 2 and 3)

| Sprint | Work | Who | Gate |
|---|---|---|---|
| B0 Re-baseline | When the owner says the CloudCanvas push is finished: move `extern/cloudcanvas` to the 0.7.x commit the owner names and add `extern/cloudcanvas-lib`, each in its own commit. Redo the kit discovery on that pair: the engine's concepts, every lib widget and component, the `widget()` contract, tokens, how it runs in tests, and a gap table against the client inventory (Markdown, dialogs, menus, tabs, graph, voice) | Two Sonnet researchers | Report read and checked |
| B1 Definition | Freeze: the view contract re-derived from the lib; the store interfaces (from inventory §2.4); the Markdown pipeline and block registration; theme token mapping; the test harness; client build and delivery paths; the gap list sorted by the owner's placement rule (Stream L's backlog); the endpoints A3 must add. Correct `DESIGN.md`, `SPEC.md`, `ARCHITECTURE.md` | Two Opus designers | **The owner approves the contracts** |
| B2 Client base | Four tracks: shell and router (frame, the five pages as views); state (API client, stores, `session-core.ts` used as is); Markdown pipeline; theming and the test harness. Accepted when a saved session opens read-only in the new client from live data | Three Opus agents, then one | Owner's sign-off, merge |
| B3 Screens | Three waves of three tracks (table below). Each track opens with a parity checklist written from that group's render tests, which the owner approves, then builds `src/client/views/<group>/` with its own tests | Three Opus agents per wave | Per track: checklist passes |
| B4 Parity QA | Every checklist end to end in the desktop window on a copy of the owner's state; consolidated QA | Sonnet reviewers | Owner's sign-off, merge |

Screen tracks, sized from the inventory (lines today / reusable as they are):

| Wave | Track | Size | Depends on |
|---|---|---|---|
| 1 | Session: transcript, composer, steering | part of 11,165 / 2,256 | B2 |
| 1 | Settings and setup | 7,081 / 54 | B2 |
| 1 | Knowledge graph | 5,666 / 1,862 | B2 |
| 2 | Session: side thread, activity, stats | rest of Session | wave 1 Session |
| 2 | Questions, plan, practice | 3,385 / 55 | wave 1 Session |
| 2 | Home and session list | 2,302 / 93 | B2 |
| 3 | Plugin views (12 `mount*` widgets, 3 `open*` calls) | 3,493 / 1,029 | waves 1 and 2 controls |
| 3 | Artifacts | 1,471 / 32 | Session |
| 3 | Dictation and read-aloud (incl. pull request 1's features) | 1,552 / 111 | composer, Settings |

The knowledge graph track reuses `components/graph-canvas.ts` unchanged (DESIGN §3.1).

## Stream L: CloudCanvas contributions

B1 produces the list. For each item placed in `cloudcanvas-lib` or the engine: a clone under
`/usr/lib/persist/peer/work/`, a feature branch, tests in that repo's own harness, a pull request to the public
repo. The owner merges it; peer then moves its pin in a commit of its own. Items are scheduled in B1 so they merge
before the screens that need them. Candidates from the superseded discovery, to be re-checked in B0: Markdown
tables, images, a block extension point and repair of half-streamed text; type definitions.

## C Cutover (Phase 4)

Package the API server and the client without Next (`electron-builder.yml`, `electron/main.cjs` `serverEntry`, and
the build and smoke scripts that assume Next's output); choose the production build tool; end to end on a copy of
the owner's state; install as a new release directory under `/usr/lib/persist/peer/releases`. `current` moves only
on the owner's word, after a state backup. The state directory does not move.

## D Removal (Phase 5)

Delete `app/`, the React components, Next, Tailwind and the React render tests. Move the shared modules into
`src/client`. Rehearse one upstream merge and write the procedure down.

## E Later features (Phases 6 and 7)

Model-built canvases, then the design points in DESIGN §6 (seventeen so far). Each opens with its own Discovery; none
is designed here.

### Phase 6: Canvases

Defined after parity. Starting points already known: the board document format, how the model is told what it may
build, how a document is validated, and whether panels and board save/load come from CloudCanvas (DESIGN §7).

### Phase 7: Learner features

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
| Learn more (+) on a section: the learner says where to expound and the model adds learning to the graph | open |
| Quizzes graded on ability, so later quizzes can be set at higher orders or degrees | open |
| Expand a set of topics in conversation, from what was learned and struggled with, toward more learning around a topic and its relation to other interests, motivations and goals | open |
| Skill tree: successes and failures mapped visually to what is known and what is being learned | yes |
| Definitions and levels: a built-in place for definitions, and the lesson, topic, unit, subject and discipline tracked as metadata while lessons are worked through | open |
| Notes and a notebook: notes after each teaching, a collection per set of teachings, and a notebook across all teachings by metadata filtering and tags | open |

Items that touch `src/{agent,core,store}` change upstream's engine, so each is designed to stay separable from
it (SPEC §5.5).

## Quality gates, every phase

1. The acceptance in SPEC §7 for that phase, demonstrated by tests and a worked example.
2. The existing logic suite is green.
3. Code-quality, security and efficiency review of the phase's diff against `master`.
4. Docs and this plan updated with what was expected and what was actually built.
5. The owner's sign-off.

Verification, per stream:

- **A:** `tests/api-parity.test.ts` passes for all 50 routes and 5 streams against Next's standalone server on
  scratch data; the logic suite is green; typecheck and lint clean; three QA reports with every confirmed
  finding fixed or declined with a reason.
- **B2:** a saved session opens read-only in the new client from live data; the unit layer passes.
- **B3 and B4:** every screen's checklist passes end to end in the desktop window on a copy of the owner's state.
- **L:** each CloudCanvas pull request passes that repo's own tests before the owner is asked to merge it.
- **Guard, every sprint:** the running app's pid, `current`, both installed AppImages and the launcher unchanged.

## Needed from the owner, and when

| When | What |
|---|---|
| Now | Approval of this plan (given 2026-11-14) |
| When the CloudCanvas push settles | The engine and lib commits to pin |
| End of B1 | Approval of the client contracts and the Stream L list |
| Each sprint's end | Sign-off to merge |
| Any time | Whether `current` moves to `v0.6.1-local.2`; the pdl status fields and the records still titled "Host" |

## Not known yet

- Whether the lib's `widget()` model fits document-style screens (transcript, settings) as it stands. B0 and B1
  establish it; B2's read-only session is the first proof.
- Whether engine 0.7.x and `cloudcanvas-lib` at their pushed commits work together. B0 checks.
- The client inventory was read, not run, and `chat.tsx` only in part; each screen's Definition sprint closes that.

## Risks

| Risk | Handling |
|---|---|
| Upstream changes a screen while we rebuild it | Parity is fixed to the upstream commit named in each checklist; later upstream interface changes are re-decided, not merged |
| A CloudCanvas widget lacks behaviour a screen needs | Found in B0's gap table or in that screen's track; placed by the owner's rule in DESIGN §3 (engine, `cloudcanvas-lib`, or peer); CloudCanvas items go through Stream L |
| The engine at the pinned commit lacks something the newer `cc-main` has | Recorded before the split; re-checked in B0 against 0.7.x and `cloudcanvas-lib` (DESIGN §7) |
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
| Evidence: the investigation report | `54fd2ef38b26` | linked to the roadmap |

The pdl titles predate the owner's correction of 2026-11-14 (DESIGN §3); renaming them is the owner's. The streams
and sprints of the approved plan (A1 to A3, B0 to B4, L, C, D, E) are not yet recorded in pdl.

The sprint's six work items are tasks tagged `proposed` and `skill:foundation`, each with acceptance,
constraints, effort and its dependencies (`pdl find --kind task --tags proposed`).

## Expected and actual

| Phase | Expected | Actual |
|---|---|---|
| 0 Foundation | Docs, report, proposed roadmap, handoff | delivered 2026-11-14 in pull request 2, merged |
| Stage 0 | Leftovers removed; pull request 1 reviewed and fixed; both pull requests signed off; handoff | 0.1 to 0.3 done 2026-11-14. Pull request 1 was reviewed by three independent reviewers (45 findings, with overlaps) and fixed in commit `3fa3928`: typecheck and lint clean, full suite 5,405 of 5,412 with 4 skipped and 3 load timeouts in `headless-helper-lifecycle` that pass alone. Different from expected: three fix agents, not one; nine findings are left as owner decisions and two were declined. 0.4: pull requests 1 and 2 merged (`master` `5d5b6e2`); the fixed build packaged as `releases/v0.6.1-local.2`, not switched to; the pdl records are still `idea`. Not done: hands-on checks of microphone dictation, read-each-reply-aloud and the desktop window |
| Sprint 1.1 | Inventory, Next behaviours, static surface, contract, parity method, submodule | Delivered in pull request 3, 2026-11-14. 1.1 to 1.3: two discovery reports. 1.6: submodule and pin rule. 1.4 and 1.5 drafted (SPEC §2, `.context/logs/reports/2026-11-14-api-parity-method.md`). Different from expected: the owner corrected the model the same day (the client is the host; the Node server is only the engine's API), so Phase 1 no longer runs the old interface; then decided the API process hands out the client's files (track T); CloudCanvas was split, which superseded the v0.6.0 pin, the view contract and the kit discovery; the execution plan's decisions were recorded (DESIGN §3.1). Merge: on the owner's word given by plan approval, after this correction |
| A1 Build | Tracks R, T, O, then P; all tracks green; parity passes for all 50 routes | not started |
| B0 Re-baseline | Both submodules pinned at the owner's commits; kit discovery redone with a gap table | not started; waits for the owner to name the commits |
