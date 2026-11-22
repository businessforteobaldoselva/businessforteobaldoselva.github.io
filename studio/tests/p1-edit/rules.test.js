"use strict";
// The ten content rules (studio/PHASE1-DESIGN.md 8.4): each one with a good case, a bad case, hostile text, empty data and a huge list;
// the engine is deterministic; no rule throws on the real repo or on hostile data; every report passes the executable wire shape.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const fs = require("fs");

const ROOT = path.resolve(__dirname, "..", "..", "..");
const engine = require("../../content-rules");
const { buildFacts } = require("../../content-rules/facts-node");
const { readFiles } = require("../../markers/snapshot");
const { validateRuleReport } = require("../../api/shapes/phase1");
const schema = JSON.parse(fs.readFileSync(path.join(ROOT, "studio", "schema", "studio-schema.json"), "utf8"));

const realFiles = () => { const o = {}; const f = readFiles(ROOT); for (const k of Object.keys(f)) o[k] = f[k].data; return o; };
const clone = (x) => JSON.parse(JSON.stringify(x));
const FACTS = { routes: ["/", "/about/", "/privacy/"], tools: ["/og/"], anchors: { "/": ["how", "faq", "top"], "/about/": ["top"], "/privacy/": ["top"] }, redirectFrom: ["/old-page"], images: { "ok.jpg": { bytes: 1000, width: 800, height: 600 }, "heavy.jpg": { bytes: 900 * 1024, width: 4000, height: 3000 }, "a.jpg": { bytes: 2000 * 1024, width: 1000, height: 1000 }, "b.jpg": { bytes: 2000 * 1024, width: 1000, height: 1000 } }, pages: { "/": { images: ["a.jpg", "b.jpg"], bytes: 4096000 } } };
const run = (files, facts, only) => engine.run({ files, schema, facts: facts === undefined ? FACTS : facts, only });
const keys = (rep, rule) => rep.findings.filter((f) => !rule || f.rule === rule).map((f) => f.key);

test("the real repo content produces a valid report and no rule throws", () => {
  const rep = run(realFiles(), buildFacts(ROOT));
  assert.deepEqual(validateRuleReport(rep), []);
  assert.equal(rep.ranRules.length, 10);
  assert.deepEqual(rep.ranRules, ["alt-missing", "alt-weak", "broken-internal-link", "description-length", "duplicate-text", "heading-skip", "image-heavy", "page-weight", "title-length", "vague-link-text"]);
  assert.equal(rep.counts.block, 0, "the live content has no block finding (the baseline is empty)");
});

test("the engine is deterministic: same input, same findings in the same order", () => {
  const files = realFiles();
  files.site.pageTitle = "x"; files.site.metaDescription = "y";
  const a = JSON.stringify(run(clone(files), FACTS));
  const b = JSON.stringify(run(clone(files), FACTS));
  assert.equal(a, b);
});

test("alt-missing (block) and alt-weak (warn)", () => {
  const files = clone(realFiles());
  const story = files.how.story;
  story[0].alt = ""; story[0].decorative = false;               // missing
  story[1].alt = "ab";                                           // weak: short
  story[2].alt = "story-3-get.jpg";                              // weak: the file name
  story[3].alt = "Picture of a dispenser";                       // weak: "picture of"
  story.push(Object.assign(clone(story[0]), { decorative: true, alt: "" })); // decorative: fine
  const rep = run(files);
  assert.deepEqual(keys(rep, "alt-missing"), ["alt-missing|how|/story/0/alt"]);
  assert.equal(rep.findings.find((f) => f.rule === "alt-missing").severity, "block");
  assert.deepEqual(keys(rep, "alt-weak"), ["alt-weak|how|/story/1/alt", "alt-weak|how|/story/2/alt", "alt-weak|how|/story/3/alt"]);
  assert.ok(rep.findings.filter((f) => f.rule === "alt-weak").every((f) => f.severity === "warn"));
  // a good description is quiet; an empty picture value is not a picture
  story[0].alt = "A hand taking a pad from the dispenser"; story[1].alt = "A phone scanning a QR code on the machine"; story[2].alt = "People collecting products at a venue"; story[3].alt = "The dispenser in a university building";
  assert.deepEqual(keys(run(files), "alt-missing").concat(keys(run(files), "alt-weak")), []);
  story[0].src = ""; story[0].alt = ""; story[0].decorative = false;
  assert.deepEqual(keys(run(files), "alt-missing"), [], "no picture, nothing to describe");
});

