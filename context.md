# Figma Plugin API — Context Pack

Purpose of this file: give an AI coding assistant everything it needs to build a Figma plugin correctly on the first few tries, specifically one that bridges a live Figma file to an external CLI (opencode) without using Figma's official Dev Mode MCP Server.

---

## 0. Feed the AI these primary sources first (don't rely on training data alone)

- `https://developers.figma.com/llms.txt` — root index of Figma's whole dev platform (Plugin API, Widget API, REST API, Code Connect, MCP Server). Built specifically to be machine-readable.
- `https://developers.figma.com/docs/plugins/llms.txt` — the full Plugin API doc index: every guide page, every global object, every node type, every data type, one flat list of links.
- `@figma/plugin-typings` (npm) — the authoritative TypeScript definitions for the entire Plugin API surface. Install it (`npm i -D @figma/plugin-typings`) and point the AI at `node_modules/@figma/plugin-typings/plugin-api.d.ts`. This is more reliable than any prose doc — wrong API usage becomes a compile error instead of a silent runtime failure.
- `@figma/widget-typings` (npm) — only needed if you also build a widget (canvas-visible object), not a plugin.
- Official sample repo: `github.com/figma/plugin-samples`

If your AI has web access, it should literally fetch the two llms.txt files above at the start of the task rather than guessing API shapes.

---

## 1. Execution model — the #1 source of "stuck" bugs

A Figma plugin is **two separate JS sandboxes** that cannot touch each other directly:

| | Main thread (`code.ts`) | UI iframe (`ui.html`) |
|---|---|---|
| Access | `figma.*` global (document, nodes, selection, viewport, etc.) | Standard browser APIs (`fetch`, `WebSocket`, DOM, `localStorage`) |
| Network | **None. Not restricted — absent.** No `fetch`, no `XMLHttpRequest`, no `WebSocket`. | Full network access, subject to `networkAccess` manifest rules and CORS |
| Figma document | Full read/write | **None** — cannot call any `figma.*` method |
| Runs on | QuickJS-based sandbox (desktop) / Realms-based sandbox (browser), roughly ES6+ | A real `<iframe>` |

**The only communication channel between them is message passing**: `figma.ui.postMessage(msg)` (main → UI) and `figma.ui.onmessage = (msg) => {}` (UI → main), and the reverse via `window.onmessage` / `parent.postMessage({ pluginMessage, pluginId }, '*')` inside `ui.html`.

Consequence for your project: your bridge/WebSocket client code **must live in `ui.html`**, not `code.ts`. `code.ts` only ever talks to the UI via postMessage; the UI is the only part of your plugin that can open a WebSocket to your local relay.

Other execution constraints that regularly break naive implementations:
- Plugins only access the **currently open file**. No cross-file access.
- **Dynamic page loading**: pages other than the current one aren't loaded by default — you must `await figma.getNodeByIdAsync()` / load pages asynchronously. Manifest should include `"documentAccess": "dynamic-page"` (required for all new plugins going forward); this manifest field also blocks some older sync APIs.
- Before editing text, you must `await figma.loadFontAsync({ family, style })` first, or the mutation throws.
- Styles/components from team libraries are only usable if already imported into the current file.
- The plugin sandbox is roughly ES6+ but is **not a full browser JS engine** — some newer syntax/APIs can behave unexpectedly (e.g. `FormData` is not supported for requests made through the invisible-UI network pattern; keep network code simple XHR/fetch in the iframe).
- A plugin's main-thread execution is tied to its running session; call `figma.closePlugin()` when done, or (for something long-running like a live bridge) keep `figma.showUI(...)` open — closing the plugin window ends the WebSocket connection in the iframe too.

---

## 2. manifest.json reference

Minimal shape:
```json
{
  "name": "MyPlugin",
  "id": "737805260747778092",
  "api": "1.0.0",
  "main": "code.js",
  "ui": "ui.html",
  "editorType": ["figma"],
  "documentAccess": "dynamic-page",
  "permissions": [],
  "networkAccess": {
    "allowedDomains": ["none"]
  }
}
```

Key fields:
- `editorType` — which Figma surfaces the plugin can run in: `"figma"`, `"figjam"`, `"slides"`, `"dev"`, `"buzz"`.
- `permissions` — opt-in array for sensitive APIs, e.g. `"currentuser"` (needed before calling `figma.currentUser`), `"activeusers"` (FigJam only). Forgetting to add these is a common runtime error even when the code looks correct.
- `networkAccess` — gates all outbound requests from the UI iframe:
  - `allowedDomains`: array of match patterns. Can include scheme prefixes (`http`, `https`, `ws`, `wss`), wildcards for subdomains (`*.example.com`), path scoping (`example.com/api/` only allows that path), or `"*"` for all domains.
  - `reasoning`: **required** if `allowedDomains` includes `"*"`, or generally any non-obvious/broad scope, or local/dev servers included directly in `allowedDomains`. Short string explaining why.
  - `devAllowedDomains`: same pattern syntax, but only enforced during local plugin development (via "Import plugin from manifest"). Use this instead of `allowedDomains` for domains you only need while developing.
  - If a request goes to a domain not listed, Figma blocks it with a CSP error — this looks like a generic network failure and is easy to misdiagnose as a bug in your bridge server instead of a manifest omission.

