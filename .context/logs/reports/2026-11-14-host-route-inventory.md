# Host route inventory and the Next behaviours a plain host must reproduce

Sprint 1.1, items 1.1 and 1.2. Research only: nothing was run (no npm, tsx, next, tests or builds).
Date 2026-11-14. Worktree `/usr/lib/persist/peer/work/1.1-host-definition`, branch `feature/1.1-host-definition`,
HEAD `ecaf3be` on `master` `5d5b6e2`. `git diff --stat 5d5b6e2..HEAD -- app src proxy.ts next.config.ts instrumentation.ts electron lib`
is empty, so every file read here is identical to `master` after pull request 1.

## 0. How to read this report

- Paths are relative to the worktree. Abbreviations: `S/` = `src/server/`, `A/` = `src/agent/`, `C/` = `src/core/`,
  `ST/` = `src/store/`. `route:N` = line N of that row's `app/api/.../route.ts`.
- `DOCS/` = `node_modules/next/dist/docs/01-app/`. `node_modules` is absent in this worktree, so the docs were read from
  `/usr/lib/persist/peer/work/pr1/node_modules/next/dist/docs/01-app/`. Next is 16.4.3 in both: `package-lock.json:14219` and
  `/usr/lib/persist/peer/work/pr1/node_modules/next/package.json:3`.
