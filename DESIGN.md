# peer: design

Status: foundation draft, 2026-11-14; the owner's correction on where the interface runs added to §3 the same day;
the owner's decisions of 2026-11-14 on the client's files, the CloudCanvas split, placement and contributions, and
the execution plan's decisions (§3.1), recorded the same day. Points marked **open** are not decided.

## 1. Purpose

`peer` is our fork of LearnHarness, an agent harness for learning: agents measure what a learner understands,
plan a route to a goal, teach it step by step, and keep the result in a knowledge graph. We keep that engine and
replace its interface with one built on CloudCanvas.

The reason is what the interface can become. CloudCanvas treats the DOM as the runtime engine: an element is the
unit, its state lives on it, and the browser owns its lifetime. An interface made of such elements can be
described as data, which means the model can build parts of it: interactive graphs, drawn SVG, dashboards for
the system, richer knowledge graphs and mappings.

## 2. Who it serves

One learner on their own machine, running the desktop app with their own model access and local voice models.

## 3. Decisions (confirmed by the owner, 2026-11-14)

| Topic | Decision |
|---|---|
| Repository | `peer-stem/peer`, a linked fork of `amosblomqvist/learnharness` |
| Branches | `master` is our integration branch; `main` receives only our releases; upstream is followed through the `upstream` remote |
| Scope of the rewrite | The interface and the server layer. No React and no Next.js in the result |
| Logic | `src/{agent,core,server,store}` stays TypeScript, moves unchanged, and keeps merging upstream |
| First release | Parity: every screen the current app has, shipped as the `peer` desktop app |
| Desktop shell | Electron stays |
| Order | Parity first. Model-built graphs and dashboards come after it |
| Old interface | Keeps building and shipping from the fork until parity, then is deleted. The new client never contains React |
| CloudCanvas source | Superseded 2026-11-14 by the split (next row). Was: `CloudsEcosys/cloudcanvas`, `main`, as a git submodule in `extern/cloudcanvas`, pinned at `c5e6e07` (v0.6.0) |
| CloudCanvas baseline | peer builds on the current split: the engine `CloudsEcosys/cloudcanvas` (0.7.x) plus `CloudsEcosys/cloudcanvas-lib`, both pinned as submodules. CloudCanvas was split on 2026-11-14: the engine's `main` no longer contains the `ui/` kit; the widget kit, board components, archetypes and the board are in `cloudcanvas-lib` as `widget()` types created on a board. The commits to pin are not named yet (the owner is still pushing). Until sprint B0 pins them, `extern/cloudcanvas` stays at `c5e6e07` (v0.6.0) and is **to be moved** |
| Client languages | Plain JavaScript for view code that talks to CloudCanvas; TypeScript for what shares types with `src/` |
| Where new capability lives | The owner's placement rule: "if they are agnostic to our project they go in the cloudcanvas-lib unless they are core/fundamental to cloudcanvas as an 'engine' -- but if they are application specific they go in our abstraction/implementation". So: fundamental to the engine → `cloudcanvas`; agnostic to peer → `cloudcanvas-lib`; application-specific → peer. Replaces the earlier two-way split (CloudCanvas side or peer) |
| CloudCanvas changes | Pull requests to the public repos (`CloudsEcosys/cloudcanvas-lib`, `CloudsEcosys/cloudcanvas`) from this project's own clones under `/usr/lib/persist/peer/work/`. The owner merges; peer then moves its pin in a commit of its own. The owner's `~/cloudcanvas` workspace is never touched |
| Deadline | None |
| Where the interface runs | The owner's words: "CloudCanvas is designed where the Client is the Host", and "cloudcanvas runs client side because it treats the DOM as the runtime engine". No server renders the interface; its files are handed out unchanged (row "The new client's own files"). The client is static native modules that run in the window, draw everything there and fetch all data. In CloudCanvas, "host" means the client side (a control's host element), so the Node server is never called host |
| The Node server | The engine's API: the routes and streams the Next layer serves today, without Next, in `src/api` (§3.1). It also hands out the client's files unchanged (next row) |
| Old interface during the migration | Stays on Next, untouched, until the removal phase. Phase 1 is accepted on route parity and the logic suite, not on the old interface running elsewhere |
| The new client's own files | The process that answers the API hands the client's files out unchanged, same origin. Nothing is rendered server-side. In development they sit under Next's `public/`; the path `/client/` is **proposed**, not decided. This was "a Phase 2 decision" until the owner decided it on 2026-11-14 |

### 3.1 Decided through the execution plan's approval (owner, 2026-11-14)

The owner approved the execution plan on 2026-11-14; approving it decided these. `PLAN.md` carries the plan.

