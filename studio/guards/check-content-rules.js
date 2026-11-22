#!/usr/bin/env node
"use strict";
// check-content-rules: the content rule engine as CI runs it (studio/PHASE1-DESIGN.md 8.5), plus the static promises of the EDIT unit.
//
//   node studio/guards/check-content-rules.js [--root <repo>] [--json]
//
// 1. loads the checkout's data and pages, builds the facts, runs the SAME engine the overlay bundles ("Check my changes"),
//    prints warnings, and FAILS for every `block` finding that is not in studio/content-rules/baseline.json and for every baseline
//    entry that no longer occurs (a ratchet that only goes down). --json prints the Report on stdout (for the parity test).
// 2. the engine is not blind: facts name real routes, and every rule still flags its own known-bad example (content-rules/seeds.js),
//    so a rule that was quietly switched off cannot pass;
// 3. field roles (content-rules/field-roles.json): a schema field named like a role (pageTitle, metaDescription, title, label, cta*...)
//    must be mapped or ignored, and no mapping may point at nothing; every picture field has a description pair or an exemption;
// 4. the panel's promises: header and sub-line, no accessibility claim, a block can never be ignored, "Send for review" is refused while
//    a block finding the draft added exists, the legend counts distinct leaf refs, the AI cost estimate is debounced, the palette's
//    search never touches the network.
// Exit 0 clean, 1 on any violation. No network, no build.

const fs = require("fs");
const path = require("path");

const args = process.argv.slice(2);
const rootArg = args.indexOf("--root") >= 0 ? args[args.indexOf("--root") + 1] : path.resolve(__dirname, "..", "..");
const ROOT = path.resolve(rootArg);
const JSON_OUT = args.includes("--json");
const problems = [];
const fail = (where, msg) => problems.push(where + ": " + msg);
const read = (rel) => fs.readFileSync(path.join(ROOT, ...rel.split("/")), "utf8").replace(/\r\n/g, "\n");
const exists = (rel) => fs.existsSync(path.join(ROOT, ...rel.split("/")));
const req = (rel) => require(path.join(ROOT, ...rel.split("/")));