**Working example for a localhost WebSocket bridge** (this is the exact manifest pattern used by the open-source Figma↔AI-agent bridges referenced in section 5):
```json
{
  "name": "OpenCode Bridge",
  "id": "YOUR_PLUGIN_ID",
  "api": "1.0.0",
  "main": "code.js",
  "ui": "ui.html",
  "editorType": ["figma", "figjam"],
  "documentAccess": "dynamic-page",
  "permissions": [],
  "networkAccess": {
    "allowedDomains": ["ws://localhost:3055"],
    "reasoning": "Connects to a local bridge server that relays commands from an AI coding agent (opencode) running on the same machine.",
    "devAllowedDomains": ["http://localhost:3055", "ws://localhost:3055"]
  }
}
```

---

## 3. Core API map (what actually lives on `figma`)

- `figma.currentPage`, `figma.root` — entry points for document traversal. `figma.currentPage.selection` returns the current selection as `ReadonlyArray<SceneNode>`.
- `figma.getNodeByIdAsync(id)`, `figma.currentPage.loadAsync()` — required for dynamic-page-loading-compatible code.
- `figma.createRectangle()`, `createFrame()`, `createText()`, `createComponent()`, etc. — node creation.
- `figma.ui` — `postMessage`, `onmessage`, `resize`, `close`.
- `figma.viewport` — `scrollAndZoomIntoView`, `.center`, `.zoom`.
- `figma.clientStorage` — small persistent key/value store scoped to the plugin (survives across runs, per-user per-file-or-global depending on API used).
- `figma.on(event, callback)` — event subscription. Arg-free events: `selectionchange`, `currentpagechange`, `close`, timer events. Events with payloads: `run` (`RunEvent`, fired on plugin launch — includes any parameters/command), `documentchange` (`DocumentChangeEvent[]` — CREATE/DELETE/PROPERTY_CHANGE/STYLE_* deltas, each tagged `origin: 'LOCAL' | 'REMOTE'`), `drop`.
- `figma.variables`, `figma.teamLibrary`, `figma.annotations`, `figma.codegen` — specialized sub-APIs (design tokens, library assets, annotations, Dev Mode codegen respectively).
- Node tree: `DocumentNode` → `PageNode` → `SceneNode` subtypes (`FrameNode`, `TextNode`, `RectangleNode`, `ComponentNode`, `InstanceNode`, `GroupNode`, `BooleanOperationNode`, `VectorNode`, etc., plus FigJam-only types like `StickyNode`, `ConnectorNode`).

Full reference: `https://developers.figma.com/docs/plugins/api/figma/` and the node type index at `https://developers.figma.com/docs/plugins/api/nodes/`.

---

## 4. Making network requests correctly (the invisible-iframe pattern)

Since `code.ts` has no network access, the standard pattern is to open a **hidden** UI iframe purely as a network worker:

```ts
// code.ts (main thread)
figma.showUI(__html__, { visible: false })
figma.ui.postMessage({ type: 'networkRequest', payload: /* ... */ })

figma.ui.onmessage = async (msg) => {
  if (msg.type === 'networkResult') {
    // do something with msg.data using the figma.* API here
  }
}
```
```html
<!-- ui.html -->
<script>
window.onmessage = async (event) => {
  const msg = event.data.pluginMessage
  if (msg.type === 'networkRequest') {
    const ws = new WebSocket('ws://localhost:3055')
    ws.onmessage = (e) => {
      window.parent.postMessage({ pluginMessage: { type: 'networkResult', data: e.data } }, '*')
    }
  }
}
</script>
```

Two gotchas worth flagging to the AI up front:
- **Null origin / CORS**: plugin iframes run with a `null` origin. External APIs must send `Access-Control-Allow-Origin: *` (or your equivalent) or the response is blocked even though the request goes out. This is why a purely local WebSocket bridge (no CORS involved) is the simplest reliable transport — it's exactly why the reference projects in section 5 use WebSocket over HTTP.
- If you ever need a **non-null origin** (e.g. for OAuth), you load a real hosted page inside `figma.showUI()` via `window.location.href`, and that domain must be in `allowedDomains`. Not needed for a pure localhost bridge.

---

## 5. Your specific goal: bridging opencode to a live Figma file, without Figma's official MCP Server

**Why not Figma's official Dev Mode MCP Server?** It's a separate Figma-hosted product aimed at giving *any* MCP client read-mostly design context (metadata, generated code, variable/token data) from a file. It doesn't give live, bidirectional control of the open canvas (current selection, real-time edits, custom commands) — that only exists through the Plugin API, which only runs *inside* the Figma app. So building your own plugin-based bridge is the correct call for what you're describing, not a workaround.

**Proven architecture** (this exact 3-piece shape is used by several open-source "AI agent ↔ Figma" projects — build yours as a variant of it rather than from scratch):

```
opencode CLI  ──(stdio, MCP)──>  Bridge process (Node/Bun)
                                        │
                              WebSocket server, localhost:3055
                                        │
                        Figma Plugin — ui.html (WebSocket client)
                                        │  postMessage
                        Figma Plugin — code.js (figma.* API)
```

- The **bridge process** is a small local program you write. It speaks MCP over stdio to opencode on one side, and runs a plain WebSocket server on the other. Current design is **codeless single-connection**: the plugin auto-connects over WS on load (no codes, no channels, one Figma file at a time), while the bridge exposes an HTTP link API (`GET /file` → live JSON + instructions, `POST /api/<command>`) and an MCP stdio server. There is no `join_channel`/channel handshake.
- opencode has **native local MCP server support** — add your bridge to `opencode.json`:
  ```json
  {
    "$schema": "https://opencode.ai/config.json",
    "mcp": {
      "figma-bridge": {
        "type": "local",
        "command": ["node", "/absolute/path/to/bridge/server.js"],
        "enabled": true
      }
    }
  }
  ```
  Once enabled, its tools (whatever you define — `get_selection`, `create_frame`, `set_text`, etc.) show up to opencode's LLM alongside its built-in tools.
