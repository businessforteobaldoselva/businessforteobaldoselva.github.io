#!/usr/bin/env node
"use strict";
// check-schema: studio/schema/studio-schema.json is the committed, current, complete image of cms/config.yml.
//
//   node studio/guards/check-schema.js [--root .] [--max 200]
//
//   1. the committed file equals a fresh generation (npm run studio:schema writes it);
//   2. every key of every data file and page front matter has a schema entry, with the widget cms/config.yml declares
//      (the same walk check:cms uses);
//   3. reservedIds equals lib/reserved-ids.js; the standard link pattern equals lib/rules.js LINK_PATTERN_SOURCE once that file exists;
//   4. the code-side rules are attached: every colour/image/list/token field carries its x rule, token bounds equal lib/tokens.js;
//   5. every pattern compiles as a JavaScript RegExp.

const fs = require("fs");
const path = require("path");

const REPO = path.resolve(__dirname, "..", "..");
const S = path.join(REPO, "scripts", "lib");
const { parseArgs, Report, readText } = require(path.join(S, "util"));
const cmsconfig = require(path.join(S, "cmsconfig"));
const { loadSources } = require(path.join(S, "data"));
const { build, serialise, LINK_PATTERN_SOURCE } = require("../schema/build-schema");
const R = require("../schema/resolve");

function eachField(fields, fn, trail) {
  for (const f of fields || []) {
    const here = (trail || []).concat(f.name);
    fn(f, here);
    eachField(f.fields, fn, here);
    if (f.field) eachField([f.field], fn, here);
    for (const t of f.types || []) eachField(t.fields, fn, here.concat("<" + t.name + ">"));
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2), { root: "string", max: "number" });
  const root = path.resolve(args.root || REPO);
  const report = new Report("check-schema");
  const file = path.join(root, "studio", "schema", "studio-schema.json");

  // 1. freshness
  let fresh;
  try {
    fresh = build(root);
  } catch (e) {
    report.add("Generation", "the schema cannot be generated: " + e.message);
    return report.print();
  }
  const text = serialise(fresh);
  if (!fs.existsSync(file)) report.add("Freshness", "studio/schema/studio-schema.json is missing", "Run: npm run studio:schema");
  else if (readText(file) !== text) report.add("Freshness", "studio/schema/studio-schema.json is out of date with cms/config.yml", "Run: npm run studio:schema and commit the result.");
  const schema = fresh;

  // 2. every data key has an entry
  const cfg = cmsconfig.loadConfig(root);
  const entries = cmsconfig.contentCollections(cfg);
  const { sources } = loadSources(root);
  let checked = 0;
  for (const s of sources) {
    if (s.kind === "njk") continue;
    const entry = entries.find((e) => (s.kind === "data" ? e.kind === "file" && e.file === s.file : e.kind === "folder" && e.folder === "src/pages"));
    if (!entry) {
      report.add("Coverage", s.file + " is not described by any collection in cms/config.yml");
      continue;
    }
    const key = s.kind === "page" ? "pages:" + s.name : s.name;
    const doc = s.data;
    cmsconfig.alignData(doc, entry.fields, [], (ev) => {
      if (ev.problem) return; // check:cms reports these
      checked += 1;
      const segs = ev.path.map(String);
      const r = R.resolve(schema, key, segs, doc);
      if (!r) report.add("Coverage", s.file + " " + ev.path.join(".") + ": no schema entry (kind of item or typed-list type unknown)");
      else if (!ev.listItem && ev.field && r.field.widget !== cmsconfig.widgetOf(ev.field)) report.add("Coverage", s.file + " " + ev.path.join(".") + ": schema widget '" + r.field.widget + "' differs from cms/config.yml '" + cmsconfig.widgetOf(ev.field) + "'");
    });
  }

  // 3. reserved ids, link pattern
  const reserved = require(path.join(root, "lib", "reserved-ids")).reservedIds(root).sorted();
  if (!reserved.length) report.add("Reserved ids", "lib/reserved-ids.js returned no ids (the schema would protect nothing)");
  if (JSON.stringify(reserved) !== JSON.stringify(schema.reservedIds)) report.add("Reserved ids", "schema.reservedIds differs from lib/reserved-ids.js");
  const rulesFile = path.join(root, "lib", "rules.js");
  if (fs.existsSync(rulesFile)) {
    const rules = require(rulesFile);
    if (rules.LINK_PATTERN_SOURCE !== undefined && rules.LINK_PATTERN_SOURCE !== LINK_PATTERN_SOURCE) report.add("Link rule", "lib/rules.js LINK_PATTERN_SOURCE differs from the pattern the schema builder uses to find link fields");
  }

  // 4. code-side rules attached
  const tokenSpecs = require(path.join(root, "lib", "tokens")).fieldSpecs();
  const seenTokens = new Set();
  const rules = {};
  for (const [fk, f] of Object.entries(schema.files)) {
    eachField(f.fields, (fl, trail) => {
      const rule = fl.x && fl.x.rule;
      if (rule) rules[rule] = (rules[rule] || 0) + 1;
      const where = fk + "." + trail.join(".");
      if (fl.widget === "color" && rule !== "color") report.add("Rules", where + ": colour field without x.rule 'color'");
      if (fl.widget === "image" && !(rule === "image" && fl.x.imageStyle)) report.add("Rules", where + ": image field without x.rule 'image' and imageStyle");
      if (fl.widget === "list" && !(fl.x && fl.x.list)) report.add("Rules", where + ": list without x.list");
      if (rule === "token") {
        const tk = trail.join(".");
        seenTokens.add(tk);
        const spec = tokenSpecs[tk];
        const t = fl.x.token;
        if (!spec) report.add("Rules", where + ": x.token but lib/tokens.js knows no token '" + tk + "'");
        else if (spec.options ? JSON.stringify(spec.options) !== JSON.stringify(t.words) : !(spec.min === t.min && spec.max === t.max && spec.step === t.step)) report.add("Rules", where + ": token bounds differ from lib/tokens.js");
      }
      if (fl.pattern) {
        try {
          new RegExp(fl.pattern.source);
        } catch (e) {
          report.add("Patterns", where + ": pattern does not compile: " + e.message);
        }
      }
    });
  }
  for (const k of Object.keys(tokenSpecs)) if (!seenTokens.has(k)) report.add("Rules", "lib/tokens.js token '" + k + "' has no field with x.rule 'token'");
  eachField(schema.pages.fields, (fl, trail) => {
    if (fl.widget === "image" && !(fl.x && fl.x.rule === "image")) report.add("Rules", "pages." + trail.join(".") + ": image field without x.rule 'image'");
    if (fl.pattern) {
      try {
        new RegExp(fl.pattern.source);
      } catch (e) {
        report.add("Patterns", "pages." + trail.join(".") + ": pattern does not compile");
      }
    }
  });
  const need = ["url", "anchor", "color", "image", "token", "redirect-from", "redirect-to", "permalink"];
  for (const r of need) if (!rules[r] && !(r === "permalink")) report.add("Rules", "no field carries x.rule '" + r + "' (the builder no longer recognises it)");
  if (!schema.pages.fields.some((f) => f.x && f.x.rule === "permalink")) report.add("Rules", "the pages permalink field lost x.rule 'permalink'");

  report.note("schema: " + Object.keys(schema.files).length + " data files, page schema, " + checked + " data nodes resolved, rules " + Object.keys(rules).sort().map((k) => k + " " + rules[k]).join(", "));
  return report.print({ max: args.max || 200 });
}

process.exitCode = main();