| Point | Choice |
|---|---|
| Name of the API directory | `src/api` |
| How the client reaches the engine | HTTP. The router's entry is a plain `Request → Response` function, so Electron's own channel stays possible later |
| How the client's files reach the window | The process that answers the API hands them out unchanged, same origin. In development they sit under Next's `public/`, proposed path `/client/` |
| Request bodies over about 27 MB | Keep Next's silent cut at 27,262,976 bytes for parity; tune later |
| What the API server is compared against | Next's standalone `server.js`, which the app ships |
| `PORT` | Required, no default |
| Running TypeScript outside Next | `tsx` for development and tests; the production build tool is chosen in the cutover sprint (esbuild **proposed**, already in the lockfile) |
| End-to-end driver | `puppeteer-core`, already a dependency (**proposed**; confirmed in sprint B1) |
| Knowledge graph at parity | Reuse `components/graph-canvas.ts` (plain TypeScript, 1,753 lines) unchanged |
| Old interface | Stays on Next, untouched, until Removal |
| Agent models | Sonnet for research and review, Opus for design and development, Fable for coordination and the hardest items |
| Pull request 3 | Approving the plan is the owner's word to merge it, after the plan's step 1 corrects its docs |

## 4. Principles

1. **The DOM is the runtime.** No client framework state tree and no virtual tree. The server's records are
   authoritative, client stores hold the working copy, and a view is a control that receives a plain model and
   reports through callbacks.
2. **One contract for every view.** A view never owns application state. **Superseded:** the contract stated
   here, `create(host, callbacks)` returning `{ update(model), destroy() }`, came from the v0.6.0 `ui/` kit, which
   the split removed from the engine. The contract is re-derived from `cloudcanvas-lib`'s `widget()` model in
   sprint B1.
3. **Additive until cutover.** New code goes in new directories. Nothing upstream owns is edited unless a phase
   says so, so upstream merges stay cheap.
4. **Nothing is written twice.** Modules that are already free of React are shared by both interfaces while both
   exist, then moved.
5. **Data, not code, from the model.** A model-built surface is a document the client checks whole and then
   builds. It is never generated script.
6. **The rules of the house apply.** Maintainability, then correctness, then efficiency; 500 lines per file,
   50 per definition, three levels of indentation; tests with the code.

## 5. Not goals of the migration (phases 1 to 5)

- Changing the teaching engine, its prompts or its storage formats.
- A hosted or multi-user version.
- Replacing Electron.
- Carrying any React, Next.js or Tailwind past the removal phase.

## 6. After the migration

Wanted by the owner (2026-11-14), to be built once the migration is in. None of these is designed yet; each
starts with its own Discovery. "Today" is what was found in the code on `master`, not a design.

| Wanted | Today |
|---|---|
| **Onboarding in the app**: find the learner's areas of interest and assess their goals, with suggestions | First run only sets up models (`components/setup-dialog.tsx`). Nothing asks about interests or goals |
| **A knowledge base about the learner**: goals, experience, interests, facts, memories (the list is not fixed) | None. The knowledge graph holds what was taught; upstream's README says it stores "the ideas and their connections, not ratings of your ability" |
| **Visuals generated by the model for tests and assessment**: geometry, anything that needs a diagram, interactive puzzles | The model can draw SVG and build sandboxed demos for explanations (`src/agent/subagents/visual-maker.ts`, `demo-builder.ts`). Questions are text, plus the plugin question types (`plugins/coding-questions`, `plugins/drawing-pad`) |
| **Linking similar and overlapping topics** by keyword and metadata, so that mathematics and computer science share what they share | Some similarity handling exists in the graph code (`src/core/proposition-candidates.ts`, `src/core/graph.ts`); its extent is not verified |
| **Ongoing skills assessment and ranking**, with a metrics dashboard of progression and skill level by area | None, and it departs from upstream's stated position quoted above. The dashboard builds on Phase 6 |
| **Thinking**: show what the model is thinking | The session view renders reasoning when a provider returns it (`components/chat.tsx`, the `reasoning` part). The Codex and Antigravity bindings in pull request 1 do not pass reasoning through |
| **Masterclass mode**, beside single lessons. Single lessons stay as they work now, and cluster. Masterclass runs extended refinement rounds, not a single planning pass, and drafts an extended roadmap toward complete knowledge of a domain. Its assessment finds everything the learner wants to learn and where they sit in each sub-domain or niche of a school of thought, or across domains; it maps the pieces and sews together successions of lessons | A session's plan is written once: one `plan_init` call, "author-once" (`src/agent/tools/plan.ts`), as the minimal tree to one goal (`src/agent/prompts/teacher/10-planning.md`). Whether anything plans across sessions or groups them is not verified |
| **Seams between domains**, alongside masterclass mode. Sets of connected topics that have been learned connect and group together in the graph. Where topics are related, even across domains, the system identifies the gaps and can test and teach the seam between the domains or teachings already created. The owner placed this last, after everything else | Not verified. The topic-linking row above names the similarity code that exists; nothing was found that detects gaps between domains |
| **Mastery and mystery**. The system identifies strengths (areas of mastery) and gaps (areas of mystery), and how to build on existing topics to extend into target areas: the areas in the map that help bridge the gaps. It reinforces the strengths and eliminates the weaknesses | Not verified. The graph stores ideas and their connections; upstream's README says it does not rate ability. See the skills-assessment row |
| **Chained learning across subjects**. The model looks at the other areas, topics and content the learner is working through and sees how they relate. The owner's example: working on machine learning while missing fundamental math, it uses the math teaching inside the machine learning and teaches both, placing what is learned in machine learning within what is missing in math, so the learner gains in both areas | Not verified. A session plans toward one goal (the masterclass row); nothing was found that relates sessions to each other |
| **Learning style, self-graded confidence and communication style**. The model learns the individual's learning style, how they grade themselves in terms of confidence, and different styles of communication, if possible | Within one session the teacher chooses "Socratic or expository for each stretch, given the topic and his energy" (`src/agent/prompts/teacher/10-planning.md`), and a question can be answered "don't know" (`dontKnow` in `src/core/plugin-view-context.ts`). Nothing was found that keeps a learner's style or confidence across sessions; not verified beyond these two files |
| **Learn more (+) on a section**. At a certain point in the learning, the learner adds (+) to a section to "learn more", tells the model where to expound, and the model modifies the graph to add more learning | A session's plan map is written once and not edited afterwards (`plan_init`, "author-once", `src/agent/tools/plan.ts`). Whether the graph can be extended on request is not verified |
| **Quizzes graded on ability**. The learner takes a quiz and is graded on ability, so future quizzes can be set at higher orders or degrees | Quizzes exist inside a session, tied to the plan's nodes (`src/agent/tools/plan.ts`). Nothing was found that grades ability or raises the level of a later quiz; upstream's README says the graph does not rate ability. Overlaps the skills-assessment and mastery rows |
| **Expand a set of topics in conversation**. The learner talks to the model about a given set of topics and "expands": the model takes what has been learned and what was struggled with, and expounds on the curriculum and the learning so far to build more learning opportunities around a topic, or shows how it relates to other areas of interest or to the learner's motivations and goals | Not verified. Overlaps masterclass mode, chained learning and the learner knowledge base |
| **Skill tree**. A visual tree showing how successes and failures map to what the learner knows and what they are learning | A session shows a live map of its own plan (`src/agent/prompts/teacher/10-planning.md`), and the knowledge graph shows ideas and their connections. Nothing was found that maps successes and failures across sessions; not verified. Overlaps the skills dashboard; needs model-built canvases |
| **Definitions, and the levels of what is learned**. The model has a place built in for definitions, and the "lesson", "topic", "unit", "subject" and "discipline" are tracked, so working through lessons maps all of them. The owner's suggestion: the model does this with metadata. How the five levels nest is **open** | A graph node holds a short name ("like a glossary headword"), one precise statement, aliases and where it came from; a cluster holds a label (`src/core/contracts/graph.ts`). A session and a plan node each hold a title. No field was found for a definition as such, or for any of the five levels; only the field names in `src/core`, `src/store` and `src/agent/tools` were searched, not the prompts. Overlaps topic linking (the same metadata), masterclass mode and the skill tree |

