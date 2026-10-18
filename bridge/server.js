#!/usr/bin/env node
// oc mcp bridge — WebSocket server (Figma plugin ui.html) + HTTP link API + MCP stdio server (opencode/CLI).
// Only dep: ws. Logs go to stderr; stdout is reserved for MCP JSON-RPC.
//
// TWO WAYS TO USE:
//   1. LINK (easiest, any CLI): plugin shows http://localhost:3055/file
//      -> AI fetches it (curl), reads live JSON, POSTs commands back to /api/<command>.
//   2. MCP tools (power): opencode spawns this same file via stdio. If the bat's bridge already
//      owns the port, this instance auto-switches to PROXY mode and forwards tool calls over HTTP
//      instead of crashing with EADDRINUSE. Single connection: one plugin at a time, no channels.
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
let WebSocketServer;
try {
  ({ WebSocketServer } = require("ws"));
} catch (e) {
  console.error("[bridge] missing dep 'ws'. Run: npm install  (inside bridge/)");
  process.exit(1);
}

const PORT = Number(process.env.FIGMA_BRIDGE_PORT || 3055);

// single Figma socket (latest wins; one plugin at a time)
let figmaSocket = null;
let msgSeq = 0;
const pending = new Map(); // id -> { resolve, reject, timer, ws }
let proxyMode = false; // true when another bridge owns PORT: forward over HTTP instead of WS

const log = (...a) => console.error("[bridge]", ...a);
const ownerBase = () => `http://127.0.0.1:${PORT}`;

// ---------- tiny HTTP client (for proxy mode) ----------
function httpJson(method, urlPath, body, timeoutMs = 50000) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const u = new URL(urlPath, ownerBase());
    const req = http.request(
      {
        hostname: u.hostname, port: u.port, path: u.pathname + u.search,
        method, headers: { "Content-Type": "application/json", ...(data ? { "Content-Length": data.length } : {}) },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
          catch (e) { reject(new Error(`Bad JSON from bridge HTTP ${res.statusCode}`)); }
        });
      }
    );
    req.on("error", (e) => reject(new Error(`Bridge HTTP unreachable (${e.message}). Is start-bridge.bat running?`)));
    req.setTimeout(timeoutMs, () => { req.destroy(new Error("Bridge HTTP timed out")); });
    if (data) req.write(data);
    req.end();
  });
}

async function ownerStatus() {
  const r = await httpJson("GET", "/status");
  return r;
}

// Shared JSON body reader (5MB cap). Rejects with .status for the route to answer.
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
      if (raw.length > 5 * 1024 * 1024) {
        const e = new Error("Body too large (max 5MB)");
        e.status = 413;
        try { req.destroy(); } catch {}
        reject(e);
      }
    });
    req.on("end", () => {
      try { resolve(raw ? JSON.parse(raw) : {}); }
      catch { const e = new Error('Body must be JSON: {"params": {...}}'); e.status = 400; reject(e); }
    });
    req.on("error", reject);
  });
}

async function sendToFigma(command, params = {}, timeoutMs = 45000) {
  if (proxyMode) {
    return httpJson("POST", `/api/${encodeURIComponent(command)}`, { params }, timeoutMs + 5000)
      .then((r) => {
        if (r && r.ok) return r.result;
        throw new Error(r && r.error ? String(r.error) : "Bridge proxy error");
      });
  }
  const ws = figmaSocket;
  if (!ws || ws.readyState !== 1) throw new Error("No Figma plugin connected. In Figma: run oc mcp (auto-connects).");
  const id = `mcp-${Date.now()}-${(++msgSeq)}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Timed out waiting for Figma (${command}). Is the plugin window still open?`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer, ws });
    try { ws.send(JSON.stringify({ id, command, params })); }
    catch (e) { clearTimeout(timer); pending.delete(id); reject(e instanceof Error ? e : new Error(String(e))); }
  });
}

// ---------- WebSocket side (Figma) ----------
const server = http.createServer((req, res) => {
  const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,POST,OPTIONS", "Access-Control-Allow-Headers": "Content-Type" };
  if (req.method === "OPTIONS") { res.writeHead(204, cors); res.end(); return; }
  const u = new URL(req.url || "/", "http://x");
  const json = (code, obj) => {
    const body = JSON.stringify(obj);
    res.writeHead(code, { ...cors, "Content-Type": "application/json" });
    res.end(body);
  };

  if (req.method === "GET" && u.pathname === "/health") { res.writeHead(200, cors); res.end("ok"); return; }

  if (req.method === "GET" && u.pathname === "/status") {
    const connected = !!figmaSocket && figmaSocket.readyState === 1;
    return json(200, { connected });
  }

  // THE LINK: full live context as one fetchable JSON. Give this URL to any AI.
  if (req.method === "GET" && u.pathname === "/file") {
    const depth = Math.min(Math.max(Number(u.searchParams.get("depth") || 2), 0), 5);
    handleFileLink(depth).then(
      (out) => json(200, out),
      (e) => json(502, { ok: false, error: String(e.message || e), hint: "Is the Figma plugin running and connected?" })
    );
    return;
  }
  const fileLegacy = u.pathname.match(/^\/file\/([A-Za-z0-9-]+)$/);
  if (req.method === "GET" && fileLegacy) {
    return json(410, { ok: false, error: "Channel codes (FIG-XXXX) removed — re-run the plugin and use GET /file.", hint: "Use GET /file and POST /api/<command>." });
  }

  if (req.method === "GET" && u.pathname === "/selection") {
    sendToFigma("get_selection", {}).then(
      (result) => json(200, { ok: true, result }),
      (e) => json(502, { ok: false, error: String(e.message || e) })
    );
    return;
  }
  const selLegacy = u.pathname.match(/^\/selection\/([A-Za-z0-9-]+)$/);
  if (req.method === "GET" && selLegacy) {
    return json(410, { ok: false, error: "Channel codes (FIG-XXXX) removed — re-run the plugin and use GET /file.", hint: "Use GET /file and POST /api/<command>." });
  }

  // Rational batch: many calls, one HTTP round-trip. Body: {calls:[{tool, arguments}], parallel?, stopOnError?}
  if (req.method === "POST" && u.pathname === "/api/batch") {
    readJsonBody(req).then(async (body) => {
      try {
        const out = await runBatch(body && body.calls, { parallel: body && body.parallel, stopOnError: body && body.stopOnError });
        json(200, { ok: true, command: "batch_tools", ...out });
      } catch (e) { json(400, { ok: false, command: "batch_tools", error: String(e.message || e) }); }
    }, (e) => json(e.status || 400, { ok: false, error: String(e.message || e) }));
    return;
  }

  // Generic write/read endpoint: POST /api/<command>  body: { params: {...} }
  const apiMatch = u.pathname.match(/^\/api\/([a-z_0-9]+)$/);
  if (req.method === "POST" && apiMatch) {
    const rawCommand = apiMatch[1];
    readJsonBody(req).then(async (body) => {
      const { _slim: hslim, _full: hfull, fields: hfields, _echo: hecho, ...rawParams } = ((body && body.params) || {});
      const { name: command, args: params } = expandCall(rawCommand, rawParams);
      if (command === "get_node_tree") params.depth = params.depth ?? 2;
      let panel = false;
      try {
        // format is a bridge directive (panel mode), not a plugin param — validate then strip
        if (params.format !== undefined && command !== "export_node") {
          if (params.format !== "panel") throw new Error('invalid format: expected "panel"');
          panel = true;
          delete params.format;
        }
        injectDetail(params, { write: isWriteTool(command), echo: hecho === true, slimRead: SLIM_DEFAULT_READS.has(command), full: hfull === true, fields: hfields, panel });
        const result = await sendToFigma(command, params);
        const res = applyReadOptions(result, { fields: hfields, _slim: hslim === true, _full: hfull }, command);
        let out = isWriteTool(command) && hecho !== true ? receiptOf(res) : res;
        if (panel && PANEL_TOOLS.has(command)) out = renderPanel(out);
        json(200, { ok: true, command, result: out });
      } catch (e) {
        json(502, { ok: false, command, error: String(e.message || e) });
      }
    }, (e) => json(e.status || 400, { ok: false, error: String(e.message || e) }));
    return;
  }
  const apiLegacy = u.pathname.match(/^\/api\/([A-Za-z0-9-]+)\/([a-z_0-9]+)$/);
  if (req.method === "POST" && apiLegacy) {
    return json(410, { ok: false, error: "Channel codes (FIG-XXXX) removed — re-run the plugin and use GET /file.", hint: "Use GET /file and POST /api/<command>." });
  }

  if (req.method === "GET" && u.pathname === "/") {
    res.writeHead(200, { ...cors, "Content-Type": "text/plain" });
    res.end("oc mcp bridge. Figma connects via WS here. AI link: GET /file  Commands: POST /api/<command>");
    return;
  }
  json(404, { ok: false, error: "Unknown route. Try GET /health, GET /status, GET /file, POST /api/<command>." });
});

async function safe(p) {
  try { return { ok: true, data: await p }; } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
}

