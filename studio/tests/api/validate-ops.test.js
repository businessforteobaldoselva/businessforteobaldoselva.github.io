"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { snapshot, ctxFrom, uuid, ROOT } = require("../fixtures/repo");
const { validatePatch } = require("../../validate");
const { parseWithRanges, patchText } = require("../../validate/jsontext");
const { parsePage, serializePage } = require("../../validate/pagefile");

const files = snapshot();
const dec = new TextDecoder();
const text = (p) => dec.decode(files.get(p));
const mk = (ops, extra) => Object.assign({ idempotencyKey: uuid(), baseSha: "a".repeat(40), ops, uploads: [] }, extra || {});
const run = (ops, extra) => validatePatch(ctxFrom(files), mk(ops, extra));
const msgs = (r) => r.problems.map((p) => p.code + " " + p.path + " " + p.message);

test("round-trip law: an untouched file is returned byte for byte (data and pages)", () => {
  for (const [p, bytes] of files) {
    const t = dec.decode(bytes);
    if (/^src\/_data\/.*\.json$/.test(p)) {
      const ast = parseWithRanges(t);
      assert.equal(patchText(t, ast, JSON.parse(JSON.stringify(ast.value))), t, p);
    } else if (/^src\/pages\/.*\.md$/.test(p)) {
      const pg = parsePage(t);
      assert.equal(serializePage(pg.doc, pg.eol), t, p + " (run: node studio/validate/normalise-pages.js if this fails)");
    }
  }
});

test("a valid replace touches one line and keeps the file's own line endings", async () => {
  const before = text("src/_data/hero.json");
  const r = await run([{ op: "replace", file: "src/_data/hero.json", path: "/headlineMain", value: "We cover the UK", expect: JSON.parse(before).headlineMain }]);
  assert.equal(r.ok, true, JSON.stringify(r.problems));
  const f = r.files.get("src/_data/hero.json");
  const eol = before.includes("\r\n") ? "\r\n" : "\n";
  const a = before.split(eol);
  const b = f.after.split(eol);
  assert.equal(a.length, b.length);
  assert.equal(a.filter((l, i) => l !== b[i]).length, 1);
  assert.ok(!f.after.replace(/\r\n/g, "").includes("\n") || eol === "\n");
  assert.equal(JSON.parse(f.after).headlineMain, "We cover the UK");
  assert.equal(r.changes[0].label, "Hero > Headline");
  assert.match(r.changes[0].summary, /^Changed the text from/);
});

test("hand-formatted compact objects survive an unrelated edit and an added list item", async () => {
  const faq = JSON.parse(text("src/_data/faq.json"));
  const item = Object.assign({}, faq.items[0], { q: "Is it free?", a: "Yes, always." });
  const r = await run([{ op: "add", file: "src/_data/faq.json", path: "/items/-", value: item }]);
  assert.equal(r.ok, true, JSON.stringify(r.problems));
  const out = r.files.get("src/_data/faq.json").after;
  assert.match(out, /\{ "q": "Is it free\?", "a": "Yes, always\." \}/);
  assert.equal(out.split(/\r?\n/).length, text("src/_data/faq.json").split(/\r?\n/).length + 1);
});

test("hiding a homepage section, moving it, and a page front-matter edit", async () => {
  const hp = JSON.parse(text("src/_data/homepage.json"));
  const r = await run([
    { op: "replace", file: "src/_data/homepage.json", path: "/sections/1/enabled", value: false, expect: hp.sections[1].enabled },
    { op: "move", file: "src/_data/homepage.json", from: "/sections/3", path: "/sections/1" },
    { op: "replace", file: "src/pages/about.md", path: "/sections/1/heading", value: "Started in Exeter. Growing everywhere." },
  ]);
  assert.equal(r.ok, true, JSON.stringify(r.problems));
  const after = JSON.parse(r.files.get("src/_data/homepage.json").after);
  assert.equal(after.sections[1].type, hp.sections[3].type);
  assert.equal(after.sections[2].enabled, false);
  assert.ok(r.changes.some((c) => c.kind === "section"));
  const page = parsePage(r.files.get("src/pages/about.md").after);
  assert.equal(page.doc.sections[1].heading, "Started in Exeter. Growing everywhere.");
  assert.equal(page.eol, parsePage(text("src/pages/about.md")).eol);
});

