"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { snapshot, splitFrontMatter } = require("../../markers/snapshot");

const ROOT = path.resolve(__dirname, "..", "..", "..");

test("snapshot of the checkout has the content.json shape of the contract", () => {
  const s = snapshot(ROOT, {});
  assert.equal(s.schemaVersion, 1);
  assert.match(String(s.schemaSha256), /^[0-9a-f]{64}$/);
  assert.deepEqual(Object.keys(s.build).sort(), ["branch", "builtAt", "prNumber", "sha"]);
  assert.ok(s.build.sha === null || /^[0-9a-f]{40}$/.test(s.build.sha));
  assert.ok(!Number.isNaN(Date.parse(s.build.builtAt)));
  for (const [key, f] of Object.entries(s.files)) {
    assert.match(key, /^(?:[a-z][a-z0-9-]*|pages:[a-z0-9-]+)$/);
    assert.ok(fs.existsSync(path.join(ROOT, f.path)), f.path);
    assert.equal(typeof f.data, "object");
  }
  assert.equal(s.files.hero.path, "src/_data/hero.json");
  assert.equal(s.files["pages:about"].path, "src/pages/about.md");
  assert.equal(typeof s.files["pages:about"].data._body, "string");
  assert.equal(s.files["pages:about"].data.permalink, "/about/");
  assert.ok(Array.isArray(s.files.homepage.data.sections));
  JSON.parse(JSON.stringify(s));
});

test("the schema hash in the snapshot is the one of the committed schema", () => {
  const schema = JSON.parse(fs.readFileSync(path.join(ROOT, "studio", "schema", "studio-schema.json"), "utf8"));
  assert.equal(snapshot(ROOT, {}).schemaSha256, schema.configSha256);
});

test("build information comes from the CI environment", () => {
  const sha = "0123456789abcdef0123456789abcdef01234567";
  const s = snapshot(ROOT, { COMMIT_REF: sha, HEAD: "studio/u1234567/summer", REVIEW_ID: "57" });
  assert.equal(s.build.sha, sha);
  assert.equal(s.build.branch, "studio/u1234567/summer");
  assert.equal(s.build.prNumber, 57);
  const g = snapshot(ROOT, { GITHUB_SHA: sha.toUpperCase(), GITHUB_HEAD_REF: "feature" });
  assert.equal(g.build.sha, sha);
  assert.equal(g.build.branch, "feature");
  assert.equal(g.build.prNumber, null);
  assert.equal(snapshot(ROOT, { COMMIT_REF: "nonsense", REVIEW_ID: "5x" }).build.prNumber, null);
});

test("front matter and body are split like the guards do", () => {
  assert.deepEqual(splitFrontMatter("---\na: 1\nlist:\n  - x\n---\nBody *text*\n"), { front: { a: 1, list: ["x"] }, body: "Body *text*\n" });
  assert.deepEqual(splitFrontMatter("---\na: 1\n---\n"), { front: { a: 1 }, body: "" });
  assert.deepEqual(splitFrontMatter("no front matter"), { front: {}, body: "no front matter" });
  assert.throws(() => splitFrontMatter("---\n- a\n---\n"));
});

test("only flat data files and page files are read", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "studio-snap-"));
  try {
    fs.mkdirSync(path.join(dir, "src", "_data"), { recursive: true });
    fs.mkdirSync(path.join(dir, "src", "pages"), { recursive: true });
    fs.writeFileSync(path.join(dir, "src", "_data", "a.json"), '{"x":1}');
    fs.writeFileSync(path.join(dir, "src", "_data", "Bad.json"), "{}");
    fs.writeFileSync(path.join(dir, "src", "_data", "b.js"), "module.exports = {}");
    fs.writeFileSync(path.join(dir, "src", "pages", "p.md"), "---\nt: y\n---\r\nhello\r\n");
    fs.writeFileSync(path.join(dir, "src", "pages", "Q.md"), "---\nt: y\n---\n");
    const s = snapshot(dir, {});
    assert.deepEqual(Object.keys(s.files).sort(), ["a", "pages:p"]);
    assert.deepEqual(s.files["pages:p"].data, { t: "y", _body: "hello\n" });
    assert.equal(s.schemaSha256, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