// Build the one JSON blob the AI gets when it fetches the link.
async function handleFileLink(depth) {
  const link = `${ownerBase()}/file`;
  const api = `${ownerBase()}/api`;
  const [doc, sel, tree, comps, styles] = await Promise.all([
    safe(sendToFigma("get_document_info", {})),
    safe(sendToFigma("get_selection", {})),
    safe(sendToFigma("get_node_tree", { depth })),
    safe(sendToFigma("get_local_components", {})),
    safe(sendToFigma("get_local_styles", {})),
  ]);
  // Nothing reachable at all (plugin closed) -> fail loud, not a fake-empty 200.
  if (!doc.ok && !sel.ok && !tree.ok) throw new Error(doc.error || "Figma plugin not connected");
  const summarize = (arr, n) => Array.isArray(arr) ? arr.slice(0, n).map((x) => ({ id: x.id, name: x.name, type: x.type })) : arr;
  return {
    ok: true,
    link,
    instructions: [
      "This URL is a LIVE view of the user's open Figma file. The JSON below is the current state — never work from memory, re-fetch this URL when you need fresh data.",
      "To READ more: GET /file?depth=3 (0-5), GET /selection, or POST /api/<command> with read commands.",
      "To CHANGE the file: POST {api}/<command> with Content-Type: application/json and body {\"params\": {...}}. Example: curl -X POST {api}/create_frame -H \"Content-Type: application/json\" -d '{\"params\":{\"name\":\"Hero\",\"width\":800,\"height\":600}}'.",
      "After creating things, POST {api}/set_selection with {\"params\":{\"nodeIds\":[...]}} to highlight the result — it does NOT move the user's camera (add \"scrollIntoView\":true only if they ask to be shown). Ask before delete_nodes.",
      `For 2+ calls in one round-trip: POST {api}/batch with {\"calls\":[{\"tool\":\"<command>\",\"arguments\":{...}}]} (max ${BATCH_MAX_CALLS}, sequential; reads may set parallel:true). For a single call, use POST {api}/<command> directly.`,
      "Compact form (same results, fewer tokens): short tool names (frm=create_frame, txt=create_text, tree=get_node_tree, sel=get_selection, doc=get_document_info, del=delete_nodes, mov=move_node, batch=batch_tools, …) and short keys (n=name, w=width, h=height, f=fill, p=parentId, t=text, s=fontSize, id=nodeId, ids=nodeIds, cr=cornerRadius, lm=layoutMode, sp=itemSpacing, pad=padding, ff=fontFamily, fs=fontStyle). Add \"_slim\":true to any params to strip heavy render keys from the response. Add \"_echo\":true to any write to restore the full response. Add \"fields\":[...] to node reads for only those keys per node. Fetch narrow: list pages/child maps first (depth 0-1), then read only needed nodes — never whole-page depth 3+ unless asked.",
      "Add \"format\":\"panel\" to get_node_tree for an indented text tree — cheaper than JSON for structure reads.",
      "If a request returns ok:false with 'not connected', tell the user to re-run the Figma plugin (it auto-connects) and retry once.",
    ].join(" "),
    api_base: api,
    commands: COMMANDS,
    for_browser_ai: "If you are an AI reading this URL pasted in a browser chat (no local network, no tools): treat this JSON as a READ-ONLY live snapshot — analyze, summarize, or write code from it freely, and re-fetch the URL for fresh data. You cannot change the Figma file from here; to enable edits, the file owner must run the local bridge with a coding CLI (opencode/Claude Code) and use POST {api_base}/<command>. Never invent node IDs; only use ids found in this JSON.",
    document: doc.ok ? doc.data : { error: doc.error },
    selection: sel.ok ? sel.data : { error: sel.error },
    tree: tree.ok ? tree.data : { error: tree.error },
    components: comps.ok ? summarize(comps.data, 100) : { error: comps.error },
    styles: styles.ok
      ? { paints: summarize(styles.data.paints, 50), texts: summarize(styles.data.texts, 50), effects: summarize(styles.data.effects, 50), grids: summarize(styles.data.grids, 50) }
      : { error: styles.error },
  };
}

// Reject every in-flight request tied to one socket (close/error). Clears timers
// so kill-plugin-mid-request leaves pending.size==0 and callers reject fast.
function rejectPendingForWs(ws, message = "Figma disconnected") {
  for (const [id, p] of pending) {
    if (p.ws === ws) {
      pending.delete(id);
      clearTimeout(p.timer);
      try { p.reject(new Error(message)); } catch {}
    }
  }
}

const wss = new WebSocketServer({ server });
wss.on("error", onListenError);

wss.on("connection", (ws) => {
  log("figma ws connected");
  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(String(raw)); } catch { return; }
    if (msg.type === "register") {
      if (figmaSocket && figmaSocket !== ws) { log("previous connection replaced"); rejectPendingForWs(figmaSocket); }
      figmaSocket = ws;
      log("registered figma plugin");
      try { ws.send(JSON.stringify({ type: "welcome" })); } catch {}
      return;
    }
    if (msg.type === "event") {
      log(`event ${msg.event}`);
      return; // v1 logs only
    }
    // response to an MCP/HTTP request
    if (msg.id !== undefined && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(new Error(String(msg.error || "Figma error")));
    }
  });
  ws.on("error", (err) => {
    log(`figma ws error: ${err && err.message || err}`);
    rejectPendingForWs(ws);
  });
  ws.on("close", () => {
    rejectPendingForWs(ws);
    if (figmaSocket === ws) figmaSocket = null;
    log("figma ws closed");
  });
});

// If another bridge (e.g. the bat's) already owns the port, DON'T crash:
// become a thin MCP->HTTP proxy onto it. This is what makes "bat + opencode" just work.
// NOTE: ws re-emits the HTTP server's errors on the WebSocketServer too,
// so the handler must be attached to BOTH or the process dies unhandled.
// Set true once listen succeeds: only listen-phase failures may exit.
// Runtime errors (after listening) log to stderr and continue — never exit.
let listening = false;
function onListenError(err) {
  if (err && err.code === "EADDRINUSE") {
    if (!proxyMode) {
      proxyMode = true;
      log(`port ${PORT} busy — proxy mode: forwarding MCP tools to the running bridge. (Keep only ONE start-bridge.bat open.)`);
    }
  } else if (!listening) {
    console.error("[bridge] server error:", err);
    process.exit(1);
  } else {
    console.error("[bridge] runtime error (continuing):", err);
  }
}
server.on("error", onListenError);

server.listen(PORT, () => {
  listening = true;
  if (!proxyMode) log(`listening ws://localhost:${PORT} + link http://localhost:${PORT}/file — open Figma plugin`);
});

// ---------- rational batch: many calls, one round-trip, bounded RAM ----------
// Sequential by default (plugin handles one message at a time; writes stay ordered).
// parallel:true only fans out when EVERY call is read-only, up to BATCH_MAX_PARALLEL at once.
// Small tasks: call the single tool directly — batch adds nothing for 1 call.
const BATCH_MAX_CALLS = 32;
const BATCH_MAX_BYTES = 5 * 1024 * 1024 - 65536; // 5MB per batch minus envelope headroom, so a max-size batch isn't replaced wholesale at the MCP cap
const BATCH_MAX_PARALLEL = 6;
const BATCH_READ_ONLY = new Set(["get_status", "ping_figma", "get_document_info", "get_selection", "get_node_tree", "get_node_by_id", "get_local_components", "get_local_styles", "get_local_variables", "export_node", "get_dev_resources", "inspect_css", "get_canvas_view", "get_reactions", "get_text_segments", "list_fonts"]);

async function runBatch(calls, opts = {}) {
  if (!Array.isArray(calls) || calls.length === 0) throw new Error(`batch needs calls:[{tool, arguments}] (1-${BATCH_MAX_CALLS})`);
  if (calls.length > BATCH_MAX_CALLS) throw new Error(`batch capped at ${BATCH_MAX_CALLS} calls — split into smaller batches`);
  const stopOnError = opts.stopOnError !== false;
  const results = [];
  let bytes = 0;
  const runOne = async (c) => {
    const tool = TOOL_ALIAS[c?.tool] || (c && c.tool); // expand compact alias before validating
    if (tool === "batch_tools") throw new Error("batch cannot nest — flatten the calls");
    if (typeof tool !== "string" || !TOOLS.find((t) => t.name === tool)) throw new Error(`unknown tool in batch: ${c && c.tool}`);
    return { tool, ok: true, result: await callTool(tool, (c && c.arguments) || {}) };
  };
  const pushResult = (r) => {
    const s = JSON.stringify(r);
    bytes += s.length;
    if (bytes > BATCH_MAX_BYTES) {
      results.push({ tool: r.tool, ok: false, error: "batch byte budget exceeded (5MB) — split into smaller batches", truncated: true });
      return true;
    }
    results.push(r);
    return false;
  };
  if (opts.parallel === true && calls.every((c) => c && BATCH_READ_ONLY.has(TOOL_ALIAS[c.tool] || c.tool))) {
    for (let i = 0; i < calls.length; i += BATCH_MAX_PARALLEL) {
      const settled = await Promise.all(calls.slice(i, i + BATCH_MAX_PARALLEL).map((c) =>
        runOne(c).catch((e) => ({ tool: c && c.tool, ok: false, error: String(e && e.message || e) }))));
      for (const r of settled) {
        if (pushResult(r)) return { ok: true, mode: "parallel", results, truncated: true };
        if (!r.ok && stopOnError) return { ok: true, mode: "parallel", results, stoppedOnError: r.tool };
      }
    }
    return { ok: true, mode: "parallel", results };
  }
  const readCache = new Map();
  for (const c of calls) {
    const expanded = TOOL_ALIAS[c?.tool] || (c && c.tool);
    const key = expanded + ":" + JSON.stringify((c && c.arguments) || {});
    if (expanded && BATCH_READ_ONLY.has(expanded) && readCache.has(key) && readCache.get(key).ok) {
      const r = { ...readCache.get(key), deduped: true };
      if (pushResult(r)) return { ok: true, mode: "sequential", results, truncated: true };
      if (!r.ok && stopOnError) return { ok: true, mode: "sequential", results, stoppedOnError: r.tool };
      continue;
    }
    let r;
    try { r = await runOne(c); }
    catch (e) { r = { tool: c && c.tool, ok: false, error: String(e && e.message || e) }; }
    if (r.ok && expanded && BATCH_READ_ONLY.has(expanded)) readCache.set(key, r);
    if (pushResult(r)) return { ok: true, mode: "sequential", results, truncated: true };
    if (!r.ok && stopOnError) return { ok: true, mode: "sequential", results, stoppedOnError: r.tool };
  }
  return { ok: true, mode: "sequential", results };
}

