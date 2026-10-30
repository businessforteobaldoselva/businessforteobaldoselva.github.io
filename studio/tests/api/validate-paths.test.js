"use strict";
// Scope (only data, pages and new pictures), pointer safety, size limits. The scope module is the ONE definition.
const test = require("node:test");
const assert = require("node:assert/strict");
const { snapshot, ctxFrom, uuid } = require("../fixtures/repo");
const { validatePatch } = require("../../validate");
const scope = require("../../validate/scope");
const P = require("../../validate/pointer");

const files = snapshot();
const mk = (ops, extra) => Object.assign({ idempotencyKey: uuid(), baseSha: "a".repeat(40), ops, uploads: [] }, extra || {});
const run = (ops, extra) => validatePatch(ctxFrom(files), mk(ops, extra));

test("scope.classify allows exactly data, pages and picture files", () => {
  assert.equal(scope.classify("src/_data/hero.json"), "data");
  assert.equal(scope.classify("src/pages/about.md"), "page");
  assert.equal(scope.classify("images/new-photo.jpg"), "image");
  assert.equal(scope.classify("images/Photo_1.PNG"), "image");
});

test("everything else is out of scope: code, templates, config, CI, packages, dotfiles, traversal", () => {
  const forbidden = [
    "package.json", "package-lock.json", ".eleventy.js", "netlify.toml", "cms/config.yml", "cms/previews.js", "lib/rules.js", "scripts/check-cms.js",
    "studio/api/handler.js", ".github/workflows/site-checks.yml", ".github/workflows/x.yml", ".gitignore", ".env", "src/index.njk", "src/_includes/site-styles.css",
    "src/_data/hero.js", "src/_data/hero.json.bak", "src/_data/sub/hero.json", "src/_data/.hidden.json", "src/_data/Hero.json", "src/_data/he ro.json",
    "src/pages/about.njk", "src/pages/../../package.json", "src/_data/../../package.json", "src/_data/%2e%2e/package.json", "src\\_data\\hero.json",
    "/src/_data/hero.json", "src//_data/hero.json", "images/../package.json", "images/sub/x.jpg", "images/.htaccess", "images/x.html", "images/x.js", "images/x.jpg.exe",
    "images/" + "a".repeat(90) + ".jpg", "images/\u0000x.jpg", "src/_data/hero.json\u0000.png", "", "images/", "images/-x.jpg", "videos/x.mp4", "admin/index.html", "requests/x.md",
    "images/a..b.jpg", "src/_data/hero.json ", " src/_data/hero.json",
  ];
  for (const f of forbidden) assert.equal(scope.classify(f), null, JSON.stringify(f));
  assert.equal(scope.classify(null), null);
  assert.equal(scope.classify({ toString: () => "src/_data/hero.json" }), null);
  assert.throws(() => scope.assertInScope("package.json"), /may not touch/);
});

test("branches: only studio/<user>/<name>", () => {
  assert.doesNotThrow(() => scope.assertStudioBranch("studio/uabcdefg/summer-edits"));
  for (const b of ["main", "master", "studio/main", "studio/x/", "feature/x", "studio/a/b/c", "studio/../main", "refs/heads/main", "STUDIO/u/x", "studio/u/ x"]) assert.throws(() => scope.assertStudioBranch(b), /studio/, b);
});

test("the validator refuses every forbidden file with path_forbidden and writes nothing", async () => {
  for (const f of ["package.json", ".github/workflows/site-checks.yml", "cms/config.yml", "src/index.njk", "src/_data/../../package.json", "src/_data/missing.json", "src/pages/new-page.md", "images/x.jpg"]) {
    const r = await run([{ op: "replace", file: f, path: "/name", value: "x" }]);
    assert.equal(r.ok, false, f);
    assert.equal(r.problems[0].code, "path_forbidden", f);
    assert.equal(r.files.size, 0);
  }
});