- The **plugin's UI iframe** is a thin WebSocket client that connects to your bridge on load, forwards incoming commands to `code.ts` via `postMessage`, and relays results back out over the socket.
- The **plugin's main thread** (`code.ts`) does the actual `figma.*` work (read selection, create/edit nodes, export assets) and returns results to the UI.

**Reference implementations worth cloning and reading (not just skimming) before writing your own:**
- `github.com/grab/cursor-talk-to-figma-mcp` — actively maintained, MIT, ~6.5k stars. Has the exact three-piece structure above (`src/talk_to_figma_mcp/` = MCP server, `src/cursor_mcp_plugin/` = the Figma plugin incl. its manifest.json, `src/socket.ts` = the WebSocket relay). Originally built for Cursor/Claude Code — swapping in opencode's MCP config is a small change, the Figma-side plugin code is reusable as-is.
- `github.com/uxmynd/figma-desktop-bidirectional-mcp` — same idea, additionally exposes a plain HTTP REST bridge (port 3056) alongside the MCP/WebSocket path, useful if you'd rather have opencode call plain HTTP endpoints instead of speaking MCP directly.

**Practical starting point**: fork one of the above, strip it down to the handful of commands you actually need (e.g. get selection, read node tree, create/modify nodes, export), then point opencode's `mcp` config at your fork's server entry point instead of the original's.

---

## 6. Known landmines (pulled from real bug reports — hand this list to the AI as a pre-flight checklist)

- `figma.currentUser` throwing "permission not specified" → add `"currentuser"` to `permissions` in manifest.json.
- CORS errors despite `allowedDomains: ["*"]` → `"*"` requires a non-empty `reasoning` field, and CORS errors can also mean the *server* isn't sending `Access-Control-Allow-Origin`, not a manifest problem — check the response headers, not just the manifest.
- `allowedDomains: "none"` (string) is invalid — must be `["none"]` (array).
- Silent network failure from `code.ts` → network calls are only possible from the UI iframe; this isn't a bug, it's the sandbox boundary (see section 1).
- `FormData` / some newer fetch options behaving oddly inside the plugin's invisible-iframe worker → keep the network worker's request code simple (plain `XMLHttpRequest` or basic `fetch`), do heavier processing after the data reaches `code.ts`.
- Deprecated sync document APIs throwing when `"documentAccess": "dynamic-page"` is set → this is expected; migrate to the async equivalents (`getNodeByIdAsync`, etc.) rather than removing the manifest flag.
- WebSocket disconnecting unexpectedly in long-running sessions → build reconnect/retry logic into `ui.html`'s WebSocket client; the plugin UI can be backgrounded/reloaded by Figma under some conditions.

---

## 7. Link reference

**Bridge link API** (verified against `bridge/server.js`; codeless, no channels — the plugin auto-connects, one Figma file at a time):

- `GET /health` → plain-text `ok`.
- `GET /status` → `{connected}`.
- `GET /file?depth=N` (N clamped 0–5, default 2) → the link blob `{ok, link, instructions, api_base, commands (156, derived from TOOLS), for_browser_ai, document, selection, tree, components (≤100), styles {paints|texts|effects|grids ≤50}}`. Fails loud (502 + hint) only when document+selection+tree ALL fail; partial failures return 200 with per-section `{error}`.
- `GET /selection` → `{ok, result}`.
- `POST /api/batch` (body `{calls:[{tool, arguments}], parallel?, stopOnError?}`) → 1–32 calls in one round-trip.
- `POST /api/<command>` (body `{"params":{...}}`).
- Legacy `FIG-XXXX` URLs (`/file/:code`, `/selection/:code`, `/api/:channel/:command`) → 410.

**External docs:**

- Root docs index: `https://developers.figma.com/llms.txt`
- Plugin API full index: `https://developers.figma.com/docs/plugins/llms.txt`
- Plugin API home: `https://developers.figma.com/docs/plugins/`
- Manifest reference: `https://developers.figma.com/docs/plugins/manifest/`
- How plugins run: `https://developers.figma.com/docs/plugins/how-plugins-run/`
- Making network requests: `https://developers.figma.com/docs/plugins/making-network-requests/`
- `figma` global object reference: `https://developers.figma.com/docs/plugins/api/figma/`
- Node types index: `https://developers.figma.com/docs/plugins/api/nodes/`
- Typings: `github.com/figma/plugin-typings`, `npmjs.com/package/@figma/plugin-typings`
- Official samples: `github.com/figma/plugin-samples`
- Reference bridge implementations: `github.com/grab/cursor-talk-to-figma-mcp`, `github.com/uxmynd/figma-desktop-bidirectional-mcp`
- opencode MCP config docs: `https://opencode.ai/docs/mcp-servers`

---

## 8. Checkpoint 2026-09-27 — shippable, works, continue here (PAUSED 25-tool job)

Working state: all checks green (`tsc --noEmit`, `node --check code.js/bridge/server.js/setup-opencode.js`). Old 30 tools unaffected. Safe to zip/use now.

Shipped this session (code.js rebuilt):
- ui.html: channel + server URL persist via localStorage, onclose hint uses live URL.
- start-bridge.bat: `.bridge-port` persist, rebuild-if-stale (code.ts newer than code.js), setup errors shown via %TEMP%\oc-setup.log.
- setup-opencode.js: exit 1 on corrupt config.
- code.ts dynamic-page fixes: loadAllPagesAsync before components, getVariableByIdAsync, getVariableCollectionByIdAsync, setCurrentPageAsync, createVariable takes collection object, depth/scale clamps, font guards.
- bridge/server.js: double-register eviction (same ws re-register drops old channel).