// ---------- compact protocol: small packets, same quality ----------
// Agents pay per token they EMIT, so verbose JSON is the real latency.
// Short tool/param aliases expand here (full names always still work;
// long form wins if both given). Responses shrink bridge-side via _slim.
const TOOL_ALIAS = {
  st: "get_status", doc: "get_document_info", sel: "get_selection",
  tree: "get_node_tree", node: "get_node_by_id",
  gcomps: "get_local_components", gstyles: "get_local_styles", gvars: "get_local_variables",
  exp: "export_node", frm: "create_frame", rect: "create_rectangle", elp: "create_ellipse",
  txt: "create_text", stc: "set_text_content", fil: "set_fills", str: "set_strokes",
  props: "set_node_props", lay: "set_layout", del: "delete_nodes", clo: "clone_node",
  mov: "move_node", ssel: "set_selection", page: "create_page", grp: "group_nodes",
  comp: "create_component", inst: "create_instance", batch: "batch_tools",
};
const KEY_ALIAS = {
  n: "name", w: "width", h: "height", f: "fill", p: "parentId",
  t: "text", s: "fontSize", id: "nodeId", ids: "nodeIds",
  cr: "cornerRadius", lm: "layoutMode", sp: "itemSpacing",
  pad: "padding", ff: "fontFamily", fs: "fontStyle",
};
function expandKeys(args) {
  const out = {};
  for (const k of Object.keys(args || {})) {
    const nk = KEY_ALIAS[k] || k;
    if (!(nk in out)) { out[nk] = args[k]; continue; } // long form wins
    if (nk !== k) out[k] = args[k]; // keep conflicting original (e.g. id vs nodeId)
  }
  return out;
}
function expandCall(name, args) {
  return { name: TOOL_ALIAS[name] || name, args: expandKeys(args) };
}
// heavy render keys nobody needs for layout/codegen decisions
// (the struct detail tier already omits all of these; adding them here is a no-op for default reads)
const SLIM_DROP = new Set(["fills", "strokes", "effects", "absoluteBoundingBox", "exportSettings",
  "relativeTransform", "absoluteTransform", "styledTextSegments", "rangeFonts", "rangeFills",
  "annotations", "guides", "exposedInstances"]);
// trees slim by default (opt out with _full:true); selection stays full (codegen source)
const SLIM_DEFAULT_READS = new Set(["get_node_tree", "get_node_by_id"]);
// fields picker: catalog is cheap, instances are expensive.
// Structural keys always survive (navigation/identity); everything else
// must be asked for. Full data stays one flag away — nothing hidden by default.
const FIELDS_ALWAYS = new Set(["id", "children", "childIds", "childCount"]);
// wrapper/envelope keys (no node `type`) that carry the payload of list/aggregate reads;
// kept so a fields picker narrows the nodes, not the container (get_selection {count,nodes}, etc).
const FIELDS_ENVELOPE = new Set(["count", "nodes", "collections", "segments", "paints", "texts", "grids", "variables", "effects", "length", "truncated"]);
const FIELDABLE_READS = new Set(["get_selection", "get_node_tree", "get_node_by_id",
  "get_local_components", "get_local_styles", "get_local_variables",
  "get_dev_resources", "inspect_css", "get_canvas_view", "get_reactions"]);