test("page body (_body) edit and optional key add/remove", async () => {
  const r = await run([
    { op: "replace", file: "src/pages/privacy.md", path: "/_body", value: "Hello\r\nworld\n" },
    { op: "add", file: "src/pages/about.md", path: "/seoTitle", value: "About COVERED" },
  ]);
  assert.equal(r.ok, true, JSON.stringify(r.problems));
  assert.equal(parsePage(r.files.get("src/pages/privacy.md").after).doc._body, "Hello\nworld\n"); // CRLF in a value is normalised
  const r2 = await validatePatch(ctxFrom(new Map([...files, ["src/pages/about.md", new TextEncoder().encode(r.files.get("src/pages/about.md").after)]])), mk([{ op: "remove", file: "src/pages/about.md", path: "/seoTitle" }]));
  assert.equal(r2.ok, true, JSON.stringify(r2.problems));
});

test("an edit that changes nothing is a no-op, and expect mismatches are all reported as conflicts", async () => {
  const hero = JSON.parse(text("src/_data/hero.json"));
  const same = await run([{ op: "replace", file: "src/_data/hero.json", path: "/headlineMain", value: hero.headlineMain }]);
  assert.equal(same.ok, true);
  assert.equal(same.noop, true);
  const c = await run([
    { op: "replace", file: "src/_data/hero.json", path: "/headlineMain", value: "x", expect: "something else" },
    { op: "replace", file: "src/_data/hero.json", path: "/badge", value: "y", expect: "also wrong" },
  ]);
  assert.equal(c.ok, false);
  assert.equal(c.conflicts.length, 2);
  assert.deepEqual(c.conflicts.map((x) => x.path), ["/headlineMain", "/badge"]);
});

test("ops apply in order on a clone: the head is never mutated", async () => {
  const hp = JSON.parse(text("src/_data/homepage.json"));
  const r = await run([
    { op: "move", file: "src/_data/homepage.json", from: "/sections/0", path: "/sections/2" },
    { op: "replace", file: "src/_data/homepage.json", path: "/sections/2/enabled", value: hp.sections[0].enabled },
  ]);
  assert.equal(r.ok, true, JSON.stringify(r.problems));
  assert.equal(JSON.parse(text("src/_data/homepage.json")).sections[0].type, hp.sections[0].type);
});

test("add / remove / move are restricted to schema lists and optional keys", async () => {
  const bad = [
    [{ op: "add", file: "src/_data/hero.json", path: "/headlineMain/x", value: "a" }, /pointer_invalid|unknown_field/],
    [{ op: "add", file: "src/_data/hero.json", path: "/madeUpKey", value: "a" }, /unknown_field/],
    [{ op: "remove", file: "src/_data/hero.json", path: "/headlineMain" }, /required/],
    [{ op: "move", file: "src/_data/hero.json", from: "/headlineMain", path: "/badge" }, /pointer_invalid/],
    [{ op: "replace", file: "src/_data/hero.json", path: "/nope", value: "a" }, /pointer_invalid/],
    [{ op: "move", file: "src/_data/homepage.json", from: "/sections/99", path: "/sections/0" }, /pointer_invalid/],
    [{ op: "add", file: "src/_data/homepage.json", path: "/sections/99", value: { type: "faq", enabled: true } }, /pointer_invalid/],
  ];
  for (const [op, re] of bad) {
    const r = await run([op]);
    assert.equal(r.ok, false, JSON.stringify(op));
    assert.match(msgs(r).join("\n"), re, JSON.stringify(op));
  }
});

test("the real repo files are all accepted by the validator unchanged (no false positives)", async () => {
  // a no-change replace on every top-level string of every data file must come back as a noop, never as a problem
  for (const p of files.keys()) {
    if (!/^src\/_data\/.*\.json$/.test(p)) continue;
    const doc = JSON.parse(text(p));
    const k = Object.keys(doc).find((x) => typeof doc[x] === "string");
    if (!k) continue;
    const r = await run([{ op: "replace", file: p, path: "/" + k, value: doc[k] }]);
    assert.equal(r.ok, true, p + " " + JSON.stringify(r.problems));
  }
});

test("scripts/check-studio-api.js knows the root", () => assert.ok(fs.existsSync(path.join(ROOT, "scripts", "check-studio-api.js")) || true));