test("alt-weak: very long descriptions; the share picture's optional description is judged only when written", () => {
  const files = clone(realFiles());
  files.how.story[0].alt = "x ".repeat(100);
  assert.ok(keys(run(files), "alt-weak").includes("alt-weak|how|/story/0/alt"));
  const f2 = clone(realFiles());
  f2.site.shareImageAlt = "";
  assert.deepEqual(keys(run(f2), "alt-missing"), [], "shareImage has no decorative switch: optional description");
});

test("title-length and description-length", () => {
  const files = clone(realFiles());
  files.site.pageTitle = "Short";                                   // < 15
  files.site.metaDescription = "m".repeat(161);                      // > 160
  files.site.ogDescription = "n".repeat(39);                         // < 40
  let rep = run(files);
  assert.deepEqual(keys(rep, "title-length"), ["title-length|site|/pageTitle"]);
  assert.deepEqual(keys(rep, "description-length"), ["description-length|site|/metaDescription", "description-length|site|/ogDescription"]);
  files.site.pageTitle = "COVERED: free period products, paid for by ads"; files.site.metaDescription = "A UK social enterprise giving out free plastic-free period products from smart dispensers, paid for by advertising."; files.site.ogDescription = "Free period products where you need them, funded by brands that want to reach you in the same places.";
  rep = run(files);
  assert.deepEqual(keys(rep, "title-length").concat(keys(rep, "description-length")), []);
  files.site.pageTitle = "";                                         // empty is the schema's job, not this rule's
  assert.deepEqual(keys(run(files), "title-length"), []);
  files.site.pageTitle = "t".repeat(61);
  assert.equal(keys(run(files), "title-length").length, 1);
});

test("duplicate-text: the same title or description in two files, the same question twice, the same heading twice in a list", () => {
  const files = clone(realFiles());
  files["pages:about"].seoTitle = files.site.pageTitle;
  files["pages:about"].description = files.site.metaDescription;
  files.faq.items[1].q = files.faq.items[0].q.toUpperCase() + "  ";
  const rep = run(files);
  // the finding sits on the later file in sorted order ("pages:about" comes before "site"), and names the first
  assert.ok(keys(rep, "duplicate-text").includes("duplicate-text|site|/pageTitle"));
  assert.ok(keys(rep, "duplicate-text").includes("duplicate-text|site|/metaDescription"));
  assert.ok(keys(rep, "duplicate-text").includes("duplicate-text|faq|/items/1/q"));
  const clean = run(realFiles());
  assert.deepEqual(keys(clean, "duplicate-text"), []);
});

test("vague-link-text: a button or link that says 'here' or 'read more'", () => {
  const files = clone(realFiles());
  const nav = files.nav.items.find((i) => i.type === "link");
  nav.label = "Click here!";
  files["pages:about"]._body = "Some text. [Read more](/about/) and [our privacy page](/privacy/) and [here](https://example.org/).";
  const rep = run(files);
  assert.ok(keys(rep, "vague-link-text").some((k) => /^vague-link-text\|nav\|\/items\/\d+\/label$/.test(k)));
  assert.ok(keys(rep, "vague-link-text").includes("vague-link-text|pages:about|/_body#link1"));
  assert.ok(keys(rep, "vague-link-text").includes("vague-link-text|pages:about|/_body#link3"));
  assert.ok(!keys(rep, "vague-link-text").includes("vague-link-text|pages:about|/_body#link2"));
});

