#!/usr/bin/env node
"use strict";
// check-phase1: the cross-unit promises of studio/PHASE1-DESIGN.md that no single unit's guard owns.
//   node studio/guards/check-phase1.js [--root <repo>]
// 1. every environment variable in the table of section 13 is named in docs/STUDIO-RUNBOOK.md;
// 2. every script the overlay manifest lists exists (an ext file that vanished is a silent feature loss);
// 3. the overlay budget lines are the Phase 1 values in check-overlay.js and check-ai-overlay.js agrees;
// 4. the pre-wired route files, rule-engine files and the shapes module exist and the handler requires the route files.
const fs = require("fs");
const path = require("path");

const i = process.argv.indexOf("--root");
const ROOT = path.resolve(i >= 0 ? process.argv[i + 1] : path.join(__dirname, "..", ".."));
const problems = [];
const read = (rel) => { try { return fs.readFileSync(path.join(ROOT, rel), "utf8"); } catch (e) { return null; } };
const fail = (where, msg) => problems.push(where + ": " + msg);

const design = read("studio/PHASE1-DESIGN.md");
const runbook = read("docs/STUDIO-RUNBOOK.md");
if (design === null) fail("studio/PHASE1-DESIGN.md", "missing");
if (runbook === null) fail("docs/STUDIO-RUNBOOK.md", "missing");

let names = [];
if (design !== null) {
  const start = design.indexOf("## 13. Environment variables");
  const end = design.indexOf("## 14.", start);
  names = start < 0 || end < 0 ? [] : [...design.slice(start, end).matchAll(/^\| `(STUDIO_[A-Z0-9_]+)` \|/gm)].map((m) => m[1]);
  if (names.length < 8) fail("studio/PHASE1-DESIGN.md", "could not read the environment table of section 13 (found " + names.length + ")");
}
if (runbook !== null) for (const n of names) if (!runbook.includes(n)) fail("docs/STUDIO-RUNBOOK.md", "does not mention environment variable " + n);

const manifestText = read("studio/overlay/manifest.json");
if (manifestText === null) fail("studio/overlay/manifest.json", "missing");
else {
  let m = null;
  try { m = JSON.parse(manifestText); } catch (e) { fail("studio/overlay/manifest.json", "does not parse"); }
  if (m) {
    for (const rel of (m.scripts || []).concat(m.styles || [])) {
      if (!fs.existsSync(path.resolve(ROOT, "studio", "overlay", rel))) fail("studio/overlay/manifest.json", "lists " + rel + " but the file does not exist");
    }
    for (const must of ["../content-rules/engine.js", "../content-rules/rules.js", "ext/legend.js", "ext/checks.js", "ext/status.js", "ext/review.js"]) {
      if (!(m.scripts || []).includes(must)) fail("studio/overlay/manifest.json", "must list " + must + " (pre-registered for Phase 1)");
    }
    if ((m.scripts || [])[m.scripts.length - 1] !== "main.js") fail("studio/overlay/manifest.json", "main.js must stay last");
  }
}

const co = read("studio/guards/check-overlay.js");
const bm = co && /const BUDGET = \{ scriptsKiB: (\d+), cssKiB: (\d+) \}/.exec(co);
if (!bm) fail("studio/guards/check-overlay.js", "BUDGET line not found");
else if (Number(bm[1]) !== 460 || Number(bm[2]) !== 64) fail("studio/guards/check-overlay.js", "the overlay budget is " + bm[1] + "/" + bm[2] + " KiB; Phase 1 fixed it at 460/64 (PHASE1-DESIGN 0, P9); raising it needs a recorded deviation");

for (const rel of ["studio/api/shapes/phase1.js", "studio/content-rules/engine.js", "studio/content-rules/rules.js", "studio/content-rules/index.js", "studio/api/routes/health.js", "studio/api/routes/board.js", "studio/api/routes/review.js", "studio/api/review-config.js"]) {
  if (!fs.existsSync(path.join(ROOT, rel))) fail(rel, "missing (pre-wired by the design commit)");
}
const handler = read("studio/api/handler.js") || "";
for (const r of ["health", "board", "review"]) if (!handler.includes('require("./routes/' + r + '")')) fail("studio/api/handler.js", "allRoutes() must require routes/" + r);
if (!(read("studio/api/config.js") || "").includes('require("./review-config").load(e)')) fail("studio/api/config.js", "loadConfig must call review-config load(e)");

if (problems.length) {
  console.error("check-phase1: FAILED\n  " + problems.join("\n  "));
  process.exit(1);
}
console.log("check-phase1: OK - " + names.length + " environment variables in the runbook, overlay manifest and budget intact, pre-wired files present");
