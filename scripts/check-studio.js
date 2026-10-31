#!/usr/bin/env node
"use strict";
// check:studio - the one entry point for every Studio (phase 4) guard and unit test.
//
//   node scripts/check-studio.js [--only <substring>]
//
// Runs, in order:
//   1. every studio/guards/check-*.js (sorted), each as its own `node <file> --root <repo>` process;
//   2. `node --test studio/tests/` when that folder holds *.test.js files (zero-dependency node:test).
// Exit 0 only if all of them exit 0. A Studio unit adds a guard by creating ONE new file in
// studio/guards/ - nobody edits this file (see studio/DESIGN.md section 15). No guards yet = pass.

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const only = (() => { const i = process.argv.indexOf("--only"); return i >= 0 ? String(process.argv[i + 1] || "") : ""; })();

function walkTests(dir, out) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkTests(p, out);
    else if (/\.test\.js$/.test(e.name)) out.push(p);
  }
  return out;
}

const steps = [];
const gdir = path.join(ROOT, "studio", "guards");
if (fs.existsSync(gdir)) {
  for (const f of fs.readdirSync(gdir).filter((n) => /^check-.*\.js$/.test(n)).sort()) {
    steps.push({ name: "guard " + f, args: [path.join(gdir, f), "--root", ROOT] });
  }
}
const tests = walkTests(path.join(ROOT, "studio", "tests"), []).sort();
if (tests.length) steps.push({ name: "unit tests (" + tests.length + " files)", args: ["--require", path.join(gdir, "no-network.js"), "--test", "--test-concurrency=4"].concat(tests) });

let failed = 0;
for (const s of steps) {
  if (only && !s.name.includes(only)) continue;
  const t0 = Date.now();
  const r = spawnSync(process.execPath, s.args, { cwd: ROOT, stdio: "inherit", env: Object.assign({}, process.env, { CMS_EDIT: "" }) });
  const ok = r.status === 0;
  if (!ok) failed += 1;
  console.log((ok ? "ok    " : "FAIL  ") + s.name + " (" + ((Date.now() - t0) / 1000).toFixed(1) + " s)");
}
console.log(steps.length ? "check:studio " + (failed ? "FAILED: " + failed + " of " + steps.length : "OK: " + steps.length + " step(s)") : "check:studio: no Studio guards yet (nothing to run)");
process.exit(failed ? 1 : 0);