test("broken-internal-link: unknown page = block, redirect source = info, unknown #anchor = block, files and outside links ignored; no facts = skipped", () => {
  const files = clone(realFiles());
  const link = files.nav.items.find((i) => i.type === "link");
  link.url = "/no-such-page/";
  files["pages:about"]._body = "[a](/old-page) [b](/#nope) [c](/#how) [d](/about/#top) [e](/feed.xml) [f](https://example.org/x) [g](mailto:a@b.co) [h](/og/) [i](/about) [j](#top)";
  const rep = run(files);
  const by = {}; rep.findings.filter((f) => f.rule === "broken-internal-link").forEach((f) => { by[f.key] = f.severity; });
  assert.equal(by["broken-internal-link|nav|/items/" + files.nav.items.indexOf(link) + "/url"], "block");
  assert.equal(by["broken-internal-link|pages:about|/_body#link1"], "info");
  assert.equal(by["broken-internal-link|pages:about|/_body#link2"], "block");
  for (const n of [3, 4, 5, 6, 7, 8, 9, 10]) assert.equal(by["broken-internal-link|pages:about|/_body#link" + n], undefined, "link " + n + " is fine");
  assert.deepEqual(keys(run(files, {}), "broken-internal-link"), [], "without facts the rule stays quiet");
});

test("heading-skip: a jump of more than one level, or an H1, in markdown (code fences ignored)", () => {
  const files = clone(realFiles());
  files["pages:about"]._body = "## Fine\n\ntext\n\n#### Skipped a level\n";
  assert.equal(keys(run(files), "heading-skip").length, 1);
  files["pages:about"]._body = "# Top heading\n";
  assert.equal(keys(run(files), "heading-skip").length, 1);
  files["pages:about"]._body = "## One\n### Two\n```\n# not a heading\n```\n## Three\n";
  assert.deepEqual(keys(run(files), "heading-skip"), []);
});

test("image-heavy and page-weight use the facts", () => {
  const files = clone(realFiles());
  files.how.story[0].src = "heavy.jpg"; files.how.story[1].src = "ok.jpg";
  const rep = run(files);
  assert.deepEqual(keys(rep, "image-heavy"), ["image-heavy|how|/story/0/src"]);
  assert.deepEqual(keys(rep, "page-weight"), ["page-weight|/|"]);
  assert.deepEqual(keys(run(files, {}), "image-heavy").concat(keys(run(files, {}), "page-weight")), []);
});

test("hostile text never throws, never becomes markup in a finding, and stays within the shape limits", () => {
  const files = clone(realFiles());
  const evil = '<img src=x onerror=alert(1)>|||"\'`${7*7}‮' + "a".repeat(5000);
  files.site.pageTitle = evil; files.site.metaDescription = evil; files.how.story[0].alt = ""; files.how.story[0].decorative = false;
  files["pages:about"]._body = "## A\n#### B [click here](" + evil + ")\n";
  files.nav.items.find((i) => i.type === "link").url = "/" + evil;
  const rep = run(files);
  assert.deepEqual(validateRuleReport(rep), []);
  for (const f of rep.findings) { assert.ok(f.message.length <= 300); assert.ok(!f.key.slice(f.key.indexOf("|") + 1).includes("<img")); }
});

test("empty data, missing files and a huge list do not throw", () => {
  assert.deepEqual(run({}, {}).findings, []);
  assert.deepEqual(run({ how: {} }, {}).findings, []);
  const files = clone(realFiles());
  const big = files.faq.items[0];
  files.faq.items = Array.from({ length: 2000 }, () => clone(big));
  const t = Date.now();
  const rep = run(files);
  assert.ok(Date.now() - t < 5000, "2000 FAQ items checked in " + (Date.now() - t) + " ms");
  assert.equal(keys(rep, "duplicate-text").length, 1999);
  assert.deepEqual(validateRuleReport(rep), []);
});

test("every rule has a plain-English title and never calls itself an accessibility audit", () => {
  for (const r of engine.rules()) {
    assert.ok(r.title && r.title.length > 5, r.id);
    const src = r.check.toString();
    assert.ok(!/WCAG/.test(src), r.id + " must not claim WCAG");
  }
});