- Claims about Next are in one of three states, always marked: **docs** (a DOCS path and line), **repo** (the repo says
  or demonstrates it; cited, not confirmed against Next's source), or listed under "Not verified".
- Count check: `git ls-files 'app/api/**/route.ts' | wc -l` = 50, and the table in 1.2 has 50 rows. No other file exists under
  `app/api` (`git ls-files app/api` shows only `route.ts` files).

## 1. Route inventory (item 1.1)

### 1.1 Facts true of all 50 route files

1. Every file imports through the `@/` alias (`tsconfig.json` `paths: {"@/*": ["./*"]}`): `rg -c 'from "@/' app/api` matches
   50 files. Targets: `@/src/server` (barrel, `S/index.ts`), `@/src/core`; only row 22 also imports `@/lib/notes-import-limits.ts`
   and `@/lib/bounded-form-data.ts` (`app/api/graph/import/route.ts:24-25`).
2. No file imports from `next/*` or `next` (`rg 'next/|from "next"|NextRequest|NextResponse' app/api` = 0 matches). Every
   handler types its request as the web `Request`; none uses `nextUrl`, `cookies`, `headers()` or any `NextRequest` member
   (`rg 'nextUrl|\.cookies\b|cookies\(|headers\(\)' src app/api lib` = 0). Next hands the handler a `NextRequest`
   (DOCS 03-api-reference/03-file-conventions/route.md:64), but only `Request` members are used: `url`, `method`,
   `headers`, `body`, `signal`, `json()`. No handler or server module calls `clone()`, `text()`, `formData()`, `blob()` or reads
   `bodyUsed` on the incoming request (`rg '(req|request|message)\.(clone|text|blob|formData|arrayBuffer|bodyUsed)' src/server app/api lib`
   = 0), and none reads cookies or sets `Set-Cookie` (`rg -i 'set-cookie|cookies'` over the same paths: one comment, no code).
3. **Second argument.** On the 20 dynamic routes the handler is called `(request, context)` with
   `context = { params: Promise<{...}> }` and awaits `context.params` (the file reads it at the lines in 1.3; row 35 reads it
   in `S/plugin-transport.ts:75`). `ARCHITECTURE.md:37` writes the handler as `handler(request, params)`; the real second
   argument is the context object with a `Promise`, not bare params. `tests/plugin-document-integration.test.ts:42` calls routes
   that way: `{ params: Promise.resolve({ id }) }`.
4. **Return type.** Handlers return `Response | Promise<Response>`. Two return a `Response` synchronously: row 18
   (`export function GET(): Response`, `route:13`) and row 17 `GET` (`customProviderGet`, `S/custom-provider-http.ts:38`).
   `ARCHITECTURE.md:37` writes `Promise<Response>`.
5. **Handlers that are assignments, not declarations**: row 17 (`export const GET/POST/PATCH/DELETE = ...`, `route:6-9`),
   rows 45 and 46 (`export const GET = ...; export const POST = ...`, `route:5-6`), row 35 (seven `export const` from one
   object, `route:8-14`). Row 17 assigns `customProviderMutation` to POST, PATCH and DELETE.
6. **"Own logic"** (column in 1.3) = the route file contains validation, branching, status mapping, header setting, response
   shaping, more than one server call, or outbound I/O. Not own logic = the handler passes the request and params to
   one server function and returns its result, or wraps a zero-argument read in `Response.json(...)`.

### 1.2 Routes, methods and the functions they call

Each cell is `METHOD (route line) → function (definition)`. A function defined elsewhere than `S/` is re-exported by
the barrel `S/index.ts` unless stated. `getChat`, `createChat`, `listChats` are `stores.chatStore` members destructured at
`S/chats.ts:25` (store implementation `ST/chats.ts:246`).

| # | Path (Next syntax) | Methods and handlers |
|---|---|---|
| 1 | `/api/activity/abort` | POST (22) → `abortJob` S/jobs.ts:446; `abortPluginWorkerActivity` S/plugin-worker-activity.ts:66; `abortTurn` S/turn-runs.ts:85; `abortExtraction` A/subagents/extraction.ts:702 (re-export S/observability.ts:31) |
| 2 | `/api/activity` | GET (12) → `activityFeed` S/observability.ts:76 |
| 3 | `/api/chat` | POST (3) → `handleChatRequest` S/chat-handler.ts:184 |
| 4 | `/api/chats/[id]/artifact-ui` | POST (15) → `getChat`; `setSteerUiInverted` C/contracts/jobs.ts:333; `stores.chatStore.saveMessages` (`stores` S/stores.ts:19) |
| 5 | `/api/chats/[id]/dismiss` | POST (26) → `reconcilePluginQuestionCompatibility` S/plugin-questions.ts:228; `getChat`; `parseDismissInput` C/input-events.ts:106; `assertPluginQuestionInputAllowed` C/input-events.ts:186; `preparePluginQuestionDismissal` S/plugin-questions.ts:189; `isTurnRunning` S/turn-liveness.ts:103; `parkDismissal` S/dismissal-park.ts:49; `abortTurn`; `dismissAppends` C/input-events.ts:160; `stores.chatStore.saveMessages`; `emit` C/events.ts:97 |
| 6 | `/api/chats/[id]/images/[snapshotId]` | GET (4) → `getChat` S/chats.ts:25 |
| 7 | `/api/chats/[id]/markdown` | GET (26) → `getChat`; `sessionMarkdown` C/session-markdown.ts:226 |
| 8 | `/api/chats/[id]` | GET (4) → `reconcilePluginQuestionCompatibility`; `getChat`; `getPluginQuestionTypeResolver` S/plugins.ts:117; `getPluginHost` S/plugins.ts:107; `pluginQuestionAvailabilityOf` S/plugin-questions.ts:203; `pluginProblemAvailabilityOf` S/plugin-problems.ts:80; `sessionCost` S/pricing.ts:45; `isTurnRunning`; `turnFailure` S/turn-runs.ts:55; `compactionInFlight` S/compaction.ts:140; `sessionCoverage` S/chats.ts:185. PUT (55) → `getChat`; `stores.chatStore.renameChat`. DELETE (87) → `deleteChatSession` S/chats.ts:99 |
| 9 | `/api/chats/[id]/settings` | PUT (27) → `getChat`; `parseSettingsBody` S/settings-body.ts:43; `validateChatSettings` S/model-catalog.ts:251; `clampChatLevel` S/model-catalog.ts:345; `effectiveSettings` S/stores.ts:38; `stores.chatStore.saveSettings` |
| 10 | `/api/chats/[id]/side-chats` | GET (18) → `sideChats.list` S/side-chat.ts:67 (instance `sideChats` S/side-chat.ts:280). POST (25) → `parseSideAskInput` C/side-chat.ts:257; `sideChats.ask` S/side-chat.ts:120 |
| 11 | `/api/chats/[id]/side-chats/[threadId]` | PATCH (10) → `parseSideOpenInput` C/side-chat.ts:295; `sideChats.setOpen` S/side-chat.ts:245. GET (25) → `sideChats.watch` S/side-chat.ts:113 |
| 12 | `/api/chats/[id]/side-chats/[threadId]/stop` | POST (7) → `sideChats.stop` S/side-chat.ts:255 |
| 13 | `/api/chats/[id]/steer` | POST (16) → `getChat`; `parseUserSteerInput` C/input-events.ts:143; `prepareAndSteerChat` S/jobs.ts:320 |
| 14 | `/api/chats/[id]/stream` | GET (18) → `getChat`; `runningTurn` S/turn-runs.ts:78; `piTurnResponse` S/pi/ui-stream.ts:371; `settledTurnResponse` S/turn-runs.ts:99 |
| 15 | `/api/chats` | GET (13) → `listChats`; `isTurnRunning`; `compactionInFlight`. POST (22) → `createChat`; `titleFromPrompt` C/contracts/graph.ts:347 (re-export S/chats.ts:26); `readSettingsRecord` = `readSettings` ST/settings.ts:86; `stores.chatStore.saveSettings/saveMessages`; `stores.graphStore.readNodes/readChains`; core `chainsForSelection`, `formatChainLine`, `newGraphContextMessage` |
| 16 | `/api/claude-code` | GET (4) → `claudeCodeInstallationResponse` S/claude-code.ts:14 |
| 17 | `/api/custom-provider` | GET (6) → `customProviderGet` S/custom-provider-http.ts:38. POST (7), PATCH (8), DELETE (9) → `customProviderMutation` S/custom-provider-http.ts:84 |
| 18 | `/api/events` | GET (13) → `eventsResponse` S/events-stream.ts:30 |
| 19 | `/api/external-cli` | GET (5) → `initAuthEnv` S/keys.ts:96; `externalCliStatusResponse` S/external-cli.ts:96 |
| 20 | `/api/graph/costs` | GET (17) → `graphCosts` S/graph.ts:34 |
| 21 | `/api/graph/coverage/extract` | POST (17) → `extractionStatuses` A/subagents/extraction.ts:693 (re-export S/observability.ts:31); `extraction.runExtraction` (`extraction` S/chat-handler.ts:135) |
| 22 | `/api/graph/import` | POST (84) → `readBoundedFormData` lib/bounded-form-data.ts:6; `convertPdf` A/subagents/pdf-ops.ts:244; `joinPages` A/subagents/pdf-markdown.ts:294; `sourceDirectory.registerImport` (S/source-organization.ts:72); `extraction.importNotes`; `NotesImportError` A/subagents/extraction.ts:757; `emit` |
| 23 | `/api/graph/nodes/[id]` | DELETE (20) → `deleteGraphNode` S/graph.ts:106 |
| 24 | `/api/graph/positions` | PUT (16) → `commitPositions` S/commit-positions.ts:34 |
| 25 | `/api/graph/render-settings` | GET (19) → `readRenderSettings` ST/render-settings.ts:20. PUT (23) → `writeRenderSettings` ST/render-settings.ts:36 |
| 26 | `/api/graph` | GET (11) → `graphView` S/graph.ts:22 |
| 27 | `/api/graph/sources` | GET (6) → `sourceDirectory.read`. DELETE (11) → `readOrganizationAction` S/source-organization.ts:76; `deleteSources` S/source-deletion.ts:29; `emit`. POST (22) → `readOrganizationAction`; `sourceDirectory.change` |
| 28 | `/api/graph/status` | GET (14) → `extractionStatuses`; `chatStore.getChat` (ST/chats.ts:246, re-export S/observability.ts:32) |
| 29 | `/api/jobs` | GET (14) → `listJobs` S/jobs.ts:797; `isTurnRunning` |
| 30 | `/api/keys/[id]` | PUT (25) → `isWritableAuthKey` S/keys.ts:71; `saveKey` S/keys.ts:219. DELETE (44) → `isWritableAuthKey`; `deleteKey` S/keys.ts:239 |
| 31 | `/api/keys` | GET (24) → `keyStatuses` S/keys.ts:179; `providerKeyList` S/keys.ts:79 |
| 32 | `/api/models` | GET (9) → `refreshConnectionCatalog` S/model-catalog.ts:28; `modelCatalog` S/model-catalog.ts:222 |
| 33 | `/api/plugins/[id]/assets/[...file]` | GET (5) → `pluginTransport.asset` S/plugin-transport.ts:55 (`pluginTransport` S/plugins.ts:120) |
| 34 | `/api/plugins/[id]/call` | POST (5) → `pluginTransport.call` S/plugin-transport.ts:48 |
| 35 | `/api/plugins/[id]/documents/markdown` | POST (8), OPTIONS (9), GET (10), HEAD (11), PUT (12), PATCH (13), DELETE (14) → `createPluginDocumentRoute(pluginTransport)` S/plugin-transport.ts:65 (module-level call, `route:7`). POST → `transport.convertDocument` S/plugin-transport.ts:54 → `host.convertDocument` S/plugin-host.ts:583 → `convert` S/plugin-documents.ts:20. The other six methods are defined at S/plugin-transport.ts:70,77,78 |
| 36 | `/api/plugins/[id]` | PUT (5) → `pluginTransport.setEnabled` S/plugin-transport.ts:41 |
| 37 | `/api/plugins` | GET (5) → `pluginTransport.list` S/plugin-transport.ts:33. POST (6) → `pluginTransport.refresh` S/plugin-transport.ts:34 |
| 38 | `/api/search` | GET (16) → `searchStatus` S/search.ts:281 |
| 39 | `/api/settings/prompts` | GET (23) → `readSettingsRecord`; `effectivePromptSegments` A/prompt-segments.ts:105 |
| 40 | `/api/settings/prompts/[...segment]` | PUT (45) → `isValidSegmentPath` C/prompt-segments.ts:45; `allSegmentPaths` A/prompt-segments.ts:128; `promptOverrides.writeOverride` (ST/prompt-overrides.ts:44). DELETE (63) → `readSettingsRecord`; `writeSettingsRecord` = `writeSettings` ST/settings.ts:113; `promptOverrides.deleteOverride` |
| 41 | `/api/settings` | GET (21) → `settingsStore.readSettings` (ST/settings.ts:128); `fileAccessConfigurationError` S/file-access.ts:24 |
| 42 | `/api/settings/[section]` | PUT (57) → `SETTINGS_SECTIONS` S/settings-body.ts:488; `sameOriginWriteAllowed` S/same-origin-write.ts:7; `readSettingsRecord`; `validateChatSettings`; `validateModelsSettings` S/model-catalog.ts:276; `themeStore.readTheme` (ST/themes.ts:31); `allSegmentPaths`; `promptOverrides.readOverride`; `clampChatLevel`; `clampModelsLevels` S/model-catalog.ts:324; `effectiveSettings`; `writeSettingsRecord`; `refreshWorkerRequestAdmission` A/worker-request-admission.ts:62; `fileAccessConfigurationError` |
| 43 | `/api/stt/token` | GET (18) → `keyValue` S/keys.ts:187 |
| 44 | `/api/stt/transcribe` | POST (4) → `transcribeResponse` S/speech.ts:74 |
| 45 | `/api/subscriptions/browser` | GET (5), POST (6) → `subscriptionBrowserResponse` S/web-subscription-http.ts:52 |
| 46 | `/api/subscriptions` | GET (5), POST (6) → `subscriptionControlsResponse` S/web-subscription-http.ts:18 |
| 47 | `/api/themes/[id]` | DELETE (13) → `isBuiltinThemeId` C/themes.ts:212; `themeStore.readTheme/deleteTheme`; `readSettingsRecord`; `writeSettingsRecord` |
| 48 | `/api/themes` | GET (17) → `BUILTIN_THEMES` C/themes.ts:144; `themeStore.listThemes`. POST (21) → `parseThemeFile` C/themes.ts:88; `themeIdFromName` C/themes.ts:113; `isBuiltinThemeId`; `isThemeId` C/themes.ts:124; `themeStore.readTheme/writeTheme` |
| 49 | `/api/tts/speak` | POST (4) → `speakResponse` S/speech.ts:113 |
| 50 | `/api/tts/voices` | GET (4) → `voicesResponse` S/speech.ts:134 |

### 1.3 Params, response kind, request body, route config, `next/*`, own logic

"Param read" lists where the file awaits the Promise. "Body" says how the request body is read; `bounded` means the code
checks the `content-length` header and counts streamed bytes itself. `dyn` = `export const dynamic = "force-dynamic"`;
`rt` = `export const runtime = "nodejs"`. The `next/*` column is `none` in all 50 rows (1.1 item 2); it is kept for
the record. "Stream" is the response, not the request.

| # | Params (type, read at) | Response; streaming? | Request body, how | Config (line) | next/* | Own logic |
|---|---|---|---|---|---|---|
| 1 | none | JSON 200/400/404/409. No | `req.json()` in try/catch → 400 (`route:24-28`); id regex `route:33` | none | none | yes: validation, dispatch on `kind`, status mapping (`route:29-58`) |
| 2 | none | JSON. No | none | dyn 10 | none | no (`Response.json(activityFeed())`) |
| 3 | none | JSON `{ok:true}` (S/chat-handler.ts:970), 4xx/5xx JSON, plain-text 400/500 (S/chat-handler.ts:553,590,610). **One path returns a fixed-body `text/event-stream`** (`settledTurnResponse()`, S/chat-handler.ts:556): not streamed, SSE content type. A graded submission keeps the POST open until grading ends, then returns JSON (S/chat-handler.ts:959-968, comment). No stream | `req.json()` in try/catch → 400 (S/chat-handler.ts:191-195) | none | none | no |
| 4 | `{id}`: `route:16` | JSON. No | `req.json().catch(() => null)` (`route:20`) | none | none | yes |
| 5 | `{id}`: `route:27` | JSON 200, 202 `{ok,parked}` (`route:66`), 4xx. No | `req.json().catch(() => null)` (`route:36`) | none | none | yes |
| 6 | `{id, snapshotId}`: `route:5` | JSON, `Cache-Control: private, no-store` (`route:9`). No | none | none | none | yes: regex `route:6`, lookup, header |
| 7 | `{id}`: `route:27` | `text/markdown; charset=utf-8` with `content-disposition: attachment; filename="<slug>.md"` (`route:32-35`). No | none | none | none | yes: `slugify` (`route:17-24`), headers |
| 8 | `{id}`: `route:5,56,88`; DELETE also query `mode` via `new URL(req.url).searchParams` (`route:89`) | JSON. No | PUT: `req.json().catch(() => null)` (`route:58`); GET, DELETE none | none | none | yes |
| 9 | `{id}`: `route:28` | JSON. No | `req.json().catch(() => null)` (`route:31`) | none | none | yes |
| 10 | `{id}`: `route:19,26` | GET JSON. POST: **NDJSON stream** `application/x-ndjson; charset=utf-8`, `Cache-Control: no-cache, no-transform` (S/side-chat.ts:110), or JSON 400/404/409/503. Stream | POST: `request.json().catch(() => null)` (`route:29`) | none | none | yes |
| 11 | `{id, threadId}`: `route:11,26` | PATCH JSON. GET: **NDJSON stream**, same headers (S/side-chat.ts:110), or JSON 404. Stream | PATCH: `request.json().catch(() => null)` (`route:14`) | none | none | yes |
| 12 | `{id, threadId}`: `route:8` | JSON. No | none | none | none | yes (409 mapping, `route:9`) |
| 13 | `{id}`: `route:17` | JSON 200/400/409/412. No | `request.json()` (`route:21`) **not guarded**: a malformed body throws `SyntaxError`, which is not a `ChatInputError`, so the catch rethrows (`route:23-26`) | none | none | yes |
| 14 | `{id}`: `route:19` | **SSE**, `text/event-stream`, `Cache-Control: no-cache, no-transform`, `X-Accel-Buffering: no`. A running turn: full replay then live until `data: [DONE]` (S/pi/ui-stream.ts:371-378, 313-355). No running turn: fixed-body SSE (`turn-settled` + `[DONE]`, S/turn-runs.ts:99-108). JSON 404. Stream | none | none | none | yes: 404 and choice of the two server responses (`route:20-23`) |
| 15 | none | JSON. No | POST: `req.json().catch(() => ({}))` (`route:23`) | none | none | yes |
| 16 | none (reads headers `origin`, `sec-fetch-site`, `x-learnharness-claude-code`, S/claude-code.ts:20-25) | JSON, `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`. No | none | none | none | no |
| 17 | none; GET reads query `authMode` (S/custom-provider-http.ts:39) | JSON; headers `etag`, `cache-control: no-store` (S/custom-provider-http.ts:35). No | POST/PATCH/DELETE: **raw stream**, `readBoundedJson(request, 65536, allowEmpty = DELETE)` (S/custom-provider-http.ts:90, S/custom-provider-body.ts:4-31), bounded. Requires `Content-Type: application/json` (415, `:86`) and `If-Match` equal to the etag (409, `:95`) | dyn 5 | none | no |
| 18 | none | **SSE**, same three headers (S/events-stream.ts:74-79). Held open until the client leaves; `: ping` every 25 s (S/events-stream.ts:64); nothing is written at open (`start`, `:34-66`). Stream | none | dyn 11 | none | no |
| 19 | none; query `id` (S/external-cli.ts:104); reads headers (`:97-101`) | JSON, `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`. No | none | none | none | yes (minimal): calls `initAuthEnv()` first (`route:7`) |
| 20 | none | JSON. No | none | dyn 15 | none | no |
| 21 | none | JSON 202 `{started:true}`; the extraction continues after the response (`route:33-36`). No | `request.json()` in try/catch → 400 (`route:18-23`) | dyn 15 | none | yes |
| 22 | none | JSON `{results}`; 400/413 JSON. No | **raw stream**: `readBoundedFormData(request, 27262976)` (`route:87`; lib/bounded-form-data.ts:6-45), which reads `request.body.getReader()`, then `new Response(bytes, {headers:{"Content-Type": ...}}).formData()` (`:34`). Bounded (`:8`). Total file bytes also capped at 26214400 (`route:95`) | dyn 34 | none | yes (145 lines: parse, validation, 3-wide worker pool, per-file results) |
| 23 | `{id}`: `route:21` | JSON. No | none | none | none | yes (status mapping, `route:22-26`) |
| 24 | none | JSON. No | `request.json()` in try/catch → 400 (`route:18-22`) | dyn 14 | none | yes |
| 25 | none | JSON. No | PUT: `request.json()` in try/catch → 400 (`route:25-29`) | dyn 17 | none | yes (PUT) |
| 26 | none | JSON. No | none | dyn 9 | none | no |
| 27 | none | JSON; 400/500 JSON. No | DELETE, POST: **raw stream**, `readOrganizationAction` (S/source-organization.ts:76-105), 65536 bytes, bounded (`:78`) | dyn 4 | none | yes (error mapping, `finally` emits three events, `route:17-19`) |
| 28 | none | JSON. No | none | dyn 12 | none | yes (projection, `route:15-34`) |
| 29 | none; query `chatId` via `new URL(req.url).searchParams` (`route:15`) | JSON. No | none | dyn 3 | none | yes (query validation `route:16-21`) |
| 30 | `{id}`: `route:26,45` | JSON. No | PUT: `req.json()` in try/catch → 400 (`route:31-35`) | dyn 21 | none | yes |
| 31 | none | JSON. No | none | dyn 22 | none | yes (minimal: one object from two calls, `route:25`) |
| 32 | none | JSON, `Cache-Control: no-store` (`route:11`). No | none | none | none | yes (minimal: two calls and a header) |
| 33 | `{id, file: string[]}`: `route:6` (catch-all → array) | Bytes (`Uint8Array`), `Content-Type` from the file extension, `Cache-Control: no-store`, `X-Content-Type-Options: nosniff` (S/plugin-transport.ts:57). Buffered, not streamed. No | none | rt 3, dyn 4 | none | no |
| 34 | `{id}`: `route:6` (`(await context.params).id`) | JSON, `Cache-Control: no-store` (S/plugin-transport.ts:16). No | `request.json()` via `objectBody` (S/plugin-transport.ts:17-22), failure → 400 | rt 3, dyn 4 | none | no |
| 35 | `{id}`: read in S/plugin-transport.ts:75, not in the route file | POST: JSON. Other methods: 403 JSON, 405 empty, or OPTIONS 204 with `Allow: OPTIONS, POST` (S/plugin-transport.ts:66-78). No | POST: **raw stream**, `readBoundedFormData(request, 27262976)` (S/plugin-documents.ts:27), bounded. Uses `request.signal` (S/plugin-host.ts:590,594). No other method touches the body (tests/plugin-document-proxy.test.ts:136-163) | rt 3, dyn 4 | none | no (route file only builds the handler object; the **gate runs in S/plugin-transport.ts:66-70, 73-78**) |
| 36 | `{id}`: `route:6` | JSON. No | PUT: `objectBody` | rt 3, dyn 4 | none | no |
| 37 | none | JSON. No | POST: `objectBody` | rt 3, dyn 4 | none | no |
| 38 | none | JSON. No | none | dyn 14 | none | no |
| 39 | none | JSON. No | none | dyn 21 | none | yes (composition, `route:24-29`) |
| 40 | `{segment: string[]}`: `route:46,64`; each element decoded with `decodeURIComponent` by the route (`route:41`) | JSON. No | PUT: `request.json().catch(() => null)` (`route:49`) | dyn 36 | none | yes |
| 41 | none | JSON. No | none | dyn 19 | none | yes (minimal: merges `fileAccessError`, `route:22-23`) |
| 42 | `{section}`: `route:58` | JSON. No | `request.json().catch(() => null)` (`route:70`) | dyn 52 | none | yes (158 lines: per-section cross-validation, clamping, orphan healing) |
| 43 | none | JSON 200/502/503. No | none | none | none | yes: outbound `fetch("https://api.deepgram.com/v1/auth/grant")` (`route:28`) and error mapping |
| 44 | none; query `language` (S/speech.ts:68) | JSON `{text}`, `Cache-Control: no-store`. No | **raw stream**, `readBoundedBytes(request, 4194304)` (S/speech.ts:63; S/speech-transport.ts:22-30), bounded; `request.signal` (S/speech.ts:87) | none | none | no |
| 45 | none; query `id` (S/web-subscription-http.ts:56) | 303 with `Location` and an empty body on success, for either method (S/web-subscription-http.ts:60); JSON 403/404/410 otherwise. No | none read (headers only) | rt 3, dyn 4 | none | no |
| 46 | none | JSON with `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff` (S/web-subscription-http.ts:9). No | POST: **raw stream**, 16384 bytes, bounded (S/web-subscription-http.ts:26-37) | rt 3, dyn 4 | none | no |
| 47 | `{id}`: `route:14` | JSON. No | none | dyn 11 | none | yes |
| 48 | none | JSON, POST 201. No | POST: `request.json().catch(() => undefined)` (`route:22`) | dyn 15 | none | yes |
| 49 | none | **Audio**: upstream body relayed through `cappedStream` (limit 33554432), `Content-Type` = upstream `audio/*`, `Cache-Control: no-store`, `X-Content-Type-Options: nosniff` (S/speech.ts:101-110); errors JSON. Stream | **raw stream**, `readBoundedJson(request, 8224)` (S/speech.ts:116; 1200 * 6 + 1024, S/speech.ts:16); `request.signal` (S/speech.ts:121) | none | none | no |
| 50 | none | JSON `{voices}`, `Cache-Control: no-store`. No | none; `request.signal` (S/speech.ts:137) | none | none | no |

### 1.4 Totals

| Measure | Count | Which |
|---|---|---|
| Route files | **50** | `git ls-files 'app/api/**/route.ts'` |
| Exported methods | **73** | GET 31, POST 20, PUT 9, DELETE 8, PATCH 3, HEAD 1, OPTIONS 1 (HEAD and OPTIONS: row 35 only) |
| Routes whose success response is a stream | **5** (5 methods) | rows 10 (POST), 11 (GET), 14, 18, 49. SSE: 14, 18. NDJSON: 10, 11. Audio: 49 |
| Routes with an SSE-typed non-stream response | 1 | row 3 (`settledTurnResponse()` fixed body) |
| Routes that read a raw request stream | 7 | rows 17, 22, 27, 35, 44, 46, 49 |
| Routes that read the body with `json()` (directly, via `objectBody`, or inside the server function) | 20 | rows 1, 3, 4, 5, 8, 9, 10, 11, 13, 15, 21, 24, 25, 30, 34, 36, 37, 40, 42, 48 |
| Routes that read no body | 23 | rows 2, 6, 7, 12, 14, 16, 18, 19, 20, 23, 26, 28, 29, 31, 32, 33, 38, 39, 41, 43, 45, 47, 50 |
| Routes using `formData()` / `text()` / `arrayBuffer()` on the request directly | 0 | form data goes through `readBoundedFormData` (rows 22, 35); the one `arrayBuffer()` is `new Response(cappedStream(request.body, limit)).arrayBuffer()` (S/speech-transport.ts:29) |
| Routes with dynamic segments | 20 | rows 4-14 (11), 23, 30, 33-36 (4), 40, 42, 47. Catch-all: rows 33 (`[...file]`) and 40 (`[...segment]`) |
| Routes reading the query string | 6 | rows 8 (DELETE), 17 (GET), 19, 29, 44, 45 |
| Routes using `request.signal` | 4 | rows 35, 44, 49, 50 |
| Routes with their own logic (column 7 = yes) | **32** | all rows except 2, 3, 16, 17, 18, 20, 26, 33, 34, 35, 36, 37, 38, 44, 45, 46, 49, 50 (18 routes without) |
| Routes exporting `dynamic = "force-dynamic"` | 28 | 22 routes do not: rows 1, 3-16, 19, 23, 32, 43, 44, 49, 50 |
| Routes exporting `runtime = "nodejs"` | 7 | rows 33-37, 45, 46 |
| Routes exporting `maxDuration`, `revalidate`, `fetchCache`, `dynamicParams`, `preferredRegion`, `config` | 0 | `rg '^export const (maxDuration\|revalidate\|fetchCache\|dynamicParams\|preferredRegion\|config)\b' app/api` = 0 |
| Routes importing from `next/*` | **0** | |

## 2. What Next does for these routes that a plain host must reproduce (item 1.2)

### 2.1 `proxy.ts`

**What it gates.** Every request whose path matches the matcher below, for every method including HEAD and OPTIONS. It
calls `apiRequestRefusal(request)` (`proxy.ts:9`; S/desktop-access.ts:59-62). Evidence that all seven methods are gated:
`tests/desktop-api.test.ts:62-65`.

**Two modes, chosen per call from `process.env`** (the `env` parameter defaults to `process.env` at
S/desktop-access.ts:59 and :69, so nothing is cached at start-up):

| Mode | Condition | Pass rule | Refusal text |
|---|---|---|---|
| Browser-only | `LH_DESKTOP_SERVER !== "1"` and `LH_DESKTOP_API_SECRET` empty (S/desktop-access.ts:6-8) | (a) the `Host` header (fallback `new URL(request.url).host`) is `localhost`, `*.localhost`, an IP literal, or listed in `LH_ALLOWED_HOSTS` (comma list, case-insensitive, port ignored) (:43-55, 70); (b) for methods other than GET/HEAD/OPTIONS (:64): `sec-fetch-site` absent or `same-origin`, and `origin` absent or equal to `subscriptionRequestOrigin(request)` (:73-77). A write with neither header passes (:67-68) | (a) `This host name is not allowed. Use localhost or an IP address, or add the name to LH_ALLOWED_HOSTS.` (:71); (b) `Cross-site requests to the LearnHarness API are not allowed.` (:77) |
| Desktop | otherwise | `LH_DESKTOP_API_SECRET` set and length >= 64, header `x-learnharness-desktop` present, equal by `timingSafeEqual` (:13-25). `LH_DESKTOP_SERVER=1` with no secret refuses everything (tests/desktop-api.test.ts:50) | `Desktop API access requires the trusted LearnHarness window.` (:61) |

`subscriptionRequestOrigin` (S/desktop-access.ts:30-38) builds `${url.protocol}//${request.headers.get("host") ?? url.host}`
and rejects anything that is not plain `http:`/`https:` origin form. The gate therefore depends on two request properties the
host must supply: the client's own `Host` header, and a `request.url` whose protocol is `http:`.

**Exact matcher** (`proxy.ts:22`): `["/api", "/api/((?!plugins/[^/]+/documents/markdown/?$).*)"]`. Behaviour pinned by
`tests/plugin-document-proxy.test.ts:26-45`:

| Path | Proxy runs |
|---|---|
| `/api`, `/api/`, `/api?request=1`, `/api/?request=1` | yes |
| `/api/<anything>`, e.g. `/api/chat`, `/api/events`, `/api/graph/import`, `/api/settings/models`, `/api/chats/scratch/markdown`, unknown `/api/*` | yes |
| `/api/plugins`, `/api/plugins/document-one`, `.../call`, `.../documents`, `.../documents/other` | yes |
| `.../documents/markdown/extra`, `.../markdownish`, `.../markdown.json`, `.../markdown.rsc` | yes |
| `/api/plugins/document-one/other/documents/markdown`, `/api/plugins/documents/markdown` | yes |
| `/api/plugins/<id>/documents/markdown`, with optional trailing `/` and/or query, `<id>` including `%2D`, `%64` forms | **no** (the exempt route) |
| `/`, `/chat/new`, `/apix`, `/api-other/plugins/document-one/documents/markdown` | no |

The test helper evaluates the raw pathname and the percent-decoded pathname and runs the proxy if either matches
(`tests/plugin-document-proxy.test.ts:17-24`, comment: "Next's router tests the raw AND decoded pathname with OR
semantics"). That is **repo** evidence; the DOCS read do not state it.

**The exempt route and why.** Only `/api/plugins/[id]/documents/markdown` (row 35). When Proxy applies, Next clones and
buffers the request body up to `proxyClientMaxBodySize` and silently truncates beyond it
(DOCS 03-api-reference/05-config/01-next-config-js/proxyClientMaxBodySize.md:7-9, 73-76). The document upload must enforce its
own actual-byte limit, so the route is excluded from the matcher and runs the same gate itself (`proxy.ts:4-6`;
S/plugin-transport.ts:62-80). `tests/plugin-document-proxy.test.ts:70-97` demonstrates the truncation with Next's real
`getCloneableBody`. The self-gate runs **before** params, body or host composition and for **all seven methods**: refusal 403,
else POST proceeds, OPTIONS → `204` with `Allow: OPTIONS, POST`, any other method → `405` empty (S/plugin-transport.ts:66-78).
Net effect: every `/api` request is gated by the same function and refused the same way; only the code location differs.

**What it returns on refusal.** Status 403, header `Cache-Control: no-store`, body `{"error":"<refusal text>"}`, built by
`NextResponse.json` (`proxy.ts:10-14`). The exempt route's self-gate returns the same status, header and body shape
(`json()` at S/plugin-transport.ts:16, 68); `tests/plugin-document-proxy.test.ts:136-163` asserts equal status, `Cache-Control: no-store` and body for all seven methods against `proxy()`. On pass: `NextResponse.next()` (`proxy.ts:16`), request unchanged.

**Ordering.** Proxy runs after `next.config` `headers` and `redirects` and before filesystem routes
(DOCS 03-api-reference/03-file-conventions/proxy.md:236-247). Because the matcher covers all of `/api/*`, an unknown `/api`
path or an unsupported method is refused 403 before any 404 or 405 can occur. Proxy runs on the Node.js runtime
(proxy.md:255).

**Caller side.** The desktop header is injected by Electron only for requests whose origin is the server's, pathname is
`/api` or `/api/...`, from the trusted main frame (electron/desktop-api.cjs:8-24; installed at electron/main.cjs:695-700; secret
`randomBytes(32).toString("hex")` = 64 characters, `electron/main.cjs:695`). `EventSource("/api/events")`
(components/server-events.tsx:39) cannot set headers and relies on this injection.

### 2.2 `next.config.ts`

The file sets exactly six keys. None adds a header, rewrite or redirect.

| Key (line) | Value | Effect on API requests or responses |
|---|---|---|
| `env` (`:9`) | `{ LH_VERSION: pkg.version, LH_HOMEPAGE: pkg.homepage }` | Build-time inlining of `process.env.LH_VERSION`/`LH_HOMEPAGE`. Read only by `components/settings/update-settings.tsx:15-16` and `components/settings/plugins-section.tsx:30`; no `src/`, `lib/` or `app/api` file reads them (`rg`). None on the API |
| `experimental.proxyClientMaxBodySize` (`:13`) | `MAX_IMPORT_BODY_BYTES` = `26 * 1024 * 1024` = **27,262,976** bytes (lib/notes-import-limits.ts:3) | Applies only to requests that run through Proxy (docs proxyClientMaxBodySize.md:115: "This setting only applies when proxy is used"). **docs**: the body is cloned and buffered; beyond the limit only the first N bytes are available, a warning is logged, the request does not fail and the client gets no error (proxyClientMaxBodySize.md:73-76). Default is 10 MB (:9). So on every route except row 35 a body larger than 27,262,976 bytes reaches the handler cut off. Routes that bound themselves: 22 (27,262,976 -> 413), 35 (same constant, own gate, never truncated), 44 (4 MiB), 46 (16 KiB), 17 and 27 (64 KiB), 49 (8,224). The 20 routes that read `json()` (1.4) have no byte bound of their own |
| `output` (`:19`) | `"standalone"` | Build artifact `.next/standalone/server.js`, which reads `PORT` and `HOSTNAME` (DOCS 03-api-reference/05-config/01-next-config-js/output.md:49,67). No request effect |
| `outputFileTracingExcludes` (`:52`), `outputFileTracingIncludes` (`:73`) | glob lists | Packaging only: which files land in the standalone bundle |
| `serverExternalPackages` (`:117-124`) | `@earendil-works/pi-ai`, `@earendil-works/pi-agent-core`, `pdfjs-dist`, `@napi-rs/canvas`, `@silvia-odwyer/photon-node`, `@resvg/resvg-js` | docs: dependencies used by Route Handlers are bundled by default (serverExternalPackages.md:6); packages listed here are loaded through native Node `require` instead (:8). No request effect. A host that runs the source unbundled loads all packages natively |

Not set, so the Next defaults apply (all **docs**): `compress` (gzip by default with `next start` or a custom server, compress.md:8),
`poweredByHeader` (adds `x-powered-by`, poweredByHeader.md:8), `trailingSlash` and `skipTrailingSlashRedirect` (a URL with a
trailing slash redirects to the form without, trailingSlash.md:8), `generateEtags` (etags for pages, generateEtags.md:8),
`cacheComponents` (so the `dynamic` segment option exists and GET handlers are not cached by default,
DOCS 01-getting-started/15-route-handlers.md:51). `headers`, `rewrites`, `redirects`, `basePath`, `assetPrefix` are absent.

### 2.3 `instrumentation.ts` and import-time work

- `register()` (`instrumentation.ts:3`). **docs**: "called once when a new Next.js server instance is initiated, and must
  complete before the server is ready to handle requests" (DOCS 03-api-reference/03-file-conventions/instrumentation.md:18).
- Body: only when `process.env.NEXT_RUNTIME === "nodejs"` (`:4`). `NEXT_RUNTIME` is set by Next; nothing in `src/`, `lib/`,
  `electron/` or `scripts/build-server.mjs` sets or reads it (`rg 'NEXT_[A-Z_]+'`: the only hit outside `NEXT_PROBLEM_TEXT` is
  `instrumentation.ts:4`). In a process Next did not start the guard is false and the body is skipped.
- Then `import("./src/server/plugins.ts")` (`:5`) and `await initializePlugins()` (`:6`) inside try/catch. A failure logs
  `[plugins] Initialization failed; plugin management will report the error:` plus the error (`:7`); **the server still starts**.
- `initializePlugins()` (S/plugins.ts:106) awaits `runtime().ready`. `runtime()` (S/plugins.ts:40-103) builds the host on
  `globalThis.__lhPlugins` (`:36,42,102`); `ready` runs `setPluginJobRecovery` (`:90`), a `recoverPluginTaskRecords` sweep
  (`:97`), then `host.initialize()` (`:100`). Importing `S/plugins.ts` alone does not load plugin code (`:38-39`). `getPluginHost()`
  (`:107`) also awaits `ready`, so a plugin route called before `register()` finishes would trigger the same initialisation; a
  rejected `ready` is cached and every later caller sees the same rejection, which `pluginTransport` turns into a JSON 500
  (S/plugin-transport.ts:24-30).
- **Work done as a side effect of importing server modules.** `S/index.ts` re-exports `chat-handler.ts` (`:7`), `stores.ts` (`:19`) and `keys.ts` (`:43`); `S/plugins.ts`
  imports `stores.ts` directly (`:22`), so `register()` already triggers the `stores.ts` rows. Which of the other rows run
  before the first request in Next, and in what order, is not established (see "Not verified" 10):

  | Where | Effect |
  |---|---|
  | S/keys.ts:252 | `initAuthEnv()`: reflects `auth.json` keys into `process.env` and snapshots which managed names were real env (S/keys.ts:96-129) |
  | S/stores.ts:43 | `configureWorkerRequestAdmission(...)` |
  | S/stores.ts:47 | `syncCustomProvider()` |
  | S/chat-handler.ts:155, 177, 181 | `setTurnRunner`, `setJobRespawn`, `setFileAccessPolicy` |

  Crash recovery of orphaned jobs runs only from `GET /api/jobs` (`listJobs` calls `recoverStaleJobs()` unless
  `NODE_ENV === "test"`: S/jobs.ts:757-758, 797-798). Other `NODE_ENV === "test"` branches: S/compaction.ts:307,
  S/turn-service.ts:115, S/chat-handler.ts:925.
- **globalThis singletons.** Run registries live on `globalThis` (S/turn-liveness.ts:8-14, S/turn-runs.ts:7-11, S/side-chat.ts:280,
  A/subagents/extraction.ts:679-688, S/plugins.ts:42). The repo comments give the reason as "Next dev compiles each route as its
  own entry" (S/turn-liveness.ts:8); that is **repo** evidence about `next dev`, not a statement about production. In a single
  module graph these guards are harmless.

### 2.4 Dynamic params

- **Sync or Promise.** Promise, in this version: `params` is "a promise that resolves to an object containing the dynamic route
  parameters" (DOCS 03-api-reference/03-file-conventions/route.md:82-91, 99-103); `Version History` row `v15.0.0-RC`
  (route.md:668) confirms the change. All 19 files that read params `await` it (lines in 1.3).
- **Shape.** `[name]` → `string`; `[...name]` → `string[]` with at least one element
  (DOCS 03-api-reference/03-file-conventions/dynamic-routes.md:88-97, Catch-all table: `/shop/a` → `['a']`, `/shop/a/b` → `['a','b']`).
  Two catch-alls exist: `[...file]` (row 33) and `[...segment]` (row 40).
- **Decoding.** The DOCS read do not say whether Next percent-decodes. **Repo** evidence only: row 40 decodes each element itself
  (`app/api/settings/prompts/[...segment]/route.ts:41`); the plugin asset consumer rejects any segment containing characters outside
  `^[a-zA-Z0-9][a-zA-Z0-9._-]*$` (S/plugin-host.ts:106, 130, 605; `asset` is at :601); the chat and job stores reject ids outside
  `^[A-Za-z0-9_-]+$` (ST/chats.ts:24 throws and `getChat` catches it and returns `null`, ST/chats.ts:63-69; ST/jobs.ts:25 throws); the client encodes ids with
  `encodeURIComponent` in most callers (components/plugin-manager.ts:86, components/session-core.ts:454, components/artifacts/use-image-snapshot.ts:14)
  and not in others (components/use-side-thread.ts:149, components/model-picker.tsx:63). The test
  `tests/plugin-document-integration.test.ts:42` passes `decodeURIComponent(match[1])` as `id`, i.e. the test author models
  Next as handing over decoded `[id]` values.
- **Resolution order (repo).** `app/api/settings/[section]/route.ts:28-30` says "Next resolves static routes first, so
  'prompts' never lands here". The only static/dynamic sibling pair in `app/api` is `settings/prompts` vs `settings/[section]`;
  `settings/prompts/[...segment]` needs one or more segments after `prompts`. The DOCS read do not state this rule.

### 2.5 Method handling

- **A method the route does not export:** `405 Method Not Allowed` (**docs**: DOCS 01-getting-started/15-route-handlers.md:43).
  Body and headers of that 405 are not documented there. Example: `PUT /api/settings/prompts` (row 39 exports GET only).
- **OPTIONS:** if not exported, Next implements it and sets `Allow` from the exported methods (**docs**: route.md:39, 56). The
  status code is not in the DOCS read; the repo's replica for row 35 uses `204` with `Allow: OPTIONS, POST`
  (S/plugin-transport.ts:77, comment at :64 "framework-style OPTIONS responses"). Only row 35 exports OPTIONS.
- **HEAD:** the docs list HEAD as a supported exported method (route.md:24, 29). They do not say what Next does for HEAD on a route
  that exports only GET. Only row 35 exports HEAD (as `unsupported`, 405 after the gate).
- **Gate first.** Proxy runs before routing (2.1), so a refused request gets 403 for any method, including ones the route would
  answer 405 or auto-OPTIONS.
- Two handlers dispatch on method themselves and return their own 405: `customProviderMutation` for non-POST/PATCH/DELETE
  (S/custom-provider-http.ts:108, "Unsupported method" 405) and `subscriptionControlsResponse` for non-GET/POST
  (S/web-subscription-http.ts:23, 405). Both are reachable only through methods their route exports (rows 17, 46), so the 405 from
  those lines is not reachable through the route table today.

### 2.6 Response defaults Next adds that a client could observe

**Documented in the DOCS read:**

| Default | Source | Observable as |
|---|---|---|
| gzip compression when the request allows it, "rendered content and static files", with `next start` or a custom server | DOCS 03-api-reference/05-config/01-next-config-js/compress.md:8 | `Content-Encoding: gzip` |
| `x-powered-by` header | poweredByHeader.md:8 | `x-powered-by` (value not stated) |
| Route Handlers are not cached by default; GET opts in only with `dynamic = 'force-static'` etc. | 01-getting-started/15-route-handlers.md:51 | No static caching of any of the 50 routes: none exports `force-static`, and `cacheComponents` is unset |
| dynamically rendered **pages** get `Cache-Control: private, no-cache, no-store, max-age=0, must-revalidate` | 02-guides/self-hosting.md:99 | pages only; whether route handlers get the same is not stated |
| generated ETags "for every page" | generateEtags.md:8 | pages; route handlers not stated |

**Repo evidence about compression:** `scripts/smoke-compression-runtime.mjs` drives Next's own compression middleware and
pipe helpers (`next/dist/compiled/compression`, `next/dist/server/pipe-readable`, `:75-77, 106`) with a fake handler. Asserted:
gzip output when the request sends `Accept-Encoding: gzip` (`:113, 154`); no compression when the response has
`Cache-Control: no-cache, no-transform` (`:92, 160-162`) or the request asks for identity; and teardown of the source stream
when the client aborts (`:85-88, 146-149`). All SSE and NDJSON responses in this repo set `no-cache, no-transform`
(S/events-stream.ts:77, S/pi/ui-stream.ts:375, S/turn-runs.ts:105, S/side-chat.ts:110). JSON, markdown, audio and plugin-asset
responses do not (row 49 sets only `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`). Whether the Electron
renderer's requests carry `Accept-Encoding: gzip` was not read, so whether a current client sees `Content-Encoding: gzip` on
those responses is "Not verified" 6. `desktop:dist` runs this smoke (`package.json:27` via `scripts/smoke-server.mjs:102`).

**Handler-set response headers** (quoted-key occurrences from `rg` over `src/server` and `app/api`): `Cache-Control` 13,
`Content-Type` 13, `X-Content-Type-Options` 5, `X-Accel-Buffering` 3, `content-disposition` 1, `Referrer-Policy` 1; unquoted
keys seen by reading: `Allow` (S/plugin-transport.ts:77), `Location` (S/web-subscription-http.ts:60), `etag`
(S/custom-provider-http.ts:35). No handler sets `Set-Cookie` or `Access-Control-*`.

### 2.7 Request details handlers rely on

| Detail | What the code does | Evidence |
|---|---|---|
| `request.url` | Parsed with `new URL(request.url)` for the query string in rows 8, 17, 19, 29, 44, 45; protocol taken from it for the origin check | route:89 (row 8), app/api/jobs/route.ts:15, S/external-cli.ts:104, S/custom-provider-http.ts:39, S/speech.ts:68, S/web-subscription-http.ts:56, S/desktop-access.ts:32-34 |
| Host | The gate and four same-origin checks read the **`Host` header first** and fall back to `url.host`. The repo says why: "Next's standalone Request URL can use its internal hostname. Match the actual addressed Host" (S/custom-provider-http.ts:56-57). A host that sets `request.url` to its bound hostname but forwards the client's `Host` header is what the code expects | S/desktop-access.ts:33, 70; S/claude-code.ts:20; S/external-cli.ts:99-101; S/web-subscription-http.ts:13-16; S/same-origin-write.ts:9-11 |
| Tests build requests with a `host` header | `tests/web-subscriptions.test.ts:35`, `tests/custom-provider-boundaries.test.ts:139`; tests without one rely on the `url.host` fallback (tests/browser-api-access.test.ts:62-63) | (not run) |
| `request.signal` | Read by rows 44, 49, 50 (S/speech.ts:87, 121, 137: `AbortSignal.any([client, timeout])`) and row 35 (S/plugin-host.ts:590, 594: aborted → 409 "Document conversion was cancelled"). The DOCS read say nothing about when Next aborts it | cited lines |
| Request body stream | Rows 17, 22, 27, 35, 44, 46, 49 call `request.body.getReader()`, `request.body.cancel()` or `pipeThrough` and compare the `content-length` header with their own limit (S/speech-transport.ts:11-29, S/custom-provider-body.ts:5-9, lib/bounded-form-data.ts:8-12, S/source-organization.ts:78-82, S/web-subscription-http.ts:26-27). For rows 17 (except DELETE), 22, 27 and 35 a `null` body is an error ("Missing ...": S/custom-provider-body.ts:11-12, lib/bounded-form-data.ts:13, S/source-organization.ts:83) | cited lines |
| Empty-body shape | The repo says "Next can represent an empty DELETE as a zero-byte stream rather than null" (S/custom-provider-http.ts:88-89), and bounds both. `readOrganizationAction` differs by shape: a null body gives "Missing source organization action." (S/source-organization.ts:83), a zero-byte stream gives "Could not read source organization action." (`JSON.parse("")` at `:97`, caught at `:100`); both are `SourceOrganizationInputError` → 400 (app/api/graph/sources/route.ts:15) | cited lines |
| Response `body` stream cancel | Four server streams define `cancel()` to release resources when the reader goes away: events (unsubscribes the bus listener, `teardown` clears the 25 s timer: S/events-stream.ts:68-72, 36-47), turn stream (removes the subscriber, S/pi/ui-stream.ts:350-355; a view leaving never stops the turn), side-chat NDJSON (`detach`, S/side-chat.ts:108), and the turn-preparation relay (S/turn-preparation.ts:73-80). If `cancel()` never runs, the bus listener and the interval stay alive. The first three push with `controller.enqueue` from event callbacks rather than from `pull` (S/events-stream.ts:51, S/pi/ui-stream.ts:321, 331, S/side-chat.ts:84) | cited lines |
| Headers before the first byte | Row 18 writes nothing until an event or the 25 s ping (S/events-stream.ts:34-66). Row 14 against a turn still in preparation writes nothing until handoff (S/turn-preparation.ts:51-58). `EventSource` opens only after response headers arrive (components/server-events.tsx:39) | cited lines |
| Response bodies and statuses | `Response` with a string, `Uint8Array`, `ReadableStream` or `null` body (`null`: rows 35 and 45). Status codes written as literals (`status: NNN` and `error(..., NNN)` in `src/server`, `app/api`): 200, 201, 202, 204, 303, 400, 403, 404, 405, 409, 410, 412, 413, 415, 500, 502, 503; others can come from variables (for example `outcome.status`, `route:24` of row 23) | `rg` over `src/server app/api` |
| Header casing | Request: every read is `headers.get("<lowercase>")` or `has(...)`, case-insensitive. Response: handlers write mixed case (`Cache-Control`, `X-Accel-Buffering`) and lowercase (`etag`, `content-disposition`) names; the wire casing Next produces is not established | cited lines |
| Long-lived requests | Row 3 can stay open through grading (S/chat-handler.ts:959-968); row 14 until the turn settles; row 18 until the client leaves; row 49 up to 10 minutes upstream (S/speech.ts:11 `SPEAK_TIMEOUT_MS`); row 44 3 minutes (`:12`) | cited lines |

### 2.8 `next/*` imports in `src/server`

None. `rg 'next/|from "next"|NextRequest|NextResponse|nextUrl' src lib config.ts app/api electron` returns no match. `next/*` imports exist only in `proxy.ts:1`, `next.config.ts:2`,
`app/layout.tsx:1-3`, `app/chat/[id]/page.tsx:1`, `app/settings/page.tsx:1`, eight files under `components/` (`rg -l 'from "next' components`), and in tests/scripts
(`scripts/smoke-compression-runtime.mjs:74-77`, `scripts/smoke-*.mjs`, `tests/*`).

### 2.9 What the bundler provides that a plain host must supply

Observed in the source, not run:

- Path alias `@/` for all 50 route files (1.1 item 1) and `.ts` suffixes in import specifiers (`allowImportingTsExtensions`,
  `tsconfig.json`).
- JSON imports **without** import attributes: `S/plugins.ts:4` (`package.json`) and `:11` (`core-plugins.json`); one **with**
  `with { type: "json" }` at `A/models.ts:17`.
- `/* turbopackIgnore: true */` comments (83 lines in `src`, `lib`, `config.ts`): comments, inert outside Turbopack.
- Files read from disk at runtime: `config.ts:6` computes `ROOT` from its own location; `PATHS.teacherPrompt` is
  `ROOT/src/agent/system-prompt.md` (`config.ts:27`); the core plugins directory is `PATHS.root/core-plugins` (S/plugins.ts:27-29,
  "Explicitly staged by build-server, not discovered by Next's filesystem tracer"); the side-chat prompt directory
  `src/agent/prompts/side-chat/*.md` is listed for tracing because it is read from disk per ask (next.config.ts:88-90).

### 2.10 Uncaught errors

Seven `throw err` sites sit in route files that rely on the framework's response for an unhandled exception: row 5
(`dismiss/route.ts:40, 55, 73`), row 13 (`steer/route.ts:25, 34`), row 10 (`side-chats/route.ts:32`), row 11
(`[threadId]/route.ts:17`); `S/chat-handler.ts` has the same pattern at lines 204, 241, 267, 275, 362, 475, 535, 995. Row 13
turns every malformed JSON body into such a throw (1.3 row 13). The DOCS pages read for error handling
(DOCS 01-getting-started/10-error-handling.md:201-207) cover error boundaries for rendering, not route handlers. What Next
returns is under "Not verified".

### 2.11 How the Electron shell starts the server, and what `next start` adds

**Packaged app (`electron/main.cjs`):**

| Item | Value | Line |
|---|---|---|
| Entry | `<resourcesPath>/server/standalone/server.js` (Next standalone `server.js`) | :73-77 |
| Binary | `process.execPath` (Electron's Node, "bundled Node 24") with `ELECTRON_RUN_AS_NODE=1` | :13-14, 216-217, 227 |
| macOS extra | `--require <resourcesPath>/server-title-guard.cjs` before the entry (a Next-specific workaround, per the comment at :218-219) | :218-222 |
| `cwd` | `path.dirname(serverEntry())` | :224 |
| `stdio` | `["ignore", "pipe", "pipe", "ipc"]`: an inherited IPC channel | :239 |
| `env` | `...process.env`, then `ELECTRON_RUN_AS_NODE: "1"`, `NODE_ENV: "production"`, `PORT` (free loopback port), `HOSTNAME: "127.0.0.1"`, `LH_DATA_DIR`, `LH_AUTH_FILE`, `LH_DESKTOP_SERVER: "1"`, `LH_DESKTOP_API_SECRET` (64 hex chars) | :225-238 |
| Port | kernel-assigned: `listen(0, "127.0.0.1")` then close | :174-184, 693 |
| Readiness | `waitUntilUp(url)`: `http.get` on `http://127.0.0.1:<port>` (root), up to 150 tries x 200 ms; **any status counts as up** | :263-277, 693, 722 |
| Stop | `SIGTERM`, then `SIGKILL` after 3000 ms | :279-292 |
| `HOSTNAME` reason | "the server defaults to 0.0.0.0 — never" | :230 |
| Dev | `desktop:dev` runs `next dev -H localhost` and `LH_DEV_URL=http://localhost:3000 electron .`; no spawn, no secret, so the server runs in browser-only mode | package.json:16, 25; electron/main.cjs:692-693, 725-745 |

**What the IPC channel is for:** `src/agent/chatgpt-bridge.ts:22` and `src/agent/subscription-bridge.ts:20` activate only when
`LH_DESKTOP_SERVER === "1"`, `LH_DESKTOP_API_SECRET` has >= 64 characters, `typeof process.send === "function"` and
`process.connected === true`; they then use `process.send` and `process.on("message")` (chatgpt-bridge.ts:49, 77;
subscription-bridge.ts:54, 85). The server process must therefore be the direct child the shell spawned with that `ipc` channel.
`electron-builder.yml:5-7` also says the standalone `server.js` `process.chdir()`s into its own directory (repo statement).

**Environment the server code reads** (`rg 'process\.env' src lib config.ts`): `LH_DATA_DIR` (config.ts:20), `LH_AUTH_FILE`
(config.ts:157), `LH_ALLOWED_HOSTS` (S/desktop-access.ts:53), `LH_DESKTOP_SERVER`, `LH_DESKTOP_API_SECRET`, `LH_IGNORE_ENV_KEYS`
(S/keys.ts:87), `LH_UPDATE_FLUSH_MS` (S/chat-handler.ts:827), `LH_PROVIDER_EVENTS` (A/provider-events.ts:93),
`LH_BACKGROUND_CAPTURE` (A/background-capture.ts:44), `NODE_ENV` (2.3), `CHROME_PATH`, `LOCALAPPDATA`, `PROGRAMFILES`
(A/subagents/headless.ts:85-99), `NEXT_RUNTIME` (instrumentation.ts:4), and every managed provider key name (S/keys.ts:96-129).
`PORT` and `HOSTNAME` are read by Next's `server.js`, not by repo code (DOCS output.md:67). `SPEC.md:32-33` lists seven names;
the list above is longer.

**`npm run start` = `next start -H localhost`** (`package.json:18`):

| Setting | Effect | Source |
|---|---|---|
| `-H localhost` | binds hostname `localhost`; the `next start` default is `0.0.0.0` | DOCS 03-api-reference/06-cli/next.md:123 |
| port | default 3000, or env `PORT` | same table |
| `--keepAliveTimeout` | optional, not passed | same table, next.md:124 |
| `LH_DESKTOP_*` | none set, so browser-only mode (2.1) | S/desktop-access.ts:6-8 |
| `NODE_ENV` | not set by this script; the repo does not state `next start`'s default | not verified |
| Conventions `next start` applies | `proxy.ts` (runs before routes) and `instrumentation.ts` `register()` (once, before ready); `next.config.ts` is the config file | proxy.md:13-15; instrumentation.md:18 |

The standalone `server.js` the shell uses instead of `next start` takes `PORT`/`HOSTNAME` from the environment (output.md:67) and
serves `public/` and `.next/static` only if they were copied into it (output.md:49), which `scripts/build-server.mjs` does
(next.config.ts:17-18, comment).

## Not verified

Everything below was not established by reading; none was run.

1. What Next does for `HEAD` on a route that exports only `GET`.
2. The headers and body of Next's 405 (is `Allow` present), the status code of its automatic OPTIONS answer, and whether a
   request to a static route that lacks the method falls through to a dynamic sibling (`PUT /api/settings/prompts` → 405 or `[section]`).
3. Whether Next percent-decodes `[id]` and catch-all params, and how it treats `%2F` inside a segment.
4. The host and protocol of `request.url` that handlers see under `next start` and under standalone `server.js` (only the
   comment at S/custom-provider-http.ts:56-57 describes it); whether a `Request` built in Node keeps a client-supplied `Host`
   header in the Node version the host will use (tests construct it that way, tests/web-subscriptions.test.ts:35, not run).
5. Whether Next aborts `request.signal` on client disconnect, and whether it cancels a streamed `Response.body` on disconnect for
   route handlers. Repo evidence covers only Next's internal pipe helper (`scripts/smoke-compression-runtime.mjs:85-88, 146-149`).
6. Whether Next applies gzip to route-handler responses of these content types, the size threshold, `Vary`, and whether the
   standalone `server.js` compresses as `next start` does. `x-powered-by`'s value. Whether route handlers get ETag,
   `Cache-Control`, `Content-Length` versus chunked `Transfer-Encoding`, `Date`, `Connection` or `Keep-Alive` defaults.
7. Trailing-slash redirect: whether it applies to `/api` paths, its status code, whether the query string is kept, and its order
   relative to Proxy.
8. What Next returns when a route handler throws (status, body, logging), what it returns for an unknown `/api/*` path
   when the gate passes, and the exact 404 body.
9. Whether Next passes `null` or a zero-byte stream as `request.body` for bodiless POST, PUT, PATCH, GET and HEAD (only DELETE is
   stated, by the repo); whether `content-length` survives Proxy's body clone; the truncation point is stated by docs as a
   byte limit, but the log message and whether the clone delays the handler until the buffer fills are not.
10. Whether route bundles in `next start` share module instances (the repo's `globalThis` comments describe `next dev` only), and
    the order in which route modules and their import-time effects run in production.
11. Whether Next's patched global `fetch` or its data cache affects server-side `fetch` calls with no `cache` option
    (S/custom-provider.ts:136, A/tools/web.ts:57, S/search.ts), e.g. caching GETs.
12. Node HTTP server timeouts and keep-alive values Next sets for `next start` and standalone, and whether standalone
    `server.js` handles `SIGTERM` gracefully (the shell sends SIGKILL after 3 s, electron/main.cjs:279-292).
13. Whether the raw/decoded OR semantics for the matcher (tests/plugin-document-proxy.test.ts:17) is how Next evaluates it;
    the DOCS read say only that matcher values must be constants and anchor at the start (proxy.md:124-136).
14. Whether `src/**` TypeScript, with `.ts` specifiers, JSON imports without attributes (S/plugins.ts:4, 11) and the `@/` alias,
    runs unbundled under the Node and loader the host will use. Not assessed: this report did not run tsx or Node.
15. Item 1.3 territory, not read: `app/**/page.tsx`, `app/layout.tsx`, `public/`, `.next/static`, the plugin-authoring
    download, and what `scripts/build-server.mjs` copies. `README.md`, `docs/` and `electron-builder.yml` were read only where cited.
16. No test in the repository was run. Statements of the form "the test asserts X" mean the test source says so.
