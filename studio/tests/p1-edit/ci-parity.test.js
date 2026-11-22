"use strict";
// The panel and CI must agree (studio/PHASE1-DESIGN.md 8.5): one bad draft per rule plus a good one are written into throwaway checkouts;
// the CI guard (check-content-rules.js --json, reading the files from disk like CI does) and the engine loaded the way the overlay bundle
// loads it (a plain script in a sandbox, given the same files, the same facts and the bundle's field roles) must report the SAME keys and severities.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");
const { spawnSync } = require("child_process");

const REPO = path.resolve(__dirname, "..", "..", "..");
const { SEEDS } = require("../../content-rules/seeds.js");
const { buildFacts } = require("../../content-rules/facts-node");
const { readFiles } = require("../../markers/snapshot");
const { validateRuleReport } = require("../../api/shapes/phase1");
const roles = JSON.parse(fs.readFileSync(path.join(REPO, "studio", "content-rules", "field-roles.json"), "utf8"));
const schema = JSON.parse(fs.readFileSync(path.join(REPO, "studio", "schema", "studio-schema.json"), "utf8"));

function mkRoot(files, extra) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "studio-parity-"));
  const cp = (rel) => fs.cpSync(path.join(REPO, rel), path.join(root, rel), { recursive: true });
  ["studio/content-rules", "studio/markers", "studio/overlay", "studio/api/shapes"].forEach(cp);
  fs.mkdirSync(path.join(root, "studio", "schema"), { recursive: true });
  fs.copyFileSync(path.join(REPO, "studio", "schema", "studio-schema.json"), path.join(root, "studio", "schema", "studio-schema.json"));
  fs.mkdirSync(path.join(root, "node_modules"));
  for (const m of ["js-yaml", "argparse", "acorn"]) if (fs.existsSync(path.join(REPO, "node_modules", m))) fs.symlinkSync(path.join(REPO, "node_modules", m), path.join(root, "node_modules", m), "junction");
  fs.mkdirSync(path.join(root, "src", "_data"), { recursive: true });
  fs.mkdirSync(path.join(root, "src", "pages"), { recursive: true });
  fs.mkdirSync(path.join(root, "images"), { recursive: true });
  for (const k of Object.keys(files)) {
    if (k.indexOf("pages:") === 0) fs.writeFileSync(path.join(root, "src", "pages", k.slice(6) + ".md"), "---\n" + Object.keys(files[k]).filter((x) => x !== "_body").map((x) => x + ": " + JSON.stringify(files[k][x])).join("\n") + "\npermalink: /" + k.slice(6) + "/\n---\n" + (files[k]._body || ""));
    else fs.writeFileSync(path.join(root, "src", "_data", k + ".json"), JSON.stringify(files[k]));
  }
  fs.writeFileSync(path.join(root, "images", "placeholder.jpg"), Buffer.alloc(10, 1)); // the guard refuses to run blind: the checkout must have a picture
  for (const f of (extra && extra.images) || []) fs.writeFileSync(path.join(root, "images", f.name), Buffer.alloc(f.bytes, 1));
  return root;
}
function ciReport(root) {
  const r = spawnSync(process.execPath, [path.join(REPO, "studio", "guards", "check-content-rules.js"), "--root", root, "--json"], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  const line = (r.stdout || "").trim().split("\n").pop();
  assert.ok(line.startsWith("{"), "the guard printed a report: " + (r.stdout || "") + (r.stderr || ""));
  return JSON.parse(line);
}
function overlayReport(root) {
  // exactly what the bundle gives the browser: engine.js and rules.js as plain scripts, the schema and the roles as data
  const ctx = vm.createContext({ console });
  for (const rel of ["engine.js", "rules.js"]) vm.runInContext(fs.readFileSync(path.join(REPO, "studio", "content-rules", rel), "utf8"), ctx, { filename: rel });
  const f = readFiles(root);
  const files = {};
  Object.keys(f).forEach((k) => { files[k] = f[k].data; });
  ctx.__input = JSON.stringify({ files, schema, facts: buildFacts(root), roles });
  return JSON.parse(vm.runInContext("JSON.stringify(CoveredContentRules.run(JSON.parse(__input)))", ctx));
}
const sig = (rep) => rep.findings.map((x) => x.severity + " " + x.key + " | " + x.message);

for (const seed of SEEDS) {
  test("parity: the panel and CI report the same findings for a bad draft of rule " + seed.rule, () => {
    const images = seed.rule === "image-heavy" ? [{ name: "heavy.jpg", bytes: 900 * 1024 }] : seed.rule === "page-weight" ? [{ name: "p1.jpg", bytes: 2000 * 1024 }, { name: "p2.jpg", bytes: 2000 * 1024 }] : [];
    const files = seed.rule === "page-weight" ? { problem: { photos: [{ src: "p1.jpg" }, { src: "p2.jpg" }] } } : seed.files;
    const root = mkRoot(files, { images });
    try {
      const ci = ciReport(root);
      const ov = overlayReport(root);
      assert.deepEqual(validateRuleReport(ci), []);
      assert.deepEqual(sig(ci), sig(ov), "same keys, severities and words");
      assert.ok(ci.findings.some((x) => x.key === seed.expect && x.severity === seed.severity), "the bad draft is flagged: " + seed.expect + " in " + ci.findings.map((x) => x.key).join(", "));
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
}

test("parity: a good draft is quiet on both sides, and CI exits 0", () => {
  const root = mkRoot({ site: { pageTitle: "COVERED: free period products, paid for by ads", metaDescription: "A UK social enterprise giving out free plastic-free period products from smart dispensers, paid for by advertising." } });
  try {
    const ci = ciReport(root);
    assert.deepEqual(sig(ci), sig(overlayReport(root)));
    assert.equal(ci.findings.filter((x) => x.severity !== "info").length, 0);
    const r = spawnSync(process.execPath, [path.join(REPO, "studio", "guards", "check-content-rules.js"), "--root", root], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stdout + r.stderr);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("parity: CI fails (exit 1) on a block finding and names it; warnings alone never fail", () => {
  const bad = mkRoot({ nav: { items: [{ type: "link", label: "Gone", url: "/no-such-page/" }] } });
  const warn = mkRoot({ site: { pageTitle: "Hi", metaDescription: "short" } });
  try {
    const a = spawnSync(process.execPath, [path.join(REPO, "studio", "guards", "check-content-rules.js"), "--root", bad], { encoding: "utf8" });
    assert.equal(a.status, 1);
    assert.match(a.stderr, /broken-internal-link\|nav\|\/items\/0\/url/);
    const b = spawnSync(process.execPath, [path.join(REPO, "studio", "guards", "check-content-rules.js"), "--root", warn], { encoding: "utf8" });
    assert.equal(b.status, 0, b.stdout + b.stderr);
    assert.match(b.stdout, /title-length/);
  } finally { fs.rmSync(bad, { recursive: true, force: true }); fs.rmSync(warn, { recursive: true, force: true }); }
});