function main() {
  globalThis.window = globalThis.window || {}; // the overlay's ext files end with })(window.__CoveredStudioBoot) and export their pure parts under node
  let engine;
  let buildFacts;
  let readFiles;
  let validateRuleReport;
  try {
    engine = req("studio/content-rules");
    buildFacts = req("studio/content-rules/facts-node").buildFacts;
    readFiles = req("studio/markers/snapshot").readFiles;
    validateRuleReport = req("studio/api/shapes/phase1").validateRuleReport;
  } catch (e) {
    fail("studio/content-rules", "cannot be loaded: " + e.message);
    return finish(null);
  }
  const schemaFile = "studio/schema/studio-schema.json";
  if (!exists(schemaFile)) { fail(schemaFile, "missing (run npm run studio:schema)"); return finish(null); }
  const schema = JSON.parse(read(schemaFile));
  const rf = readFiles(ROOT);
  const files = {};
  Object.keys(rf).forEach((k) => { files[k] = rf[k].data; });
  const facts = buildFacts(ROOT);

  // ---- 2a. the engine can see
  if (!Array.isArray(facts.routes) || facts.routes.indexOf("/") < 0) fail("facts", "no routes (the link rules would be blind)");
  if (!facts.images || Object.keys(facts.images).length === 0) fail("facts", "no pictures found in images/ (the picture rules would be blind)");

  // ---- 1. run and ratchet
  const report = engine.run({ files, schema, facts });
  const bad = validateRuleReport(report);
  if (bad.length) fail("report", "does not match the wire shape: " + bad.slice(0, 3).join("; "));
  const baselineFile = "studio/content-rules/baseline.json";
  let baseline = { blocked: [] };
  if (exists(baselineFile)) { try { baseline = JSON.parse(read(baselineFile)); } catch (e) { fail(baselineFile, "does not parse"); } } else fail(baselineFile, "missing");
  const known = new Set(Array.isArray(baseline.blocked) ? baseline.blocked : []);
  const blocked = report.findings.filter((f) => f.severity === "block");
  for (const f of blocked) if (!known.has(f.key)) fail(f.file + " " + f.path, f.message + " [" + f.key + "]");
  const now = new Set(blocked.map((f) => f.key));
  for (const k of known) if (!now.has(k)) fail(baselineFile, "lists " + k + " but it no longer occurs: remove it (the baseline only goes down)");

  // ---- 2b. every rule still flags its own example
  let seeds = [];
  let seedFacts = {};
  try { const s = req("studio/content-rules/seeds.js"); seeds = s.SEEDS; seedFacts = s.FACTS; } catch (e) { fail("studio/content-rules/seeds.js", "cannot be loaded: " + e.message); }
  for (const rule of engine.rules()) {
    const seed = seeds.find((s) => s.rule === rule.id);
    if (!seed) { fail("studio/content-rules/seeds.js", "rule " + rule.id + " has no known-bad example"); continue; }
    let rep;
    try { rep = engine.run({ files: seed.files, schema, facts: seedFacts, only: [rule.id] }); } catch (e) { fail("rule " + rule.id, "threw on its own example: " + e.message); continue; }
    const hit = rep.findings.find((f) => f.key === seed.expect);
    if (!hit) fail("rule " + rule.id, "no longer flags its own known-bad example (expected " + seed.expect + "; got " + (rep.findings.map((f) => f.key).join(", ") || "nothing") + ")");
    else if (hit.severity !== seed.severity) fail("rule " + rule.id, "flags its example as " + hit.severity + ", expected " + seed.severity);
    if (rep.findings.some((f) => f.message.length > 300)) fail("rule " + rule.id, "a message is longer than 300 characters");
  }
  if (engine.rules().length !== seeds.length) fail("studio/content-rules/seeds.js", seeds.length + " examples for " + engine.rules().length + " rules");

  // ---- 3. field roles and picture descriptions
  roleProblems(schema);

  // ---- 4. the panel's promises
  uiProblems(schema);

  return finish(report);
}

// all fields of the schema with their path ("homepage.sections[].video.poster") and the list of their siblings
function schemaFields(schema) {
  const out = [];
  function walk(fields, fileLabel, prefix, parentFields) {
    (fields || []).forEach((f) => {
      const p = prefix + f.name;
      out.push({ file: fileLabel, name: f.name, path: p, field: f, siblings: parentFields });
      if (f.fields) walk(f.fields, fileLabel, p + (f.widget === "list" ? "[]" : "") + ".", f.fields);
      if (f.types) f.types.forEach((t) => walk(t.fields, fileLabel, p + "[].", t.fields));
      if (f.field) walk([f.field], fileLabel, p + "[].", [f.field]);
    });
  }
  Object.keys(schema.files || {}).forEach((k) => walk(schema.files[k].fields, k, k + ".", schema.files[k].fields));
  if (schema.pages) walk(schema.pages.fields, "pages", "pages.", schema.pages.fields);
  return out;
}

