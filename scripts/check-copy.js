#!/usr/bin/env node
"use strict";
// check-copy: every word a visitor can see or hear must come from editable data.
//
//   node scripts/check-copy.js [--site <built site>] [--root .] [--allowlist scripts/copy-allowlist.json]
//                              [--max 200] [--no-stale] [--strict-stale]
//
// Reads the BUILT site. Without --site it builds the checkout (--root) into a fresh temp folder and
// deletes it afterwards, so leftovers in _site (Eleventy never clears its output folder) cannot add
// pages that are not in the source; --site <dir> reads an existing build instead. Visible text (text nodes, alt / aria-label / title / placeholder, submit
// values, <title>, meta description + share tags, JSON-LD text) and the human-readable strings in
// inline <script>s (found with a real JavaScript parser) must be traceable to the corpus of editable
// data - string leaves of src/_data/*.json, front matter + body of src/pages/*.md, front matter of
// src/*.njk - or be matched by an entry of scripts/copy-allowlist.json (each entry has a reason).
// Exit code: 0 clean, 1 violations, 2 usage / missing build.

const path = require("path");
const { spawnSync } = require("child_process");
const { runMain, mkTmp, removeTree, strictStale, parseArgs, readJson, exists, Report, REPO_ROOT, SCRIPTS_DIR } = require("./lib/util");
const { loadSources } = require("./lib/data");
const { buildCorpus } = require("./lib/corpus");
const { AllowList } = require("./lib/allowlist");
const { scanSite, Acceptor } = require("./lib/copycheck");
const { eleventyBin } = require("./lib/workspace");

// Builds the checkout into a throwaway folder. -> { ok, out, tmp, log }
function freshBuild(root) {
  const tmp = mkTmp("covered-copy-");
  const out = path.join(tmp, "site");
  const r = spawnSync(process.execPath, [eleventyBin(root), "--quiet", "--output=" + out], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { ok: r.status === 0 && exists(out), out, tmp, log: (r.stdout || "") + (r.stderr || "") };
}

function main() {
  const args = parseArgs(process.argv.slice(2), { site: "string", root: "string", allowlist: "string", max: "number", noStale: "boolean", strictStale: "boolean" });
  if (args.help) {
    console.log("usage: node scripts/check-copy.js [--site <built site; default: build the checkout into a temp folder>] [--root <repo root>] [--allowlist <file>] [--max <n>] [--no-stale] [--strict-stale]");
    return 0;
  }
  const root = path.resolve(args.root || REPO_ROOT);
  if (args.site) {
    const siteDir = path.resolve(args.site);
    if (!exists(siteDir)) {
      console.error("check-copy: built site not found at " + siteDir + "\n  Pass an existing build with --site <dir>, or omit --site to build the checkout.");
      return 2;
    }
    return check(args, root, siteDir, path.relative(process.cwd(), siteDir) || ".");
  }
  const b = freshBuild(root);
  try {
    if (!b.ok) {
      console.error("check-copy: the site does not build\n" + b.log.split("\n").slice(-20).join("\n"));
      return 2;
    }
    return check(args, root, b.out, "fresh build of " + (path.relative(process.cwd(), root) || "."));
  } finally {
    removeTree(b.tmp);
  }
}

function check(args, root, siteDir, siteLabel) {
  const allowFile = path.resolve(args.allowlist || path.join(SCRIPTS_DIR, "copy-allowlist.json"));
  const report = new Report("check-copy");
  const { sources, problems } = loadSources(root);
  problems.forEach((p) => report.add("Data files", p));
  const corpus = buildCorpus(sources);
  const refs = {};
  for (const s of sources) refs[s.name] = s.data;
  const allow = new AllowList(exists(allowFile) ? readJson(allowFile) : {}, refs);
  allow.problems.forEach((p) => report.add("Allow-list file", p));
  // a template entry whose data is gone is dormant (the editor switched the feature off); strict mode calls it stale
  if (strictStale(args)) allow.inactive.forEach((p) => report.add("Allow-list file", p, "The data it composes from is missing or empty."));
  else if (allow.inactive.length) report.note("  note: " + allow.inactive.length + " template allow-list entr" + (allow.inactive.length === 1 ? "y is" : "ies are") + " dormant because the editable data it composes from is empty (" + allow.inactive.map((x) => x.split(":")[0].replace("entry ", "")).join(", ") + ")");

  const acceptor = new Acceptor(allow, report, { corpus });
  const stats = scanSite(siteDir, (t, c, u, i) => acceptor.accept(t, c, u, i), report, { isExcluded: (url) => allow.isExcluded(url) });

  for (const p of acceptor.proseProblems()) {
    report.add("Allow-list file", "entry '" + p.id + "' is a sentence-length exact text used on indexable page(s) " + p.pages.join(", "), "Prose may only be allow-listed on noindex pages. Move the words into src/_data (or page front matter) and give the CMS a field for them.");
  }
  const unused = args.noStale ? [] : allow.entries.filter((e) => e.uses === 0 && !e.allowUnused);
  if (strictStale(args)) {
    for (const e of unused) report.add("Allow-list file", "entry '" + e.id + "' matched nothing", "Delete it (the text it excused is gone) or fix it. Unused entries would silently excuse the same text in future.");
  } else if (unused.length) report.note("  note: " + unused.length + " allow-list entr" + (unused.length === 1 ? "y" : "ies") + " matched nothing (" + unused.map((e) => e.id).join(", ") + "); --strict-stale makes that an error"); 

  const rel = (p) => path.relative(process.cwd(), p) || ".";
  report.note("check-copy: site " + siteLabel + " | data root " + rel(root));
  report.note("  scanned " + stats.pages.length + " page(s): " + stats.pages.join(" ") + (stats.skipped.length ? "   (excluded: " + stats.skipped.join(" ") + ")" : ""));
  report.note("  " + stats.items + " text/attribute items, " + stats.scripts + " script blocks (" + stats.scriptStrings + " readable strings); corpus " + corpus.size + " segments; allow-list " + allow.entries.length + " entries (" + allow.entries.filter((e) => e.uses).length + " used)");
  return report.print({ max: args.max || 200, okMessage: "OK - all visible text, pictures and outward links are traceable to editable data" });
}

runMain("check-copy", main);
