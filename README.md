# figcontext — Figma ↔ AI bridge (no usage limits)

A simple file that lets your CLI know what's going on in your Figma file using the Figma plugin API. The plugin and bridge themselves are named **oc mcp**.

Let opencode, Claude Code, Cursor, or any AI **read your open Figma file and change it**. No Figma Dev Mode MCP, no 6/month limit.

The plugin auto-connects — no codes, no channels, nothing to paste.

---

## Setup — 3 steps (2 minutes, first time only)

**1. Install Node.js** — get LTS from `https://nodejs.org` (skip if you already have it).

**2. Start the bridge** — either double-click `start-bridge.bat` (keeps a window open, says `[bridge] listening ws://localhost:3055`), or run `bridge\ensure-bridge.vbs` once for a hidden background start. After editing `server.js`, restart the bridge — Node loads the file once at startup.

**3. Add the plugin to Figma** — in Figma Desktop open any file:
- `Plugins → Development → Import plugin from manifest…` → pick `manifest.json` in THIS folder (re-import only if `manifest.json` itself changes)
- Then `Plugins → Development → oc mcp` → it connects by itself and stays connected while its window is open

Done. Restart opencode/Claude/Cursor once so it loads the bridge (`node setup-opencode.js` already merged the MCP config).

> Port `3055` is automatic — only change it if that port is busy. If two bridges end up on one port, the second becomes a proxy instead of crashing — keep just one open to avoid confusion.

---

## Everyday use — 3 steps (30 seconds)

**1.** Make sure the bridge is up (`http://localhost:3055/health` says `ok`).

**2.** In Figma run `oc mcp` — it auto-connects (keep its window open; it reconnects by itself if the connection drops).

**3.** Paste the link (`http://localhost:3055/file`) to ANY AI and tell it what to do:
- `this is my Figma file: <link> — code the hero section in React`
- `<link> — add a red button under the headline`
- `<link> — what components and styles are in this file?`

The AI reads the live file from the link and posts changes back. Re-fetch the link for fresh state — never work from memory.

**Power (no link, MCP tools):** in opencode just say `connect` (or `get_status`, then `get_document_info`) — then `get my selection and code it`, `create a frame`, etc. 157 tools, same names over HTTP (`POST /api/<command>`) and MCP.

---

## Share a public link (browser AI like ChatGPT/Claude.ai)

Local links only work on your PC. To share:

1. Make sure the bridge + Figma plugin are running.
2. Get `cloudflared.exe` once from `https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/` → drop it in this folder.
3. Double-click `share-link.bat` → keep open → it prints `https://something.trycloudflare.com` — your share link is `THAT-URL/file`. Paste to Claude/ChatGPT in browser. Close `share-link.bat` to kill the link instantly.

> Browser AIs are READ-only via the public link. Writing still needs the local bridge + CLI.

---

## If it doesn't work

| You see | Fix |
|---|---|
| `ws closed code=1006` looping | Bridge not running — start it (bat or `ensure-bridge.vbs`), then re-run plugin |
| Link says `not connected` / `ok:false` | Plugin window closed — re-run plugin (it auto-connects) |
| `Timed out waiting for Figma` | Plugin window was closed mid-task — re-open plugin, retry once |
| `unknown command: <name>` over HTTP | Bridge is running old `server.js` — restart it to load the new code |
| Port 3055 busy | Close extra bridge windows — only ONE at a time |
| Copy button does nothing | Drag-select the text, `Ctrl+C` (Figma blocks auto-copy sometimes) |

Still stuck? Send: (1) last 10 lines of bridge output, (2) plugin log last 10 lines, (3) AI error text.

---

## Manual / advanced (you don't need this)

```bat
npm --prefix bridge install
npm install
node node_modules/typescript/bin/tsc -p tsconfig.json
node setup-opencode.js              # global config
node setup-opencode.js --project .\my-project
```
The bat does all of this automatically. Only use manual steps for CI or custom paths. (`npx` is blocked by PowerShell execution policy — call `node`/`npm.cmd` directly.)