function roleProblems(schema) {
  const rolesFile = "studio/content-rules/field-roles.json";
  let roles;
  try { roles = JSON.parse(read(rolesFile)); } catch (e) { return fail(rolesFile, "missing or does not parse"); }
  const map = roles.map || {};
  let re;
  try { re = new RegExp(roles.namedLike); } catch (e) { return fail(rolesFile, "namedLike is not a valid pattern"); }
  const fields = schemaFields(schema);
  const VALID = ["seoTitle", "seoDescription", "socialDescription", "heading", "label", "body", "ignore"];
  for (const k of Object.keys(map)) if (VALID.indexOf(map[k]) < 0) fail(rolesFile, k + ": unknown role " + map[k]);
  const seen = new Set();
  for (const f of fields) {
    if (!re.test(f.name)) continue;
    const key = f.file + ":" + f.name;
    const generic = "*:" + f.name;
    seen.add(key); seen.add(generic);
    if (!(key in map) && !(generic in map)) fail(rolesFile, "the schema field " + f.path + " is named like a content role but is not mapped (add " + key + " or " + generic + ", or map it to ignore)");
  }
  const names = new Set(fields.map((f) => f.file + ":" + f.name));
  const generics = new Set(fields.map((f) => "*:" + f.name));
  for (const k of Object.keys(map)) if (!names.has(k) && !generics.has(k)) fail(rolesFile, "the entry " + k + " matches no schema field (remove it)");

  // every picture field: a description pair next to it, or listed in scripts/alt-exemptions.json
  let exempt = null;
  if (exists("scripts/alt-exemptions.json")) { try { exempt = (JSON.parse(read("scripts/alt-exemptions.json")).entries || []).map((e) => e.path); } catch (e) { exempt = null; } }
  if (!exempt) return;
  const has = (sibs, n) => (sibs || []).some((s) => s.name === n);
  for (const f of fields) {
    if (!(f.field.widget === "image" || (f.field.x && f.field.x.rule === "image"))) continue;
    const paired = (has(f.siblings, "alt") && has(f.siblings, "decorative")) || has(f.siblings, f.name + "Alt");
    const ok = paired || exempt.some((e) => e === f.path || (e.indexOf("*.") === 0 && f.path.endsWith(e.slice(1))));
    if (!ok) fail("scripts/alt-exemptions.json", "the picture field " + f.path + " has no description field next to it and is not exempt: the content rules cannot check it");
  }
}

