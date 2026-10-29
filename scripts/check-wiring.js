#!/usr/bin/env node
"use strict";
// check-wiring: SENTINEL test. Every editable string in a throwaway copy of the site is replaced by
// a unique token, the copy is built, and each token must appear in the built output (text, attribute,
// inline script blob, JSON-LD ...). A token that never shows up belongs to a dead field: an editor can
// change it in the CMS and nothing on the site moves.
//
// The same build is then used for a second, stricter copy test: with every editable word replaced
// by a token, any other word left on a page can only come from code. (No "it also occurs in some
// sentence" loophole.) That scan is repeated for a few more builds in which the yes / no switches are
// turned on and off and every dropdown is moved to its other choices, so markup that only appears
// in some editor-chosen state cannot hide a hard-coded word either.
//
//   node scripts/check-wiring.js [--root .] [--max 200] [--no-copy] [--variants 6] [--keep] [--verbose]
//
// Exit code: 0 clean, 1 violations, 2 usage error.

const path = require("path");
const { runMain, strictStale, parseArgs, readJson, exists, Report, REPO_ROOT, SCRIPTS_DIR, clip } = require("./lib/util");
const { loadSources, pathString } = require("./lib/data");
const { loadConfig } = require("./lib/cmsconfig");
const { IgnoreList } = require("./lib/ignore");
const { AllowList } = require("./lib/allowlist");
const { Workspace } = require("./lib/workspace");
const { TOKEN_RE, makePlan, applyPlan, readBuild } = require("./lib/sentinel");
const { scanSite, Acceptor } = require("./lib/copycheck");

