---
name: figma-bridge
description: Read and write live Figma files via the local oc mcp bridge link or MCP tools (selection, node trees, styles, variables, exports, creating frames/text/components). Use when the user pastes a localhost file link, mentions Figma, or wants to code a design or generate layouts in Figma.
license: MIT
compatibility: opencode
metadata:
  audience: makers
  workflow: figma-bridge
---

## What I do

I connect you to the user's **open Figma file** through a local bridge (no Figma Dev Mode MCP, no usage limits). Two ways in — prefer the LINK when the user pastes one:

- **LINK (easiest, works with any CLI):** `http://localhost:3055/file` returns live JSON (document, selection, tree, components, styles) plus machine instructions for POSTing changes back. Fetch it with curl/fetch, then `POST {api_base}/<command>` with `{"params": {...}}`. The same link served over a public tunnel (`share-link.bat`, e.g. `https://xxx.trycloudflare.com/file`) works for browser AIs too — those get an extra `for_browser_ai` field and are READ-only.
- **MCP tools (power):** same 157 tools over stdio (`get_status`, `get_selection`, …). No codes, no channels — the bridge auto-routes to the connected plugin.

## Start (default when the user says start / connect / hooks me up)

This is the normal flow. No bat file, no manual setup, no popups — just drive it:
0. Bridge check: `GET /health` (port from the link, default 3055). If unreachable, start it YOURSELF silently — find `bridge/server.js` via the MCP config (`mcp.figma-bridge.command[1]` in opencode.json → `<repo>/bridge/server.js`), run `wscript <repo>/bridge/ensure-bridge.vbs` (hidden window, no-ops if already up), wait ~8s, re-check. Never ask the user to double-click anything.
1. Call `get_status`. If a plugin is already connected, skip to step 4.
2. If none: tell the user ONE thing — "In Figma, run the `oc mcp` plugin — it auto-connects, nothing to paste." (If they don't have the plugin: import `manifest.json` from the downloaded folder once via `Plugins → Development → Import plugin from manifest`.)
3. Call `get_status` again to verify. If it still reports no plugin, tell the user to re-run the plugin (it auto-connects, keep the window open), then retry once.
4. Call `get_document_info` and reply with a one-line summary (file name, pages, current page). You are now connected — proceed with the task.

Note: in MCP flow the bridge listens on its own (opencode spawns it via stdio, so it owns port 3055 automatically). The user never needs `start-bridge.bat` here — that bat is only for the HTTP link flow below.

## Hard requirements (check before any Figma call)

1. MCP flow (default): nothing to start — the bridge is already listening (spawned via stdio). Just run Start above.
2. HTTP link flow only: the bridge must be running: `http://localhost:3055/health` says `ok` (adjust port if the link uses another). If not, tell the user: double-click `start-bridge.bat` in the downloaded folder and keep it open.
3. The Figma plugin `oc mcp` must be running in the open file (it auto-connects, nothing to paste — keep its window open).
4. No channels or codes — the bridge auto-routes to the connected plugin. If several Figma files are open, keep only the target plugin window open.

On `No Figma plugin connected` / `ok:false` errors: stop, tell the user to re-run the plugin (it auto-connects), then retry once. Do not guess node IDs.

## Link flow (preferred when a link is pasted)

1. `curl -s <link>` (append `?depth=3` for deeper trees, 0-5). Read `document`, `selection`, `tree`, `components`, `styles`, and the `instructions` field — it lists every command.
2. For pixel truth / assets: `POST {api_base}/export_node` with `{"params":{"nodeId":"...","format":"PNG","scale":2}}` (SVG for icons; MCP-only `savePath` makes the bridge write the file itself).
3. To CHANGE the file: `POST {api_base}/<command>` with `Content-Type: application/json`, body `{"params": {...}}`. Example: `curl -X POST {api_base}/create_frame -H "Content-Type: application/json" -d '{"params":{"name":"Hero","width":800,"height":600}}'`.
4. After creating things, `POST {api_base}/set_selection` with the new ids so the user sees the result. Ask before `delete_nodes`.
5. Re-fetch the link when you need fresh state — never work from memory.

## MCP flow (when tools are available and no link was pasted)

1. `get_status` (verify connected) → `get_document_info` (one-line summary of what you found).
2. Read: `get_selection` first, then `get_node_tree { depth: 3 }` (≤4 unless asked for all), `get_local_styles`, `get_local_variables`; `export_node` for images.
3. Write with primitives (`create_frame` + auto-layout, `create_text`, `create_rectangle`, `set_fills`, `set_layout`, `create_component`/`create_instance`, `create_variable_collection`/`create_variable`); `set_selection` afterwards to show results.

## Coding designs (both flows)

Code into whatever language the user asked (default React + Tailwind if unspecified — ask if unclear). Map auto-layout → flex, fills → colors, text nodes → real text with font/size. Fidelity notes: layout, spacing, colors/type via styles + variables transfer well; custom fonts, blurs, complex shadows drift — say so when it happens.

## Full command list

All tool names live in `references/tools.md` (two transports, same names) - trust that file, not memory. Same tools over HTTP: `POST /api/<command>` and MCP.

Arg shapes: see `references/tools.md`. HTTP routes: `GET /health`, `GET /status`, `GET /file?depth=2`, `GET /selection`, `POST /api/<command>`, `POST /api/batch`.

## Motion (Beta)

- Animation lives in `set_manual_keyframes` / `get_node_animations` / `set_timeline_duration` / `apply_motion_style`. All `figma.motion` + `node.*Animation*` access goes through the `MOTION COMPAT` table in `code.ts`.
- **No physics engine.** Anything that must feel physical gets simulated offline and baked as dense keyframes — read `references/motion-recipes.md` BEFORE writing an animation. It has the pinned-tip rig, the rigid-pendulum equations, the ω/ζ tuning table, and the field-shape traps.
- `SCALE_XY`/`SCALE_X`/`SCALE_Y`/`TRANSLATION_XY` need `{type:'VECTOR', value:{x,y}}`, not a number. `OPACITY`/`TRANSLATION_X|Y`/`ROTATION` take plain numbers.
- Sample 30-60 Hz with `easing:"LINEAR"`. Sparse keys + eased interpolation is what makes baked motion look fake.
- Read `timelines[0].id` from `get_node_animations` immediately before `set_timeline_duration`; ids change between builds.

## Rules

- One Figma file per session unless the user says otherwise — keep only the target plugin window open.
- Batch 2+ calls with `batch_tools` (max 32, sequential; `parallel:true` reads-only); a single call goes direct — batch adds nothing for one call.
- Emit compact packets: short tool/key aliases + `_slim:true` on reads (see Compact form in `references/tools.md`). Same results, far fewer tokens.
- Fetch discipline: catalog is cheap, instances are expensive. List first, fetch only what the task touches, only as deep as needed — never whole-page depth ≥ 3 unless asked. Prefer `fields:[...]` for targeted reads.
- State the call plan with a count before executing (e.g. '3 calls: doc, tree id X depth 1, node Y' + why each is needed); fetch narrow, expand on demand.
- Keep trees shallow (depth ≤ 4) unless the user asks for everything.
- Prefer scale 1-2 PNG for screens, SVG for icons.
- After writing to Figma, name the frame/page you made.
- If the connection drops mid-session, tell the user to re-run the plugin (link flow: also check the bat window is still open), then retry once.