The third and fifth depend on model-built canvases (Phase 6). The others do not depend on the interface and
could be scheduled earlier; that ordering is **open** (§7). Proposed, not decided: masterclass mode builds on
onboarding's assessment, the learner knowledge base and topic linking; whether its roadmap view needs Phase 6 is
**open**.

## 7. Open decisions

Decided on 2026-11-14 and moved to §3: the placement rule (was open point 1's rule), model tiers (was 3), the
knowledge graph at parity (was 5), how the client reaches the engine (was 7), how the client's files reach the
window (was 8), the name `src/api` (was 9).

| Open point | Falls due |
|---|---|
| **The commits to pin** for `extern/cloudcanvas` (0.7.x) and `extern/cloudcanvas-lib` | When the owner says the CloudCanvas push is finished; pinned in sprint B0 |
| **The view contract**, re-derived from `cloudcanvas-lib`'s `widget()` model (§4, principle 2) | Sprint B1; the owner approves the contracts |
| **Each capability CloudCanvas lacks, placed by the rule in §3.** From the superseded v0.6.0 kit discovery, to be re-checked in sprint B0: type definitions, rendering of half-streamed text and a Markdown block extension point were proposed for the CloudCanvas side; math, Mermaid and code highlighting as application blocks (peer) | B0 redoes the gap table; B1 sorts it by the rule into Stream L's list; the owner approves it at the end of B1 |
| **The client's development path**: `/client/` under Next's `public/` is proposed | Sprint B1 (client build and delivery paths) |
| **The end-to-end driver**: `puppeteer-core` proposed | Confirmed in sprint B1 |
| **The production build tool**: esbuild proposed | The cutover sprint (C) |
| **Panels and board save/load.** Before the split they existed only in `CloudsEcosys/cc-main`; the board is now in `cloudcanvas-lib`, and whether save/load came with it is to be re-checked in sprint B0. Dashboards after parity probably need them | Re-checked in B0; decided before Phase 6 (E) |
| **Effort for each work item**: proposed in pdl | Not scheduled in the plan |
| **The fork's default branch** on GitHub is still `main`; pull requests name `master` explicitly | Not scheduled in the plan |
| **When the items in §6 are scheduled**, and which of them may start before parity. The plan's stream E lists model-built canvases, then the §6 points, each opening with its own Discovery | Not scheduled in the plan |