function pickFields(v, fields) {
  const allow = new Set([...FIELDS_ALWAYS, ...fields]);
  const walk = (x, depth) => {
    if (Array.isArray(x)) return x.map((y) => walk(y, depth));
    if (x && typeof x === "object") {
      // envelope keys survive only at the TOP level: a nested typeless object
      // (e.g. a style entry {id,name,paints}) must not re-leak its heavy payload.
      const wrapper = depth === 0 && typeof x.type !== "string";
      const o = {};
      for (const k of Object.keys(x)) { if (allow.has(k) || (wrapper && FIELDS_ENVELOPE.has(k))) o[k] = walk(x[k], depth + 1); }
      return o;
    }
    return x;
  };
  return walk(v, 0);
}
function applyReadOptions(out, params, readTool) {
  let r = out;
  const f = params.fields;
  if (f !== undefined && FIELDABLE_READS.has(readTool)) {
    if (!Array.isArray(f) || f.some((x) => typeof x !== "string")) throw new Error("fields must be string[]");
    if (f.length) r = pickFields(r, f);
  }
  const explicitFields = f !== undefined && Array.isArray(f) && f.length > 0;
  // An explicit fields picker is an exact request; pickFields already narrowed the payload, so never re-slim it.
  if (!explicitFields && (params._slim === true || (SLIM_DEFAULT_READS.has(readTool) && params._full !== true))) r = slimResult(r);
  return r;
}
function slimResult(v) {
  if (Array.isArray(v)) return v.map(slimResult);
  if (v && typeof v === "object") {
    const o = {};
    for (const k of Object.keys(v)) {
      if (SLIM_DROP.has(k)) continue;
      if (k === "characters" && typeof v[k] === "string" && v[k].length > 200) { o[k] = v[k].slice(0, 200) + "\u2026(slim)"; continue; }
      o[k] = slimResult(v[k]);
    }
    return o;
  }
  return v;
}
// Keys the plugin's honest-write report attaches next to a node; never dropped by the collapse.
const RECEIPT_KEEP = ["applied", "mismatched", "restoredChildren"];
// Compact a write response: id-bearing objects -> {id, name, type}. Other data passes through.
function receiptOf(v, depth = 0) {
  if (depth > 4 || v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map((x) => receiptOf(x, depth + 1));
  if (typeof v.id === "string" && (typeof v.type === "string" || typeof v.resolvedType === "string")) {
    const o = { id: v.id };
    if (typeof v.name === "string") o.name = v.name;
    if (typeof v.type === "string") o.type = v.type;
    if (typeof v.resolvedType === "string") o.resolvedType = v.resolvedType;
    for (const k of RECEIPT_KEEP) if (v[k] !== undefined) o[k] = v[k];
    return o;
  }
  const out = {};
  for (const k of Object.keys(v)) out[k] = receiptOf(v[k], depth + 1);
  return out;
}

// ---------- panel render: a node tree as indented text (cheaper than JSON) ----------
// Opt-in via {format:"panel"} on the structure-read tools only. Returns {panel, lines}.
const PANEL_MAX_DEPTH = 12;
const PANEL_MAX_CHARS = 200000;
const PANEL_TOOLS = new Set(["get_node_tree", "get_node_by_id", "get_selection", "get_current_page"]);

// 1 decimal, trailing ".0" dropped. Non-numbers -> null.
function panelNumber(v) {
  if (typeof v !== "number" || !isFinite(v)) return null;
  return String(Math.round(v * 10) / 10).replace(/\.0$/, "");
}
function panelLine(node) {
  const parts = [node.type];
  if (typeof node.name === "string") parts.push(`"${node.name}"`);
  if (typeof node.id === "string") parts.push(`#${node.id}`);
  if (typeof node.width === "number" && isFinite(node.width) && typeof node.height === "number" && isFinite(node.height)) {
    parts.push(`${panelNumber(node.width)}x${panelNumber(node.height)}`);
  }
  const flags = [];
  if (node.visible === false) flags.push("hidden");
  if (typeof node.opacity === "number" && node.opacity < 1) flags.push(`opacity ${panelNumber(node.opacity)}`);
  if (typeof node.layoutMode === "string" && node.layoutMode !== "NONE") {
    flags.push(node.layoutMode === "HORIZONTAL" ? "H" : node.layoutMode === "VERTICAL" ? "V" : node.layoutMode === "GRID" ? "GRID" : node.layoutMode);
  }
  if (typeof node.itemSpacing === "number" && node.itemSpacing !== 0) flags.push(`gap ${panelNumber(node.itemSpacing)}`);
  if (typeof node.counterAxisSpacing === "number" && node.counterAxisSpacing !== 0) flags.push(`crossGap ${panelNumber(node.counterAxisSpacing)}`);
  const pads = [node.paddingTop, node.paddingRight, node.paddingBottom, node.paddingLeft];
  if (pads.every((p) => typeof p === "number" && isFinite(p)) && pads.some((p) => p !== 0)) {
    flags.push(`pad ${pads.map(panelNumber).join("/")}`);
  }
  if (node.layoutPositioning === "ABSOLUTE") flags.push("abs");
  if (typeof node.layoutGrow === "number" && node.layoutGrow !== 0) flags.push(`grow ${panelNumber(node.layoutGrow)}`);
  if (typeof node.layoutAlign === "string" && node.layoutAlign !== "INHERIT") flags.push(`align ${node.layoutAlign}`);
  if (flags.length) parts.push(flags.join(", "));
  if (node.type === "TEXT" && typeof node.characters === "string") {
    let t = node.characters.replace(/\s+/g, " ").trim();
    if (t.length > 60) t = t.slice(0, 60) + "\u2026";
    if (t) parts.push(`"${t}"`);
  }
  return parts.join(" ");
}
// get_selection may be a bare array, or an object wrapping nodes/selection.
function panelRoots(result) {
  if (Array.isArray(result)) return result;
  if (result && typeof result === "object") {
    if (Array.isArray(result.nodes)) return result.nodes;
    if (Array.isArray(result.selection)) return result.selection;
    return [result];
  }
  return [];
}
function renderPanel(result) {
  const lines = [];
  const emit = (node, depth) => {
    if (!node || typeof node !== "object" || typeof node.type !== "string") return; // skip typeless
    if (depth > PANEL_MAX_DEPTH) return; // hard depth cap
    lines.push("  ".repeat(depth) + panelLine(node));
    if (Array.isArray(node.children)) {
      for (const child of node.children) emit(child, depth + 1);
    } else if (typeof node.childCount === "number" && node.childCount > 0) {
      lines.push("  ".repeat(depth + 1) + `+${node.childCount} children`); // depth-0 collapse
    }
  };
  for (const root of panelRoots(result)) emit(root, 0);
  let panel = lines.join("\n");
  if (panel.length > PANEL_MAX_CHARS) {
    let used = 0;
    let kept = 0;
    for (let i = 0; i < lines.length; i++) {
      const add = lines[i].length + (i ? 1 : 0);
      if (used + add > PANEL_MAX_CHARS) break;
      used += add;
      kept = i + 1;
    }
    panel = lines.slice(0, kept).join("\n") + `\n\u2026 (truncated, ${lines.length - kept} more lines)`;
  }
  return { panel, lines: lines.length };
}
// reads are get_/list_/find_/inspect_/export_ plus an explicit extra set; everything else is a write
const READ_TOOL_RE = /^(get_|list_|find_|inspect_|export_)/;
const READ_EXTRA = new Set(["client_storage", "node_data", "get_status", "batch_tools", "ping_figma", "list_channels", "join_channel"]);
const isWriteTool = (name) => !READ_TOOL_RE.test(name) && !READ_EXTRA.has(name);

// keys the plugin's "struct" tier omits; a fields picker that asks for one needs full detail
const STRUCT_DROPPED = new Set(["fills","strokes","effects","absoluteBoundingBox","exportSettings","relativeTransform","absoluteTransform","absoluteRenderBounds","layoutGrids","styledTextSegments","rangeFonts","rangeFills","vectorNetwork","vectorPaths","fillGeometry","strokeGeometry","exposedInstances","annotations","guides","vertexCount","segmentsTruncated","annotationCount","guideCount"]);

function injectDetail(params, opts) {
  if (!params || typeof params !== "object" || params._detail !== undefined) return; // never override an explicit request
  const wantsDropped = Array.isArray(opts.fields) && opts.fields.some((k) => STRUCT_DROPPED.has(k));
  if (opts.write) { params._detail = opts.echo === true ? "full" : "receipt"; return; }
  if (opts.panel) { params._detail = "struct"; return; } // a text panel only needs structure, on any tool
  else if (opts.slimRead) params._detail = opts.full === true || wantsDropped ? "full" : "struct";
}

// ---------- MCP side (stdio JSON-RPC) ----------
const TOOLS = [
  { name: "get_status", description: "Bridge connection status (single connection, no channels).", inputSchema: { type: "object", properties: {} } },
  { name: "ping_figma", description: "Ping the connected Figma file.", inputSchema: { type: "object", properties: {} } },
  { name: "get_document_info", description: "File name, pages, current page. Start here, then get_node_tree.", inputSchema: { type: "object", properties: { channel: { type: "string" } } } },
  { name: "get_selection", description: "Current selection serialized (type, layout, fills, text). Best source for 'code this component'.", inputSchema: { type: "object", properties: { channel: { type: "string" }, format: { type: "string", enum: ["panel"], description: "Return an indented text tree {panel, lines} instead of JSON." } } } },
  { name: "get_node_tree", description: "Serialize a node subtree (or current page). depth 0-10. Use depth 2-4 for codegen to avoid huge dumps.", inputSchema: { type: "object", properties: { channel: { type: "string" }, nodeId: { type: "string" }, depth: { type: "number" }, format: { type: "string", enum: ["panel"], description: "Return an indented text tree {panel, lines} instead of JSON." } } } },
  { name: "get_node_by_id", description: "Serialize one node by id.", inputSchema: { type: "object", properties: { channel: { type: "string" }, nodeId: { type: "string" }, depth: { type: "number" }, format: { type: "string", enum: ["panel"], description: "Return an indented text tree {panel, lines} instead of JSON." } }, required: ["nodeId"] } },
  { name: "get_local_components", description: "Local components + component sets (design system inventory).", inputSchema: { type: "object", properties: { channel: { type: "string" } } } },
  { name: "get_local_styles", description: "Local paint/text/effect styles (design tokens).", inputSchema: { type: "object", properties: { channel: { type: "string" } } } },
  { name: "get_local_variables", description: "Local variable collections + variables (color/number/string/boolean tokens).", inputSchema: { type: "object", properties: { channel: { type: "string" } } } },
  { name: "export_node", description: "Export node as PNG/JPG/SVG/PDF/MP4/GIF/WEBM. Returns base64 (PNG/JPG/PDF/video) or svg text. Optionally saves to savePath via the bridge.", inputSchema: { type: "object", properties: { channel: { type: "string" }, nodeId: { type: "string" }, format: { type: "string", enum: ["PNG", "JPG", "SVG", "PDF", "MP4", "GIF", "WEBM"] }, scale: { type: "number" }, fps: { type: "number" }, quality: { type: "string", enum: ["LOW", "MEDIUM", "HIGH"] }, loopCount: { type: "number" }, savePath: { type: "string" } }, required: ["nodeId"] } },
  { name: "create_frame", description: "Create a frame on current page (or parentId). Use for pages/sections/layouts/websites.", inputSchema: { type: "object", properties: { channel: { type: "string" }, name: { type: "string" }, width: { type: "number" }, height: { type: "number" }, x: { type: "number" }, y: { type: "number" }, fill: { type: "string" }, parentId: { type: "string" }, layoutMode: { type: "string", enum: ["NONE", "HORIZONTAL", "VERTICAL"] }, itemSpacing: { type: "number" }, padding: { type: "number" } } } },
  { name: "create_rectangle", description: "Create a rectangle.", inputSchema: { type: "object", properties: { channel: { type: "string" }, name: { type: "string" }, width: { type: "number" }, height: { type: "number" }, x: { type: "number" }, y: { type: "number" }, fill: { type: "string" }, cornerRadius: { type: "number" }, parentId: { type: "string" } } } },
  { name: "create_ellipse", description: "Create an ellipse.", inputSchema: { type: "object", properties: { channel: { type: "string" }, name: { type: "string" }, width: { type: "number" }, height: { type: "number" }, x: { type: "number" }, y: { type: "number" }, fill: { type: "string" }, parentId: { type: "string" } } } },
  { name: "create_text", description: "Create a text node. fill = hex like #111111.", inputSchema: { type: "object", properties: { channel: { type: "string" }, text: { type: "string" }, fontSize: { type: "number" }, fontFamily: { type: "string" }, fontStyle: { type: "string" }, fill: { type: "string" }, x: { type: "number" }, y: { type: "number" }, name: { type: "string" }, parentId: { type: "string" }, align: { type: "string", enum: ["LEFT", "CENTER", "RIGHT", "JUSTIFIED"] } }, required: ["text"] } },
  { name: "set_text_content", description: "Replace text node characters.", inputSchema: { type: "object", properties: { channel: { type: "string" }, nodeId: { type: "string" }, text: { type: "string" } }, required: ["nodeId", "text"] } },
  { name: "set_fills", description: "Set fills. fills=[{color:'#ff0000',opacity:1}] or single fill/color. Pass fills:[] to remove all fills.", inputSchema: { type: "object", properties: { channel: { type: "string" }, nodeId: { type: "string" }, fills: { type: "array" }, fill: { type: "string" }, color: { type: "string" }, imageHash: { type: "string" }, scaleMode: { type: "string", enum: ["FILL", "FIT", "CROP", "TILE"] } }, required: ["nodeId"] } },
  { name: "set_strokes", description: "Set strokes + optional strokeWeight.", inputSchema: { type: "object", properties: { channel: { type: "string" }, nodeId: { type: "string" }, strokes: { type: "array" }, strokeWeight: { type: "number" }, strokeAlign: { type: "string", enum: ["CENTER", "INSIDE", "OUTSIDE"] }, strokeTopWeight: { type: "number" }, strokeRightWeight: { type: "number" }, strokeBottomWeight: { type: "number" }, strokeLeftWeight: { type: "number" } }, required: ["nodeId"] } },
  { name: "set_node_props", description: "Generic props: x,y,width,height,name,opacity,visible,locked,cornerRadius,fill,rotation. Returns {applied, mismatched?}; resize needs both width and height.", inputSchema: { type: "object", properties: { channel: { type: "string" }, nodeId: { type: "string" }, props: { type: "object" } }, required: ["nodeId"] } },
  { name: "set_layout", description: "Auto-layout on a frame: layoutMode, itemSpacing, counterAxisSpacing, padding*, primaryAxisAlignItems, counterAxisAlignItems, grid row/column counts, gaps, sizes, auto tracks, preserveChildLayout (default true; keeps children's layoutGrow/layoutAlign/layoutPositioning across a layoutMode change). Returns {applied, mismatched?, restoredChildren?}.", inputSchema: { type: "object", properties: { channel: { type: "string" }, nodeId: { type: "string" }, preserveChildLayout: { type: "boolean", description: "Keep children's layoutGrow/layoutAlign/layoutPositioning across a layoutMode change (default true)." }, layoutMode: { type: "string", enum: ["NONE", "HORIZONTAL", "VERTICAL", "GRID"] }, itemSpacing: { type: "number" }, counterAxisSpacing: { type: "number" }, padding: { type: "number" }, paddingTop: { type: "number" }, paddingBottom: { type: "number" }, paddingLeft: { type: "number" }, paddingRight: { type: "number" }, primaryAxisAlignItems: { type: "string" }, counterAxisAlignItems: { type: "string" }, primaryAxisSizingMode: { type: "string", enum: ["FIXED", "AUTO"] }, counterAxisSizingMode: { type: "string", enum: ["FIXED", "AUTO"] }, gridRowCount: { type: "number" }, gridColumnCount: { type: "number" }, gridRowGap: { type: "number" }, gridColumnGap: { type: "number" }, gridRowSizes: { type: "array" }, gridColumnSizes: { type: "array" }, gridAutoTracks: { type: "string", enum: ["NONE", "ROWS"] } }, required: ["nodeId"] } },
  { name: "set_grid_child", description: "Position a child inside a GRID-layout frame (row/column + optional spans/aligns).", inputSchema: { type: "object", properties: { channel: { type: "string" }, nodeId: { type: "string" }, row: { type: "number" }, column: { type: "number" }, rowSpan: { type: "number" }, columnSpan: { type: "number" }, hAlign: { type: "string", enum: ["MIN", "CENTER", "MAX", "AUTO"] }, vAlign: { type: "string", enum: ["MIN", "CENTER", "MAX", "AUTO"] } }, required: ["nodeId", "row", "column"] } },
  { name: "set_shape_props", description: "Set polygon/star/ellipse geometry (pointCount, innerRadius, arcData).", inputSchema: { type: "object", properties: { channel: { type: "string" }, nodeId: { type: "string" }, pointCount: { type: "number" }, innerRadius: { type: "number" }, arcData: { type: "object" } }, required: ["nodeId"] } },
  { name: "set_aspect_lock", description: "Lock/unlock a node's aspect ratio.", inputSchema: { type: "object", properties: { channel: { type: "string" }, nodeId: { type: "string" }, locked: { type: "boolean" } }, required: ["nodeId", "locked"] } },
  { name: "get_transform", description: "Get a node's relative and absolute transforms.", inputSchema: { type: "object", properties: { channel: { type: "string" }, nodeId: { type: "string" } }, required: ["nodeId"] } },
  { name: "delete_nodes", description: "Delete nodes by id.", inputSchema: { type: "object", properties: { channel: { type: "string" }, nodeIds: { type: "array" }, nodeId: { type: "string" } } } },
  { name: "clone_node", description: "Clone a node.", inputSchema: { type: "object", properties: { channel: { type: "string" }, nodeId: { type: "string" }, parentId: { type: "string" }, x: { type: "number" }, y: { type: "number" } }, required: ["nodeId"] } },
  { name: "move_node", description: "Reparent / reorder a node.", inputSchema: { type: "object", properties: { channel: { type: "string" }, nodeId: { type: "string" }, parentId: { type: "string" } }, required: ["nodeId", "parentId"] } },
  { name: "set_selection", description: "Select nodes. The camera does NOT move unless scrollIntoView:true.", inputSchema: { type: "object", properties: { channel: { type: "string" }, nodeIds: { type: "array" }, scrollIntoView: { type: "boolean", description: "Move the camera to the selection (default false — the user's view is left untouched)." } }, required: ["nodeIds"] } },
  { name: "create_page", description: "Create a page. select=true switches to it.", inputSchema: { type: "object", properties: { channel: { type: "string" }, name: { type: "string" }, select: { type: "boolean" } } } },
  { name: "group_nodes", description: "Group nodes.", inputSchema: { type: "object", properties: { channel: { type: "string" }, nodeIds: { type: "array" }, name: { type: "string" } }, required: ["nodeIds"] } },
  { name: "create_component", description: "Create component (blank, or from fromNodeId).", inputSchema: { type: "object", properties: { channel: { type: "string" }, name: { type: "string" }, fromNodeId: { type: "string" }, width: { type: "number" }, height: { type: "number" }, parentId: { type: "string" } } } },
  { name: "create_instance", description: "Instantiate a component.", inputSchema: { type: "object", properties: { channel: { type: "string" }, componentId: { type: "string" }, x: { type: "number" }, y: { type: "number" }, parentId: { type: "string" } }, required: ["componentId"] } },
  { name: "import_component", description: "Import a published component (or set when set:true) by key.", inputSchema: { type: "object", properties: { channel: { type: "string" }, key: { type: "string" }, set: { type: "boolean" } }, required: ["key"] } },
  { name: "create_variable_collection", description: "Create a variable collection (design tokens).", inputSchema: { type: "object", properties: { channel: { type: "string" }, name: { type: "string" } } } },
  { name: "create_variable", description: "Create a variable in a collection. type COLOR|FLOAT|STRING|BOOLEAN.", inputSchema: { type: "object", properties: { channel: { type: "string" }, collectionId: { type: "string" }, name: { type: "string" }, type: { type: "string", enum: ["COLOR", "FLOAT", "STRING", "BOOLEAN", "TIMING", "EASING"] } }, required: ["collectionId", "name"] } },
  { name: "import_variable", description: "Import a published variable by key.", inputSchema: { type: "object", properties: { channel: { type: "string" }, key: { type: "string" } }, required: ["key"] } },
  { name: "get_dev_resources", description: "Get dev resources for a node (or current page).", inputSchema: { type: "object", properties: { channel: { type: "string" }, nodeId: { type: "string" } } } },
  { name: "attach_dev_resource", description: "Attach a dev resource URL to a node (or current page).", inputSchema: { type: "object", properties: { channel: { type: "string" }, nodeId: { type: "string" }, url: { type: "string" }, name: { type: "string" } }, required: ["url"] } },
  { name: "inspect_css", description: "Get CSS for a node.", inputSchema: { type: "object", properties: { channel: { type: "string" }, nodeId: { type: "string" } }, required: ["nodeId"] } },
  { name: "create_version_history", description: "Save version history snapshot.", inputSchema: { type: "object", properties: { channel: { type: "string" }, title: { type: "string" }, description: { type: "string" } }, required: ["title"] } },
  { name: "scroll_to_node", description: "Scroll viewport to node(s).", inputSchema: { type: "object", properties: { channel: { type: "string" }, nodeId: { type: "string" }, nodeIds: { type: "array" } } } },
  { name: "add_to_selection", description: "Add nodes to current selection. The camera does NOT move unless scrollIntoView:true.", inputSchema: { type: "object", properties: { channel: { type: "string" }, nodeIds: { type: "array" }, scrollIntoView: { type: "boolean", description: "Move the camera to the selection (default false)." } }, required: ["nodeIds"] } },
  { name: "clear_selection", description: "Clear current selection.", inputSchema: { type: "object", properties: { channel: { type: "string" } } } },
  { name: "get_canvas_view", description: "Get viewport center, zoom, and bounds.", inputSchema: { type: "object", properties: { channel: { type: "string" } } } },
  { name: "set_layout_constraints", description: "Set layout constraints (MIN|CENTER|MAX|STRETCH|SCALE).", inputSchema: { type: "object", properties: { channel: { type: "string" }, nodeId: { type: "string" }, horizontal: { type: "string" }, vertical: { type: "string" } }, required: ["nodeId"] } },
  { name: "set_layout_positioning", description: "Set layout positioning (AUTO|ABSOLUTE).", inputSchema: { type: "object", properties: { channel: { type: "string" }, nodeId: { type: "string" }, positioning: { type: "string" } }, required: ["nodeId", "positioning"] } },
  { name: "create_boolean_operation", description: "Combine nodes (UNION|SUBTRACT|INTERSECT|EXCLUDE).", inputSchema: { type: "object", properties: { channel: { type: "string" }, nodeIds: { type: "array" }, op: { type: "string" }, parentId: { type: "string" }, index: { type: "number" } }, required: ["nodeIds", "op"] } },
  { name: "create_vector", description: "Create a vector node.", inputSchema: { type: "object", properties: { channel: { type: "string" }, parentId: { type: "string" }, x: { type: "number" }, y: { type: "number" }, vectorNetwork: { type: "object" } } } },
  { name: "set_image_fill", description: "Set image fill on a node.", inputSchema: { type: "object", properties: { channel: { type: "string" }, nodeId: { type: "string" }, imageHash: { type: "string" }, scaleMode: { type: "string" }, opacity: { type: "number" }, visible: { type: "boolean" } }, required: ["nodeId", "imageHash"] } },
  { name: "import_image", description: "Upload base64 image bytes (data-URI prefix ok, 5MB cap). Returns image hash.", inputSchema: { type: "object", properties: { channel: { type: "string" }, base64: { type: "string" }, name: { type: "string" } }, required: ["base64"] } },
  { name: "get_image_bytes", description: "Get base64 bytes for an image hash (truncated at 1500000 chars).", inputSchema: { type: "object", properties: { channel: { type: "string" }, hash: { type: "string" } }, required: ["hash"] } },
  { name: "toggle_layer_mask", description: "Toggle mask on a layer.", inputSchema: { type: "object", properties: { channel: { type: "string" }, nodeId: { type: "string" }, enabled: { type: "boolean" } }, required: ["nodeId"] } },
  { name: "set_variable_code_syntax", description: "Set variable code syntax (WEB|ANDROID|iOS).", inputSchema: { type: "object", properties: { channel: { type: "string" }, variableId: { type: "string" }, platform: { type: "string" }, value: { type: "string" } }, required: ["variableId", "platform", "value"] } },
  { name: "bind_variable_to_property", description: "Bind a variable to a node field.", inputSchema: { type: "object", properties: { channel: { type: "string" }, nodeId: { type: "string" }, field: { type: "string" }, variableId: { type: "string" } }, required: ["nodeId", "field", "variableId"] } },
  { name: "set_variable_alias", description: "Set a variable value to alias another variable.", inputSchema: { type: "object", properties: { channel: { type: "string" }, variableId: { type: "string" }, modeId: { type: "string" }, aliasId: { type: "string" } }, required: ["variableId", "modeId", "aliasId"] } },
  { name: "get_variable_modes", description: "Get modes of a variable collection.", inputSchema: { type: "object", properties: { channel: { type: "string" }, collectionId: { type: "string" } }, required: ["collectionId"] } },
  { name: "create_variable_mode", description: "Add a mode to a variable collection.", inputSchema: { type: "object", properties: { channel: { type: "string" }, collectionId: { type: "string" }, name: { type: "string" } }, required: ["collectionId", "name"] } },
  { name: "update_variable_mode", description: "Rename or remove a variable collection mode.", inputSchema: { type: "object", properties: { channel: { type: "string" }, collectionId: { type: "string" }, modeId: { type: "string" }, action: { type: "string" }, name: { type: "string" } }, required: ["collectionId", "modeId"] } },
  { name: "batch_update_variables", description: "Batch set variable values per mode.", inputSchema: { type: "object", properties: { channel: { type: "string" }, updates: { type: "array" } }, required: ["updates"] } },
  { name: "set_node_variable_mode", description: "Set explicit variable mode for a node+collection.", inputSchema: { type: "object", properties: { channel: { type: "string" }, nodeId: { type: "string" }, collectionId: { type: "string" }, modeId: { type: "string" } }, required: ["nodeId", "collectionId", "modeId"] } },
  { name: "add_prototype_link", description: "Add tap-to-navigate prototype link from a node to a frame.", inputSchema: { type: "object", properties: { channel: { type: "string" }, nodeId: { type: "string" }, destinationId: { type: "string" }, transition: { type: "string" } }, required: ["nodeId", "destinationId"] } },
  { name: "clear_prototype_links", description: "Remove all prototype links from a node.", inputSchema: { type: "object", properties: { channel: { type: "string" }, nodeId: { type: "string" } }, required: ["nodeId"] } },
  { name: "set_layout_child", description: "Set auto-layout child props (grow/align/positioning) on a node. Returns {applied, mismatched?}.", inputSchema: { type: "object", properties: { channel: { type: "string" }, nodeId: { type: "string" }, layoutGrow: { type: "number" }, layoutAlign: { type: "string", enum: ["MIN", "CENTER", "MAX", "STRETCH", "INHERIT"] }, layoutPositioning: { type: "string", enum: ["AUTO", "ABSOLUTE"] } }, required: ["nodeId"] } },
  { name: "set_text_props", description: "Set text props (lineHeight/letterSpacing/case/decoration/trim/alignVertical/autoResize/truncation/maxLines/wrap) on a text node.", inputSchema: { type: "object", properties: { channel: { type: "string" }, nodeId: { type: "string" }, lineHeight: { type: "number" }, letterSpacing: { type: "number" }, textCase: { type: "string", enum: ["ORIGINAL", "UPPER", "LOWER", "TITLE", "SMALL_CAPS", "SMALL_CAPS_FORCED"] }, textDecoration: { type: "string", enum: ["NONE", "UNDERLINE", "STRIKETHROUGH"] }, leadingTrim: { type: "string", enum: ["NONE", "CAP_HEIGHT"] }, alignVertical: { type: "string", enum: ["TOP", "CENTER", "BOTTOM"] }, autoResize: { type: "string", enum: ["NONE", "WIDTH_AND_HEIGHT", "HEIGHT", "TRUNCATE"] }, textTruncation: { type: "boolean" }, maxLines: { type: "number" }, textWrapStyle: { type: "string", enum: ["AUTO", "BALANCE", "PRETTY"] } }, required: ["nodeId"] } },
  { name: "set_text_range", description: "Set font/size/fill/link/styleIds on one character range of a text node.", inputSchema: { type: "object", properties: { channel: { type: "string" }, nodeId: { type: "string" }, start: { type: "number" }, end: { type: "number" }, fontSize: { type: "number" }, fontFamily: { type: "string" }, fontStyle: { type: "string" }, fill: { type: "string" }, styleId: { type: "string" }, fillStyleId: { type: "string" }, link: { description: "URL string|null or {type:URL,url}|{type:NODE,nodeId}" } }, required: ["nodeId", "start", "end"] } },
  { name: "edit_text_chars", description: "Insert or delete characters in a text node (insert needs text, delete needs end).", inputSchema: { type: "object", properties: { channel: { type: "string" }, nodeId: { type: "string" }, mode: { type: "string", enum: ["insert", "delete"] }, start: { type: "number" }, end: { type: "number" }, text: { type: "string" } }, required: ["nodeId", "mode", "start"] } },
  { name: "list_fonts", description: "List available fonts (up to 200).", inputSchema: { type: "object", properties: { channel: { type: "string" } } } },
  { name: "get_text_segments", description: "Get styled text segments of a text node (fonts/fills/decoration per range).", inputSchema: { type: "object", properties: { channel: { type: "string" }, nodeId: { type: "string" }, fields: { type: "array" }, start: { type: "number" }, end: { type: "number" } }, required: ["nodeId"] } },
  { name: "get_text_list", description: "Get list type of a text node (ORDERED|UNORDERED|NONE).", inputSchema: { type: "object", properties: { channel: { type: "string" }, nodeId: { type: "string" } }, required: ["nodeId"] } },
  { name: "set_text_list", description: "Set list type on a text node.", inputSchema: { type: "object", properties: { channel: { type: "string" }, nodeId: { type: "string" }, type: { type: "string", enum: ["ORDERED", "UNORDERED", "NONE"] } }, required: ["nodeId", "type"] } },
  { name: "get_reactions", description: "Get prototype reactions on a node.", inputSchema: { type: "object", properties: { channel: { type: "string" }, nodeId: { type: "string" } }, required: ["nodeId"] } },
  { name: "apply_style", description: "Apply a local paint/text/effect style to a node.", inputSchema: { type: "object", properties: { channel: { type: "string" }, nodeId: { type: "string" }, styleId: { type: "string" }, kind: { type: "string", enum: ["PAINT", "TEXT", "EFFECT"] } }, required: ["nodeId", "styleId", "kind"] } },
  { name: "set_export_settings", description: "Set export settings on a node.", inputSchema: { type: "object", properties: { channel: { type: "string" }, nodeId: { type: "string" }, settings: { type: "array" } }, required: ["nodeId", "settings"] } },
  { name: "set_viewport", description: "Set canvas viewport (zoom/center).", inputSchema: { type: "object", properties: { channel: { type: "string" }, zoom: { type: "number" }, centerX: { type: "number" }, centerY: { type: "number" } } } },
  { name: "set_instance_props", description: "Set properties on an instance.", inputSchema: { type: "object", properties: { channel: { type: "string" }, nodeId: { type: "string" }, properties: { type: "object" } }, required: ["nodeId", "properties"] } },
  { name: "swap_instance", description: "Swap an instance to a different component.", inputSchema: { type: "object", properties: { channel: { type: "string" }, nodeId: { type: "string" }, componentId: { type: "string" } }, required: ["nodeId", "componentId"] } },
  { name: "detach_instance", description: "Detach an instance from its component.", inputSchema: { type: "object", properties: { channel: { type: "string" }, nodeId: { type: "string" } }, required: ["nodeId"] } },
  { name: "get_main_component", description: "Get an instance's main component (null when detached).", inputSchema: { type: "object", properties: { channel: { type: "string" }, nodeId: { type: "string" } }, required: ["nodeId"] } },
  { name: "reset_instance", description: "Reset all direct overrides on an instance.", inputSchema: { type: "object", properties: { channel: { type: "string" }, nodeId: { type: "string" } }, required: ["nodeId"] } },
  { name: "create_section", description: "Create a section.", inputSchema: { type: "object", properties: { channel: { type: "string" }, name: { type: "string" }, x: { type: "number" }, y: { type: "number" }, width: { type: "number" }, height: { type: "number" } } } },
  { name: "create_shape", description: "Create a shape (line/polygon/star).", inputSchema: { type: "object", properties: { channel: { type: "string" }, kind: { type: "string", enum: ["LINE", "POLYGON", "STAR"] }, parentId: { type: "string" }, x: { type: "number" }, y: { type: "number" }, pointCount: { type: "number" }, name: { type: "string" } }, required: ["kind"] } },
  { name: "create_slice", description: "Create a slice.", inputSchema: { type: "object", properties: { channel: { type: "string" }, parentId: { type: "string" }, x: { type: "number" }, y: { type: "number" }, width: { type: "number" }, height: { type: "number" }, name: { type: "string" } } } },
  { name: "page_ops", description: "Page ops on the current page.", inputSchema: { type: "object", properties: { channel: { type: "string" }, action: { type: "string", enum: ["rename", "duplicate", "background"] }, name: { type: "string" }, color: { type: "string" } }, required: ["action"] } },
  { name: "set_effects", description: "Set effects (shadows/blurs) on a node.", inputSchema: { type: "object", properties: { channel: { type: "string" }, nodeId: { type: "string" }, effects: { type: "array" } }, required: ["nodeId", "effects"] } },
  { name: "set_blend_mode", description: "Set blend mode on a node.", inputSchema: { type: "object", properties: { channel: { type: "string" }, nodeId: { type: "string" }, blendMode: { type: "string" } }, required: ["nodeId", "blendMode"] } },
  { name: "create_style", description: "Create a paint/text/effect style.", inputSchema: { type: "object", properties: { channel: { type: "string" }, name: { type: "string" }, type: { type: "string" } }, required: ["name", "type"] } },
  { name: "delete_style", description: "Delete a style, requires confirm:true.", inputSchema: { type: "object", properties: { channel: { type: "string" }, styleId: { type: "string" }, styleIds: { type: "array" }, confirm: { type: "boolean" } }, required: ["styleId"] } },
  { name: "rename_style", description: "Rename a style.", inputSchema: { type: "object", properties: { channel: { type: "string" }, styleId: { type: "string" }, name: { type: "string" } }, required: ["styleId", "name"] } },
  { name: "get_style_by_id", description: "Get one local style by id (paint/text/effect/grid).", inputSchema: { type: "object", properties: { channel: { type: "string" }, styleId: { type: "string" } }, required: ["styleId"] } },
  { name: "import_style", description: "Import a published style by key.", inputSchema: { type: "object", properties: { channel: { type: "string" }, key: { type: "string" } }, required: ["key"] } },
  { name: "set_page_backgrounds", description: "Set page backgrounds.", inputSchema: { type: "object", properties: { channel: { type: "string" }, nodeId: { type: "string" }, backgrounds: { type: "array" }, color: { type: "string" }, prototypeBackgrounds: { type: "array" } }, required: ["nodeId"] } },
  { name: "ungroup", description: "Ungroup a group node.", inputSchema: { type: "object", properties: { channel: { type: "string" }, nodeId: { type: "string" } }, required: ["nodeId"] } },
  { name: "move_node_index", description: "Reparent / reorder a node by index.", inputSchema: { type: "object", properties: { channel: { type: "string" }, nodeId: { type: "string" }, parentId: { type: "string" }, index: { type: "number" } }, required: ["nodeId"] } },
  { name: "create_table", description: "Create a table.", inputSchema: { type: "object", properties: { channel: { type: "string" }, numRows: { type: "number" }, numColumns: { type: "number" }, parentId: { type: "string" }, name: { type: "string" }, x: { type: "number" }, y: { type: "number" } } } },
  { name: "create_connector", description: "Create a connector.", inputSchema: { type: "object", properties: { channel: { type: "string" }, parentId: { type: "string" }, name: { type: "string" }, x: { type: "number" }, y: { type: "number" } } } },
  { name: "set_guides", description: "Set guides on a page or frame.", inputSchema: { type: "object", properties: { channel: { type: "string" }, nodeId: { type: "string" }, guides: { type: "array" } }, required: ["nodeId", "guides"] } },
  { name: "delete_page", description: "Delete a page, requires confirm:true.", inputSchema: { type: "object", properties: { channel: { type: "string" }, pageId: { type: "string" }, nodeId: { type: "string" }, confirm: { type: "boolean" } }, required: ["pageId"] } },
  { name: "create_sticky", description: "Create a sticky note.", inputSchema: { type: "object", properties: { channel: { type: "string" }, parentId: { type: "string" }, name: { type: "string" }, x: { type: "number" }, y: { type: "number" } } } },
  { name: "create_shape_with_text", description: "Create a shape with text.", inputSchema: { type: "object", properties: { channel: { type: "string" }, parentId: { type: "string" }, name: { type: "string" }, x: { type: "number" }, y: { type: "number" } } } },
  { name: "create_code_block", description: "Create a code block.", inputSchema: { type: "object", properties: { channel: { type: "string" }, parentId: { type: "string" }, name: { type: "string" }, x: { type: "number" }, y: { type: "number" } } } },
  { name: "create_slide", description: "Create a slide.", inputSchema: { type: "object", properties: { channel: { type: "string" }, row: { type: "number" }, col: { type: "number" } } } },
  { name: "import_svg", description: "Import an SVG string as a node.", inputSchema: { type: "object", properties: { channel: { type: "string" }, svg: { type: "string" }, parentId: { type: "string" }, name: { type: "string" } }, required: ["svg"] } },
  { name: "set_text_font", description: "Set font on a text node.", inputSchema: { type: "object", properties: { channel: { type: "string" }, nodeId: { type: "string" }, family: { type: "string" }, fontFamily: { type: "string" }, style: { type: "string" }, fontStyle: { type: "string" } }, required: ["nodeId", "family"] } },
  { name: "create_component_prop_def", description: "Add a component property definition.", inputSchema: { type: "object", properties: { channel: { type: "string" }, nodeId: { type: "string" }, name: { type: "string" }, type: { type: "string", enum: ["BOOLEAN", "TEXT", "INSTANCE_SWAP", "VARIANT", "SLOT"] } }, required: ["nodeId", "name", "type"] } },
  { name: "delete_component_prop_def", description: "Delete a component property definition.", inputSchema: { type: "object", properties: { channel: { type: "string" }, nodeId: { type: "string" }, propertyName: { type: "string" } }, required: ["nodeId", "propertyName"] } },
  { name: "edit_component_prop_def", description: "Edit a component property definition (name/defaultValue/preferredValues/description/slotSettings).", inputSchema: { type: "object", properties: { channel: { type: "string" }, nodeId: { type: "string" }, propertyName: { type: "string" }, name: { type: "string" }, defaultValue: { }, preferredValues: { type: "array" }, description: { type: "string" }, slotSettings: { type: "object" } }, required: ["nodeId", "propertyName"] } },
  { name: "combine_as_variants", description: "Combine components as variants.", inputSchema: { type: "object", properties: { channel: { type: "string" }, nodeIds: { type: "array" }, parentId: { type: "string" } }, required: ["nodeIds"] } },
  { name: "rename_variable", description: "Rename a variable.", inputSchema: { type: "object", properties: { channel: { type: "string" }, variableId: { type: "string" }, name: { type: "string" } }, required: ["variableId", "name"] } },
  { name: "unbind_variable", description: "Unbind a variable from a node field.", inputSchema: { type: "object", properties: { channel: { type: "string" }, nodeId: { type: "string" }, field: { type: "string" } }, required: ["nodeId", "field"] } },
  { name: "delete_variable", description: "Delete a variable, requires confirm:true.", inputSchema: { type: "object", properties: { channel: { type: "string" }, variableId: { type: "string" }, confirm: { type: "boolean" } }, required: ["variableId"] } },
  { name: "get_variable_by_id", description: "Get one variable by id.", inputSchema: { type: "object", properties: { channel: { type: "string" }, variableId: { type: "string" } }, required: ["variableId"] } },
  { name: "get_variable_collection_by_id", description: "Get one variable collection by id.", inputSchema: { type: "object", properties: { channel: { type: "string" }, collectionId: { type: "string" } }, required: ["collectionId"] } },
  { name: "extend_collection", description: "Extend a library (collectionKey) or local (collectionId) collection — exactly one.", inputSchema: { type: "object", properties: { channel: { type: "string" }, name: { type: "string" }, collectionKey: { type: "string" }, collectionId: { type: "string" } }, required: ["name"] } },
  { name: "delete_variable_collection", description: "Delete a variable collection, requires confirm:true.", inputSchema: { type: "object", properties: { channel: { type: "string" }, collectionId: { type: "string" }, confirm: { type: "boolean" } }, required: ["collectionId", "confirm"] } },
  { name: "list_library_collections", description: "List available library variable collections (up to 100).", inputSchema: { type: "object", properties: { channel: { type: "string" } } } },
  { name: "list_library_variables", description: "List variables in a library collection (up to 200).", inputSchema: { type: "object", properties: { channel: { type: "string" }, key: { type: "string" } }, required: ["key"] } },
  { name: "set_vector_network", description: "Set vector network on a node.", inputSchema: { type: "object", properties: { channel: { type: "string" }, nodeId: { type: "string" }, vectorNetwork: { type: "object" } }, required: ["nodeId", "vectorNetwork"] } },
  { name: "set_reactions", description: "Set prototype reactions on a node.", inputSchema: { type: "object", properties: { channel: { type: "string" }, nodeId: { type: "string" }, reactions: { type: "array" } }, required: ["nodeId", "reactions"] } },
  { name: "set_flow_starting_point", description: "Set flow starting point.", inputSchema: { type: "object", properties: { channel: { type: "string" }, nodeId: { type: "string" }, name: { type: "string" } }, required: ["nodeId"] } },
  { name: "edit_dev_resource", description: "Edit a dev resource.", inputSchema: { type: "object", properties: { channel: { type: "string" }, currentUrl: { type: "string" }, url: { type: "string" }, name: { type: "string" }, nodeId: { type: "string" } }, required: ["currentUrl"] } },
  { name: "delete_dev_resource", description: "Delete a dev resource.", inputSchema: { type: "object", properties: { channel: { type: "string" }, url: { type: "string" }, nodeId: { type: "string" } }, required: ["url"] } },
  { name: "notify", description: "Show a toast notification in Figma (300 chars max).", inputSchema: { type: "object", properties: { text: { type: "string" }, timeout: { type: "number" }, error: { type: "boolean" } }, required: ["text"] } },
  { name: "undo", description: "Trigger one undo step in Figma.", inputSchema: { type: "object", properties: {} } },
  { name: "client_storage", description: "Plugin client storage get/set (JSON-safe values).", inputSchema: { type: "object", properties: { action: { type: "string", enum: ["get", "set"] }, key: { type: "string" }, value: { } }, required: ["action", "key"] } },
  { name: "node_data", description: "Node plugin data get/set (string values; shared needs namespace).", inputSchema: { type: "object", properties: { nodeId: { type: "string" }, action: { type: "string", enum: ["get", "set"] }, key: { type: "string" }, value: { }, shared: { type: "boolean" }, namespace: { type: "string" } }, required: ["nodeId", "action", "key"] } },
  { name: "watch_document", description: "Opt-in documentchange events (log-only, no history).", inputSchema: { type: "object", properties: { on: { type: "boolean" } }, required: ["on"] } },
  { name: "flatten_nodes", description: "Flatten 2-100 nodes into a single vector (parent of first).", inputSchema: { type: "object", properties: { channel: { type: "string" }, nodeIds: { type: "array" } }, required: ["nodeIds"] } },
  { name: "set_layout_grids", description: "Set layout grids on a frame/section/component (pattern ROWS|COLUMNS|GRID each).", inputSchema: { type: "object", properties: { channel: { type: "string" }, nodeId: { type: "string" }, grids: { type: "array" } }, required: ["nodeId", "grids"] } },
  { name: "get_selection_colors", description: "Colors used in the current selection (up to 50 paints).", inputSchema: { type: "object", properties: { channel: { type: "string" } } } },
  { name: "find_nodes", description: "Find nodes under parentId (or current page). Filters: types[], nameContains, textContains (TEXT characters, case-insensitive), textEmpty (TEXT with empty text), pluginData, sharedPluginData; limit default 100, clamped 1-1000. Returns {total, returned, truncated, matches:[{id, name, type, path}]}.", inputSchema: { type: "object", properties: { channel: { type: "string" }, parentId: { type: "string" }, types: { type: "array" }, nameContains: { type: "string" }, limit: { type: "number", description: "Max matches to return (default 100, clamped 1-1000)." }, textContains: { type: "string", description: "Case-insensitive substring of a TEXT node's characters." }, textEmpty: { type: "boolean", description: "Only TEXT nodes whose text is empty." }, pluginData: { type: "object", properties: { keys: { type: "array" } } }, sharedPluginData: { type: "object", properties: { namespace: { type: "string" }, keys: { type: "array" } } } } } },
  { name: "rescale_node", description: "Rescale a node by a positive scale factor (Scale Tool).", inputSchema: { type: "object", properties: { nodeId: { type: "string" }, scale: { type: "number" } }, required: ["nodeId", "scale"] } },
  { name: "outline_stroke", description: "Outline a node's strokes into a new vector (null when no strokes).", inputSchema: { type: "object", properties: { nodeId: { type: "string" } }, required: ["nodeId"] } },
  { name: "create_text_path", description: "Convert a vector node to text-on-a-path.", inputSchema: { type: "object", properties: { nodeId: { type: "string" }, startSegment: { type: "number" }, startPosition: { type: "number" } }, required: ["nodeId"] } },
  { name: "batch_tools", description: `Run up to ${BATCH_MAX_CALLS} tool calls in ONE round-trip (sequential; parallel only when every call is a read). Use for 2+ calls. For a single call, call that tool directly.`, inputSchema: { type: "object", properties: { calls: { type: "array", description: "[{tool, arguments}]", items: { type: "object" } }, parallel: { type: "boolean" }, stopOnError: { type: "boolean" } }, required: ["calls"] } },
  { name: "get_motion_info", description: "Motion playhead + animation styles (Beta).", inputSchema: { type: "object", properties: {} } },
  { name: "get_node_animations", description: "Read-only Motion state on a node (Beta).", inputSchema: { type: "object", properties: { nodeId: { type: "string" } }, required: ["nodeId"] } },
  { name: "apply_motion_style", description: "Apply a Motion animation style to a node (Beta).", inputSchema: { type: "object", properties: { nodeId: { type: "string" }, styleId: { type: "string" }, config: { type: "object" } }, required: ["nodeId", "styleId"] } },
  { name: "remove_motion_style", description: "Remove an applied Motion style instance from a node (Beta).", inputSchema: { type: "object", properties: { nodeId: { type: "string" }, id: { type: "string" } }, required: ["nodeId", "id"] } },
  { name: "set_manual_keyframes", description: "Write a manual Motion keyframe track on a node (Beta). Friendly field/value/easing forms.", inputSchema: { type: "object", properties: { nodeId: { type: "string" }, field: { }, baseValue: { }, keyframes: { type: "array" }, operation: { type: "string", enum: ["SET", "OFFSET", "SCALE"] } }, required: ["nodeId", "field", "keyframes"] } },
  { name: "remove_manual_keyframes", description: "Remove a manual Motion keyframe track from a node (Beta).", inputSchema: { type: "object", properties: { nodeId: { type: "string" }, field: { } }, required: ["nodeId", "field"] } },
  { name: "set_timeline_duration", description: "Set a Motion timeline duration in seconds (Beta).", inputSchema: { type: "object", properties: { nodeId: { type: "string" }, id: { type: "string" }, duration: { type: "number" } }, required: ["nodeId", "id", "duration"] } },
  { name: "transform_group", description: "Group nodes with transform modifiers.", inputSchema: { type: "object", properties: { nodeIds: { type: "array" }, parentId: { type: "string" }, index: { type: "number" }, modifiers: { type: "array" } }, required: ["nodeIds"] } },
  { name: "get_measurements", description: "Get page measurements (or for one node).", inputSchema: { type: "object", properties: { nodeId: { type: "string" } } } },
  { name: "get_style_consumers", description: "Get nodes consuming a style.", inputSchema: { type: "object", properties: { styleId: { type: "string" } }, required: ["styleId"] } },
  { name: "get_component_instances", description: "List instances of a component.", inputSchema: { type: "object", properties: { nodeId: { type: "string" } }, required: ["nodeId"] } },
  { name: "create_slot", description: "Create a slot in a component.", inputSchema: { type: "object", properties: { nodeId: { type: "string" } }, required: ["nodeId"] } },
  { name: "reset_slot", description: "Reset a slot to component content.", inputSchema: { type: "object", properties: { nodeId: { type: "string" } }, required: ["nodeId"] } },
  { name: "get_font_axes", description: "Get variation axes of a font family.", inputSchema: { type: "object", properties: { family: { type: "string" } }, required: ["family"] } },
  { name: "set_grid_style", description: "Apply a grid style to a node.", inputSchema: { type: "object", properties: { nodeId: { type: "string" }, styleId: { type: "string" } }, required: ["nodeId", "styleId"] } },
  { name: "create_page_divider", description: "Create a page divider.", inputSchema: { type: "object", properties: { name: { type: "string" } } } },
  { name: "get_file_thumbnail", description: "Get the file thumbnail node.", inputSchema: { type: "object", properties: {} } },
  { name: "set_file_thumbnail", description: "Set the file thumbnail node.", inputSchema: { type: "object", properties: { nodeId: { type: "string" } }, required: ["nodeId"] } },
  { name: "open_url", description: "Open an http(s) URL in the browser.", inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } },
  { name: "get_plugin_info", description: "Plugin file metadata (apiVersion/mode/fileKey/editorType).", inputSchema: { type: "object", properties: {} } },
  { name: "get_node_binds", description: "Get a node's bound/inferred variables + resolved modes.", inputSchema: { type: "object", properties: { nodeId: { type: "string" } }, required: ["nodeId"] } },
  { name: "get_vector_geometry", description: "Get a node's fill/stroke geometry + vector paths.", inputSchema: { type: "object", properties: { nodeId: { type: "string" } }, required: ["nodeId"] } },
  { name: "set_node_description", description: "Set node/style description + http(s) doc links.", inputSchema: { type: "object", properties: { nodeId: { type: "string" }, description: { type: "string" }, links: { type: "array" } }, required: ["nodeId"] } },
  { name: "set_dev_status", description: "Set/clear dev status (READY_FOR_DEV|COMPLETED, null clears).", inputSchema: { type: "object", properties: { nodeId: { type: "string" }, status: { } }, required: ["nodeId", "status"] } },
];
// advertised HTTP commands = plugin-level tool names (bridge-local tools excluded, ping_figma -> ping)
const BRIDGE_ONLY_TOOLS = new Set(["get_status", "batch_tools"]);
const COMMANDS = Array.from(new Set(
  TOOLS.map((t) => t.name)
    .filter((n) => !BRIDGE_ONLY_TOOLS.has(n))
    .map((n) => (n === "ping_figma" ? "ping" : n))
    .concat(["batch"])
));
// Single-connection: strip legacy channel from advertised schemas (runtime accepts+ignores it).
for (const t of TOOLS) { if (t.inputSchema && t.inputSchema.properties && t.inputSchema.properties.channel) delete t.inputSchema.properties.channel; }
// Advertise the fields picker on node-reading tools (same place, no schema drift).
for (const t of TOOLS) {
  if (FIELDABLE_READS.has(t.name) && t.inputSchema && t.inputSchema.properties) {
    t.inputSchema.properties.fields = { type: "array", description: "Allowlist of response keys per node (id/children/childIds/childCount always kept)" };
  }
}
// Advertise the slim opt-out on default-slim reads (same place, no schema drift).
for (const t of TOOLS) {
  if (SLIM_DEFAULT_READS.has(t.name) && t.inputSchema && t.inputSchema.properties) {
    t.inputSchema.properties._full = { type: "boolean", description: "Return full-fidelity nodes (default is slim)" };
  }
}

