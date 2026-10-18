// opencode config merge for oc mcp.
// Usage:
//   node setup-opencode.js                 -> writes GLOBAL config (~/.config/opencode/opencode.json)
//   node setup-opencode.js --project DIR   -> also writes DIR/opencode.json (project-local)
// Safe: merges mcp.figma-bridge, preserves all other keys.
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");

const serverPath = path.join(__dirname, "bridge", "server.js");

function mergeConfig(cfgPath) {
  let cfg = {};
  try {
    cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
  } catch (e) {
    if (e.code !== "ENOENT") {
      console.error("[setup] could not parse " + cfgPath + ": " + e.message);
      return false;
    }
  }
  cfg.$schema = cfg.$schema || "https://opencode.ai/config.json";
  cfg.mcp = cfg.mcp && typeof cfg.mcp === "object" ? cfg.mcp : {};
  cfg.mcp["figma-bridge"] = {
    type: "local",
    command: ["node", serverPath],
    enabled: true,
  };
  fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  console.log("[setup] updated: " + cfgPath);
  return true;
}

const args = process.argv.slice(2);
const projIdx = args.indexOf("--project");
const projDir = projIdx >= 0 ? args[projIdx + 1] : null;

let ok = mergeConfig(path.join(os.homedir(), ".config", "opencode", "opencode.json"));
if (projDir) {
  const p = path.resolve(projDir);
  if (!fs.existsSync(p)) {
    console.error("[setup] project folder not found: " + p);
    process.exit(1);
  }
  const projOk = mergeConfig(path.join(p, "opencode.json"));
  ok = ok && projOk;
}
if (!ok) {
  process.exit(1);
}
console.log("[setup] restart opencode to pick up figma-bridge.");
