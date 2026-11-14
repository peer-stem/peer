# API parity method

Sprint 1.1, item 1.5. Design only; nothing was run. Date 2026-11-14. Status: **proposed**, awaiting the owner's
approval. Contract: `SPEC.md` §2. Sources: **R** = `2026-11-14-host-route-inventory.md`, **St** =
`2026-11-14-host-static-surface.md` (both in this directory).

## 1. What is compared

| Compared | Not compared |
|---|---|
| Every `RouteRecord` of the table (50 files, 73 exported methods, R §1.4), plus automatic OPTIONS and HEAD on every pattern | Pages, `public/`, `/_next/**`: Next serves them and the API server does not (SPEC §2.1). Their "Not verified" items (St) belong to Phase 2 |
| Status, headers (§4), body, stream events (§5), data directory after each write (§3) | Timing, except headers before the first byte (§5) |
| Gate answers in every mode (§6) | |

**Coverage check.** The test records every `(pattern, method)` it called and fails if that set differs from the
route table plus the automatic methods. A new route without a case fails the run.

## 2. Servers

| Item | Next | API server |
|---|---|---|
| Code | the standalone `server.js` from `.next/standalone` of the same commit, the one the desktop app runs (`electron/main.cjs:73-77`; St §6). Needs `npm run build` and `scripts/build-server.mjs` in the sprint worktree. `next start` is the alternative (**open**) | `src/api/server.ts` from the same worktree |
| Working directory | `.next/standalone` (`electron/main.cjs:224`) | worktree root, holding `scripts/plugin-loader.cjs` and the built `core-plugins/` (SPEC §2.8) |
| Port | spare, from `listen(0)` then close, as `electron/main.cjs:174-184` does; one retry on `EADDRINUSE` | same |
| Readiness | `GET /api/settings` returns 200 (row 41), 30 s limit | same |
| Stop | `SIGTERM`, then `SIGKILL` after 3 s, as the shell does (`electron/main.cjs:279-292`) | same |

**Environment.** Built from an allowlist, never inherited from the owner's shell:

