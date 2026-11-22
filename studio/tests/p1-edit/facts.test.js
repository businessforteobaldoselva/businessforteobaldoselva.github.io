"use strict";
// buildFacts (studio/PHASE1-DESIGN.md 8.2): the routes equal the routes of a real build's sitemap; the snapshot embeds the facts compactly.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..", "..", "..");
const { buildFacts } = require("../../content-rules/facts-node");
const { snapshot } = require("../../markers/snapshot");

test("facts: the routes are exactly the pages a real build lists in its sitemap", () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "studio-facts-"));
  try {
    const bin = require("../../../scripts/lib/workspace").eleventyBin(ROOT);
    const r = spawnSync(process.execPath, [bin, "--quiet", "--output=" + out], { cwd: ROOT, encoding: "utf8", env: Object.assign({}, process.env, { COVERED_IMG_FAST: "1", CMS_EDIT: "" }), maxBuffer: 64 * 1024 * 1024 });
    assert.equal(r.status, 0, (r.stdout || "") + (r.stderr || ""));
    const sitemap = fs.readFileSync(path.join(out, "sitemap.xml"), "utf8");
    const paths = Array.from(sitemap.matchAll(/<loc>https?:\/\/[^/]+(\/[^<]*)<\/loc>/g)).map((m) => m[1]).sort();
    const facts = buildFacts(ROOT);
    assert.deepEqual(facts.routes, paths);
    // the other built pages (tools) are known too, so a link to them is not called broken
    const built = [];
    (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name === "index.html") built.push("/" + path.relative(out, path.dirname(p)).split(path.sep).join("/") + (path.dirname(p) === out ? "" : "/")); } })(out);
    for (const b of built) assert.ok(facts.routes.includes(b) || facts.tools.includes(b), "built page " + b + " is a route or a tool");
    // the sections visitors are sent to by the menu are anchors in the static set AND really on the built home page
    const html = fs.readFileSync(path.join(out, "index.html"), "utf8");
    const ids = new Set(Array.from(html.matchAll(/\sid=(?:"([^"]+)"|'([^']+)'|([^\s"'<>=`]+))/g)).map((m) => m[1] || m[2] || m[3]));
    for (const a of ["how", "faq", "brands", "partners", "venues", "locations", "vision"]) { assert.ok(facts.anchors["/"].includes(a), a + " is a static anchor"); assert.ok(ids.has(a), a + " is on the built home page"); }
    // with the built site passed, anchors only grow
    const withSite = buildFacts(ROOT, { site: out });
    for (const a of facts.anchors["/"]) assert.ok(withSite.anchors["/"].includes(a));
    assert.ok(withSite.anchors["/"].includes("how"));
  } finally { fs.rmSync(out, { recursive: true, force: true }); }
});

test("facts: pictures have sizes, pages list their pictures, and the whole thing stays small", () => {
  const facts = buildFacts(ROOT);
  const og = facts.images["covered-og.jpg"];
  assert.ok(og && og.bytes > 1000 && og.width > 100 && og.height > 100, JSON.stringify(og));
  assert.ok(Object.keys(facts.pages).includes("/") && facts.pages["/"].images.length > 3);
  assert.ok(Buffer.byteLength(JSON.stringify(facts)) < 40 * 1024);
});

test("facts: the snapshot (content.json) carries them as an additive key and stays at schemaVersion 1", () => {
  const s = snapshot(ROOT);
  assert.equal(s.schemaVersion, 1);
  assert.deepEqual(s.facts, buildFacts(ROOT));
  assert.ok(Buffer.byteLength(JSON.stringify(s.facts)) <= 40 * 1024);
});

test("facts: a checkout without pictures, pages or scripts/ still gives routes (no throw)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "studio-facts-empty-"));
  try {
    fs.mkdirSync(path.join(dir, "src", "_data"), { recursive: true });
    const f = buildFacts(dir);
    assert.deepEqual(f.routes, ["/"]);
    assert.deepEqual(f.images, {});
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
