# oc mcp — CONTEXT for future AI edits

Read this first before touching anything. It describes what was built, why, and how to extend it without breaking the connection.

## 0. Read order for a new AI

1. THIS file (`AGENTS.md`) — what this repo is, exact behaviors, how to change it.
2. `context.md` (same folder) — generic Figma Plugin API background (sandboxes, manifest fields, reference links).
3. `skill/figma-bridge/SKILL.md` + `skill/figma-bridge/references/tools.md` — how agents are taught to USE the bridge (link flow, MCP flow, arg shapes).
4. `node_modules/@figma/plugin-typings/plugin-api.d.ts` — authoritative API shapes when writing `code.ts` (prose lies, types don't).

## 1. What this is

A Figma plugin + local bridge that lets ANY coding CLI read AND write the user's open Figma file, bypassing Figma's Dev Mode MCP (free-plan 6/month limit). Two transports, one bridge:

```
ANY AI --(HTTP: GET link / POST commands)--> bridge/server.js <--(WS localhost:3055)--> ui.html --(postMessage)--> code.js (figma.* API)
MCP CLI --(stdio JSON-RPC, same file)-------> bridge/server.js <--(or HTTP proxy if bat owns port)
```

## 2. Exact file map (repo root = Figma dev-import folder; manifest paths are relative to it)

- `manifest.json` — plugin id `1680485268450463756`, name `oc mcp`, api `1.0.0`, `main: code.js`, `ui: ui.html`, `documentAccess: dynamic-page`, `editorType: [figma, figjam]`, `permissions: []`, `networkAccess.allowedDomains: ["ws://localhost:3055"]` + reasoning + `devAllowedDomains: [http://localhost:3055, ws://localhost:3055]`. Manifest is read at IMPORT time: manifest edits need dev-plugin RE-IMPORT; `code.js`/`ui.html` reload on every plugin RUN.
- `code.ts` (2859 lines) → compiled to `code.js` via `tsc -p tsconfig.json` (so `code.js` is a build artifact — never hand-edit it). ONLY place that touches `figma.*`. No network (sandbox has none). `figma.showUI(__html__, {width:340, height:520})`. `placeNode()` is DEAD code (never called); `resolveParent()` is the live parent-resolution path.
- `ui.html` (255 lines) — visible panel: readonly link input + `Copy link` button; an `Advanced` `<details>` holding the server URL input (default `ws://localhost:3055`, persisted in localStorage as `oc_server`); `Connect`/`Disconnect`; `Ping canvas`; a minimize button (resizes the plugin window 340x520 ↔ 340x64 via a `local-resize` message); status dot; log; hint block. ONLY place with WebSocket. Auto-connects 600ms after open, sends a WS heartbeat `{type:'ping'}` every 20s, registers as `{type:'register', client:'figma-plugin'}`, and reconnects (exponential backoff, cap 30s) while `wantConnected`; removes the legacy `oc_channel` localStorage key. Forwards bridge commands to `code.ts`, returns results. `local-*` message ids are UI-internal (Ping test) and are NEVER forwarded to the bridge. Copy buttons use `navigator.clipboard` with `execCommand` fallback (clipboard API is blocked in Figma's null-origin iframe).
- `bridge/server.js` (878 lines, single dep `ws`) — WS server for Figma + HTTP link API + MCP stdio server, all in one process. ONE Figma socket (`figmaSocket`): a new register replaces the old socket and rejects its in-flight requests ("previous connection replaced"); welcome is `{type:'welcome'}`. No channel registry or default-target fallback, no uppercasing. If the port is busy, the second instance becomes an MCP→HTTP PROXY instead of crashing (see §6).
- `bridge/package.json` — `{name: oc-mcp-bridge, version 1.0.0, type: commonjs, deps: {ws: ^8.18.0}}`.
- `package.json` — plugin-side scripts: `build` (tsc), `lint`, `watch`, `bridge:install`, `bridge:start` (`node bridge/server.js`); devDeps: typescript, eslint, `@figma/plugin-typings` (API types), `@figma/eslint-plugin-figma-plugins`.
- `tsconfig.json` — target es2020, lib es2020+dom, strict, skipLibCheck, `include: [code.ts]` ONLY. Output `code.js` sits next to the manifest (what Figma loads).
- `.gitignore` — `node_modules/`, `out/`, `dist/`, `*.tsbuildinfo`, `.bridge-port`, `opencode.json`, `*.log*`, OS/editor junk, `%USERPROFILE%/`. `code.js` IS tracked/committed so a fresh clone loads in Figma immediately; the bat rebuilds it when `code.ts` is newer.
- `start-bridge.bat` — single double-click setup+run: node check → port prompt (default 3055, exported as `FIGMA_BRIDGE_PORT`) → installs bridge deps if `node_modules\ws` missing → builds `code.js` if missing (asks to rebuild if present) → runs `setup-opencode.js` (global, optional) → optional `--project` config → optional global skill install via xcopy → `node server.js` in `bridge/`.
- `share-link.bat` — public sharing via Cloudflare quick tunnel (no account): needs `cloudflared.exe` (one-time download into this folder or PATH) + bridge + plugin running; prints the `https://<random>.trycloudflare.com` base; share link = base + `/file`. URL changes every run; closing the window kills the link instantly.
- `setup-opencode.js` — safe-merge helper: writes `mcp.figma-bridge = {type: local, command: [node, <abs path>/bridge/server.js], enabled: true}` into global `~/.config/opencode/opencode.json`, and with `--project DIR` also into `DIR/opencode.json`. Never wipes other keys; exits 1 on unparseable config or missing project dir.
- `opencode.example.json` — manual-config reference with a placeholder path (`/ABSOLUTE/PATH/TO/oc mcp/bridge/server.js`); the bat/`setup-opencode.js` generate the real machine-specific `opencode.json`, which is gitignored.
- `skill/figma-bridge/SKILL.md` — agent skill, frontmatter `name: figma-bridge` (MUST equal the directory name; lowercase-hyphen format). Install target global `~/.config/opencode/skills/figma-bridge/` or project `.opencode/skills/`.
- `skill/figma-bridge/references/tools.md` — command/route reference for agents.
- `README.md` — dumb-proof user guide. `context.md` — Figma API background (do not rename; see §6 case-sensitivity).

## 3. Protocol (do not change casually)

- Figma registers: UI → bridge WS `{type:'register', client:'figma-plugin'}`. Bridge replies `{type:'welcome'}`.
- WS command flow: bridge → UI `{id:'mcp-…', command, params}` → UI `parent.postMessage({pluginMessage})` → `code.ts` `figma.ui.onmessage` → `handleCommand` → `figma.ui.postMessage({id, ok, result|error})` → UI → WS `{id, ok, result|error}` → bridge resolves `pending` entry. WS-side timeout 45s per request (`Timed out waiting for Figma…`); proxy HTTP leg 50s.
- HTTP routes (CORS `*` on all, `OPTIONS` → 204, JSON everywhere unless noted):
  - `GET /health` → plain text `ok`.
  - `GET /status` → `{connected}`.
  - `GET /file?depth=N` (N clamped 0–5, default 2) → the LINK blob: `{ok, link, instructions, api_base, commands (156, derived from TOOLS), for_browser_ai, document, selection, tree, components[≤100], styles{paints|texts|effects|grids ≤50}}`. If document+selection+tree ALL fail → 502 `{ok:false, error, hint}` (fail loud, never fake-empty 200); partial failures → 200 with per-section `{error}`.
  - `GET /selection` → `{ok, result}` / 502.
  - Legacy channel URLs `GET /file/<code>`, `GET /selection/<code>`, `POST /api/<code>/<command>` → 410 `{ok:false, error}` "Channel codes removed — use GET /file".
  - `POST /api/batch` with `{calls:[{tool, arguments}], parallel?, stopOnError?}` (1–32 calls, 5MB cap) → per-call results; a top-level `_echo:true` propagates to sub-calls.
  - `POST /api/<command>` with `{"params":{…}}` (body cap 5MB, else 400) → `{ok, command, result}` / 502. Accepts every advertised command (156) plus HTTP-only `get_current_page`; `ping` is aliased.
  - `GET /` → plain-text usage line. Anything else → 404 JSON with route hints.
- MCP (hand-rolled newline-delimited JSON-RPC on stdio, no SDK on purpose): `initialize` (echoes client protocolVersion, default `2024-11-05`; serverInfo `oc-mcp-bridge/1.0.0`), `notifications/*` ignored, `ping` → `{}`, `tools/list` → 157 tools, `tools/call` → `{content:[{type:text, text: JSON ≤200000 chars}]}` in COMPACT form (no pretty-print; an over-cap reply becomes a valid truncation envelope, see §5). Logs go to STDERR only — anything on stdout breaks MCP framing.
- Routing (single connection): the bridge sends commands to the single registered plugin socket; when none is connected it errors (`No Figma plugin connected…`). In proxy mode `sendToFigma` forwards over HTTP via `POST /api/<command>` to the owner bridge.
- UI ↔ code.ts: UI→code `{id, command, params}`; code→UI `{id, ok, result|error}` or `{type:'event', event, data}`. Unsolicited `selectionchange` (selection ids) and `currentpagechange` (pageId) events are forwarded by the UI over WS; the bridge currently only LOGS them. `cancel` message closes the plugin.

## 4. Command inventory (exact counts)

- MCP: 157 tools (full inventory in `skill/figma-bridge/references/tools.md`). Notable reads: `get_document_info`; `get_selection` (serializes selection at depth 3; honors the `_detail` tier — full by default, `struct` in panel mode); `get_node_tree` (depth 0–10, bridge default 2); `get_node_by_id`; `get_local_components` (cap 500); `get_local_styles`; `get_local_variables`; `export_node` (PNG/JPG→base64 (+mime), SVG→text cap 500000 chars, base64 truncated at 1500000 chars with `truncated:true`; `savePath` is MCP-ONLY — the bridge writes the file and returns `savedTo`; HTTP has no savePath). Notable writes: `create_frame|rectangle|ellipse|text`, `set_text_content`, `set_fills|strokes`, `set_node_props`, `set_layout`, `delete_nodes` (accepts `nodeIds[]` or singular `nodeId`; MCP maps singular→array), `clone_node`, `move_node`, `set_selection`, `create_page`, `group_nodes`, `create_component`, `create_instance`, `create_variable_collection`, `create_variable`.
- HTTP `COMMANDS` advertised in the link: 156, DERIVED from `TOOLS` in `bridge/server.js` (bridge-local tools `get_status`/`batch_tools` excluded, `ping_figma` → `ping`, plus `batch`). `POST /api` additionally accepts `get_current_page` (serializes current page at fixed depth 2; no MCP equivalent).
- `ping` returns `{pong, file: figma.root.name}`.
- Arg details: `skill/figma-bridge/references/tools.md`. Fills accept `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa` (with or without `#`), or `{r,g,b}` 0–1 (a numeric `.a` is honored; an explicit `opacity` argument wins over hex alpha). An invalid/malformed color now THROWS (`invalid color: expected #rgb, #rgba, #rrggbb, #rrggbbaa, or {r,g,b}; got …`) instead of silently becoming gray; an absent color still defaults to gray where a default exists.

## 5. Builder defaults & behaviors (what the code does when args are omitted)

- `create_frame`: 800×600, no fill unless `fill` given; `layoutMode`/`itemSpacing`/`padding` (single number → all four sides) applied best-effort. `create_rectangle`: 200×120, fill `#D9D9D9`. `create_ellipse`: 160×160, same default fill. `create_component` blank: 200×120. `create_text`: text defaults `"Hello"`, font `Inter/Regular` (loads via `ensureFont`; on failure tries the selection's font, then `Inter/Regular` again); `fontSize`/`fill`/`x`/`y`/`name`/`align` only applied when provided.
- `set_node_props`: accepts `{props:{…}}` or flat args; resize needs BOTH width+height; fields: x,y,width,height,name,opacity,visible,locked,cornerRadius,fill,rotation (each guarded by capability checks).
- Parents: `resolveParent(parentId)` → `getNodeByIdAsync`, falls back to `figma.currentPage` when missing/incapable. `create_page`: `select:true` switches to it. `set_selection`: silently drops PAGE/DOCUMENT ids, zooms to the rest; OBSERVED QUIRK: selecting nodes that live on a non-current page 502s — select only current-page nodes.
- Serialization (`serializeNode`): base fields id/name/type/visible/locked/removed + geometry, fills/strokes/effects (safe-cloned), auto-layout fields when present, TEXT extras (`characters` cap 20000, fontName/size/align/lineHeight/letterSpacing), INSTANCE `mainComponent{id,name}`, `exportSettings`, `absoluteBoundingBox`. `figma.mixed` Symbols are converted to `"mixed"` via `clean()`/`safeSerialize` (postMessage cannot clone Symbols — deep reads used to crash on this). Recursion cap: objects/arrays truncate past depth 6; `get_node_tree` clamps depth 0–10. At depth 0, children collapse to `childCount` + `childIds`.
- Serialization tiers (`_detail`): `"receipt"` = `{id,name,type}` only; `"struct"` drops fills, strokes, effects, relativeTransform, absoluteTransform, absoluteRenderBounds, layoutGrids, styledTextSegments, segmentsTruncated, rangeFonts, rangeFills, vectorNetwork, vertexCount, vectorPaths, fillGeometry, strokeGeometry, exposedInstances, annotations, guides, exportSettings, absoluteBoundingBox (plus the derived `annotationCount`/`guideCount`); `"full"` = everything (default when absent). The bridge injects the tier — writes get `receipt`, `get_node_tree`/`get_node_by_id` get `struct`, all other reads stay `full`. `_echo:true` on a write forces `full`; `_full:true`, or a `fields` list that asks for a struct-dropped key, forces `full`. An explicit `_detail` is never overridden, and `fields` are never re-slimmed once supplied.
- Write receipts: mutating tools return `{id, name, type}` by default instead of the full serialized node. `_echo:true` (per call, or top-level on `batch_tools`) restores the full response. Reads are unaffected.
- Payload sizing: `tools/call` replies are COMPACT JSON. An over-cap reply (>200000 chars, or 5 MiB for `batch_tools`) becomes `{ok:false,truncated:true,chars,limit,hint}` — a valid envelope, never a mid-object slice. `fields` on wrapper-shaped reads keeps envelope keys at the TOP level only (`get_selection` `{count,nodes}`, `get_local_styles` `{paints,texts,effects,grids}`) and narrows nested entries; `_slim:true` additionally drops styledTextSegments/rangeFonts/rangeFills/relativeTransform/absoluteTransform/annotations/guides/exposedInstances.
- `format:"panel"`: on `get_node_tree`, `get_node_by_id`, `get_selection`, `get_current_page` returns `{panel: <indented text tree>, lines: <n>}` instead of JSON. Any other value throws `invalid format: expected "panel"`. `export_node`'s `format` is unrelated (PNG/JPG/SVG/…). Example line: `FRAME "Card" #1:1 400x300 V, gap 8, pad 16/16/16/16` / `  TEXT "Title" #1:2 200x24 align STRETCH "…"`.
- `find_nodes`: returns `{total, returned, truncated, matches:[{id,name,type,path}]}` (was a bare array and threw past 100). Params: `types`, `nameContains`, `textContains` (TEXT characters, case-insensitive), `textEmpty` (TEXT with empty text), `pluginData`, `sharedPluginData`, `parentId`, `limit` (default 100, clamped 1..1000). `path` is ancestor names joined `" / "`, capped at 6 levels with a leading `… / ` when deeper.
- Layout writes report truth: `set_layout`, `set_layout_child`, `set_node_props`, `set_grid_child` return `applied` (count of properties that stuck), `mismatched` (present only when non-empty; entries `{property, requested, applied|error}`), and `set_layout` additionally `restoredChildren` (only when >0). `set_layout` accepts `preserveChildLayout` (default true), which snapshots children's `layoutGrow`/`layoutAlign`/`layoutPositioning` before a `layoutMode` change and restores them after, because Figma normalizes them on that assignment. `set_node_props` `resize` needs both width and height.
- `get_document_info`: never throws on unloaded pages (`childCount: "unloaded"` fallback). `get_local_styles`/`variables` degrade to `[]` on failure.

## 6. Build / test (Windows; PowerShell blocks `npm.ps1` — use `npm.cmd` full path or the bat/cmd.exe)

- Deps: bridge `npm --prefix bridge install`; plugin `npm install`. Build: `npx tsc -p tsconfig.json` → `code.js`. Syntax: `node --check bridge/server.js`, `node --check code.js`, `node --check setup-opencode.js`.
- MCP test: spawn `node bridge/server.js`, write `initialize` / `tools/list` / `tools/call get_status` newline-delimited to stdin → expect 157 tools.
- HTTP link test (use a NON-default port, e.g. `FIGMA_BRIDGE_PORT=3057`, to avoid the user's live bridge): register a fake Figma WS as `{type:'register', client:'figma-plugin'}` that answers the commands the link needs (ping, get_document_info, get_selection, get_node_tree, get_local_components, get_local_styles); `GET /file`, `GET /selection`, `POST /api/<cmd>` must round-trip; legacy `/file/FIG-TEST` must 410; unknown route 404; with no plugin registered `/file` must 502 with hint.
- Proxy test: owner on one port + fake Figma; second instance on the SAME port via MCP stdio → must log `proxy mode` (not crash) and answer `tools/call ping_figma` through the owner — the proxy forwards over HTTP (`POST /api/<command>`), not the old channel endpoint.
- Gotcha found while testing this: `ws` re-emits the HTTP server's errors on the WebSocketServer — `onListenError` MUST stay attached to BOTH `server` and `wss` or EADDRINUSE still kills the process. `sendToFigma` MUST stay `async` (a sync throw would escape HTTP route handlers and reset the AI's connection instead of returning JSON).

## 7. How to add a new tool (all layers, in order)

1. `code.ts`: implement `cmdX(params)` + `case` in `handleCommand`. Use `findNode`/`resolveParent`/`serializeNode`/`clean`, `ensureFont` for text. ES2020, no Node APIs, guard everything fallible.
2. Rebuild: `npx tsc -p tsconfig.json`. User must RE-RUN the plugin in Figma to load the new `code.js`.
3. `bridge/server.js`: add to `TOOLS` (`required` INSIDE `inputSchema`) — that alone is enough. `COMMANDS` (the link's advertised list) is DERIVED from `TOOLS` automatically, and the default `callTool` path forwards to the plugin (`get_current_page`-style HTTP-only commands need no TOOLS entry). HTTP `POST /api/…` picks it up automatically.
4. Docs: `skill/figma-bridge/references/tools.md` (+ `SKILL.md` list + link-field list if the response shape changed).
5. Verify: `node --check`, MCP `tools/list` count, `POST /api/<cmd>` round-trip, E2E against real Figma.

## 8. Landmines (every one hit at least once in this repo's history)

- Manifest (`allowedDomains`) is read at IMPORT: manifest edits need dev-plugin RE-IMPORT; `code.js`/`ui.html` edits only need plugin RE-RUN. `["none"]` (string) is invalid — must be `["none"]` (array); WS needs `ws://localhost:3055` listed or it dies with a generic CSP/network error.
- Network code in `code.ts` silently fails — WS/fetch only in `ui.html` (sandbox boundary, not a bug).
- `navigator.clipboard` fails in Figma's null-origin iframe — ui.html uses execCommand fallback + auto-select.
- PowerShell `npm` fails (`npm.ps1` execution policy) — use `npm.cmd` full path or the bat.
- `node server.js` from wrong cwd → MODULE_NOT_FOUND — must run in `bridge/`; bat handles cwd.
- Two bridges on one port → second becomes MCP→HTTP proxy (no crash). Still tell users to keep ONE bat window to avoid confusion.
- `/file` fails loud (502 + hint) only when document+selection+tree ALL fail; partial failures return 200 with per-section `{error}`.
- `code.js` is tracked in git, so a clone works immediately; if it's ever missing, the bat rebuilds it from `code.ts`. Never commit `node_modules`.
- `create_variable` schema: `required` INSIDE `inputSchema` (an extra-brace typo once broke the whole bridge).
- Plugin sandbox ≈ ES6+/ES2020: no `FormData`, guard new APIs with try/catch.
- `documentAccess: dynamic-page`: use `getNodeByIdAsync`/`loadAsync`; load fonts before text mutation.
- MCP stdout is sacred: bridge logs to stderr only.
- UI auto-reconnect (exponential backoff, cap 30s) masks "bridge down" — UI logs close code (`1006` = bridge down) + health hint.
- One Figma socket: every plugin RUN replaces the previous connection ("previous connection replaced") and rejects its in-flight requests. Keep only the target plugin window open.
- Windows filenames are case-insensitive: NEVER create two files differing only by case (`CONTEXT.md` vs `context.md` are the same file and WILL overwrite each other — happened once, had to restore `context.md` byte-for-byte). This file is `AGENTS.md` for exactly that reason.
- `KEY_ALIAS` maps `id`→`nodeId`, so `{nodeId, id}` used to silently DROP the `id` (the "long form wins" branch ate it) and `set_timeline_duration`/`remove_motion_style` failed with a bare *"id required"*. `expandKeys` now keeps the original key on conflict — **if you touch `KEY_ALIAS`, re-check every tool whose real param is literally `id`.**
- Motion VECTOR fields (`SCALE_XY`, `SCALE_X`, `SCALE_Y`, `TRANSLATION_XY`) reject bare numbers: *"baseValue for SCALE_XY must be a VECTOR keyframe value"*. `motionKeyframeValue()` passes raw `{type:'VECTOR',…}` straight through, so callers must send it for baseValue AND every keyframe.
- `motionEasing()` was written from an older spec and rejected `EASE_IN_BACK`/`EASE_OUT_BACK`/`EASE_IN_AND_OUT_BACK`/`QUICK`/`BOUNCY`/`SLOW`, all of which the v1.138 typings declare. Now validated against `MOTION_EASING_TYPES` (code.ts) — **keep that list in sync with `MotionEasing` in the typings.**
- Motion **timeline ids are not stable across builds**: re-applying tracks after a reload minted `2149:197` → `2152:569`. Always read `timelines[0].id` from `get_node_animations` right before `set_timeline_duration`.
- Motion has **no physics engine** — no gravity, no springs-on-transform. Physical motion = simulate offline, bake dense keyframes. See `skill/figma-bridge/references/motion-recipes.md`.
- Video export (`MP4`/`GIF`/`WEBM`) is capped at **30fps** on this plan; 60fps throws *"exceeds the 1920×1080 / 30fps limit for this plan"*.
- A stray literal `%USERPROFILE%` directory can appear at the repo root when a bat expands `%USERPROFILE%` unexpanded — it duplicates `SKILL.md`/`tools.md` into `oc mcp\%USERPROFILE%\.config\...`. Junk; delete it, never edit it.
- `receiptOf` collapses id-bearing objects to `{id,name,type}`; the `RECEIPT_KEEP` allowlist must keep `applied`/`mismatched`/`restoredChildren`, or the honest-write report silently disappears from default write responses.
- `find_nodes` returns an OBJECT now (`{total, returned, truncated, matches}`); code written for the old bare array must read `.matches`.
- `format:"panel"` collides with `export_node`'s `format`; the carve-out in the HTTP route (`command !== "export_node"`) must stay, or `export_node {format:"PNG"}` would be rejected as an invalid panel format.
- `hexToRgb` must NEVER throw and must keep returning `null` for non-hex strings: motion keyframes (`motionKeyframeValue`) rely on that null to pick `TEXT_DATA`.
- `server.js` edits only take effect in the process that loaded them. In proxy setup (the bat owns the port) the opencode MCP instance is the PROXY and it runs `applyReadOptions` for MCP reads — restart the CLI/MCP to reload; restarting only the bat does not refresh the proxy.

## 9. Sharing / publishing

- Dev-import based (`Import plugin from manifest`). Community publish (no import step) needs listing assets/review — not done.
- Distribute as zip of this folder. First-run: Node → Figma import manifest → double-click bat (Enter through prompts) → restart CLI → paste the link or use the MCP tools.
- Skill installs via bat to the global skills dir; also installable via `npx skills add <git-url> --skill figma-bridge` once hosted on git.
- Public links (`share-link.bat` + cloudflared): browser AIs are READ-only through the tunnel (they can't POST); writes need local bridge + CLI. Anyone with the link can read while the tunnel runs — closing the bat window kills it instantly; the public URL changes every run.
