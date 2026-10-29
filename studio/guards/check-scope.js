#!/usr/bin/env node
"use strict";
// check:scope - the second gate behind the Studio API: a pull request from a studio/ branch may change ONLY data.
//
//   node studio/guards/check-scope.js --base origin/main --head HEAD [--root <repo>]
//   node studio/guards/check-scope.js --paths-file <file of "<status>\t<path>" lines>     (tests / selftest)
//
// Allowed: added or modified files that studio/validate/scope.js classifies (src/_data/*.json, src/pages/*.md,
// new files in images/). Everything else fails: code, templates, config, CI, package files, dotfiles; renames
// (a rename is a delete plus an add of a path somebody chose); deletions of anything but pictures.
// With no --base and no --paths-file (how `npm run check` calls it) only the scope definition itself is verified:
// the files that must never be in scope are checked against scope.js, so an edit that widens it fails everywhere.

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const argv = process.argv.slice(2);
const argOf = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const root = path.resolve(argOf("--root") || path.resolve(__dirname, "..", ".."));
const scope = require("../validate/scope.js"); // the scope definition next to THIS file (in CI: the copy taken from main)

const MUST_BE_OUT = [
  "package.json", "package-lock.json", "netlify.toml", ".eleventy.js", ".gitignore", ".github/workflows/site-checks.yml",
  ".github/CODEOWNERS", "cms/config.yml", "cms/previews.js", "lib/rules.js", "scripts/check-cms.js", "studio/api/handler.js",
  "studio/validate/scope.js", "src/index.njk", "src/_includes/base.njk", "src/_data/../../package.json", "src/_data/x.js",
  "src/_data/x.json.js", "src/_data/sub/x.json", "src/_data/.json", "src/_data/X.json", "src/pages/a.njk", "src/pages/a.md.js",
  "images/x.html", "images/x.js", "images/.hidden", "images/../package.json", "images/a/b.jpg", "assets/app.js", "index.html", "admin/index.html",
  "../package.json", "/etc/passwd", "src\\_data\\hero.json",
];
const MUST_BE_IN = ["src/_data/hero.json", "src/pages/about.md", "images/story-5-bathroom.jpg", "images/logo.svg"];

function selfCheck() {
  const problems = [];
  for (const p of MUST_BE_OUT) if (scope.classify(p) !== null) problems.push("scope.js lets Studio touch " + JSON.stringify(p));
  for (const p of MUST_BE_IN) if (scope.classify(p) === null) problems.push("scope.js refuses " + JSON.stringify(p) + " (Studio could not do its job)");
  return problems;
}

function changedFromGit(base, head) {
  const r = spawnSync("git", ["-C", root, "diff", "--name-status", "--no-renames", "-z", base + "..." + head], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) { console.error("check-scope: git diff failed: " + String(r.stderr || "").trim().slice(0, 300)); process.exit(2); }
  // --no-renames reports a rename as a delete plus an add, which is exactly how it is judged here
  const parts = String(r.stdout).split("\0").filter(Boolean);
  const out = [];
  for (let i = 0; i + 1 < parts.length; i += 2) out.push({ status: parts[i][0], path: parts[i + 1] });
  return out;
}
function changedFromFile(file) {
  return fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map((l) => { const [s, ...p] = l.split("\t"); return { status: s[0], path: p.join("\t") }; });
}

function judge(changes) {
  const problems = [];
  for (const c of changes) {
    const kind = scope.classify(c.path);
    if (!kind) { problems.push(c.status + " " + c.path + ": outside what Studio may change"); continue; }
    if (c.status === "D" && kind !== "image") problems.push("D " + c.path + ": Studio never deletes data files or pages");
    else if (c.status === "A" && kind !== "image") problems.push("A " + c.path + ": Studio never creates data files or pages");
    else if (!/^[AMD]$/.test(c.status)) problems.push(c.status + " " + c.path + ": unexpected change type");
  }
  return problems;
}

function main() {
  const problems = selfCheck();
  const base = argOf("--base");
  const head = argOf("--head") || "HEAD";
  const pf = argOf("--paths-file");
  let n = null;
  if (pf || base) {
    const changes = pf ? changedFromFile(pf) : changedFromGit(base, head);
    n = changes.length;
    problems.push(...judge(changes));
  }
  if (problems.length) {
    console.log("== Studio scope ==");
    for (const p of problems.slice(0, 60)) console.log("  - " + p);
    console.log("\nCHECK-SCOPE FAILED: " + problems.length + " problem(s)");
    return 1;
  }
  console.log("check-scope: ok (" + (n === null ? "scope definition verified against " + (MUST_BE_OUT.length + MUST_BE_IN.length) + " paths" : n + " changed file(s), all data") + ")");
  return 0;
}
process.exit(main());
