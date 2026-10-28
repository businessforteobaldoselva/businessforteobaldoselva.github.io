#!/usr/bin/env node
"use strict";
// check-hostile: hostile text typed into any field must not break out of where it is printed.
//
//   node scripts/check-hostile.js [--root .] [--max 200] [--keep] [--quick]
//
// Builds a reference copy of the site (every editable field holds a harmless token, plus an example
// of every optional field and unused block type), then builds the same copy several times with
// attack strings in every editable field - appended markup / script / template breakouts,
// javascript: and protocol-relative links, attribute and CSS breakouts, path traversal - and a
// "chaos" build that rewrites every string of the data, selects and ids included. Each result is
// compared with the reference:
//   no new event-handler attribute, script, style, iframe / object / base / meta refresh element,
//   no javascript: / data: / off-site / .. URL in a link or source attribute, inline scripts still
//   parse and contain no injected call, JSON-LD still parses, no template expression was evaluated.
// A static rule also bans fed-from-data innerHTML / document.write / eval / location changes in the
// page's own scripts. Exit code: 0 clean, 1 violations, 2 usage error.

const path = require("path");
const fs = require("fs");
const { runMain, parseArgs, Report, REPO_ROOT, clip, readText } = require("./lib/util");
const { loadSources } = require("./lib/data");
const { loadConfig } = require("./lib/cmsconfig");
const { Workspace } = require("./lib/workspace");
const { makePlan, applyPlan } = require("./lib/sentinel");
const { findPages, pageUrlOf } = require("./lib/copycheck");
const { analysePage, scriptProblems, sinkProblems } = require("./lib/hostile");

// Each family is applied to every editable field in its own build.
const FAMILIES = [
  { id: "appended markup", fn: (s) => s + ' HXAPP<img src=x onerror=alert(1)></script><script>alert(2)</script></style><script>alert(3)</script>"\'><svg onload=alert(4)>{{ 90911 + 6 }}{% if true %}HXTPL{% endif %}' },
  { id: "javascript: URL", fn: () => "javascript:alert(5)" },
  { id: "protocol-relative URL + breakout", fn: () => "//evil.example/x\"'><svg onload=alert(6)>" },
  { id: "path traversal + attribute breakout", fn: () => "../../../../etc/passwd\" onmouseover=\"alert(7)\" x='" },
  { id: "CSS / style breakout", fn: () => "red;}</style><script>alert(8)</script><style>{{ 90911 + 6 }}" },
  { id: "data: URL", fn: () => "data:text/html;base64,PHNjcmlwdD5hbGVydCg5KTwvc2NyaXB0Pg==" },
];
const SKIP_KEYS = new Set(["permalink", "layout"]); // path-level keys: Eleventy itself decides what they may be
const DANGEROUS_SCHEME = /^\s*(javascript|vbscript):|^\s*data:(?!image\/)/i;
const OFFSITE = /^\s*(https?:)?\/\//i;
const RESOURCE_ATTRS = new Set(["src", "srcset", "poster", "data", "background", "manifest", "ping", "codebase", "longdesc"]);
const LOADING_RELS = /stylesheet|preload|prefetch|modulepreload|icon|manifest|import/;

