#!/usr/bin/env node
"use strict";
// check-copy: every word a visitor can see or hear must come from editable data.
//
//   node scripts/check-copy.js [--site _site] [--root .] [--allowlist scripts/copy-allowlist.json]
//                              [--max 200] [--no-stale] [--strict-stale]
//
// Reads the BUILT site. Visible text (text nodes, alt / aria-label / title / placeholder, submit
// values, <title>, meta description + share tags, JSON-LD text) and the human-readable strings in
// inline <script>s (found with a real JavaScript parser) must be traceable to the corpus of editable
// data - string leaves of src/_data/*.json, front matter + body of src/pages/*.md, front matter of
// src/*.njk - or be matched by an entry of scripts/copy-allowlist.json (each entry has a reason).
// Exit code: 0 clean, 1 violations, 2 usage / missing build.

const path = require("path");
const { runMain, strictStale, parseArgs, readJson, exists, Report, REPO_ROOT, SCRIPTS_DIR } = require("./lib/util");
const { loadSources } = require("./lib/data");
const { buildCorpus } = require("./lib/corpus");
const { AllowList } = require("./lib/allowlist");
const { scanSite, Acceptor } = require("./lib/copycheck");

function main() {
  const args = parseArgs(process.argv.slice(2), { site: "string", root: "string", allowlist: "string", max: "number", noStale: "boolean", strictStale: "boolean" });
  if (args.help) {
    console.log("usage: node scripts/check-copy.js [--site <built site, default _site>] [--root <repo root>] [--allowlist <file>] [--max <n>] [--no-stale] [--strict-stale]");
    return 0;
  }
  const root = path.resolve(args.root || REPO_ROOT);
  const siteDir = path.resolve(args.site || path.join(root, "_site"));
  const allowFile = path.resolve(args.allowlist || path.join(SCRIPTS_DIR, "copy-allowlist.json"));
  if (!exists(siteDir)) {
    console.error("check-copy: built site not found at " + siteDir + "\n  Run `npm run build` first (or pass --site <dir>).");
    return 2;
  }

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
  report.note("check-copy: site " + rel(siteDir) + " | data root " + rel(root));
  report.note("  scanned " + stats.pages.length + " page(s): " + stats.pages.join(" ") + (stats.skipped.length ? "   (excluded: " + stats.skipped.join(" ") + ")" : ""));
  report.note("  " + stats.items + " text/attribute items, " + stats.scripts + " script blocks (" + stats.scriptStrings + " readable strings); corpus " + corpus.size + " segments; allow-list " + allow.entries.length + " entries (" + allow.entries.filter((e) => e.uses).length + " used)");
  return report.print({ max: args.max || 200, okMessage: "OK - all visible text, pictures and outward links are traceable to editable data" });
}

runMain("check-copy", main);