async function callTool(name, args = {}) {
  const a = { ...(args || {}) };
  name = TOOL_ALIAS[name] || name; // compact alias first (unknown names fall through to the error below)
  const slim = a._slim === true;
  const slimOut = (out) => (slim ? slimResult(out) : out);
  switch (name) {
    case "get_status": {
      if (proxyMode) {
        try {
          const r = await ownerStatus();
          return slimOut({ connected: !!r.connected, via: "proxy" });
        } catch { return slimOut({ connected: false, via: "proxy" }); }
      }
      const connected = !!figmaSocket && figmaSocket.readyState === 1;
      if (!connected) return slimOut({ connected: false });
      try {
        const pong = await sendToFigma("ping", {});
        return slimOut({ connected: true, file: pong && pong.file });
      } catch { return slimOut({ connected: false }); }
    }
    case "export_node": {
      const { channel: _c, _slim: _s, _full: _f2, fields: _fd, ...rest } = a;
      const ex = expandKeys(rest);
      const r = await sendToFigma("export_node", { nodeId: ex.nodeId, format: ex.format || "PNG", scale: ex.scale ?? 2, fps: ex.fps, quality: ex.quality, loopCount: ex.loopCount });
      if (ex.savePath) {
        if (r.truncated) throw new Error("export truncated — file would be corrupt; lower scale");
        if (!r.base64) throw new Error("savePath needs PNG/JPG/PDF/MP4/GIF/WEBM — SVG returns inline text");
        const p = path.resolve(String(ex.savePath));
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, Buffer.from(r.base64, "base64"));
        return slimOut({ ...r, base64: r.base64.slice(0, 120) + "...(saved)", savedTo: p });
      }
      return slimOut(r);
    }
    default: {
      if (name === "batch_tools") {
        const { channel: _b, _echo: _be, ...b } = a;
        // top-level _echo propagates onto each sub-call's arguments so the whole batch takes the full-response path
        if (_be === true && Array.isArray(b.calls)) {
          for (const c of b.calls) {
            if (c && typeof c === "object" && !Array.isArray(c.arguments)) {
              c.arguments = { ...(c.arguments && typeof c.arguments === "object" ? c.arguments : {}), _echo: true };
            }
          }
        }
        return await runBatch(b.calls, { parallel: b.parallel, stopOnError: b.stopOnError });
      }
      const known = TOOLS.find((t) => t.name === name);
      if (!known) throw new Error(`unknown tool: ${name}`);
      const { channel: _drop, _slim: _s2, _full: _full, fields: _f, _echo: _e, format: _fmt, ...rest } = a;
      if (_fmt !== undefined && _fmt !== "panel") throw new Error('invalid format: expected "panel"');
      const params = expandKeys(rest);
      // map MCP arg shape -> plugin command params
      if (name === "delete_nodes" && params.nodeId && !params.nodeIds) params.nodeIds = [params.nodeId];
      if (name === "get_node_tree") params.depth = params.depth ?? 2; // narrow by default; ask deeper deliberately
      const cmd = name === "ping_figma" ? "ping" : name;
      injectDetail(params, { write: isWriteTool(name), echo: _e === true, slimRead: SLIM_DEFAULT_READS.has(name), full: _full === true, fields: _f, panel: _fmt === "panel" });
      const res = applyReadOptions(await sendToFigma(cmd, params), { fields: _f, _slim: slim, _full: _full }, name);
      const out = isWriteTool(name) && _e !== true ? receiptOf(res) : res;
      return _fmt === "panel" && PANEL_TOOLS.has(name) ? renderPanel(out) : out;
    }
  }
}