test("pointers: prototype pollution and malformed forms are refused before anything is applied", async () => {
  const bad = ["/__proto__/polluted", "/constructor/prototype/x", "/prototype", "/headlineMain/__proto__", "headlineMain", "", "/", "//headlineMain", "/a/~2", "/a/~", "/sections/00", "/sections/-1", "/sections/1e1", "/sections/ 1", "/" + "a/".repeat(25), "/\u0000"];
  for (const p of bad) {
    const r = await run([{ op: "replace", file: "src/_data/hero.json", path: p, value: "x" }]);
    assert.equal(r.ok, false, JSON.stringify(p));
    assert.ok(["pointer_invalid", "unknown_field"].includes(r.problems[0].code), JSON.stringify(p) + r.problems[0].code);
  }
  assert.equal({}.polluted, undefined);
  assert.equal(Object.prototype.polluted, undefined);
  // "~1" and "~0" are valid escapes but name keys the schema does not have
  const esc = await run([{ op: "replace", file: "src/_data/hero.json", path: "/a~1b", value: "x" }]);
  assert.equal(esc.problems[0].code, "pointer_invalid");
  assert.deepEqual(P.parse("/a~1b/c~0d"), ["a/b", "c~d"]);
  assert.equal(P.format(["a/b", "c~d"]), "/a~1b/c~0d");
});

test("'-' is only valid as the last segment of an add", async () => {
  const r = await run([{ op: "replace", file: "src/_data/faq.json", path: "/items/-", value: { q: "x", a: "y" } }]);
  assert.equal(r.ok, false);
  const r2 = await run([{ op: "add", file: "src/_data/faq.json", path: "/items/-/q", value: "x" }]);
  assert.equal(r2.ok, false);
});

test("values that are not plain JSON, or carry __proto__, are refused", async () => {
  const evil = JSON.parse('{"q":"a","a":"b","__proto__":{"polluted":true}}');
  const r = await run([{ op: "add", file: "src/_data/faq.json", path: "/items/-", value: evil }]);
  assert.equal(r.ok, false);
  assert.equal(Object.prototype.polluted, undefined);
  const nested = {};
  let cur = nested;
  for (let i = 0; i < 40; i += 1) { cur.x = {}; cur = cur.x; }
  const deep = await run([{ op: "add", file: "src/_data/faq.json", path: "/items/-", value: nested }]);
  assert.equal(deep.ok, false);
  assert.equal(deep.problems[0].code, "too_large");
});

test("envelope: unknown keys, bad ids and shas, too many ops, too many uploads", async () => {
  const base = mk([{ op: "replace", file: "src/_data/hero.json", path: "/headlineMain", value: "x" }]);
  const cases = [
    [Object.assign({}, base, { evil: 1 }), "unknown_field"],
    [Object.assign({}, base, { idempotencyKey: "nope" }), "type"],
    [Object.assign({}, base, { baseSha: "xyz" }), "type"],
    [Object.assign({}, base, { title: "x".repeat(81) }), "too_large"],
    [Object.assign({}, base, { ops: [{ op: "replace", file: "src/_data/hero.json", path: "/headlineMain", value: "x", sneaky: 1 }] }), "unknown_field"],
    [Object.assign({}, base, { ops: [{ op: "eval", file: "src/_data/hero.json", path: "/headlineMain" }] }), "type"],
    [Object.assign({}, base, { ops: [] .concat(Array.from({ length: 201 }, () => ({ op: "replace", file: "src/_data/hero.json", path: "/headlineMain", value: "x" }))) }), "too_large"],
    [Object.assign({}, base, { uploads: Array.from({ length: 5 }, (_, i) => ({ id: "u" + i, name: "a" + i + ".png", contentType: "image/png", size: 1, dataBase64: "AA==" })) }), "too_large"],
    [Object.assign({}, base, { ops: "no" }), "type"],
    [null, "type"],
    [[], "type"],
  ];
  for (const [p, code] of cases) {
    const r = await validatePatch(ctxFrom(files), p);
    assert.equal(r.ok, false);
    assert.ok(r.problems.some((x) => x.code === code), code + " " + JSON.stringify(r.problems.map((x) => x.code)));
  }
});

test("a huge array in a value is refused (list item cap) without blowing up", async () => {
  const huge = Array.from({ length: 5000 }, (_, i) => "item " + i);
  const t = Date.now();
  const r = await run([{ op: "replace", file: "src/_data/homepage.json", path: "/sections/1/items", value: huge }]);
  assert.equal(r.ok, false);
  assert.ok(Date.now() - t < 3000);
});