Paused work — 22 new code.ts commands CODED + BUILT but NOT wired into bridge/server.js TOOLS/COMMANDS yet (old MCP list still 30). They work over HTTP POST /api/<ch>/<cmd> today, not via tools/list. To continue: add the 22 names to COMMANDS (27->49) + TOOLS (30->52) with required INSIDE inputSchema, keep default forward path, then update skill/figma-bridge/references/tools.md + SKILL.md list, then live-test each on a CAP TEST page with plugin re-run.
New names: get_dev_resources, attach_dev_resource, inspect_css, create_version_history (save-only), scroll_to_node, add_to_selection, clear_selection, get_canvas_view, set_layout_constraints, set_layout_positioning, create_boolean_operation, create_vector (blank+network), set_image_fill (hash-only), toggle_layer_mask, set_variable_code_syntax, bind_variable_to_property, set_variable_alias, get_variable_modes, create_variable_mode, update_variable_mode (rename/remove), batch_update_variables (non-atomic loop), set_node_variable_mode.
CUT (do not implement, REST/absent): get_code_connect_snippets (0 hits in plugin-api.d.ts), create_comment + get_file_comments (REST-only, sandbox has no fetch).
Live verified on FIG-GYKS: components + variables + create_page select:true pass. create_variable needs one more plugin re-run (col-object fix built, not yet loaded in Figma).

## 9. Checkpoint 2026-09-28 — 25-tool job DONE (bridge wired, docs done, P1 fixed)

52 MCP tools wired (TOOLS 30->52, COMMANDS 27->49), docs updated (tools.md + SKILL.md), P1 persist fixes applied (vector no-orphan, group/boolean respect parent, image-hash guard, version title required). Bug loop 2026-09-28 SHIP IT: pending-hang-on-close fixed (rejectPendingForWs + ws error handler, exit only pre-listen), /file reads parallelized (wall max not sum), over-cap POST returns 413 JSON, resolveChannel upper-trim normalized, >100 ids/updates rejected, ui connect validates URL/channel with WS-ctor guard + backoff 1s/2s/4s stop-after-5. All checks green (tsc, code.js, server.js, setup). CUT round: unbounded getLocalVariables/serialize breadth, resolveParent throw, numeric/font clamps, /api allowlist, proxy taxonomy, MCP buf cap, reconnect/copy/setup polish — each with repro steps in session.

## 10. Skill Start flow (AI-led connect, no bat)

SKILL.md leads with a Start section, and the flow is codeless: invoke the `figma-bridge` skill → call `get_status` → if no plugin is connected, ask the user to run the `oc mcp` plugin in Figma (it auto-connects, nothing to paste) → then work, starting with `get_document_info` for a one-line summary. No codes, no channels — `list_channels`/`join_channel` do not exist. MCP flow needs no bat (stdio-spawned bridge owns port 3055 itself, or proxies if the bat owns it); the bat is link-flow-only.

## 11. Checkpoint 2026-09-28 — GUI overhaul SHIP IT (codeless connect + Figma chat)

ui.html remade (no subtitle, no code field, responsive, server under Advanced, chat panel with Send + AI replies). Protocol is codeless single-connection: plugin auto-connects with zero input, GET /file, POST /api/<cmd>, GET /status, GET /messages; legacy FIG routes return 410. MCP is 53 tools (join/list removed, get_status + get_gui_messages + reply_to_gui added), zero channel params (legacy ignored). Chat loop is POLLING ONLY: Figma typing queues on bridge (cap 50), agent fetches via get_gui_messages each turn per skill turn-check, replies via reply_to_gui. Limits: one open Figma file at a time; agent never pushed-to — idle sessions see nothing until they poll. Bug-hunter SHIP IT after FIX FIRST round (evict reject, send try/catch, export guards, docs rewrite). All checks green.

## 12. Chat removed, buttons 16px (2026-09-28)

In-plugin chat panel deleted (ui.html panel + send/reply branches), bridge queue + get_gui_messages/reply_to_gui + GET /messages + POST /reply deleted (MCP back to 51 tools), skill turn-check deleted. Plugin buttons now 16px radius. Re-run plugin to load.

## 13. Minimize button (2026-09-28)

Topbar with chevron toggle at top-right shrinks panel to a slim bar via figma.ui.resize (340x64 collapsed, 340x520 expanded); code.ts handles local-only resize command. Re-run plugin to load.

## 14. Prototype tools + app wired (2026-09-28)

code.ts: add_prototype_link {nodeId, destinationId, transition?} (ON_CLICK→NAVIGATE via setReactionsAsync, appends) + clear_prototype_links {nodeId}. Bridge: both in TOOLS (53 total) + COMMANDS. Docs updated. All 5 app screens uniform 393×988. 17 live links verified: 4 tab bars × full mesh (minus self-links) + Settings back→Profile. Present from App–Home to play.

## 14. Source sync + GUIDE.md + app grid (2026-09-28)

Skill synced to global install (~/.config/opencode/skills/figma-bridge). GUIDE.md added (setup/use/build/landmines for AI + humans). Test app home is now a 2x2 grid, greeting removed.

## 14. Demo app test/app (2026-09-28; root RELOCATED 2026-10-01)

