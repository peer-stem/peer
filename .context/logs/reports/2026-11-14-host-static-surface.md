# Host static surface: every non-API path the server answers today

Sprint 1.1, item 1.3. Research only; nothing was run. Date 2026-11-14.
Worktree `/usr/lib/persist/peer/work/1.1-host-definition`, HEAD `ecaf3be` (on `master` `5d5b6e2`).

## Evidence bases and citation form

| Prefix | Meaning |
|---|---|
| `path:line` | File in this worktree |
| `pr1:` | `/usr/lib/persist/peer/work/pr1/`, a built checkout at `3fa3928` (Next 16.4.3, Turbopack build, `build-server.mjs` already run). This worktree has no `node_modules` and no `.next`, so all build-output facts come from there |
| `docs:` | `/usr/lib/persist/peer/work/pr1/node_modules/next/dist/docs/01-app/` (Next 16.4.3; the worktree's `package-lock.json:14218-14219` pins the same version) |

Source files that feed the static surface were diffed between `pr1` and the worktree and are byte-identical: `app/`, `components/`, `public/` (except the generated `public/plugin-authoring/`), `next.config.ts`, `proxy.ts`, `scripts/build-server.mjs`, `electron-builder.yml`, `electron/main.cjs`. Chunk hashes, the build id and file counts under `pr1:.next` differ per build.

## Counts

| Item | Count | Evidence |
|---|---|---|
| `app/**/page.tsx` | 5 | `app/page.tsx`, `app/chat/[id]/page.tsx`, `app/chat/new/page.tsx`, `app/plugins/[pluginId]/[viewId]/page.tsx`, `app/settings/page.tsx` |
| Layouts | 1 (`app/layout.tsx`) | `git ls-files ':(glob)app/**/layout.tsx'` |
| Other tracked files under `app/` outside `api/` | 1 (`app/globals.css`, 24,404 bytes) | `git ls-files app` lists 57 files: 50 `route.ts` (all under `app/api/`), 5 pages, layout, `globals.css` |
| Route handlers outside `app/api/` | 0 | `git ls-files 'app/**/route.ts' \| wc -l` = 50 = `git ls-files ':(glob)app/api/**/route.ts' \| wc -l` |
| Tracked files in `public/` | 5, 233,493 bytes | section 2 |
| Generated files in `public/` | 1 (`plugin-authoring/learnharness-plugins.zip`, 2,908,090 bytes in `pr1`) | section 2 |
| Plugin asset routes | 1 route handler (`GET /api/plugins/:id/assets/*file`), plus 2 static files that plugins depend on (`/plugin-loader.js`, the authoring zip) | section 3 |

Deviation from the quality gate: `git ls-files 'app/**/page.tsx' | wc -l` prints **4**, not 5. In git's default (non-glob) pathspec mode the pattern needs a directory between `app/` and `/page.tsx`, so it skips `app/page.tsx`. With `:(glob)` it prints 5. The page count in this report is 5 pages plus the layout (6 files). 4 plus the layout would miss `/`.

## 1. Pages

| File | URL | Dynamic input | Server work in the file | `next/*` imports in the file | Renders |
|---|---|---|---|---|---|
| `app/layout.tsx:24-57` | wraps every page | none | `await connection()` (:29); `readThemeBoot()` (:30) reads the settings record and a custom theme file (`src/server/theme-boot.ts:23-29`); writes `lang="en"`, `className` (theme mode + two font variables) and inline `style` (theme colour variables) onto `<html>` (:32-37); `metadata` title "Learning Harness" and a description (:19-22); imports `katex/dist/katex.min.css` and `./globals.css` (:4-5) | `next` (type `Metadata`, :1), `next/font/google` (`JetBrains_Mono`, `Source_Sans_3`, :2, :16-17), `next/server` (`connection`, :3) | Client providers: `ServerEventsProvider`, `PluginsProvider`, `AppearanceProvider`, `SidebarProvider`, `ActivityProvider`, `AppShell`, `UpdateBanner` (:41-53); all `"use client"` (line 1 of each file) |
| `app/page.tsx:10-22` | `/` | none | `export const dynamic = "force-dynamic"` (:8); `readSettingsRecord()` (:14); `resolveSettings(record ?? null).graph.rendering` (:18); `slotsConfigured(record?.models)` (:20) passed as `initialConfigured` and `rendering` | none | `Home` (`components/home.tsx`, client) |
| `app/chat/[id]/page.tsx:8-41` | `/chat/:id` | path `id` (:12, :15); query `prompt` (:13, :15, :34) | `force-dynamic` (:6); `getChat(id)` (:16); **`notFound()` when the chat does not exist** (:17); `readSettingsRecord()` (:21); passes the full `chat.messages` (:31), `turnFailure` (:32), `isTurnRunning` (:36), `compactionInFlight` (:37) | `next/navigation` (`notFound`, :1) | `Chat` (`components/chat.tsx`, client) with the transcript embedded in the response |
| `app/chat/new/page.tsx:18-30` | `/chat/new` | query `mode` (:21, :23); `"practice"` else teach (:27) | `force-dynamic` (:5); `readSettingsRecord()` (:26). The static segment wins over `[id]` (:11-12 comment) | none | `NewSession` (`components/new-session.tsx`, client) |
| `app/plugins/[pluginId]/[viewId]/page.tsx:3-6` | `/plugins/:pluginId/:viewId` | path `pluginId`, `viewId` (:3-4) | none. No `dynamic` export | none | `PluginViewScreen` (`components/plugin-view.tsx`, client shell) |
| `app/settings/page.tsx:9-11` | `/settings` | none | **`redirect("/chat/new")`** (:10). The comment (:3-7) says the page stays routed so no URL lands on a dead page | `next/navigation` (`redirect`, :1) | nothing |

Other facts for this section:

| Fact | Evidence |
|---|---|
| No `loading`, `error`, `not-found`, `template`, `default`, `global-error` file and no `icon`, `favicon`, `manifest`, `robots`, `sitemap`, `opengraph-image` file under `app/` | `git ls-files app` (57 files, listed above) |
| The build still emits `/_not-found` and `/_global-error`; `/_global-error` is the only prerendered route, as `server/app/_global-error.html` (9,075 bytes) with `server/pages/500.html` (9,075 bytes) | `pr1:.next/app-path-routes-manifest.json`, `pr1:.next/prerender-manifest.json` (routes: `/_global-error` only), `pr1:.next/server/pages-manifest.json` (`/500`) |
| All five pages are rendered per request in this build. `staticRoutes` in `routes-manifest.json` lists `/`, `/chat/new`, `/settings` only as parameterless path patterns, not as prerendered output | `pr1:.next/routes-manifest.json`, `pr1:.next/prerender-manifest.json`; the layout comment at `app/layout.tsx:25-28` states why (`connection()` stops a prerendered route baking the build machine's record) |
| `next/*` imports in the client components the pages render (what the React interface itself needs from Next) | `next/navigation`: `components/chat.tsx:4,90`, `home.tsx:4`, `keyboard-shortcuts.tsx:28`, `new-session.tsx:4`, `plugins.tsx:4`, `plugin-view.tsx:5`, `sidebar.tsx:5`. `next/link`: `components/graph-view.tsx:70`, `plugin-view.tsx:3`, `sidebar.tsx:4` |
| No `next/image`, `next/script`, `next/head`, `next/dynamic`, `next/headers` import exists outside `app/api/` and `tests/` | `rg "from ['\"]next(/\|['\"])"` over the tracked tree (minus `app/api/`, `node_modules/`) returns only the imports above plus `next.config.ts`, `proxy.ts` and test files |
| No page or layout reads cookies or request headers | no `next/headers` import (previous row) |
| Unknown paths and unknown `/chat/:id` | `/_not-found` is built (`app-path-routes-manifest.json`); `app/chat/[id]/page.tsx:17` calls `notFound()`. The status actually sent is under "Not verified" |
| `/favicon.ico` has no file and returns 404 today | `scripts/smoke-plugin-browser.mjs:191-198` lists "the app's absent favicon" as an expected `404` |

## 2. `public/`

Tracked (`git ls-files public`, 5 files, 233,493 bytes):

| File | URL | Bytes | Requested by | Note |
|---|---|---|---|---|
| `public/fonts/cmunbx.ttf` | `/fonts/cmunbx.ttf` | 221,904 | `app/globals.css:96` (`@font-face lh-cmu`, weight 700; `--font-title` is `"lh-cmu", serif`, :599); also re-fetched by URL by the `drawing-pad` core plugin (`plugins/drawing-pad/src/fonts.ts:111`, section 5) | built CSS holds the absolute `url(/fonts/cmunbx.ttf)` (`pr1:.next/static/chunks/421mov3sj3pam.css`) |
| `public/fonts/OFL.txt` | `/fonts/OFL.txt` | 4,820 | nothing in the repo requests it (`rg OFL` finds no reference outside `public/`) | licence text |
| `public/plugin-loader.js` | `/plugin-loader.js` | 182 | `components/plugins.tsx:58` (creates `<script type="module" src="/plugin-loader.js">`, :56-57); asserted by `tests/plugin-frontend.test.tsx:733-737`, `scripts/smoke-plugin-browser.mjs:611,819`, `scripts/build-server.mjs:106` | body is one line: `window.__lhImportPlugin = (url) => import(url);` (`public/plugin-loader.js:3`); header comment: "served as a native browser module, outside the Next bundle" (:1) |
| `public/siwc/chatgpt-logo-white.svg` | `/siwc/chatgpt-logo-white.svg` | 4,214 | `components/settings/chatgpt-connection.tsx:324` (`<img src>`); `tests/chatgpt-connection-ui.test.tsx:112` | |
| `public/worklets/pcm-capture.js` | `/worklets/pcm-capture.js` | 2,373 | `components/dictation.tsx:214` (`audioWorklet.addModule`) | header comment: "Ships as a static file under public/ so it rides the standalone bundle" (`public/worklets/pcm-capture.js:22`) |

Generated at build time, not tracked:

| File | URL | Generated by | Evidence |
|---|---|---|---|
| `public/plugin-authoring/learnharness-plugins.zip` (2,908,090 bytes in `pr1`) | `/plugin-authoring/learnharness-plugins.zip` | `scripts/build-plugin-authoring.mjs` (`buildPluginAuthoring`, writes the file at :145-147). Run by `npm run plugins:build-authoring` (`package.json:23`), which `npm run dev` (:16) and `npm run build` (:17) run before Next; and by `scripts/build-server.mjs:84` (`standalone: true`), which writes `.next/standalone/public/plugin-authoring/learnharness-plugins.zip` (`build-plugin-authoring.mjs:103-105`) | `.gitignore` `/public/plugin-authoring/`; requested by `components/settings/plugins-section.tsx:30` (`<a href download>`; the download name embeds `process.env.LH_VERSION`); asserted by `tests/plugin-frontend.test.tsx:717-720`, `tests/desktop-payload.test.ts:135` |

Non-public output of the same script: `dist/plugin-authoring/` (dev) or `.next/standalone/plugin-authoring/` (standalone), a directory tree that no URL serves (`build-plugin-authoring.mjs:103-104`).

Built tree: `pr1:public` and `pr1:.next/standalone/public` each hold the same 6 files (12 files in total by `find`).

`public/` files are served by Next at their path with `Cache-Control: public, max-age=0` (`docs:03-api-reference/03-file-conventions/public-folder.md:27-31`). A standalone `server.js` serves `public/` and `.next/static` only if they were copied into `standalone/` (`docs:03-api-reference/05-config/01-next-config-js/output.md:49`); `scripts/build-server.mjs:33-42` does that copy (section 6).

## 3. Plugin assets

One route serves every plugin frontend file. No static directory serves plugin files.

| Channel | URL | Served by | Evidence |
|---|---|---|---|
| Plugin entry module | `GET /api/plugins/<id>/assets/<manifest.main>?revision=<sha256>` (`main` is a root `.js` name, validated `^[a-zA-Z0-9][a-zA-Z0-9._-]*$` and `.js`, `src/core/plugins.ts:397-399`) | route `app/api/plugins/[id]/assets/[...file]/route.ts:5-8` (`runtime = "nodejs"`, `dynamic = "force-dynamic"`; the request object is ignored, so `?revision` is never checked) → `pluginTransport.asset` (`src/server/plugin-transport.ts:55-58`) → `host.asset` (`src/server/plugin-host.ts:601-616`) | URL built at `components/plugin-manager.ts:85-87`; imported by the browser at `plugin-manager.ts:477` through `importPluginModule` (`components/plugins.tsx:53-69`) |
| Plugin stylesheet | same route, `<manifest.styles>` (a root `.css`) | same | `<link rel="stylesheet">` appended at `components/plugins.tsx:86-91`, called at `plugin-manager.ts:474-475` |
| Plugin sub-assets (chunks, worker, fonts, CSS imports) | `/api/plugins/<id>/assets/assets/<path...>`. The doubled `assets` is real: modules and CSS resolve relative to the entry URL `…/assets/main.js`, so `./assets/x.js` becomes `…/assets/assets/x.js`; these requests carry no `?revision` | same | `plugins/rich-code-blocks/src/styles.css:1` (`@import url("./assets/fonts/fonts.css")`), `plugins/rich-code-blocks/src/render.ts:103` (`new URL("./assets/tex-worker.js", import.meta.url)`), `scripts/smoke-plugin-browser.mjs:611,614` (asserts `…/assets/assets/helper.js` and the revision query on `main.js` only), `scripts/smoke-plugin-runtime.mjs:660-665` |
| Module loader shim | `GET /plugin-loader.js` | static (`public/`) | section 2 |
| Authoring download | `GET /plugin-authoring/learnharness-plugins.zip` | static (`public/`, generated) | section 2 |

Directories on disk:

| Origin | Directory | Evidence |
|---|---|---|
| Core (4 ids: `flashcards`, `coding-questions`, `drawing-pad`, `rich-code-blocks`) | `<ROOT>/core-plugins/<id>/` (flat: `manifest.json`, `main.js`, `styles.css`, `backend.cjs`, `assets/`). `ROOT` is the directory of `config.ts` (`config.ts:5`) | `src/server/plugins.ts:28-32`; `src/server/plugin-host.ts:149` (core package directory is the root itself), `:361`; ids in `core-plugins.json:1-6`; built by `scripts/build-core-plugins.mjs:63-86` from each `plugins/<id>/dist` into `core-plugins/<id>` (`npm run plugins:build-core`, `package.json:24`); `.gitignore` `/core-plugins/` |
| Community | `<LH_DATA_DIR>/plugins/<id>/dist/`; `LH_DATA_DIR` defaults to `<ROOT>/data` | `src/server/plugins.ts:26`; `plugin-host.ts:149,361`; `config.ts:20-22`; install helper `scripts/install-plugin-local.mjs:74-82` |
| Core private data (never served) | `<LH_DATA_DIR>/core-plugin-data` | `src/server/plugins.ts:30` |
| `plugins/<id>/dist` in the repo | build output of the source projects; copied to `core-plugins/` by the build script; not read by the running server | `scripts/build-core-plugins.mjs:71-75` |

`plugins/ui-showcase` exists but is not in `core-plugins.json`, so it has no `core-plugins/` package (it is only an authoring project, `build-plugin-authoring.mjs:15`).

How a request is answered (`src/server/plugin-host.ts:601-616`, in order):

| Check | Result |
|---|---|
| Plugin not enabled, not `active`, no manifest, or `blocked` | 409 "Plugin assets are disabled or unavailable" (:604) |
| No path segments, or any segment fails `^[a-zA-Z0-9][a-zA-Z0-9._-]*$` (:106) | 400 "Invalid plugin asset path" (:605) |
| Allowed only if exactly one segment equal to `manifest.main` or `manifest.styles`, or two or more segments with the first equal to `assets` | otherwise 404 "not allowlisted" (:607) |
| Any segment equal to `data`, or the path equals `manifest.backend` | 404 "Private plugin file" (:608) |
| Core root and package root must be real directories, no symlink in the chain, no escape from the package (`pluginRoot`, `regularFile`, :128-146) | 404 "Unknown or unsafe plugin asset" (:609-612) |
| Path must be in the in-memory `files` map | 404 "Unknown plugin asset" (:613-614) |
| Success | bytes copied from the in-memory snapshot (`Uint8Array.from`, :615) |

The bytes are not read per request. `snapshot()` reads every root-level file with a safe name (except a root `data`) and everything under `assets/` into a `Map` at discovery or refresh (`plugin-host.ts:147-172`, files with unsafe names are skipped silently, :157). The `revision` returned in `/api/plugins` is the SHA-256 over every name, length and byte of that map (:169-171). Each request still runs lstat and realpath checks against disk (`regularFile`, :611).

Content types and headers set by code:

| Item | Value | Evidence |
|---|---|---|
| Content-Type | from the lowercased extension: `.js` and `.css` `; charset=utf-8`, `.json` `; charset=utf-8`, `.txt` `; charset=utf-8`, `.svg`, `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.woff`, `.woff2`, `.ico`; anything else `application/octet-stream` | `plugin-host.ts:173-177`, `:615` |
| Not in the table | `.ttf`, `.gz`, `.wasm`, `.map`, `.html`, no extension. In the built `rich-code-blocks` package this is 140 `.ttf` (under `assets/fonts/bakoma/ttf/`), 3 `.gz` (`assets/tex/core.dump.gz` 3,252,439 bytes, `tex_files.tar.gz` 1,386,194, `tex.wasm.gz` 121,703) and the extensionless `assets/fonts/bakoma/LICENCE`; all are served as `application/octet-stream` today | `pr1:core-plugins/rich-code-blocks/assets`; `pr1:core-plugins/rich-code-blocks/assets/fonts/fonts.css` (`url('bakoma/ttf/cmb10.ttf')`) |
| Cache | success and errors both send `Cache-Control: no-store` | success `plugin-transport.ts:57`; errors `plugin-transport.ts:16,24-30` (JSON body `{ error }`) |
| Integrity / sniffing | `X-Content-Type-Options: nosniff` on success only (`plugin-transport.ts:57`). No `ETag`, `Last-Modified`, `Content-Length`, `Content-Disposition`, CORS or SRI header is set by this code; the `?revision=` value is a URL token the server ignores | `route.ts:5-8`; `plugin-transport.ts:55-58` |
| Access gate | the route is under `/api`, so `proxy.ts` runs first: Host check in browser mode, per-launch secret in desktop mode (section 7) | `proxy.ts:19-23` (matcher exempts only `plugins/<id>/documents/markdown`) |
| Desktop header | Electron adds `x-learnharness-desktop` to requests to `/api/*` that come from the trusted main frame (conditions at `desktop-api.cjs:14-20`); whether that covers module and stylesheet loads of these URLs is item 9 under "Not verified" | `electron/main.cjs:698-700`, `electron/desktop-api.cjs:7-24` |

Size of the built core packages in `pr1:core-plugins` (equal to `pr1:.next/standalone/core-plugins` by `diff -rq`):

| Package | Files | Bytes | Files under `assets/` |
|---|---|---|---|
| `coding-questions` | 130 | 1,753,752 | 123 (`.js`) |
| `drawing-pad` | 8 | 101,712 | 0 |
| `flashcards` | 7 | 216,543 | 0 |
| `rich-code-blocks` | 173 | 9,549,981 | 149 (1 `.css`, 3 `.gz`, 4 `.js`, 140 `.ttf`, 1 extensionless) |

All four manifests set `main: main.js`, `backend: backend.cjs`, `styles: styles.css` (`pr1:core-plugins/*/manifest.json`). No file name under any `assets/` fails the safe-segment pattern.

Docs statement of the same rule: "The HTTP adapter exposes list/enable/call and allowlisted frontend assets; private plugin data and backend modules are never asset responses" (`docs/architecture.md:186`).

## 4. Other non-API paths the client requests

| URL | Requested at | Kind | Served from |
|---|---|---|---|
| `/fonts/cmunbx.ttf` | `app/globals.css:96` | CSS `@font-face` | `public/fonts/cmunbx.ttf` |
| `/worklets/pcm-capture.js` | `components/dictation.tsx:214` | `AudioWorklet.addModule` | `public/worklets/pcm-capture.js` |
| `/plugin-loader.js` | `components/plugins.tsx:58` | `<script type="module">` | `public/plugin-loader.js` |
| `/siwc/chatgpt-logo-white.svg` | `components/settings/chatgpt-connection.tsx:324` | `<img>` | `public/siwc/chatgpt-logo-white.svg` |
| `/plugin-authoring/learnharness-plugins.zip` | `components/settings/plugins-section.tsx:30` | download link | generated `public/plugin-authoring/` |
| `/api/plugins/<id>/assets/…` | `components/plugin-manager.ts:86` (built), `:475` (CSS), `:477` (module) | section 3 | plugin host |
| `/_next/static/**` | no source reference (`rg _next` finds only unrelated test strings); emitted by Next into the HTML and CSS | section 5 | `.next/static` |
| Page navigations: `/`, `/chat/new`, `/chat/new?mode=practice`, `/chat/<id>`, `/chat/<id>#<anchor>`, `/plugins/<pluginId>/<viewId>` | `components/sidebar.tsx:428,681,718,776,840`; `home.tsx:160`; `new-session.tsx:321`; `keyboard-shortcuts.tsx:126,134`; `activity-dock.tsx:527`; `plugin-manager.ts:83,467-469`; `plugin-view.tsx:44`; `graph-view.tsx:1652` (href from `src/core/session-navigation.ts:23-26`); `chat.tsx:1072`; the `?prompt=` form is read by `app/chat/[id]/page.tsx:15` | `router.push` / `<Link>` / `<a>` | pages (section 1); client-side navigation also issues RSC requests (section 5) |
| Boot probe `GET /` | `electron/main.cjs:263-277` (`waitUntilUp`: any status code resolves); `scripts/smoke-server.mjs:181-188` (polls until `200`) | readiness | page `/` |
| `GET /favicon.ico` | none in source; browsers request it | | 404 today (`scripts/smoke-plugin-browser.mjs:191-198`) |

Checked and absent: no `manifest.json` / `site.webmanifest` / `apple-touch-icon` / `robots.txt` / `sitemap` reference or file for the app (`rg` over the repo outside `docs/`, `plugins/`, `extern/`); no service worker, `new Worker`, `.wasm`, `<iframe src>`, `<script src>` other than `/plugin-loader.js`; chat and artifact images are `data:` URIs (`components/artifacts/image-card.tsx:15`, `components/submitted-images.tsx:15`, `components/artifacts/svg-image.tsx:19`); demos use `srcDoc` (`components/artifacts/demo-card.tsx:159,217`); blob URLs are created in the browser (`components/speech-playback.ts:64`, `components/artifacts/download.ts:26`). The browser opens one external WebSocket to Deepgram (`components/dictation.tsx:481`), not to this server. Every other `fetch` the client makes targets `/api/...` (the variable-URL ones: `components/session-core.ts:768`, `plugin-manager.ts:225`, `settings/subscription-client.ts:9`).

## 5. Next's own assets

Counts are from `pr1:.next/static` (482 files, 19,221,264 bytes).

| Path | Files / bytes | What it is | Needed by |
|---|---|---|---|
| `/_next/static/chunks/<hash>.js` | 405 | Turbopack chunks: the React app, the Next client runtime and the Turbopack runtime; `build-manifest.json` names 1 polyfill file and 4 `rootMainFiles` | React interface only. No non-React code references `/_next` |
| `/_next/static/chunks/<hash>.css` | 1 (`421mov3sj3pam.css`, 117,927 bytes); chunks total 406 files, 17,905,073 bytes | the one stylesheet: `globals.css` rules (including the `lh-cmu` face), KaTeX rules and the `next/font` `@font-face` rules | React interface (the only stylesheet) |
| `/_next/static/media/*.woff2` (next/font) | 13 | JetBrains Mono (6 subsets) and Source Sans 3 (7 subsets), downloaded from Google at build time and self-hosted (`docs:03-api-reference/02-components/font.md:13`); two of them (`-s.p.` names) are preloaded on every page (`pr1:.next/server/next-font-manifest.json`) | React interface via CSS; **also re-fetched by URL** by the `drawing-pad` plugin (below) |
| `/_next/static/media/KaTeX_*` | 60 (20 faces in `.woff2`, `.woff`, `.ttf`) | KaTeX fonts, referenced by `url(../media/…)` in the built CSS (74 `url()` tokens in the CSS file) | React interface via CSS; same plugin re-fetch |
| `/_next/static/<BUILD_ID>/_buildManifest.js`, `_ssgManifest.js`, `_clientMiddlewareManifest.js` | 3 (`_4-tlwi51b_yoKusNTpSH` in this build) | client router manifests (`build-manifest.json` `lowPriorityFiles`) | React interface |
| Page URL with `?_rsc=<hash>` and request headers `rsc`, `next-router-state-tree`, `next-router-prefetch`, `next-router-segment-prefetch`; response type `text/x-component`; `.rsc` and `.segment.rsc` suffixes | not files | App Router client navigation. `pr1:.next/routes-manifest.json` `rsc`: `header "rsc"`, `varyHeader "rsc, next-router-state-tree, next-router-prefetch, next-router-segment-prefetch"`, `suffix ".rsc"`, `prefetchSegmentSuffix ".segment.rsc"`, `contentTypeHeader "text/x-component"`. Docs: the client adds `_rsc` and the headers during client-side navigation (`docs:03-api-reference/05-config/01-next-config-js/skipProxyUrlNormalize.md:71`); a request with a wrong `_rsc` hash gets a 307 to the right one (`docs:02-guides/cdn-caching.md:77`) | React interface, through the call sites listed in section 4 |
| `/_next/image` | not requested | configured (`pr1:.next/images-manifest.json` `path`), but no code imports `next/image` | nothing |
| `/_next/data/*` | none | `dataRoutes` is `[]` (`pr1:.next/routes-manifest.json`) | nothing |
| Internal redirect `/:path+/` to `/:path+`, status 308; `caseSensitive: false` | not files | `pr1:.next/routes-manifest.json` (`redirects[0]`, `caseSensitive`); `trailingSlash: false` in the generated config (`pr1:.next/standalone/server.js:18`); docs `docs:03-api-reference/05-config/01-next-config-js/trailingSlash.md:8` | any path |

What else depends on `/_next/...`: `plugins/drawing-pad/src/fonts.ts:69` (`referenceFontCSS`) walks `document.styleSheets`, selects every `@font-face` whose family is used under the drawing root (:89), and calls `fetch(url)` on each source URL (:111). It rejects a non-OK status or a `text/html` content type (:112). In the app those URLs are `/fonts/cmunbx.ttf` and the `/_next/static/media/*` files listed above. Test seam: `plugins/drawing-pad/tests/browser.mjs:46`.

Build-time Next input that is not served by a path: `LH_VERSION` and `LH_HOMEPAGE` are inlined into the client bundle by `next.config.ts:9` (`env`). Client code reads them at `components/settings/update-settings.tsx:15-16` and `components/settings/plugins-section.tsx:30`.

## 6. Build and packaging

`scripts/build-server.mjs`, in order:

| Step | Lines | What it does |
|---|---|---|
| Precondition | 27-30, 35-38 | refuses unless `.next/standalone/server.js` and `.next/static` exist |
| Static copy | 33-41 | `.next/static` to `.next/standalone/.next/static` |
| Public copy | 40-42 | the whole `public/` to `.next/standalone/public` (includes the generated `public/plugin-authoring/` if present) |
| Leak guards | 45-64 | refuses if the standalone holds `data/`, `auth.json`, `*-credentials.json*`, `.env`, `.env.local` |
| Plugin loader | 70 | `scripts/plugin-loader.cjs` to `.next/standalone/scripts/plugin-loader.cjs` |
| Core plugins | 72-80 | `validateCorePackages` on `core-plugins/`, replaces `.next/standalone/core-plugins` with a copy, validates again; refuses if missing (`npm run plugins:build-core` must have run) |
| Authoring | 84 | `buildPluginAuthoring({ root, standalone: true })`: writes `.next/standalone/plugin-authoring/` and `.next/standalone/public/plugin-authoring/learnharness-plugins.zip` (overwrites the copy from step "Public copy") |
| Curation | 94-100 | removes `.next/standalone/plugins`, `.next/standalone/dist`, `.next/standalone/node_modules/electron` |
| Sanity | 104-116 | requires `scripts/plugin-loader.cjs`, `public/plugin-loader.js`, `src/agent/system-prompt.md`, `src/agent/prompts/teacher/20-teaching.md`, `src/agent/prompts/side-chat/00-base.md`, `src/agent/prompts/side-chat/90-style.md` |

What `next build` itself puts in `.next/standalone` (observed in `pr1:.next/standalone`, 225 MB): `server.js` (9,104 bytes), `package.json`, the traced `node_modules`, `.next/{BUILD_ID, *.json, server/}`, plus traced copies of repo trees (`app/`, `components/`, `src/`, `tests/`, `docs/`, `tools/` and others). Configuration that shapes it: `next.config.ts:19` (`output: "standalone"`), `:52-61` (excludes), `:73-113` (includes, among them `src/agent/prompts/side-chat/*.md` at :90), `:117-124` (external packages).

Generated `server.js` (`pr1:.next/standalone/server.js`): sets `NODE_ENV=production` (:11); `process.chdir(__dirname)` (:12); reads `PORT` (default 3000, :14), `HOSTNAME` (default `0.0.0.0`, :15) and `KEEP_ALIVE_TIMEOUT` (:17); calls `startServer({ dir, isDev: false, config, hostname, port, allowRetry: false, keepAliveTimeout })` (:33-39). The full Next config is serialized into it (:18).

`electron-builder.yml`:

| Lines | Assumption |
|---|---|
| 98-101 | `extraResources: from .next, to server, filter standalone/**/*`, so the payload lands at `<resources>/server/standalone/**`, outside the asar. The comment at 90-97 records that `from: .next/standalone` silently dropped `node_modules` and `.next` |
| 6-8 | the server directory ships unpacked because native `.node` files cannot load from an asar and "server.js process.chdir()s into its own dir" |
| 54-56, 68-85 | the asar holds only `electron/**/*`, `package.json` and the `electron-updater` and `jose` trees |
| 86-89 | `docs/compaction-accounting.md` to `<resources>/licenses/pi-compaction.md` |
| 103-107 | mac only: `electron/server-title-guard.cjs` to `<resources>/server-title-guard.cjs`, outside the asar so `--require` can load it |

`electron/main.cjs`:

| Lines | Assumption |
|---|---|
| 73-77 | server entry is `process.resourcesPath/server/standalone/server.js` |
| 214-224 | spawned with `process.execPath`, `ELECTRON_RUN_AS_NODE=1`; macOS prepends `--require <resources>/server-title-guard.cjs`; `cwd` is the directory of the entry (`path.dirname(serverEntry())`) |
| 225-238 | environment: `NODE_ENV=production`, `PORT`, `HOSTNAME=127.0.0.1` (comment: "the server defaults to 0.0.0.0"), `LH_DATA_DIR`, `LH_AUTH_FILE`, `LH_DESKTOP_SERVER=1`, `LH_DESKTOP_API_SECRET` |
| 239 | `stdio: ["ignore", "pipe", "pipe", "ipc"]`. The server side listens on the IPC channel in `src/agent/chatgpt-bridge.ts:49` and `src/agent/subscription-bridge.ts:54` |
| 263-277, 693-723 | URL is `http://127.0.0.1:<free port>`; readiness is `GET /` resolving with any status code; the window loads that URL with no path (:406) |
| 711 | `loadSubscriptionSDK(path.dirname(serverEntry()))` resolves `@earendil-works/pi-ai` through `<server dir>/package.json` (`electron/subscriptions.cjs:22-38`), so `package.json` and `node_modules` must sit beside the entry |
| 698-700 | request header injection for `/api` only (section 7) |

Other code that depends on the same layout:

| Where | Dependence |
|---|---|
| `src/server/plugin-host.ts:329` | `path.join(process.cwd(), "scripts", "plugin-loader.cjs")`: the working directory must be the server directory |
| `src/server/plugins.ts:29` | `core-plugins/` resolved from `ROOT` (`config.ts:5`) |
| `scripts/smoke-server.mjs:41,95,138-150,181-195` | runs `.next/standalone/server.js` with `cwd` = standalone, `PORT`, `HOSTNAME`, `LH_DATA_DIR`, `LH_AUTH_FILE`; polls `GET /` until 200; probes `/api/graph`, `/api/models`, `/api/settings`, `/api/plugins` |
| `.github/workflows/release.yml:181-189` | payload paths `…/Resources/server/standalone`, `dist/win-unpacked/resources/server/standalone`, `dist/linux-unpacked/resources/server/standalone` |
| `tests/desktop-payload.test.ts:107-138` | asserts which files exist under the standalone after `build-server.mjs` |
| `package.json:18,27` | `npm start` is `next start -H localhost`; `desktop:dist` runs `rm -rf dist .next/standalone`, `npm run build`, `smoke-provider-runtime`, `build-server`, `smoke-server`, `electron-builder` |

## 7. Headers

| Where | Header or rule for non-API responses | Evidence |
|---|---|---|
| `next.config.ts` | none: no `headers()`, `redirects()` or `rewrites()` | `next.config.ts:1-127`; `pr1:.next/routes-manifest.json` has `headers: []`, `onMatchHeaders: []`, empty `rewrites` |
| `proxy.ts` | does not run for non-API paths. Matcher is `/api` and `/api/((?!plugins/[^/]+/documents/markdown/?$).*)` only | `proxy.ts:19-23`; `pr1:.next/server/functions-config-manifest.json` (`/_middleware` has the same two matchers). **Consequence: pages, `/_next/**` and `public/` files get no Host check and no desktop-secret check** (the gate is `apiRequestRefusal`, `src/server/desktop-access.ts:59-62`, applied by the proxy and by the documents route) |
| Pages and layout | none set: no `headers()` or `cookies()`, no `next/headers` import | section 1 |
| Electron | no CSP, `onHeadersReceived` or security header for the app window; `session.webRequest.onBeforeSendHeaders` only adds the desktop secret to `/api` requests from the main frame | `rg` for CSP and header names finds only `electron/chatgpt.cjs:290-291` (a separate local OAuth callback server); `electron/desktop-api.cjs:13` |
| Security headers anywhere in the repo | `X-Content-Type-Options: nosniff` and `Cache-Control: no-store` on some API handlers (for example `src/server/plugin-transport.ts:57`, `src/server/speech.ts:108`); none on non-API responses | `rg` over `src/`, `electron/` |
| Next defaults that apply (from config and docs, not observed on the wire) | `x-powered-by: Next.js` (`poweredByHeader: true`, `pr1:.next/standalone/server.js:18`; `docs:03-api-reference/05-config/01-next-config-js/poweredByHeader.md:8`); gzip when the client accepts it (`compress: true`; `docs:03-api-reference/05-config/01-next-config-js/compress.md:8`); ETags for pages (`generateEtags: true`; `docs:…/generateEtags.md:8`); dynamic pages `Cache-Control: private, no-cache, no-store, max-age=0, must-revalidate` (`docs:02-guides/cdn-caching.md:24`); `/_next/static` `public, max-age=31536000, immutable` (`docs:02-guides/cdn-caching.md:30`); `public/` `public, max-age=0` (`docs:03-api-reference/03-file-conventions/public-folder.md:27-31`); `Vary: rsc, next-router-state-tree, next-router-prefetch, next-router-segment-prefetch` on App Router responses (`docs:02-guides/cdn-caching.md:47-53`; `pr1:.next/routes-manifest.json` `rsc.varyHeader`) | as cited |
| Smoke test for compression | `scripts/smoke-compression-runtime.mjs` exists and is called from `scripts/smoke-server.mjs:102`; its content was not read | `scripts/smoke-server.mjs:32,102` |

## Not verified

1. Nothing was run. No response was observed, so every status, header and content type above comes from code, a build manifest or the Next docs, and is labelled as such.
2. The `Content-Type` Next sends for `public/` and `/_next/static` files (`.js`, `.css`, `.ttf`, `.woff2`, `.svg`, `.zip`). The docs read do not state it.
3. The status codes actually sent for `/settings` (the docs say `redirect()` uses 307 and, once streaming has begun, inserts a meta tag: `docs:03-api-reference/04-functions/redirect.md:12,215`) and for an unknown `/chat/:id` (`notFound()` gives 404 only before streaming starts: `docs:03-api-reference/04-functions/not-found.md:195`). The layout awaits `connection()` and there is no `loading.tsx`, but whether streaming has started at that point was not observed.
4. Next's handling of `HEAD`, `OPTIONS`, `Range`, `If-None-Match` and `Last-Modified` for `public/` and `/_next/static` files; whether `compress: true` compresses `application/octet-stream`, `.ttf` or `.gz` responses; the contents of `scripts/smoke-compression-runtime.mjs`.
5. How Next treats percent-encoded characters, dot segments, dotfiles and symlinks in `public/` and `/_next/static` paths, trailing slashes (`/:path+/` 308 is a manifest value), and mixed case (`caseSensitive: false` is a manifest value).
6. The browser's real request set. The RSC and prefetch requests are inferred from the docs and the `router.push` / `<Link>` call sites; whether `<Link>` prefetches fire for these `force-dynamic` routes in production was not captured.
7. Whether `/_next/image` answers at all (configured, never used).
8. What `PATHS.root` (`config.ts:5`, from `import.meta.url`) resolves to inside the Turbopack bundle. `core-plugins/` is found today (`build-server.mjs:72-75` stages it at the standalone root and the smoke tests pass), but the resolution was not traced.
9. Whether `electron/desktop-api.cjs` attaches the desktop secret to plugin module and stylesheet loads in a packaged window. The conditions at `desktop-api.cjs:14-20` (main frame, initiator origin) point to yes; `scripts/smoke-plugin-browser.mjs` runs a browser against the server and was not read for which mode it uses.
10. Build baseline: counts and names in `pr1:.next` are from a build of `pr1` at `3fa3928`, not of this worktree. The files that produce the surface were diffed identical (list at the top), but `src/`, `package.json` and `lib/` were not diffed, and chunk and font hash names change per build.
11. Development-server paths (`next dev`, `npm run dev`, `LH_DEV_URL`, `package.json:16,25`): HMR and `/_next/**` dev endpoints were not inventoried.
12. Any non-API path served by code outside `app/`, `public/` and `proxy.ts` (for example a custom server entry). None was found by `rg` over the tracked tree, but `tests/` and `docs/` were searched only for the strings cited.