function uiProblems(schema) {
  void schema;
  const need = ["studio/overlay/ext/checks.js", "studio/overlay/ext/legend.js", "studio/overlay/ext/ai.js", "studio/overlay/ext/palette.js"];
  for (const rel of need) if (!exists(rel)) return fail(rel, "missing");
  const checksSrc = read("studio/overlay/ext/checks.js");
  const legendSrc = read("studio/overlay/ext/legend.js");
  for (const [rel, src] of [["studio/overlay/ext/checks.js", checksSrc], ["studio/overlay/ext/legend.js", legendSrc]]) {
    if (/\bWCAG\b/.test(src)) fail(rel, "mentions WCAG: the panel checks words, links and pictures, it is not an accessibility audit");
    if (/\baccessible\b/i.test(src)) fail(rel, "uses the word 'accessible' (the panel must not claim the page is accessible)");
  }
  let checks;
  let legend;
  try { checks = req("studio/overlay/ext/checks.js"); legend = req("studio/overlay/ext/legend.js"); } catch (e) { return fail("studio/overlay/ext", "cannot be loaded under node: " + e.message); }

  if (checks.HEADER !== "Check my changes") fail("studio/overlay/ext/checks.js", 'the panel header must be "Check my changes"');
  if (checks.SUBLINE !== "These checks look at your words, links and pictures. They are not a full accessibility audit.") fail("studio/overlay/ext/checks.js", "the sub-line must say what the checks cover and that they are not a full accessibility audit");
  const F = (severity, key) => ({ key: key || "r|f|/" + severity, rule: "r", severity, file: "f", path: "/" + severity, message: "m", hint: "", fix: null, data: null });
  if (checks.canIgnore(F("block")) !== false) fail("studio/overlay/ext/checks.js", "a block finding can be ignored (CI would still stop it)");
  if (checks.canIgnore(F("warn")) !== true || checks.canIgnore(F("info")) !== true) fail("studio/overlay/ext/checks.js", "warnings and notes can no longer be ignored");
  const rep = (...fs2) => ({ findings: fs2 });
  const blockNew = F("block", "r|f|/new");
  if (!checks.gate(checks.summarize(rep(blockNew), rep(), {})).blocked) fail("studio/overlay/ext/checks.js", '"Send for review" is not refused while the draft has a new block finding');
  if (!checks.gate(checks.summarize(rep(blockNew), rep(), { "r|f|/new": 1 })).blocked) fail("studio/overlay/ext/checks.js", "ignoring a block finding lets the draft through");
  if (checks.gate(checks.summarize(rep(blockNew), rep(blockNew), {})).blocked) fail("studio/overlay/ext/checks.js", "a block finding that is already on the live site stops the draft (CI holds it in its baseline)");
  if (checks.gate(checks.summarize(rep(F("warn")), rep(), {})).blocked) fail("studio/overlay/ext/checks.js", "a warning stops the draft");
  if (!/Fix these first/.test(checks.BLOCK_MESSAGE)) fail("studio/overlay/ext/checks.js", "the refusal must start with \"Fix these first\"");

  const markers = [{ ref: "a.b", kind: "text" }, { ref: "a.b", kind: "text" }, { ref: "a.c", kind: "image" }, { ref: "s.0", kind: "section" }, { ref: "i.0", kind: "item" }, { ref: "a.d", kind: "toggle" }];
  if (legend.countEditable(markers) !== 3) fail("studio/overlay/ext/legend.js", "countEditable must count distinct refs of the leaf kinds only (got " + legend.countEditable(markers) + ", expected 3)");
  if (legend.chipText(14) !== "14 editable things here" || legend.chipText(1) !== "1 editable thing here") fail("studio/overlay/ext/legend.js", 'the chip must read "14 editable things here" (singular: "1 editable thing here")');
  if (!/use All fields/.test(legend.sentence(0))) fail("studio/overlay/ext/legend.js", "with nothing to edit the sentence must point to All fields");

  const aiSrc = read("studio/overlay/ext/ai.js");
  const m = /estTimer = setTimeout\(function \(\) \{([\s\S]*?)\}, (\d+)\);/.exec(aiSrc);
  if (!m || Number(m[2]) < 400 || m[1].indexOf("/v1/ai/estimate") < 0) fail("studio/overlay/ext/ai.js", "the cost estimate must be asked from a debounce of at least 400 ms (never on every keystroke)");
  if ((aiSrc.match(/\/v1\/ai\/estimate/g) || []).length !== 1) fail("studio/overlay/ext/ai.js", "the estimate route must be called from one place only");
  if (!/estimateWanted/.test(aiSrc)) fail("studio/overlay/ext/ai.js", "the estimate must wait until the instruction is long enough and AI is on");

  const palSrc = read("studio/overlay/ext/palette.js");
  const callRe = /studio\.api\.(get|post|put|del)\s*\(/g;
  const calls = palSrc.match(callRe) || [];
  const at = palSrc.indexOf("function loadHistory");
  const body = at < 0 ? "" : palSrc.slice(at, at + 700);
  if (calls.length !== 1 || (body.match(callRe) || []).length !== 1) fail("studio/overlay/ext/palette.js", "the palette may call the API only in loadHistory (palette sources must read caches: search() never uses the network)");
  if (/\bfetch\s*\(/.test(palSrc)) fail("studio/overlay/ext/palette.js", "fetch in the palette");
  if (!/Up\/Down to move, Enter to run, Esc to close, \? for help/.test(palSrc)) fail("studio/overlay/ext/palette.js", "the palette footer line is missing");
}

function finish(report) {
  if (JSON_OUT) {
    if (report) process.stdout.write(JSON.stringify(report) + "\n");
    if (problems.length) console.error("check-content-rules: FAILED\n  " + problems.join("\n  "));
    return problems.length ? 1 : 0;
  }
  if (problems.length) {
    console.error("check-content-rules: FAILED (" + problems.length + ")\n  " + problems.join("\n  "));
    return 1;
  }
  const warns = report.findings.filter((f) => f.severity !== "block");
  for (const f of warns.slice(0, 30)) console.log("  " + f.severity + " " + f.key + ": " + f.message);
  console.log("check-content-rules: OK - " + report.ranRules.length + " rules on " + "the live content: " + report.counts.block + " block (baseline holds " + (JSON.parse(read("studio/content-rules/baseline.json")).blocked || []).length + "), " + report.counts.warn + " warn, " + report.counts.info + " info; every rule flags its example; field roles mapped; the panel promises hold");
  return 0;
}

process.exitCode = main();
