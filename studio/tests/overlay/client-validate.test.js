"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { load, fixtures, plain } = require("./load");

function setup() {
  const S = load();
  const fx = fixtures();
  const sc = S.schemaClient.create(fx.schema);
  const f = (file, name) => sc.fileSchema(file).fields.find((x) => x.name === name);
  const v = (field, value) => plain(S.validateClient.validate(field, value, { limits: sc.limits, reservedIds: fx.schema.reservedIds }));
  return { S, sc, f, v, fx };
}

test("strings: required, pattern with the schema's own message, length, controls and bidi", () => {
  const { f, v } = setup();
  const head = f("hero", "headlineMain");
  assert.deepEqual(v(head, "We cover the UK"), []);
  assert.equal(v(head, "")[0].code, "required");
  assert.equal(v(head, "   ")[0].code, "required");
  assert.deepEqual(v(head, "a <b> c").map((p) => p.message), ["Please don't use < or > in the headline."]);
  assert.equal(v(head, "x".repeat(20001))[0].code, "too_large");
  assert.ok(v(head, "a\u0000b").some((p) => p.code === "encoding"));
  assert.ok(v(head, "evil‮txt").some((p) => p.code === "encoding"), "RTL override is refused");
  assert.ok(v(head, "evil⁦txt").some((p) => p.code === "encoding"), "isolates too");
  assert.ok(v(head, "two\nlines").some((p) => p.code === "encoding"), "single-line field");
  assert.deepEqual(v(f("hero", "subhead"), "two\nlines"), [], "a text field may hold line breaks");
});

test("links need a safe form (same rule as the site's safeUrl)", () => {
  const { f, v } = setup();
  const link = f("hero", "ctaLink");
  ["/about/", "/#faq", "#top", "https://example.com/x", "http://example.com", "mailto:a@b.test"].forEach((ok) => assert.deepEqual(v(link, ok), [], ok));
  ["javascript:alert(1)", "data:text/html,x", "//evil.test", "www.example.com", "ftp://x", "/a b"].forEach((bad) => assert.ok(v(link, bad).length > 0, bad));
});

test("colours: #RGB/#RGBA/#RRGGBB/#RRGGBBAA only", () => {
  const { f, v } = setup();
  const c = f("theme", "paper");
  ["#FFF", "#ffff", "#FFEFDA", "#FFEFDA80"].forEach((ok) => assert.deepEqual(v(c, ok), [], ok));
  ["red", "#GGGGGG", "rgb(0,0,0)", "#12345", "url(x)"].forEach((bad) => assert.ok(v(c, bad).length > 0, bad));
});

test("pictures: a file name with a picture extension; optional fields may be empty", () => {
  const { sc, v } = setup();
  const img = sc.fileSchema("how").fields.find((x) => x.name === "story").fields.find((x) => x.name === "image");
  assert.deepEqual(v(img, "story-9.jpg"), []);
  assert.ok(v(img, "evil.exe").length > 0);
  assert.ok(v(img, "../x.jpg").length > 0);
  const alt = sc.fileSchema("how").fields.find((x) => x.name === "story").fields.find((x) => x.name === "alt");
  assert.deepEqual(v(alt, ""), []);
});

test("booleans, numbers, selects", () => {
  const { S } = setup();
  const V = (f, x) => plain(S.validateClient.validate(f, x, {}));
  assert.ok(V({ widget: "boolean" }, "yes").length);
  assert.deepEqual(V({ widget: "boolean" }, false), []);
  assert.ok(V({ widget: "number", min: 1, max: 5, valueType: "int" }, 7).length);
  assert.ok(V({ widget: "number", valueType: "int" }, 1.5).length);
  assert.deepEqual(V({ widget: "number", min: 1, max: 5 }, 3), []);
  assert.ok(V({ widget: "select", options: [{ label: "A", value: "a" }] }, "b").length);
});

test("anchors: lower-case slugs that are not reserved ids", () => {
  const { S, fx } = setup();
  const f = { widget: "string", required: false, x: { rule: "anchor" } };
  const V = (x) => plain(S.validateClient.validate(f, x, { reservedIds: fx.schema.reservedIds }));
  assert.deepEqual(V("my-block"), []);
  assert.deepEqual(V(""), []);
  assert.ok(V("My Block").length);
  assert.ok(V("adbar").length, "reserved id");
});

test("schema client: breadcrumbs, typed lists, leaves and image style", () => {
  const { sc, fx } = setup();
  const doc = fx.content.files.homepage.data;
  assert.equal(sc.labelFor("homepage", ["sections", "3", "enabled"], doc), "Homepage layout > Page sections > The problem > Show this section");
  assert.equal(sc.itemName("homepage", ["sections", "3"], doc), "The problem");
  assert.equal(sc.labelFor("how", ["story", "1", "title"], fx.content.files.how.data), "How it works > Story cards > card 2 > Card title");
  assert.equal(sc.resolve("homepage", ["sections", "9", "enabled"], doc), null, "no such item");
  assert.equal(sc.resolve("hero", ["nope"], fx.content.files.hero.data), null);
  assert.equal(sc.resolve("pages:about", ["_body"], {}).field.widget, "markdown");
  const story = sc.fileSchema("how").fields[1];
  assert.equal(sc.imageStyle(story.fields[1]), "bare-name");
  const leaves = sc.leaves("how", fx.content.files.how.data);
  assert.ok(leaves.some((l) => l.segs.join(".") === "story.2.image"));
  assert.equal(sc.leaves("pages:about", { title: "t", _body: "b" }).length, 2);
});

test("refs: the grammar of DESIGN 2.1", () => {
  const { S } = setup();
  const p = (x) => plain(S.util.parseRef(x));
  assert.deepEqual(p("how.story.2.title"), { file: "how", segs: ["story", "2", "title"] });
  assert.deepEqual(p("pages:about._body"), { file: "pages:about", segs: ["_body"] });
  ["", "how", "How.title", "how..x", "how.a b", "a".repeat(200) + ".b", "pages:About.x", "how.x/y", "../x.y"].forEach((bad) => assert.equal(p(bad), null, bad));
  assert.equal(S.util.pointerOf(["a", "b~c", "d/e"]), "/a/b~0c/d~1e");
  assert.equal(S.util.safeHref("javascript:alert(1)"), null);
  assert.equal(S.util.safeHref("//evil.test"), null);
  assert.equal(S.util.safeHref("blob:http://x/1"), null);
  assert.equal(S.util.safeHref("blob:http://x/1", true), "blob:http://x/1");
  assert.equal(S.util.safeHref("/ok"), "/ok");
});