| Variable | Value | Why |
|---|---|---|
| `LH_DATA_DIR` | `<run>/next-data` or `<run>/api-data` (§3) | never the owner's state (PLAN, rules) |
| `LH_AUTH_FILE` | `<run>/<side>-auth.json`, absent at start | no real keys |
| `LH_IGNORE_ENV_KEYS` | `1` | env keys invisible (`src/server/keys.ts:86-88`) |
| `HOME`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_CACHE_HOME`, `TMPDIR` | under `<run>/home` | no real CLI homes or `~/.config/LearnHarness` |
| `PATH` | `<run>/bin` only (§7); the child is started by absolute path | stubs shadow real CLIs |
| `NODE_ENV` | `production` on both | `server.js` sets it (St §6); `npm test` sets `test`, which changes `listJobs` (R §2.3) |
| `PORT`, `HOSTNAME` | spare port, `127.0.0.1` | loopback only |
| `LH_DESKTOP_SERVER`, `LH_DESKTOP_API_SECRET`, `LH_ALLOWED_HOSTS` | per gate group (§6) | the gate reads them per call (R §2.1) |

`<run>` is a private directory made by `mkdtemp` under `/tmp/peer/` with mode 0700, removed after the run unless the
run is told to keep it.

**Running.** `tests/api-parity*.test.ts` fall inside `npm test`'s glob (`package.json:19`). **Proposed**: they skip,
stating why, unless `PEER_API_PARITY=1` is set (name proposed) and `.next/standalone/server.js` exists, so the logic
suite never needs a Next build. The Phase 1 QA runs them explicitly.

## 3. Data directories and fixtures

**One fixture, two copies (proposed).** The brief asked for one scratch data directory shared by both servers. This
method proposes two byte-identical copies of one fixture, one per server, for three reasons. Two processes writing
one directory race. Run registries live per process on `globalThis` (`src/server/turn-liveness.ts:8-14`, R §2.3).
And reads write too: import-time `initAuthEnv` and `syncCustomProvider`, `listJobs` recovery, plugin question
reconciliation (R §1.2 row 8, §2.3). Cases run in the same order on both servers, Next first, so the two directories
evolve in step. After every write case, the two directories are compared after the normalisation in §4.

**Base fixture.** `tests/fixtures/golden-data/`: 2 chats (teach, practice), the graph ledgers, 5 jobs, `settings.json`.
It is copied, never edited (its README, "never hand-edited"). Additions are written into each copy before the
servers start, through the engine's own store functions (`writeSettings`, `src/store/settings.ts:113`), never by hand.

| Group | Rows | Fixture and setup |
|---|---|---|
| Chats and sessions | 4-9, 12, 14, 15 | golden chats; a chat created by `POST /api/chats` for write cases (ids mapped per server) |
| Side threads, steering, turns | 3, 5, 10, 11, 13 | as above, with the stub model (§7) pinned in all three model slots |
| Graph | 20, 23-28 | golden `graph/`. Row 27 writes emit three events (R §1.3 row 27), used by §5 |
| Import and extraction | 21, 22 | row 22: `tests/fixtures/sample-3page.pdf`, `tests/fixtures/not-a-pdf.txt`, `tests/helpers/tiny-pdf.ts`; stub model |
| Jobs and activity | 1, 2, 29 | golden `jobs/` (done, aborted and error records) |
| Settings, prompts, themes | 39-42, 47, 48 | golden `settings.json`; one custom theme from `POST /api/themes` |
| Keys, providers, models, CLIs | 16, 17, 19, 30-32 | empty auth file; a dummy key written by `PUT /api/keys/[id]`; custom provider pointing at the stub; CLI stubs |
| Plugins | 33-37 | the four core plugins from `core-plugins/` (St §3); for row 35, a community plugin with a document converter in `<data>/plugins/<id>/dist`. Which plugin, and whether `tests/helpers/plugin-authoring-fixture.ts` can make it, is settled in Track D's first step |
| Speech | 43, 44, 49, 50 | speech endpoint in settings pointing at the stub; no Deepgram key |
| Subscriptions | 45, 46 | refusal, not-found and bound cases only, until Track D reads `src/server/web-subscription-http.ts` and confirms the success paths stay local |
| Events | 18 | any |

## 4. Comparison rules

**Requests.** The same bytes go to both servers, with `Host: 127.0.0.1:<that server's port>` and no
`Accept-Encoding` (gzip has its own case, §8). Each response is read in full, or as a stream (§5).

**Status.** Equal.

**Headers.** Names compared case-insensitively, values exactly, after replacing each server's port with a token.

| Treatment | Headers | Why |
|---|---|---|
| Compared | every header not listed below, among them `content-type`, `cache-control`, `x-content-type-options`, `x-accel-buffering`, `content-disposition`, `referrer-policy`, `allow`, `location`, `etag` | set by handlers (R §2.6) or by the router (SPEC §2.4) |
| Ignored | `date` | the clock |
| Ignored | `connection`, `keep-alive` | connection handling, not the route's |
| Ignored | `transfer-encoding`, `content-length` | framing; the body is compared byte for byte instead. HEAD's `content-length` has its own case |
| Recorded | `x-powered-by`, `vary`, a generated `etag`, `content-encoding`, and any header found on one side only | Next defaults the API server does not reproduce (SPEC §2.9; R §2.6). A recorded difference fails the run unless it is in an approved list the owner signs, kept beside the test |

**Bodies.** JSON is parsed and compared after normalisation; anything else is compared byte for byte. Normalisation
replaces only an explicit, reviewed list of fields: ids created during the run (mapped per server, so the same
logical object gets the same token), timestamps, durations and the port. Any other difference fails.

**Upstream calls.** The stubs (§7) record what each server sent upstream; both servers must send the same calls,
normalised the same way.

## 5. Streams

The 5 streamed routes (R §1.4) are opened on both servers and read as events: SSE parsed into `{event, id, data}`
with `: ping` comments dropped; NDJSON split into one JSON value per line; audio as bytes. Sequences are compared
after normalisation; arrival times are not compared.

