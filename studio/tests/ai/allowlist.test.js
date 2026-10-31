"use strict";
// The AI allow-list is DERIVED from the schema and enforced in code (AI-DESIGN 8).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const A = require("../../api/ai/allowlist");
const policy = require("../../api/ai/policy");
const scope = require("../../validate/scope");
const { loadSchema } = require("../fixtures/schema-from-config");
const { parseCtx } = require("./helpers");

const schema = loadSchema();
const al = A.deriveAllowList(schema);
const find = (file, template) => al.targets.find((t) => t.file === file && t.template === template);

test("derivation facts: words, switches and colours are writable; pictures and wiring are not", () => {
  assert.ok(find("src/_data/hero.json", "/headlineMain"));
  assert.ok(find("src/_data/theme.json", "/accent").widget === "color");
  assert.ok(find("src/_data/homepage.json", "/sections/*[hero]/enabled").widget === "boolean");
  assert.ok(find("src/pages/*.md", "/_body"));
  for (const t of al.targets) {
    assert.ok(t.file === policy.PAGES_FILE || scope.classify(t.file) === "data", t.file);
    assert.ok(["image", "file", "hidden", "object"].indexOf(t.widget) < 0, t.file + t.template + " is a " + t.widget);
    assert.ok(!policy.DENIED_RULES.has(t.rule), t.file + t.template);
    assert.ok(!/redirects/.test(t.file));
    const last = t.template.split("/").pop().replace(/\[.*$/, "");
    assert.ok(!policy.DENIED_FIELD_NAMES.has(last), "denied field name " + last + " in " + t.file);
  }
  for (const gone of [["src/_data/how.json", "/story/*/src"], ["src/pages/*.md", "/permalink"], ["src/_data/locations.json", "/cities/*/id"], ["src/_data/locations.json", "/landPath"], ["src/_data/brands.json", "/form/fields/*/type"], ["src/_data/tokens.json", "/fonts/display"]]) assert.equal(find(gone[0], gone[1]), undefined, gone.join(" "));
  assert.equal(al.targets.some((t) => /tokens|motion|redirects/.test(t.file)), false);
});

test("links and emails are sensitive; sections may only be moved; typed lists never grow", () => {
  for (const [f, t] of [["src/_data/site.json", "/contactEmail"], ["src/_data/problem.json", "/sourceUrl"], ["src/_data/nav.json", "/items/*[link]/url"]]) assert.equal(find(f, t).sensitive, true, f + t);
  assert.deepEqual(find("src/_data/homepage.json", "/sections").ops, ["move"]);
  assert.deepEqual(find("src/pages/*.md", "/sections").ops, ["move"]);
  for (const t of al.targets.filter((x) => x.widget === "list" && x.typed)) assert.equal(t.ops.indexOf("add"), -1, t.file + t.template);
  assert.ok(find("src/_data/faq.json", "/items").ops.indexOf("add") >= 0);
});

test("modes narrow the targets: alt text and meta description", () => {
  assert.ok(find("src/_data/how.json", "/story/*/alt").modes.indexOf("alt_text") >= 0);
  assert.equal(find("src/_data/hero.json", "/badge").modes.indexOf("alt_text"), -1);
  assert.ok(find("src/_data/site.json", "/metaDescription").modes.indexOf("meta_description") >= 0);
  assert.ok(find("src/pages/*.md", "/description").modes.indexOf("meta_description") >= 0);
  assert.equal(find("src/_data/hero.json", "/badge").modes.indexOf("meta_description"), -1);
});

test("the committed snapshot matches the schema (any change to the AI's reach needs a human)", () => {
  const snap = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "api", "ai", "allowlist.snapshot.json"), "utf8"));
  const lines = A.snapshotLines(al);
  assert.deepEqual(snap.lines, lines);
  assert.equal(snap.sha256, crypto.createHash("sha256").update(lines.join("\n")).digest("hex"));
});

test("matchTarget refuses 60 hostile pointers and files without throwing", async () => {
  const { docs } = await parseCtx("edit");
  const hostile = ["", "/", "//", "/a/../b", "~", "/~", "/~2", "/%2e%2e", "/ ", "/\u0000", "/badge\n", "/-", "/-/x", "/items/-1", "/items/01", "/items/1e3", "/items/99999999999", "/__proto__", "/constructor", "/prototype", "/badge/x", "/badge/0", "/badge//", "/BADGE", "/Badge", "badge", " /badge", "/badge ", "/‮badge", "/ba​dge", "/" + "a/".repeat(30), "/" + "a".repeat(400), "/0", "/headlineMain/headlineMain", "/stamp/../badge", "/./badge", "/../badge", "\\badge", "/bad\\ge", null, undefined, 5, {}, [], "/badge?x=1", "/badge#x", "/%62adge", "/badge%00", "/ｂadge", "/bаdge"];
  let n = 0;
  for (const p of hostile) for (const op of ["replace", "add", "remove", "move"]) {
    const r = A.matchTarget(al, "src/_data/hero.json", p, docs.get("src/_data/hero.json"), { op });
    assert.equal(r.ok, false, JSON.stringify(p) + " " + op);
    n += 1;
  }
  const files = ["", "src/_data/hero.json/", "SRC/_data/hero.json", "src/_data/Hero.json", "src/_data/hero.JSON", "./src/_data/hero.json", "src/_data//hero.json", "src/pages/../_data/hero.json", "src/pages/a/b.md", "src/pages/.md", "images/a.png", "src/_data/hero.json\u0000", null, 7];
  for (const f of files) assert.equal(A.matchTarget(al, f, "/badge", {}, { op: "replace" }).ok, false, String(f));
  assert.ok(n >= 60);
  assert.equal(A.matchTarget(al, "src/_data/hero.json", "/badge", docs.get("src/_data/hero.json"), { op: "replace" }).ok, true);
  assert.equal(A.matchTarget(al, "src/_data/hero.json", "/badge", {}, { op: "remove" }).ok, false, "a leaf is not a list item");
});

test("files not sent in a narrowed request are unreachable", async () => {
  const { docs } = await parseCtx("edit");
  const sent = new Set(["src/_data/hero.json"]);
  assert.equal(A.matchTarget(al, "src/_data/hero.json", "/badge", docs.get("src/_data/hero.json"), { op: "replace", filesSent: sent }).ok, true);
  assert.equal(A.matchTarget(al, "src/_data/faq.json", "/kicker", docs.get("src/_data/faq.json"), { op: "replace", filesSent: sent }).ok, false);
});
