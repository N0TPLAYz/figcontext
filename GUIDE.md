# GUIDE.md — oc mcp setup + use (for AI assistants and humans)

`oc mcp` connects an AI coding CLI (opencode, Claude Code, Cursor) to the user's
open Figma file: live read + write, no Figma Dev Mode MCP, no usage limits.

## 1. First-time setup (do once)

1. Install Node.js LTS (`https://nodejs.org`).
2. In Figma Desktop: `Plugins → Development → Import plugin from manifest…` →
   pick `manifest.json` in this folder.
3. Double-click `start-bridge.bat` (keep the window open). It installs deps,
   builds `code.js`, writes the opencode MCP config, installs the skill, and
   starts the bridge (`ws://localhost:3055`).
4. Restart the CLI once so it loads the new MCP server + skill.
5. In Figma, run `Plugins → Development → oc mcp`. It auto-connects.

## 2. Everyday use (no setup)

- CLI: invoke the `figma-bridge` skill, say "start". The agent runs
  `get_status`; if not connected it asks you to run the plugin (nothing to
  paste — it auto-connects). Then it works from your instructions.
- Any CLI via link: copy the link in the plugin panel
  (`http://localhost:3055/file`), paste it to the AI with a task.
- Browser AI: `share-link.bat` (needs `cloudflared.exe`) gives a public
  `https://…/file` link — READ-only.

## 3. Architecture (3 pieces)

```
CLI --(MCP stdio)--> bridge/server.js --(WS localhost:3055)--> ui.html --(postMessage)--> code.js (figma.* API)
```

- `code.ts` → `code.js` (built with `npx tsc -p tsconfig.json`): ONLY place
  that touches `figma.*`. No network (sandbox has none).
- `ui.html`: panel + WebSocket client. Auto-connects, reconnects with backoff.
- `bridge/server.js` (dep: `ws` only): WS server + HTTP link API + MCP stdio
  server in one process. Single connection (latest plugin run wins).
- Logs go to stderr; stdout is MCP framing — never `console.log` in server.js.

## 4. Verify it works

```bat
npx.cmd tsc -p tsconfig.json --noEmit
node --check code.js
node --check bridge/server.js
```

Live (plugin running): `GET /health` → `ok`; `GET /status` →
`{connected:true}`; `GET /file` → live JSON; MCP `tools/list` → 157 tools.

## 5. Adding a new tool (all layers, in order)

1. `code.ts`: implement `cmdX(params)` + `case` in `handleCommand`.
   Use `findNode`/`resolveParent`/`serializeNode`, `ensureFont` for text.
   ES2020, no Node APIs, guard everything fallible.
2. Rebuild: `npx tsc -p tsconfig.json`. Re-run the plugin in Figma.
3. `bridge/server.js`: add to `TOOLS` (`required` INSIDE `inputSchema`) —
   the default `callTool` path forwards automatically. That alone is enough:
   the link's advertised `COMMANDS` is DERIVED from `TOOLS` (bridge-local
   `get_status`/`batch_tools` excluded, `ping_figma` → `ping`, plus `batch`),
   so there is no separate list to maintain. HTTP `POST /api/<command>` picks
   it up automatically (`get_current_page`-style HTTP-only commands need no
   `TOOLS` entry).
4. Docs: `skill/figma-bridge/references/tools.md` + `SKILL.md` list.
5. Verify: checks above + round-trip `POST /api/<cmd>` + MCP call.

## 6. Landmines

- Manifest edits need plugin RE-IMPORT; `code.js`/`ui.html` need only RE-RUN.
- `documentAccess: dynamic-page`: use `*Async` APIs
  (`getNodeByIdAsync`, `loadAllPagesAsync`, `getVariableByIdAsync`,
  `setCurrentPageAsync`). Sync versions throw.
- PowerShell blocks `npm.ps1` — use `npm.cmd`/`npx.cmd`.
- One Figma file at a time (single connection).
- `code.js` is git-ignored — fresh folders MUST build (the bat does it).
- Never create two files differing only by case (Windows).
- Old channel URLs (`/file/FIG-XXXX`, `/api/FIG-XXXX/<cmd>`) return 410 (codes were removed).

## 7. If it doesn't work

| You see | Fix |
|---|---|
| `No Figma plugin connected` | Run the `oc mcp` plugin in Figma (auto-connects) |
| `ws closed code=1006` looping | Bridge not running — start `start-bridge.bat`, keep open |
| Port 3055 busy | Close extra bat windows — only ONE at a time |
| Stale/wrong data | Re-run plugin (loads fresh `code.js`/`ui.html`) |
| MCP tool missing | Restart CLI (loads new `tools/list`), re-run plugin |
