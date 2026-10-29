"use strict";
// Every kind of invalid value is refused with a message a founder can act on, and nothing is written.
const test = require("node:test");
const assert = require("node:assert/strict");
const { snapshot, ctxFrom, uuid } = require("../fixtures/repo");
const { validatePatch } = require("../../validate");
const { parsePage } = require("../../validate/pagefile");

const files = snapshot();
const dec = new TextDecoder();
const J = (p) => JSON.parse(dec.decode(files.get(p)));
const mk = (ops) => ({ idempotencyKey: uuid(), baseSha: "a".repeat(40), ops, uploads: [] });
const rep = (file, p, value) => ({ op: "replace", file, path: p, value });
async function refuse(op, code, fragment) {
  const r = await validatePatch(ctxFrom(files), mk(Array.isArray(op) ? op : [op]));
  assert.equal(r.ok, false, JSON.stringify(op).slice(0, 200));
  assert.equal(r.files.size, 0);
  const hit = r.problems.find((p) => p.code === code);
  assert.ok(hit, "expected " + code + " but got " + JSON.stringify(r.problems.map((p) => p.code + ":" + p.message)));
  if (fragment) assert.match(hit.message, fragment);
  assert.ok(hit.message.length > 8 && !/undefined|\[object/.test(hit.message));
  return hit;
}

test("wrong type: a number, boolean, object or null where text belongs", async () => {
  for (const v of [42, true, null, { a: 1 }, ["x"]]) await refuse(rep("src/_data/hero.json", "/headlineMain", v), "type");
  await refuse(rep("src/_data/homepage.json", "/sections/0/enabled", "yes"), "type", /on or off/);
});

test("pattern: e-mail, dates, permalink, canonical address", async () => {
  await refuse(rep("src/_data/site.json", "/contactEmail", "not an email"), "pattern");
  await refuse({ op: "add", file: "src/_data/site.json", path: "/lastModified", value: "14/08/2026" }, "pattern");
  await refuse(rep("src/pages/about.md", "/permalink", "/About Us/"), "pattern");
  await refuse({ op: "add", file: "src/_data/site.json", path: "/canonicalUrl", value: "https://evil.example/" }, "pattern");
});

test("length limits are checked before any pattern runs (no ReDoS surface)", async () => {
  await refuse(rep("src/_data/site.json", "/metaDescription", "x".repeat(321)), "pattern");
  await refuse(rep("src/_data/site.json", "/metaDescription", "x".repeat(20001)), "too_large");
  await refuse(rep("src/pages/about.md", "/_body", "y".repeat(60001)), "too_large");
});

test("tokens: out of range, wrong word, not a number", async () => {
  const t = J("src/_data/tokens.json");
  await refuse(rep("src/_data/tokens.json", "/text/baseSize", 500), "token");
  await refuse(rep("src/_data/tokens.json", "/text/baseSize", "100"), "type");
  await refuse(rep("src/_data/tokens.json", "/fonts/body", "comic-sans"), "option");
  await refuse(rep("src/_data/tokens.json", "/text/lead/max", 99), "token");
  await refuse(rep("src/_data/tokens.json", "/shape/shadow", 0.1234567), "token");
  const ok = await validatePatch(ctxFrom(files), mk([rep("src/_data/tokens.json", "/text/baseSize", t.text.baseSize === 110 ? 105 : 110)]));
  assert.equal(ok.ok, true, JSON.stringify(ok.problems));
});

test("links: javascript:, data:, protocol-relative and spaces are refused; good links pass", async () => {
  const link = (url) => ({ op: "add", file: "src/_data/nav.json", path: "/items/-", value: { type: "link", label: "Hi", url } });
  for (const bad of ["javascript:alert(1)", "data:text/html,x", "//evil.example/", "/with space", "vbscript:x", "JaVaScRiPt:1", ""]) await refuse(link(bad), bad === "" ? "required" : "pattern");
  for (const good of ["/about/", "#faq", "https://example.org/x?y=1", "mailto:hello@example.org"]) {
    const r = await validatePatch(ctxFrom(files), mk([link(good)]));
    assert.equal(r.ok, true, good + JSON.stringify(r.problems));
  }
});

test("colours: only hex", async () => {
  const theme = J("src/_data/theme.json");
  const k = Object.keys(theme).find((x) => /^#/.test(theme[x]));
  assert.ok(k, "theme.json has a colour");
  for (const bad of ["red", "#12", "#ggg", "url(javascript:x)", "#fff; background:url(x)", "expression(1)"]) await refuse(rep("src/_data/theme.json", "/" + k, bad), "color");
  const ok = await validatePatch(ctxFrom(files), mk([rep("src/_data/theme.json", "/" + k, "#0a1B2c")]));
  assert.equal(ok.ok, true, JSON.stringify(ok.problems));
});

test("anchors: reserved built-in ids and bad characters are refused", async () => {
  const block = (anchor) => ({ op: "add", file: "src/_data/homepage.json", path: "/sections/-", value: { type: "textBlock", enabled: true, body: "Hello", anchor } });
  for (const bad of ["brands", "adbar", "Has Space", "UPPER", "a_b", "bname", "faq"]) await refuse(block(bad), "pattern");
  const ok = await validatePatch(ctxFrom(files), mk([block("our-numbers")]));
  assert.equal(ok.ok, true, JSON.stringify(ok.problems));
});

test("redirects: loops, unapproved external hosts, reserved addresses", async () => {
  const add = (item) => ({ op: "add", file: "src/_data/redirects.json", path: "/items/-", value: item });
  await refuse(add({ fromLink: "/old/", toLink: "https://evil.example/phish", permanent: true }), "redirect");
  await refuse(add({ fromLink: "/images/x", toLink: "/about/", permanent: true }), "redirect");
  await refuse(add({ fromLink: "/same/", toLink: "/same/", permanent: true }), "redirect");
  const good = await validatePatch(ctxFrom(files), mk([add({ fromLink: "/old-about/", toLink: "/about/", permanent: true })]));
  assert.equal(good.ok, true, JSON.stringify(good.problems));
});

test("required, min items, unknown fields and unknown block types", async () => {
  await refuse(rep("src/_data/hero.json", "/headlineMain", "   "), "required");
  await refuse({ op: "remove", file: "src/_data/hero.json", path: "/headlineMain" }, "required");
  const nav = J("src/_data/nav.json");
  const ops = nav.items.map(() => ({ op: "remove", file: "src/_data/nav.json", path: "/items/0" }));
  await refuse(ops, "min_items");
  await refuse({ op: "add", file: "src/_data/nav.json", path: "/items/-", value: { type: "mystery", label: "x" } }, "option");
  await refuse({ op: "add", file: "src/_data/hero.json", path: "/extra", value: "x" }, "unknown_field");
  await refuse({ op: "add", file: "src/_data/faq.json", path: "/items/-", value: { q: "q", a: "a", evil: "<script>" } }, "unknown_field");
  await refuse({ op: "add", file: "src/_data/faq.json", path: "/items/-", value: { q: "no answer" } }, "required");
});

test("max items", async () => {
  const nav = J("src/_data/nav.json");
  const adds = [];
  for (let i = nav.items.length; i < 12; i += 1) adds.push({ op: "add", file: "src/_data/nav.json", path: "/items/-", value: JSON.parse(JSON.stringify(nav.items[0])) });
  await refuse(adds, "max_items");
});

test("invisible and control characters are refused (bidi, NUL, lone CR, line separators)", async () => {
  for (const bad of ["a\u0000b", "a\u202eb", "a\u2066b", "a\rb", "a\u2028b", "a\u0085b", "a\u007fb"]) await refuse(rep("src/_data/hero.json", "/headlineMain", bad), "encoding");
  await refuse(rep("src/_data/hero.json", "/headlineMain", "two\nlines"), "encoding", /one line/);
});

test("newline / YAML / CRLF injection through a page value stays data and cannot add keys", async () => {
  const evil = "x\r\nlayout: evil.njk\r\npermalink: /pwn/\n---\nmalicious: true";
  const r = await validatePatch(ctxFrom(files), mk([rep("src/pages/about.md", "/_body", evil)]));
  assert.equal(r.ok, true, JSON.stringify(r.problems));
  const doc = parsePage(r.files.get("src/pages/about.md").after).doc;
  assert.equal(doc.layout, "page.njk");
  assert.equal(doc.permalink, "/about/");
  assert.equal(doc._body, evil.replace(/\r\n/g, "\n"));
  const r2 = await validatePatch(ctxFrom(files), mk([rep("src/pages/about.md", "/description", "line1\nlayout: evil.njk")]));
  assert.equal(r2.ok, true, JSON.stringify(r2.problems));
  const d2 = parsePage(r2.files.get("src/pages/about.md").after).doc;
  assert.equal(d2.layout, "page.njk");
  assert.equal(d2.description, "line1\nlayout: evil.njk");
  // a string that YAML would turn into something else is quoted, never reinterpreted
  for (const tricky of ["yes", "null", "~", "1.0", "2026-01-01", "0x10", "- item", "key: value", "[a, b]", "{a: 1}", "&anchor", "*alias", "!!js/function 'x'", "# comment"]) {
    const t = await validatePatch(ctxFrom(files), mk([rep("src/pages/about.md", "/sections/1/kicker", tricky)]));
    assert.equal(t.ok, true, tricky + JSON.stringify(t.problems));
    assert.equal(parsePage(t.files.get("src/pages/about.md").after).doc.sections[1].kicker, tricky);
  }
});

test("JSON injection through a data value stays a string", async () => {
  const evil = '","evil":"1","x":"';
  const r = await validatePatch(ctxFrom(files), mk([rep("src/_data/hero.json", "/headlineMain", evil)]));
  assert.equal(r.ok, true, JSON.stringify(r.problems));
  const doc = JSON.parse(r.files.get("src/_data/hero.json").after);
  assert.equal(doc.headlineMain, evil);
  assert.equal("evil" in doc, false);
});

test("problems that already exist at the head are warnings, not blockers", async () => {
  const f2 = new Map(files);
  const hero = J("src/_data/hero.json");
  hero.badge = 12345; // a legacy wrong-typed value somewhere else in the file
  f2.set("src/_data/hero.json", new TextEncoder().encode(JSON.stringify(hero, null, 2) + "\n"));
  const r = await validatePatch(ctxFrom(f2), mk([rep("src/_data/hero.json", "/headlineMain", "Fine")]));
  assert.equal(r.ok, true, JSON.stringify(r.problems));
  assert.ok(r.warnings.some((w) => w.path === "/badge"));
  const worse = await validatePatch(ctxFrom(f2), mk([rep("src/_data/hero.json", "/badge", 99)]));
  assert.equal(worse.ok, true); // same wrong type as before: still only a warning
  const newBad = await validatePatch(ctxFrom(f2), mk([rep("src/_data/hero.json", "/headlineMain", 5)]));
  assert.equal(newBad.ok, false);
});

// The code-level rules are enforced even when the CMS pattern is missing (they are imported from lib/rules.js).
test("x.rule url / anchor / permalink hold without any pattern", () => {
  const { validateDocument } = require("../../validate/fields");
  const { reservedIds } = require("../../../lib/reserved-ids");
  const { ROOT } = require("../fixtures/repo");
  const info = { path: "src/_data/hero.json", key: "hero", kind: "data", fields: [
    { name: "a", widget: "string", required: false, x: { rule: "url" } },
    { name: "b", widget: "string", required: false, x: { rule: "anchor" } },
  ] };
  const ctx = { schema: {}, reservedIds: reservedIds(ROOT) };
  const run = (doc) => validateDocument(ctx, info, doc, doc).problems.map((p) => p.code + p.path);
  assert.deepEqual(run({ a: "javascript:alert(1)" }), ["url/a"]);
  assert.deepEqual(run({ a: "//evil.example" }), ["url/a"]);
  assert.deepEqual(run({ a: "/ok/", b: "brands" }), ["anchor/b"]);
  assert.deepEqual(run({ b: "bad_one" }), ["anchor/b"]);
  assert.deepEqual(run({ a: "https://example.org", b: "nice-name" }), []);
});