| Row | How it is driven |
|---|---|
| 18 `/api/events` | Open on both. Assert headers arrive within 1 s while nothing is emitted (R §2.7). Do the same row 27 write on each server; compare the events each stream receives. Close, then reopen to show the server still answers |
| 14 `/api/chats/[id]/stream` | (a) No turn running: fixed SSE body, compared exactly (`src/server/turn-runs.ts:99-108`). (b) Running turn: start `POST /api/chat` with a stub that holds its reply until the test releases it, attach, release, read to `data: [DONE]`. (c) Unknown chat: JSON 404 |
| 10 POST, 11 GET side threads | Ask with the stub model; compare NDJSON lines; watch the thread with GET |
| 49 `/api/tts/speak` | The stub returns fixed WAV bytes in several delayed chunks; compare bytes and headers. Over-cap case: the stub sends more than 33,554,432 bytes and both servers must cut it the same way (R §1.3 row 49) |

Disconnects are seen through the stub. For row 49 the test aborts mid-stream, and the stub must see its upstream
request aborted (`src/server/speech.ts:121` joins the client's signal). That shows `request.signal` aborts. Release of
the bus listener on row 18 cannot be seen from outside, so `tests/api-adapter.test.ts` asserts the `cancel()` call on
a recording stream (PLAN Phase 1, Track B).

## 6. Gate cases

Each mode is a separate pair of server processes, since the gate reads the environment (R §2.1).

| Mode (environment) | Refused requests sent | Passing requests sent |
|---|---|---|
| Browser (no desktop variables) | `Host: evil.example`; writes with `sec-fetch-site: cross-site`; writes with `origin: http://evil.example` | `Host` localhost or IP; a write with neither header; a write whose `origin` equals the server's (R §2.1) |
| Browser, `LH_ALLOWED_HOSTS=peer.test` | `Host: other.test` | `Host: peer.test` |
| Desktop (`LH_DESKTOP_SERVER=1`, 64-hex secret made per run) | no `x-learnharness-desktop`; a wrong value | the right value |
| Desktop, no secret | everything (`tests/desktop-api.test.ts:50`) | none |

The refusal matrix in each mode: one concrete path per route pattern, plus `/api`, `/api/`, `/api?request=1`, an
unknown `/api/nope`, and every path in the matcher table pinned by `tests/plugin-document-proxy.test.ts:26-45`, each
with all seven methods. Every answer must be 403 with `Cache-Control: no-store` and the same body on both servers. No
handler runs (row 35's own gate answers the same, R §2.1), so the matrix has no side effects. `/`, `/apix` and
`/api-other/...` are sent to the API server only: 404 with no gate (SPEC §2.4 step 1).

## 7. Routes that call models, endpoints or CLIs

No case may spend a model call or reach the network:

- **Model.** A stub OpenAI-compatible server on a spare loopback port, set as the custom provider (an
  OpenAI-compatible base URL, keyless placeholder: `src/server/custom-provider.ts:1-27`) and pinned in all three model
  slots of each copy. It answers scripted completions, can hold a reply until released, and logs every request. Used
  by rows 3, 5, 10, 11, 13, 21 and 22. Each route's "not configured" path is also run with the slots empty.
- **Speech.** The same stub answers the speech endpoint paths (`/audio/speech`, transcription, voices) for rows 44,
  49 and 50 (`src/server/speech.ts:113-122`). Row 43 calls a fixed Deepgram URL (R §1.3 row 43), so only its no-key
  path is run.
- **CLIs.** `<run>/bin` holds a stub executable for every name the engine looks up, printing a fixed version. PATH is
  searched first, then fixed directories such as `/usr/bin` (`src/agent/external-cli/binary.ts:19-21`;
  `src/agent/claude-code/binary.ts:66`), so a missing stub would find a real CLI. Track D takes the name list from
  that code. Rows 16 and 19 also need their same-origin headers (`src/server/claude-code.ts:20-25`,
  `src/server/external-cli.ts:97-101`).
- **Bridges.** The ChatGPT and subscription bridges stay off, because the children have no `ipc` channel (R §2.11).
- **Residual risk.** Nothing above blocks the network at the process level. A network-less run (a namespace or
  firewall rule) is **open**; it needs the owner, since it may need privileges.

## 8. Unverified behaviours as named cases

R "Not verified" items, each turned into a case in `tests/api-parity.test.ts`. SPEC §2.10 lists the same names.

| Case | Item | Sent | Expected or recorded |
|---|---|---|---|
| `head-on-get-route` | 1 | HEAD to rows 26 and 41 | Both run GET with no body (Next source: `auto-implement-methods.js:39-46`, SPEC §2.4). Compare status, headers, `content-length` |
| `405-shape` | 2 | PUT to row 39 (GET only) | 405, no body, no `Allow` (same file, :16-20) |
| `auto-options` | 2 | OPTIONS to rows 26, 8 and 17 | 204 with a sorted `Allow` (same file, :49-73) |
| `static-before-dynamic` | 2 | `PUT /api/settings/prompts` | 405, not row 42 |
| `unknown-method` | 2 | `TRACE`, `FOO` to row 26 | recorded |
| `param-decoding` | 3 | `[id]` with `%2D`, `%2F`, `%25`, non-ASCII; row 33 and 40 catch-alls with encoded segments | compare; the stores reject unsafe ids (R §2.4) |
| `request-url-and-host` | 4 | rows 16 and 19 with `origin` equal to `http://<Host header>` and with a different origin; a gated write with each (they compare `origin` with `subscriptionRequestOrigin`, R §2.7) | equal pass and refusal on both |
| `abort-on-disconnect` | 5 | abort row 49 mid-stream | the stub sees its request aborted on both |
| `cancel-on-disconnect` | 5 | close row 18 and row 11, then repeat 50 times | the server stays answering; the cancel itself is checked in `tests/api-adapter.test.ts` |
| `default-headers` | 6 | every case | the "Recorded" row in §4 |
| `gzip` | 6 | rows 41, 33 and 18 with `Accept-Encoding: gzip` | recorded: whether Next compresses API answers (SPEC §2.9) |
| `trailing-slash` | 7 | `/api/graph/`, `/api/graph/?x=1`, refused and passing | status, `Location`, query kept, gate before or after |
| `handler-throws` | 8 | row 13 with a malformed JSON body (R §1.3 row 13) | status, body, a log line |
| `unknown-api-path` | 8 | `/api/nope`, gate passing | status, headers, body |
| `bodiless-shape` | 9 | row 27 POST and DELETE with no body | "Missing ..." means `null`, "Could not read ..." means an empty stream (R §2.7) |
| `body-cap` | 9 | 27,262,977 bytes of valid JSON to row 24, with and without `content-length`; the same to row 22 and row 35 | Next's cut reproduced, row 35 uncut (SPEC §2.6) |
| `shared-registries` | 10 | start a turn on row 3, then `GET /api/chats/[id]` (row 8) | `turnInFlight: true` on both |
| `outbound-fetch-uncached` | 11 | row 50 twice, the stub changing its voice list between calls | both see the change |
| `sigterm-stop` | 12 | SIGTERM with row 18 open | exit within 3 s on both, or recorded |
| `long-stream` | 12 | row 18 held 6 minutes, past Node's 300 s request timeout | stays open on both; runs only with a long-run flag |
| `matcher-encoded-paths` | 13 | encoded forms of the exempt path (`%2D` and `%64` in the id, `%6Darkdown`) in each gate mode | same 403 or pass on both |
| `routes-import` | 14 | in `tests/api-routes.test.ts`: import every route module under the API server's runtime | all load |

Items 15 and 16 of R's list are about what that report did not read or run; they need no case.

## 9. Files (Track D)

`tests/api-parity.test.ts` (route cases), `tests/api-parity-gate.test.ts` (§6) and `tests/api-parity-streams.test.ts`
(§5), each under 500 lines. Helpers: `tests/helpers/api-parity-servers.ts` (directories, environment, ports, start,
stop), `tests/helpers/api-parity-compare.ts` (normalisation, header rules, stream readers),
`tests/helpers/api-parity-stubs.ts` (model, speech and CLI stubs).

## 10. Open

- Next's standalone `server.js` or `next start` as the reference (§2).
- Two data copies instead of one shared directory (§3).
- The opt-in variable name and the approved-differences list (§2, §4).
- A run with no network (§7).
