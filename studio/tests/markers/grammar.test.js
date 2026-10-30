"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { parseRef, formatRef, locate, REF_RE } = require("../../markers/grammar");

test("parseRef reads data and page references", () => {
  assert.deepEqual(parseRef("hero.headlineMain"), { file: "hero", segs: ["headlineMain"] });
  assert.deepEqual(parseRef("how.story.2.title"), { file: "how", segs: ["story", "2", "title"] });
  assert.deepEqual(parseRef("homepage.sections.3.enabled"), { file: "homepage", segs: ["sections", "3", "enabled"] });
  assert.deepEqual(parseRef("pages:about.sections.1.heading"), { file: "pages:about", segs: ["sections", "1", "heading"] });
  assert.deepEqual(parseRef("pages:about._body"), { file: "pages:about", segs: ["_body"] });
  assert.deepEqual(parseRef("nav.items.1.label"), { file: "nav", segs: ["items", "1", "label"] });
});

test("parseRef refuses anything else, and never throws", () => {
  const bad = [
    "", "hero", "hero.", ".hero.x", "hero..x", "Hero.x", "9hero.x", "hero.x y", "hero.x\"y", "hero.x<y", "hero.a/b", "hero.a b",
    "pages:.x", "pages:About.x", "pages:about", "pages::about.x", "../hero.x", "hero.__proto__!", "hero.x\n", " hero.x", "hero.x ",
    "hero." + "a".repeat(200), null, undefined, 5, {}, [], "javascript:alert(1)", "hero.x;y", "hero.x'y", "hero.é",
  ];
  for (const b of bad) assert.equal(parseRef(b), null, JSON.stringify(b));
});

test("REF_RE accepts exactly what parseRef accepts (attribute checks)", () => {
  for (const ok of ["hero.badge", "pages:privacy.title", "how.story.0.alt"]) assert.ok(REF_RE.test(ok));
  for (const bad of ["hero", "Hero.x", 'hero.x"']) assert.ok(!REF_RE.test(bad));
});

test("formatRef builds references and rejects bad parts", () => {
  assert.equal(formatRef("how", ["story", 2, "title"]), "how.story.2.title");
  assert.equal(formatRef("pages:about", ["_body"]), "pages:about._body");
  assert.throws(() => formatRef("How", ["x"]));
  assert.throws(() => formatRef("how", []));
  assert.throws(() => formatRef("how", ["a.b"]));
  assert.throws(() => formatRef("how", ["a b"]));
  assert.throws(() => formatRef("pages:", ["x"]));
  assert.throws(() => formatRef("how", ["x".repeat(200)]));
});

test("formatRef and parseRef round-trip", () => {
  for (const r of ["a.b", "hero.headlineMain", "homepage.sections.11.items.0", "pages:x-y.sections.2.heading"]) {
    const p = parseRef(r);
    assert.equal(formatRef(p.file, p.segs), r);
  }
});

test("locate gives the repository file and the JSON pointer", () => {
  assert.deepEqual(locate("how.story.2.title"), { filePath: "src/_data/how.json", kind: "data", pointer: "/story/2/title" });
  assert.deepEqual(locate("pages:about.sections.1.heading"), { filePath: "src/pages/about.md", kind: "page", pointer: "/sections/1/heading" });
  assert.deepEqual(locate("pages:about._body"), { filePath: "src/pages/about.md", kind: "page", pointer: "/_body" });
  assert.deepEqual(locate({ file: "hero", segs: ["badge"] }), { filePath: "src/_data/hero.json", kind: "data", pointer: "/badge" });
  assert.equal(locate("nope"), null);
  assert.equal(locate("../x.y"), null);
});
