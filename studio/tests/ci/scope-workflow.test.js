"use strict";
// studio-scope runs the guard from a copy of main in a temp folder. A module the guard needs but the workflow does not copy
// crashes it (MODULE_NOT_FOUND) and blocks every Studio draft: list every relative require and demand the workflow copies it.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..", "..", "..");
const wf = fs.readFileSync(path.join(ROOT, ".github", "workflows", "studio-scope.yml"), "utf8");

function relRequires(file, seen) {
  const abs = path.join(ROOT, file);
  if (seen.has(file)) return;
  seen.add(file);
  const text = fs.readFileSync(abs, "utf8");
  for (const m of text.matchAll(/require\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g)) {
    let p = path.relative(ROOT, path.resolve(path.dirname(abs), m[1])).split(path.sep).join("/");
    if (!/\.[cm]?js$/.test(p)) p += ".js";
    relRequires(p, seen);
  }
}

test("the studio-scope workflow copies every file its guard needs", () => {
  const needed = new Set();
  relRequires("studio/guards/check-scope.js", needed);
  assert.ok(needed.size >= 3, "expected the guard, the scope definition and the image rules");
  for (const f of needed) assert.ok(wf.includes("origin/main:" + f), f + " is required by the scope guard but the workflow does not take it from main");
});