// minimal MCP stdio transport (newline-delimited JSON-RPC)
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", async (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let req;
    try { req = JSON.parse(line); } catch { continue; }
    handleMcp(req).catch((e) => reply(req?.id, null, { code: -32603, message: String(e?.message || e) }));
  }
});

function reply(id, result, error) {
  if (id === undefined || id === null) return;
  const msg = error ? { jsonrpc: "2.0", id, error } : { jsonrpc: "2.0", id, result };
  process.stdout.write(JSON.stringify(msg) + "\n");
}

async function handleMcp(req) {
  const { id, method, params } = req || {};
  if (method === "initialize") {
    return reply(id, {
      protocolVersion: (params && params.protocolVersion) || "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "oc-mcp-bridge", version: "1.0.0" },
    });
  }
  if (method === "notifications/initialized" || (typeof method === "string" && method.startsWith("notifications/"))) return;
  if (method === "ping") return reply(id, {});
  if (method === "tools/list") return reply(id, { tools: TOOLS });
  if (method === "tools/call") {
    const toolName = params?.name;
    try {
      const result = await callTool(toolName, params?.arguments || {});
      const text = typeof result === "string" ? result : JSON.stringify(result);
      const cap = toolName === "batch_tools" ? 5 * 1024 * 1024 : 200000;
      if (text.length > cap) {
        // never cut JSON mid-object: return a valid envelope the caller can parse
        process.stderr.write(`tools/call ${toolName}: response ${text.length} chars exceeds cap ${cap}; returning truncation envelope\n`);
        return reply(id, { content: [{ type: "text", text: JSON.stringify({ ok: false, truncated: true, chars: text.length, limit: cap, hint: "response too large - narrow the query (fields/_slim/_detail) or lower depth" }) }], isError: false });
      }
      return reply(id, { content: [{ type: "text", text }], isError: false });
    } catch (e) {
      return reply(id, { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true });
    }
  }
  return reply(id, null, { code: -32601, message: `Method not found: ${method}` });
}

log("mcp stdio ready");