function analyseSite(dir) {
  const pages = new Map();
  for (const f of findPages(dir)) {
    const url = pageUrlOf(dir, f);
    if (/^\/(cms|admin)\//.test(url)) continue;
    const html = readText(f);
    pages.set(url, { html, a: analysePage(html) });
  }
  return pages;
}

function main() {
  const args = parseArgs(process.argv.slice(2), { root: "string", max: "number", keep: "boolean", quick: "boolean" });
  if (args.help) {
    console.log("usage: node scripts/check-hostile.js [--root <repo root>] [--max <n>] [--keep] [--quick]");
    return 0;
  }
  const root = path.resolve(args.root || REPO_ROOT);
  const report = new Report("check-hostile");
  const cfg = loadConfig(root);
  const { sources } = loadSources(root);
  const plan = makePlan(sources, cfg, null);
  plan.edits = plan.edits.filter((e) => e.dev !== true && !SKIP_KEYS.has(String(e.path[e.path.length - 1])));
  const workspaces = [];
  const buildWith = (label, opts) => {
    const ws = new Workspace(root, { prefix: "covered-hostile-" });
    workspaces.push(ws);
    // the reference run keeps tokens; hostile runs substitute the payload
    applyPlan(ws, plan, sources, opts);
    const b = ws.build(label.replace(/\W+/g, "-"));
    return { ws, b };
  };

  let ref;
  try {
    ref = buildWith("reference", {});
    if (!ref.b.ok) {
      report.add("Reference build", "the reference copy does not build", ref.b.log.split("\n").slice(-20).join("\n"));
      return report.print({ max: args.max || 200 });
    }
    const base = analyseSite(ref.b.out);

    // ---------------- static rules on the page's own scripts
    let scriptCount = 0;
    for (const [url, p] of base) {
      for (const s of p.a.scripts) {
        if (/ld\+json|json/i.test(s.type) || s.attribs.src) continue;
        scriptCount += 1;
        for (const pr of sinkProblems(s.code)) report.add("Scripts feeding data into HTML / code", url + " inline script line " + pr.line, pr.what);
      }
    }

    // ---------------- hostile builds
    const runs = [];
    const fams = args.quick ? FAMILIES.slice(0, 2) : FAMILIES;
    for (const f of fams) runs.push({ id: f.id, opts: { payload: f.fn }, fn: f.fn });
    const rot = (s, key) => (SKIP_KEYS.has(key) ? s : FAMILIES[(s.length + (key || "").length) % FAMILIES.length].fn(s));
    if (!args.quick) runs.push({ id: "chaos: every string of the data rewritten", opts: { payload: FAMILIES[0].fn, all: rot } });

    let reached = 0;
    let tested = 0;
    for (const run of runs) {
      const { b } = buildWith(run.id, run.opts);
      if (!b.ok) {
        report.add("Build with hostile data", "'" + run.id + "': the site no longer builds", b.log.split("\n").slice(-12).join("\n"));
        continue;
      }
      const got = analyseSite(b.out);
      tested += 1;
      for (const [url, h] of got) {
        const g = base.get(url);
        if (!g) {
          report.add("Page set changed", "'" + run.id + "': " + url + " exists only in the hostile build");
          continue;
        }
        const where = (what) => "[" + run.id + "] " + url + " " + what;
        const known = new Set(g.a.handlers.map((x) => x.el + "|" + x.attr + "|" + x.value));
        for (const x of h.a.handlers) if (!known.has(x.el + "|" + x.attr + "|" + x.value)) report.add("Script injection", where("<" + x.el + "> gained attribute " + x.attr), clip(x.value, 100));
        if (h.a.scripts.length > g.a.scripts.length) report.add("Script injection", where("has " + (h.a.scripts.length - g.a.scripts.length) + " extra <script> element(s)"), "Text from the data became a live <script> (printed as markup, or it escaped the script block it is printed in).");
        for (const s of h.a.scripts) for (const p of scriptProblems(s)) report.add("Script injection", where("a script was altered"), p);
        if (h.a.styles.length > g.a.styles.length) report.add("Style injection", where("has extra <style> element(s)"));
        for (const css of h.a.styles) if (/alert\(|HX[A-Z]/.test(css)) report.add("Style injection", where("a style block contains the attack string"), clip(css.slice(Math.max(0, css.search(/alert\(|HX[A-Z]/) - 30)), 100));
        for (const tag of Object.keys(h.a.loaders)) if ((h.a.loaders[tag] || 0) > (g.a.loaders[tag] || 0)) report.add("Element injection", where("gained <" + tag + ">"));
        if (h.a.metaRefresh > g.a.metaRefresh) report.add("Element injection", where("gained a <meta http-equiv=refresh>"));
        const knownUrls = new Set(g.a.urls.map((x) => x.el + "|" + x.attr + "|" + x.value));
        for (const x of h.a.urls) {
          if (knownUrls.has(x.el + "|" + x.attr + "|" + x.value)) continue;
          const parts = x.attr === "srcset" ? x.value.split(",").map((p) => p.trim().split(/\s+/)[0]) : [x.value];
          const loads = RESOURCE_ATTRS.has(x.attr) || (x.el === "link" && x.attr === "href" && LOADING_RELS.test(x.rel));
          for (const part of parts) {
            if (DANGEROUS_SCHEME.test(part)) report.add("Dangerous link / source", where("<" + x.el + " " + x.attr + "> can run script (javascript: / data: URL)"), clip(part, 100));
            else if (loads && OFFSITE.test(part)) report.add("Dangerous link / source", where("<" + x.el + " " + x.attr + "> loads something from another site"), clip(part, 100));
            else if (loads && /(^|\/)\.\.(\/|$)/.test(part)) report.add("Dangerous link / source", where("<" + x.el + " " + x.attr + "> climbs out of its folder (..)"), clip(part, 100));
          }
        }
        const knownForms = new Set(g.a.forms.map((x) => x.el + "|" + x.value));
        for (const x of h.a.forms) if (!knownForms.has(x.el + "|" + x.value)) report.add("Dangerous link / source", where("<" + x.el + "> gained an action"), clip(x.value, 100));
        if (h.a.rawScriptCloses > g.a.rawScriptCloses) report.add("Script injection", where("source contains " + (h.a.rawScriptCloses - g.a.rawScriptCloses) + " extra </script"), "Text printed into a script must have < written as \\u003c.");
        if (h.a.rawCommentOpens > g.a.rawCommentOpens) report.add("Script injection", where("source contains extra <!--"));
        if (/90917/.test(h.html) && !/90917/.test(g.html)) report.add("Template injection", where("a {{ }} expression typed into a field was evaluated"), "Output contains 90917.");
        if (/HXTPL/.test(h.html) && !/\{% if true %\}HXTPL/.test(h.html)) report.add("Template injection", where("a {% %} tag typed into a field was evaluated"));
        if (run.id === "appended markup") reached += (h.html.match(/HXAPP/g) || []).length;
      }
    }
    if (!args.quick && reached < 100) report.add("Test is not exercising the site", "the appended attack string reached only " + reached + " places in the built pages", "Something stopped the payload from being printed; the test would pass vacuously.");

    report.note("check-hostile: " + base.size + " page(s), " + plan.edits.length + " planted fields (incl. optional fields and unused block types), " + tested + " hostile build(s) [" + runs.map((r) => r.id).join("; ") + "]");
    report.note("  attack string printed in " + reached + " places (escaped); " + scriptCount + " inline scripts checked for HTML / eval sinks");
  } finally {
    if (args.keep) workspaces.forEach((w) => console.log("workspace kept: " + w.dir));
    else workspaces.forEach((w) => w.cleanup());
  }
  return report.print({ max: args.max || 200, okMessage: "OK - hostile text is printed as text everywhere" });
}

runMain("check-hostile", main);
