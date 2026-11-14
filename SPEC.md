# peer: specification

Status: foundation draft, 2026-11-14. This states what must be true of the rewrite. Points marked **open** are
not decided.

## 1. Parity

The first release has every screen the current app has, with the same data and the same server behaviour.

| Screen | Route today | Current source (lines) |
|---|---|---|
| Home and session list | `/` | `home.tsx` 351, `sidebar.tsx` 971, `new-session.tsx` 398 |
| Session: transcript, composer, steering, side thread, activity, stats | `/chat/[id]`, `/chat/new` | `chat.tsx` 2,996, `session-core.ts` 1,257, `activity-dock.tsx` 540, `side-thread.tsx` 288, `composer.tsx` 242, `stats-bar.tsx` 213 |
| Questions, plan, practice | inside the session | `question-dock.tsx` 991, `plan-block.tsx` 984, `practice-cards.tsx` 300, `practice-dock.tsx` 218, `answered-card.tsx` 240 |
| Knowledge graph | inside the app shell | `graph-view.tsx` 1,705, `graph-canvas.ts` 1,753, `chain-table.tsx` 894, `extraction-coverage.tsx` 411 |
| Settings and first-run setup | `/settings` | `components/settings` 5,614, `setup-dialog.tsx` 610, `model-picker.tsx` 350 |
| Plugin views | `/plugins/[pluginId]/[viewId]` | `plugin-manager.ts` 666, `plugin-ui-host.tsx` 364 |
| Artifacts: demos, jobs, images | inside the session | `components/artifacts` 1,471 |
| Dictation and read-aloud | inside composers and replies | `dictation.tsx` 865, plus pull request 1 |

A screen has parity when its checklist passes. Each checklist is written in that screen's Definition sprint from
the current behaviour and the existing render tests, and is approved before development starts.

## 2. Host

1. Serves every route the Next layer serves, with the same method, path, status, headers and body.
2. Applies `apiRequestRefusal` before every `/api` route.
3. Passes response streams through without buffering.
4. Serves the client's files and the plugin assets the Next layer serves today.
5. Binds loopback by default, as `next start -H localhost` does.
6. Starts plugins once, before the first request is answered.
7. Reads the same environment: `LH_DATA_DIR`, `LH_AUTH_FILE`, `LH_ALLOWED_HOSTS`, `LH_DESKTOP_SERVER`,
   `LH_DESKTOP_API_SECRET`, `PORT`, `HOSTNAME`.

## 3. Client

1. Contains no React, no Next.js and no Tailwind.
2. Every view follows `create(host, callbacks) => { update(model), destroy() }` and keeps no application state.
3. Only `src/client/state` calls the host.
4. Markdown renders everything `streamdown` renders for the tutor today, including code with highlighting, LaTeX
   math, Mermaid diagrams and text that is still streaming.
5. Model-produced text never reaches the DOM as markup. Where a diagram library returns SVG, it is inserted under
   the same restrictions the app applies today (`securityLevel: "strict"` for Mermaid).
6. Interactive demos stay in a sandboxed frame with an opaque origin.
7. Keyboard behaviour matches the current shortcuts (`docs/keyboard.md`).
8. The plugin frontend contract in `src/core/plugins.ts` is met without changing any plugin.

## 4. Data

1. Storage formats do not change. A state directory written by the current app opens in the new one, and the
   reverse, for as long as both exist.
2. No migration runs at cutover.

## 5. Code

1. At most 500 lines per file, 50 per definition, three levels of indentation.
2. Every unit has tests in the same change.
3. No secret, credential or learning record is committed.
4. Logging is non-blocking and configurable; configuration is explicit.
5. Changes inside `src/{agent,core,server,store}` are kept small and separable, because that tree merges from upstream.

## 6. Tests

| Layer | What it covers | Tooling |
|---|---|---|
| Unit | stores, views, blocks, host router | `node:test`, linkedom, the kit's `ui/testing` |
| Integration | every route answers identically under Next and under the host; streams included | `node:test` against both servers |
| End to end | each screen's parity checklist in the real desktop window, on a copy of real state | browser driver **open** (ARCHITECTURE §5) |
| Regression | the existing logic suite (`tests/*.test.ts`) stays green throughout | `npm test` |

## 7. Acceptance by phase

| Phase | Accepted when |
|---|---|
| 1 Host | Integration layer passes for all routes; the logic suite is green; the current interface runs on the host unchanged |
| 2 Client base | A saved session opens read-only in the new client from live data; the unit layer exists and passes |
| 3 Screens | Every screen's checklist passes end to end in the new client |
| 4 Cutover | The packaged desktop app runs the new host and client and passes end to end on a copy of real state |
| 5 Removal | No React, Next.js or Tailwind remains in the dependency tree; one upstream merge has been rehearsed and documented |
| 6 Canvases | Defined in that phase's Definition sprint |

## 8. Open

- The parity checklists themselves (§1).
- Whether the session stream protocol needs any change for the new client. Proposed: none.
- Accessibility targets beyond matching current behaviour.