Built from frame iPhone 16 - 1 (393x852) + design-system tokens into `<Desktop>\figma plugin\test\app\`: styles.css (tokens), app.js (localStorage cart), index.html (home), dish.html (1:1 responsive port), cart.html (steppers/totals). Assets in `<Desktop>\figma plugin\test\assets\`: hero.png (2x export of Rectangle 2), wifi.svg, battery.svg, star.svg (exact vectors; star is yellow #FFE100). Emoji placeholders still used for search/cart/back icons — owner adding real 24px icons in Figma next. DONE 2026-09-28: home cards 2-col grid, greeting header removed; icon swap pending.

## 15. test folder relocated + mobile-app session (2026-10-01)

RELOCATION: `<Desktop>\test\` → `<Desktop>\figma plugin\test\`. Plain Move-Item failed (dir handle locked, "Access to the path denied"); `robocopy /E /MOVE` succeeded (exit 1 = ok), source removed, all 8 subfolders (app, assets, desktop20, desktop3, hargrove, kerney, mobile-app, newportfolio) + root index.html intact. All `Desktop\test\...` paths in this file now resolve under `Desktop\figma plugin\test\...`.

SESSION on `figma plugin\test\mobile-app\` (React-in-HTML burger app, no build step — script type="text/babel"; verify with `npx --yes esbuild <file> --outfile=<tmp>` for both the extracted JSX block and styles.css; PowerShell blocks npx.ps1 → call `npx.cmd`; esbuild writes progress to stderr, exit 0 = pass):
- Settings rows: `.setrow .val` got inline-flex + centering (baseline misalignment bug); values editable inline — address is a tap-to-type input, Diet/Language open a centered modal dropdown (`.sheet-back`/`.sheet` in styles.css: group-vibe card = #f1f1f4 fill, 2px --line outline, 16px radius, 2px full-bleed dividers, white hover fill on options).
- Modal glass: sheet itself is `rgba(255,255,255,.7)` + `backdrop-filter: blur(20px) saturate(180%)` + 1px rgba(255,255,255,.4) edge; overlay is lighter blur+dim. Overlay MUST stay `position:absolute; inset:0` inside `.phone` (which is `position:relative`) so blur covers ONLY the app screen, never the whole browser window — do not change back to `fixed`.
- Status bar (time/date/signal/battery) deleted from index.html + styles.css (component, usage, `.statusbar` rules).
- Search rebuilt like a real app: 320ms-debounced cross-dish search (name/tags/cat/desc, not chip-trapped) with shimmer skeleton rows, autofocus, clear × button, Esc clears, idle state = Recent (clock icon + Clear) + Popular chips, "All" chip is default (category browse only when a chip is picked), empty state with Clear search / All categories buttons. New icons: `x`, `clock`, `check`; new state: `busy` via useEffect, `submitRecent(term)` accepts a term arg, `clearRecent`.
- Order-placed card restyled to the settings-group vibe: `.placed` = group shell, header row (✓ Confirmed), divider rows Status (green dot) / ETA / Total paid, final `.setrow` action "Back to home" with chevron + white hover.
- Viewport uniformity pass: DELETED the `@media (max-width:360px)` block (small phones must not restyle), replaced `clamp(...,5vw,...)` detail h1 with fixed `--text-xl`, replaced `.valedit` `46vw` cap with fixed 240px + `flex:1;min-width:0` on `.setrow .val`. No rule may scale with viewport width again; shell stays capped at 430px.

## 16. Rational batch multi-call (2026-10-01) — bridge-side, no plugin rebuild

New MCP tool `batch_tools` + HTTP `POST /api/batch` (body `{calls:[{tool,arguments}], parallel?, stopOnError?}`): up to 8 calls in ONE round-trip, sequential by default (plugin `onmessage` has no queue — concurrent writes would interleave), `parallel:true` only fans out when EVERY call is in the read-only allowlist (max 4 at once), `stopOnError` defaults true, no nesting, 5MB total byte budget with truncation marker (raised from 200k on 2026-10-01 per request; MCP text cap for batch raised to match, single calls stay 200k), response carries `mode` + `stoppedOnError`. Single-call path untouched — small tasks call tools directly (skill + tool description say so). `POST /api/batch` route sits BEFORE the generic `/api/<command>` matcher or "batch" would forward to Figma. Refactored both POST routes onto a shared `readJsonBody` (5MB cap; 413/400/empty-body behavior unchanged). Docs: SKILL.md (95→96 tools, routes, Rules bullet), tools.md (HTTP line + Session entry), GUIDE.md (51→96). Verified: `node --check` clean + live probe on port 3059 (tools/list 96, empty/9-call/unknown/nested/bad-JSON all reject correctly, health 200). Bug-hunt SHIP IT.

## 17. Compact protocol — small packets, same quality (2026-10-01)

Agent token emission was the real latency (localhost is free; Figma ops are 100-500ms). Bridge-side, backward compatible, no plugin rebuild: short tool aliases (`frm/txt/tree/sel/doc/del/mov/batch/…`, 24 total) + short keys (`n/w/h/f/p/t/s/id/ids`, long form wins) expanded in `callTool` + HTTP routes; `_slim:true` strips `fills/strokes/effects/absoluteBoundingBox/exportSettings` + caps `characters` at 200. Measured live: emitted packet −24% (grows with batch size), depth-1 tree −8%, depth-3 burger page 1.85MB→1.59MB (−14%). Bug caught by probe: `runOne` validated raw names so ALL aliases died in batch (+ parallel gate fell back silently) — fixed by expanding before validation. Docs: tools.md Compact section, SKILL bullet, link instructions line. Single calls + full names untouched.

## 18. Slim-default trees + fetch discipline (2026-10-01, AGENTS.md rounds)

Spec round caught planner staleness: another hand had ALREADY shipped fields picker (`pickFields`/`FIELDS_ALWAYS`), depth-2 default both paths, and the fetch-discipline docs — spec verified with file:line refs instead of trusting memory. Gate CUT depth/fields rebuilds; kept: (a) slim-by-default on `get_node_tree`/`get_node_by_id` with `_full:true` opt-out (`SLIM_DEFAULT_READS`, stripped from both forward paths, advertised in schemas), `get_selection` stays full; (b) skill rule "state call plan with a count before executing". Measured live: bare burger tree 1.37MB no fills/strokes/effects vs 1.61MB full (−15%); depth-1 page 26.7KB slim. Bug-hunt SHIP IT + 2 lows fixed (export `_full`/`fields` strip hygiene, fields+slim render-keys caveat documented). Regression probes green (empty/9-cap/alias/long-form/export-SVG). Call-plan-with-count is now also planner behavior, not just skill text.

## 19. Four free optimizations (2026-10-01, AGENTS.md rounds)

+6 key aliases (`cr/lm/sp/pad/ff/fs`, docs both places), sequential-only read dedup (expanded-name + BATCH_READ_ONLY gate, ok-only cache, `deduped:true` copies, budget/stop unchanged), parallel fan-out 4→6, session-static-info fetch-once rule in tools.md. Measured live: aliases apply (HORIZONTAL/gap-8/pad-16 frame built via shorts), duplicate read returns identical payload with `deduped:true`, duplicate writes still execute twice (2 distinct ids, file cleaned), 6-wide parallel all green. Bug-hunt SHIP IT (1 LOW info: shallow copy of cached result — unexploitable, no in-batch mutation; revisit only if results ever get mutated post-cache).

## 20. Remaining-tools sweep C1-C6 (2026-10-01, spec→gate→5 coder rounds→review)

Audit vs pasted Figma API list: 95 handlers → 120 tools (+24 net: batch_tools/get_status/ping_figma counted in TOOLS). Added: set_text_range, edit_text_chars, list_fonts (+alignVertical/autoResize on set_text_props with CORRECT WIDTH_AND_HEIGHT enum), get_style_by_id, GRID create+list, import_style, import_variable, import_component(+set), get_main_component, reset_instance, edit_component_prop_def (d.ts-verified), import_image (base64Decode, NOT createImageAsync), get_image_bytes (1.5M cap), notify, undo, client_storage, node_data, watch_document (opt-in documentchange forward; bridge log path needed zero changes), flatten_nodes, get_selection_colors, find_nodes (100-cap), set_layout_grids (50-cap), rescale_node (0-100 cap), outline_stroke, create_text_path; extensions: set_fills IMAGE+gradient-schema, set_strokes align+sides, set_layout GRID+sizing/counterAxisSpacing, SLOT prop defs, TIMING/EASING vars. CUT with reasons: createImageAsync(url) (no network in sandbox), commitUndo (meaningless across messages), pattern fill (no simple ctor), variable fonts (no API), align/distribute/tidy (no API), pen/pencil/builder/simplify (no creation API), comments (REST-only), edit_text_chars input 20k cap + rescale/grid caps added post-review. textAutoResize=WIDTH_AND_HEIGHT (not WIDTH) caught by spec. §39.8 conflict (figmatools.md bans loadAllPagesAsync/setPluginData/createImageAsync): loadAllPagesAsync stays INTERNAL-only (guarded, required for full-file inventory under dynamic-page); setPluginData exposed deliberately via node_data (explicit keys); createImageAsync ban complied with via base64Decode path. SKILL 120 + GUIDE 120 + tools.md sections + link instructions all updated. Live probes PENDING user plugin re-run (code.js rebuilt, never loaded in Figma yet).

## 21. Standing rules (consolidated from root + oc mcp AGENTS.md, 2026-10-01)

Planner owns todos + memory (this file), dispatches specialists, merges, talks to user. Rounds: spec→gate→code→review; skip only when trivial. Budgets: spec 1 pass/2 files, coder 1 concern/<100 lines, bug-hunt 5 items + SHIP/FIX verdict. Evidence before synthesis; verify-then-edit; compile-check every edit (tsc + node --check, zero output = pass); no commits/config changes unless asked. PowerShell: no && (use ;), npx.ps1 blocked → node direct / npm.cmd / wscript for hidden. Bridge: single owner on 3055 or proxy-mode; MCP stdout sacred (stderr logs only); sendToFigma stays async. Figma: manifest edits need re-IMPORT, code.js/ui.html need re-RUN; dynamic-page → async node APIs; fonts load before text mutation; single Figma socket: a new plugin run replaces the old connection and rejects its in-flight requests; keep one plugin window open. Windows filenames case-insensitive (never same-name-different-case files).

## 19. Four free optimizations (2026-10-01, AGENTS.md rounds)

+6 key aliases (`cr/lm/sp/pad/ff/fs`, docs both places), sequential-only read dedup (expanded-name + BATCH_READ_ONLY gate, ok-only cache, `deduped:true` copies, budget/stop unchanged), parallel fan-out 4→6, session-static-info fetch-once rule in tools.md. Measured live: aliases apply (HORIZONTAL/gap-8/pad-16 frame built via shorts), duplicate read returns identical payload with `deduped:true`, duplicate writes still execute twice (2 distinct ids, file cleaned), 6-wide parallel all green. Bug-hunt SHIP IT (1 LOW info: shallow copy of cached result — unexploitable, no in-batch mutation; revisit only if results ever get mutated post-cache).

## 22. Live verification of all 24 (2026-10-01, user re-ran plugin with new code.js)

10 batches, ~40 calls, everything self-cleaned. PASS: set_text_range, edit insert+delete, list_fonts (200 cap hit), alignVertical/autoResize (+WIDTH rejected correctly), find narrow (1 hit) + over-100 cap, sel-colors, node_data set/get, stroke to outline (vector id back), rescale, image import to bytes byte-identical round-trip, main-component lookup, reset, prop-def add+edit (on variant set - Figma restricts editing to that context, error surfaced faithfully otherwise), frame GRID + counterAxisSpacing, storage set/get, watch on/off, GRID style create+get, editorType=figma, bogus library imports fail with Figma's own messages, flatten to textpath chain. Quality fix from probes: set_layout_grids now fills per-pattern defaults (COLUMNS/ROWS: STRETCH/24/12/0, GRID: sectionSize 100) so minimal input works. Real bug found by probes: findStyleById missed grids, grid-style delete failed; fixed (one line) + tsc clean. Leftovers resolved post re-run: Probe/Grid style deleted clean, zero probe nodes remain; 1px probe image hash + client_storage probe key are invisible residue. Deliberately untested: undo (would destroy user work), library-import happy paths (no keys). Improvement ledger: emission -24%+, reads -8 to -15% default-slim, round-trips /8 via batch, 5MB/8-call/dedup rails; floor remains Figma op time (100-500ms, sequential writes by sandbox design).

## 23. PawPals landing in Figma (2026-10-01)

Dog-match landing page built live on new page 'PawPals Landing': 1440 master (9 autolayout sections: nav, hero, press strip, 3 steps, 2x2 features, breed pills, testimonials, terracotta CTA band, cocoa footer) + cloned 1024/768 variants that genuinely reflow (FILL rows/cards, hug containers). Tokens: cream BG, cocoa ink, terracotta primary, Inter Medium base (no light weights per user). Lessons: set_layout padding without layoutMode is a no-op (buttons stayed 100x40) - always set flow; rects can't take FILL sizing (divider removed); hug frames ignore direct height sets (use sizingVertical FIXED first); export+read PNG loop caught all of it. Verified via PNG inspection at all 3 widths.

## 24. PawPals wireframe build (2026-10-01)

User rejected the free-designed landing (AI taste miss) and pointed at their own wireframe (selected Desktop-1 frame). Read it via get_selection + export PNG: nav row, centered caps headline, left dog tile + CTA under it, right tall person+dog tile. Rebuilt 1:1 on new page 'PawPals Hero' (same 1440x1024 geometry, warm tokens, caps headline kept, Inter Medium, photo placeholders as tinted tiles with annotations since image upload needs bytes). Multi-size via clone + rescale_node (0.7111/0.5333 - works on frames, true proportional variants), verified by PNG at all widths. Lesson: wireframe-first beats free design for AI taste gaps; export-and-look beats tree-reading for wireframes.

## 25. PawPals on user design system (2026-10-01)

Read their tokens live (styles + variables + components, 3 parallel batches): spacing/type/leading/weight scales, gray+indigo primitives, semantic aliases (bg/surface/text/border/accent), radius scale, elevation sm/md/lg, button-base + button-xl variant sets. Rebuilt hero on new page 'PawPals DS' using tokens only (no invented colors): bg-default bg, text-primary/secondary, accent-600 CTAs, gray-100 photo tiles, radius-full pills, radius-xl cards, text scale sizes, Medium base. Gold standard applied: 5 variable binds (bg, dot, both CTAs, headline) + elevation-md effect style on tiles. Two catches: apply_style ids carry a trailing comma (dropped it once, failed, fixed); button-base instances skipped (fixed component size vs wireframe geometry - tokens win). 1024/768 rescale clones verified by PNG.

## 26. PawPals rest-of-site (2026-10-01)

Selection was empty so continued from the approved DS hero on the same page: 7 sections below it (press strip, 3 steps, 2x2 features with elevation-sm cards, breed pills, testimonials, accent CTA band, dark footer) - all tokens, Medium+ only, on-scale sizes. Full-page PNG export verified clean. Process note: >8-call batches fail empty (foot-b lesson, now habit); doc/tree calls return data not ids (ids-vs-results trap caught twice); page-level export works for full-page review.

## 27. PawPals about/reviews/footer pass (2026-10-01)

Shifted lower sections +620 to insert About (story, 2023/48k/4.9 stats, photo tile); upgraded testimonials to Reviews with amber star rows; extended footer band + newsletter signup row. Full-page PNG verified clean, no overlaps.

## 28. Review cards rebuild (2026-10-01)

Replaced thin testimonial blocks with real review cards (avatar initial, name, owner role, amber stars, quote, elevated white cards); shifted CTA+footer +60 for rhythm. Full-page PNG verified.

## 29. Portfolio review cards (2026-10-01)

New review cards on portfolio page in its own style (black bg, avatar initials tile, gray quote, white name, Google Sans Flex Medium): 3 rows at y4800-5420 in the gap below existing testimonials. Full-page export too big (truncated) - verified via single-card PNG export instead.

## 30. Session close-out, resume state (2026-10-01 evening)

All docs re-verified against code today. TOOLS=120 everywhere (bridge, SKILL, GUIDE, link). README rewritten (channel/FIG-XXXX flow removed; auto-connect + silent-start current). Global skill re-synced from repo (was 30-tool stale). tools.md notes grid defaults. No code changes pending.
LIVE STATE: bridge hidden on 3055 with latest server.js (restart after every server.js edit; kill PID on port + wscript ensure-bridge.vbs). Plugin running latest code.js (user re-ran; grid-delete proof). MCP configs global+repo point at real server.js. File 'design system (Copy)': PawPals DS page = hero + full site (about/reviews-3/newsletter footer), PawPals Hero/Landing pages intact, portfolio page +3 review cards, main has Batch Demo (autolayout), Burger v2 page deleted.
OPEN (deliberate): undo untested (destroys work), library-import happy paths (no keys), shallow-copy future-proof, invisible residue (1px image hash, storage probe key). Next session: say connect; bridge self-boots via skill step 0.

## 31. Motion demo prototype (2026-10-01)

5-frame Smart Animate loop on new 'Motion Demo' page (M1 idle far cursor, M2 mid, M3 hover-lift, M4 dark press + click dot, M5 ripple release): AFTER_TIMEOUT chain (0.5/0.7/0.45/0.3/1.4s) with SMART_ANIMATE (ease-out glide, 0.12s ease-in press snap). Correct reaction shape is trigger{}+actions[{type:NODE...}] (NOT action:{type:NAVIGATE}); easing enum is EASE_IN_AND_OUT. Flow start point NOT set remotely (API needs current page) - user presents from M1. Verified via get_reactions read-back + PNG.

## 32. PLUGIN SWEEP COMPLETE + stable resume state (2026-10-01, AGENTS.md rounds)

Final tally 157 tools (120 + motion 7 + media/measure/slots 12 + text 3 + vars/lib 6 + text-list 2 + layout/shape 4 + meta 5 + extensions). Key points: MOTION (Beta) tools shipped with compat shim (all mutation paths via motionNodeCall/motionRoot); keyframe input uses friendly names + physical-spring->bounce bridge; video export (MP4/GIF/WEBM); library imports; base64 image round-trip; find_nodes criteria incl pluginData; grid styles in get/delete; text truncation/wrap/list ranges. Cut with documented reasons: createImageAsync, commitUndo, pattern paint, createCustomAnimationStyle (absent in installed v1.138 typings), shape-builder/simplify/pen APIs, comments (REST-only). All docs (SKILL/GUIDE) say 157 + file pointer. Bug-hunter across rounds: SHIP IT except the 3 pre-emptive Lows (export_node _full hygiene, fields+slim ordering caveat, strict true) all handled.

## 33. Checkpoint 2026-10-17 — optimization pass: tiers, receipts, panel, honest writes (all verified)

- Bridge (`bridge/server.js`, 878 lines): write receipts — mutating tools return `{id, name, type}` by default, `_echo:true` (per call or top-level on batch) restores full; report keys `applied`/`mismatched`/`restoredChildren` survive receipts via `RECEIPT_KEEP`. Detail tiers injected by the bridge: writes → `_detail:"receipt"`, `get_node_tree`/`get_node_by_id` → `"struct"`, other reads unchanged; explicit `_detail`/`_full`/`fields` win; `fields` skips the slim pass. Batch cap 8→32 (`BATCH_MAX_CALLS`), single-sourced; advertises `COMMANDS` DERIVED from `TOOLS` (156). New `format:"panel"` on `get_node_tree`/`get_node_by_id`/`get_selection`/`get_current_page` → `{panel, lines}` indented text; invalid format throws; `export_node`'s `format` is carved out. MCP schemas now advertise `limit`/`textContains`/`textEmpty`, `format`, `preserveChildLayout`.
- Plugin (`code.ts`, 2859 lines; `code.js` rebuilt by tsc): `serializeNode` detail tiers `receipt`/`struct`/`full` (struct drops fills/strokes/effects/transforms/vector/export/… and skips `styledTextSegments` + per-range calls). Colors `#rgb`/`#rgba`/`#rrggbb`/`#rrggbbaa`/`{r,g,b}`; 8-digit hex keeps RGB+alpha; invalid colors THROW; fill is validated BEFORE node creation in all four `create_*` builders (no orphan nodes). `find_nodes` returns `{total, returned, truncated, matches:[{id, name, type, path}]}` with `textContains`/`textEmpty`/`limit` (default 100, clamped 1..1000). Honest writes: `applied`/`mismatched` from read-back; `set_layout {preserveChildLayout}` snapshots/restores children across `layoutMode` changes; `restoredChildren` counts only real drift; restore failures surface as `child[<id>].<key>` in `mismatched`; `get_selection` honors the tier.
- Verification: tsc clean, `node --check` clean, 157 tools, regression battery (tiers/fields/panel/smoke) + mock harnesses (colors, find_nodes, layout drift, fill-before-mutation) all green; two cold-review rounds fixed an orphan-node defect and a fields-vs-slim conflict.
- Activation: restart the bridge (it loads `server.js` once at startup) and RE-RUN the plugin in Figma (loads new `code.js`).
- Pending/open: a "security token" item was approved in earlier planning but no spec exists anywhere in the repo — deliberately NOT implemented; the design carry-over (leadingTrim `CAP_HEIGHT` on variants `2084:48` and `2084:143`) is still open.

**RESUME (for next session):**
1. Say 'connect' = skill path; health check first; if DOWN, wscript bridge/ensure-bridge.vbs silent (skill step 0).
2. Plugin running = MCP flows via stdio; for HTTP flows start bridge bat if you want a window.
3. tool count: 157 (tools/list is authoritative; a raw `name:` grep over server.js hits 162 — serverInfo + non-TOOLS matches included, do not trust it). Probe via POST /api/batch {calls:[{tool:'st'}],parallel:true}.
4. This file (checkpoint 33) + SKILL.md + references/tools.md are the resume documents; README rewritten (no more FIG-XXXX).
