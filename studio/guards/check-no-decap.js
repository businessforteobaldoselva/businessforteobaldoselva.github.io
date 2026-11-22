#!/usr/bin/env node
"use strict";
// check-no-decap: the old Decap editor and the Netlify Identity / Git Gateway login stay retired (PHASE1-DESIGN 12).
//   node studio/guards/check-no-decap.js [--root <repo>]
// Fails if: a file outside admin/, docs/, node_modules/ and the retirement notes holds one of the dead strings;
// cms/index.html, cms/previews.js or cms/custom.css exist; cms/config.yml has a backend: or publish_mode: key;
// package.json has decap-server, cms-local or check:previews; netlify.toml mentions identity or a gateway;
// cms/moved.html is missing, runs a script, loads anything from another site, or lacks noindex.
const fs = require("fs");
const path = require("path");

const i = process.argv.indexOf("--root");
const ROOT = path.resolve(i >= 0 ? process.argv[i + 1] : path.join(__dirname, "..", ".."));
const problems = [];
const fail = (where, msg) => problems.push(where + ": " + msg);
const read = (rel) => { try { return fs.readFileSync(path.join(ROOT, rel), "utf8"); } catch (e) { return null; } };

const DEAD = ["identity.netlify.com", "netlify-identity", "decap-cms", "decap-server", "git-gateway", "editorial_workflow", "/.netlify/identity", "invite_token"];
const SKIP_DIRS = new Set(["node_modules", ".git", "_site", "admin", "docs", ".claude", "graphify-out"]);
const SKIP_FILES = new Set(["studio/PHASE1-DESIGN.md", "studio/NOTES-p1-decap.md", "studio/guards/check-no-decap.js", "studio/guards/selftest-p1-decap.js", "studio/tests/p1-decap/decap.test.js"]);
const TEXT = /\.(js|mjs|cjs|json|md|njk|html|css|yml|yaml|toml|txt|sql|xml|sh)$/i;

(function walk(rel) {
  for (const e of fs.readdirSync(path.join(ROOT, rel), { withFileTypes: true })) {
    const r = rel ? rel + "/" + e.name : e.name;
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(r); continue; }
    if (!TEXT.test(e.name) || SKIP_FILES.has(r)) continue;
    const text = fs.readFileSync(path.join(ROOT, r), "utf8");
    for (const d of DEAD) if (text.includes(d)) fail(r, 'contains "' + d + '" (Decap / Netlify Identity is retired)');
  }
})("");

for (const f of ["cms/index.html", "cms/previews.js", "cms/custom.css"]) if (fs.existsSync(path.join(ROOT, f))) fail(f, "must not exist (the old editor is retired); the page at /cms/ is cms/moved.html");
const cfg = read("cms/config.yml");
if (cfg === null) fail("cms/config.yml", "missing (it is the schema source of truth)");
else if (/^(backend|publish_mode)\s*:/m.test(cfg)) fail("cms/config.yml", "has a backend: or publish_mode: key (Decap settings)");
const pkg = read("package.json") || "";
for (const k of ["decap-server", "cms-local", "check:previews"]) if (pkg.includes(k)) fail("package.json", "mentions " + k);
if (/identity|gateway/i.test(read("netlify.toml") || "")) fail("netlify.toml", "mentions identity or a gateway (those are Netlify site settings, never repo config)");

const moved = read("cms/moved.html");
if (moved === null) fail("cms/moved.html", "missing (it is published as /cms/)");
else {
  if (/<script/i.test(moved)) fail("cms/moved.html", "has a <script");
  if (/(src|href)\s*=\s*["']?\s*(https?:)?\/\//i.test(moved)) fail("cms/moved.html", "loads or links something from another address");
  if (!/<meta\s+name="robots"\s+content="[^"]*noindex/i.test(moved)) fail("cms/moved.html", "has no noindex robots meta");
}

if (problems.length) {
  console.error("check-no-decap: FAILED\n  " + problems.join("\n  "));
  process.exit(1);
}
console.log("check-no-decap: OK - no Decap editor, Identity or Git Gateway wiring left; /cms/ is the static moved page");