function main() {
  const args = parseArgs(process.argv.slice(2), { root: "string", max: "number", noCopy: "boolean", keep: "boolean", verbose: "boolean", variants: "number", strictStale: "boolean" });
  if (args.help) {
    console.log("usage: node scripts/check-wiring.js [--root <repo root>] [--max <n>] [--no-copy] [--variants <n, default 6>] [--keep] [--verbose]");
    return 0;
  }
  const root = path.resolve(args.root || REPO_ROOT);
  const report = new Report("check-wiring");
  const cfg = loadConfig(root);
  const { sources, problems } = loadSources(root);
  problems.forEach((p) => report.add("Data files", p));
  const ignoreFile = path.join(SCRIPTS_DIR, "wiring-ignore.json");
  const ignore = new IgnoreList(exists(ignoreFile) ? readJson(ignoreFile) : {});
  ignore.problems.forEach((p) => report.add("wiring-ignore.json", p));
  const allowFile = path.join(SCRIPTS_DIR, "copy-allowlist.json");
  const refs = {};
  for (const s of sources) refs[s.name] = s.data;
  const allow = new AllowList(exists(allowFile) ? readJson(allowFile) : {}, refs);

  const plan = makePlan(sources, cfg, (name, schema, check, injected) => ignore.match(name, schema, check, injected), { switches: true });
  for (const f of plan.missingEntry) report.add("CMS coverage", f + " has no entry in cms/config.yml, so its text cannot be tested (and cannot be edited)");

  const workspaces = [];
  const buildVariant = (variant) => {
    const ws = new Workspace(root, { prefix: "covered-wiring-" });
    workspaces.push(ws);
    const { mediaFiles } = applyPlan(ws, plan, sources, { variant });
    return { ws, mediaFiles, built: ws.build(variant ? "variant" + variant : "sentinel") };
  };
  // hard-coded words: with every editable word a token, anything else on a page comes from code
  const copyScan = (outDir, label) => {
    const acceptor = new Acceptor(allow, report, { tokenRe: TOKEN_RE });
    const scoped = new Proxy(report, {
      get(target, prop) {
        if (prop === "add") return (group, title, detail) => target.add("Hard-coded words (every editable word is a token; " + label + ")" + (group ? " - " + group : ""), title, detail);
        return target[prop];
      },
    });
    return scanSite(outDir, (t, c, u, i) => acceptor.accept(t, c, u, i), scoped, { isExcluded: (url) => allow.isExcluded(url) });
  };

  try {
    const first = buildVariant(0);
    const built = first.built;
    if (!built.ok) {
      report.add("Sentinel build", "Eleventy failed to build the sentinel copy", built.log.split("\n").slice(-25).join("\n"));
    } else {
      const hay = readBuild(built.out, (url) => allow.isExcluded(url));
      let tested = 0;
      let dead = 0;
      for (const e of plan.edits) {
        if (e.synth || e.dev || e.flip) continue;
        if (e.unfoundable) {
          report.add("Sentinel setup", pathString([e.src.name].concat(e.path)) + ": " + e.unfoundable);
          continue;
        }
        tested += 1;
        if (hay.includes(e.token)) continue;
        dead += 1;
        const where = e.src.file + " > " + pathString(e.path);
        const label = e.field && e.field.label ? ' (CMS label "' + e.field.label + '")' : "";
        report.add(
          "Dead fields - editing these changes nothing on the site",
          where + label,
          e.injected
            ? "The CMS offers this field but the data does not hold it and no template reads it: a value typed here would be thrown away."
            : "The data holds " + JSON.stringify(clip(String(e.orig), 60)) + " but no template or script puts it on a page."
        );
      }
      const switches = plan.edits.filter((e) => e.flip);
      report.note("check-wiring: " + sources.filter((s) => s.kind !== "njk").length + " editable sources, " + tested + " tokens planted (" + plan.edits.filter((e) => e.injected).length + " injected into optional fields, " + plan.edits.filter((e) => e.synth).length + " example items of unused block types, " + first.mediaFiles + " image/video copies), build " + (built.ms / 1000).toFixed(1) + " s");
      const keyOf = (s) => s.reason.replace(/\(.*$/, "").replace(/^wiring-ignore: .*/, "wiring-ignore");
      const skippedBy = {};
      for (const s of plan.skipped) skippedBy[keyOf(s)] = (skippedBy[keyOf(s)] || 0) + 1;
      report.note("  skipped (not free text or deliberately ignored): " + Object.entries(skippedBy).map(([k, v]) => v + " x " + k.trim()).join("; "));
      report.note("  dead: " + dead);
      if (args.verbose) for (const s of plan.skipped) console.log("  skipped " + s.src + " " + s.schema + " - " + s.reason);

      const unusedIgnores = ignore.unused("wiring");
      if (strictStale(args)) {
        for (const e of unusedIgnores) report.add("wiring-ignore.json", "entry '" + e.path + "' skipped nothing", "Remove it, or fix the path. Unused entries would silently excuse the same field in future.");
      } else if (unusedIgnores.length) report.note("  note: " + unusedIgnores.length + " wiring-ignore entr" + (unusedIgnores.length === 1 ? "y" : "ies") + " skipped nothing (" + unusedIgnores.map((e) => e.path).join(", ") + "); --strict-stale makes that an error");

      if (!args.noCopy) {
        const stats = copyScan(built.out, "switches on, dropdowns as shipped");
        let items = stats.items;
        let ran = 1;
        const choices = Math.max(2, ...switches.filter((e) => e.kind === "select").map((e) => e.options.length));
        const variants = Math.min(args.variants === undefined ? 6 : args.variants, choices - 1);
        for (let v = 1; v <= variants; v += 1) {
          const next = buildVariant(v);
          if (!next.built.ok) {
            report.add("Sentinel build", "Eleventy failed to build variant " + v + " (switches " + (v % 2 === 0 ? "on" : "off") + ", dropdowns at choice " + (v + 1) + ")", next.built.log.split("\n").slice(-15).join("\n"));
            continue;
          }
          items += copyScan(next.built.out, "switches " + (v % 2 === 0 ? "on" : "off") + ", dropdowns at choice " + (v + 1)).items;
          ran += 1;
          next.ws.cleanup();
        }
        report.note("  copy scan: " + stats.pages.length + " page(s) x " + ran + " build(s) (" + switches.filter((e) => e.kind === "bool").length + " yes/no switches and " + switches.filter((e) => e.kind === "select").length + " dropdowns varied), " + items + " items");
      }
    }
  } finally {
    if (args.keep) workspaces.forEach((w) => console.log("workspace kept: " + w.dir));
    else workspaces.forEach((w) => w.cleanup());
  }
  return report.print({ max: args.max || 200, okMessage: "OK - every editable string reaches the site and no word is hard-coded" });
}

runMain("check-wiring", main);
