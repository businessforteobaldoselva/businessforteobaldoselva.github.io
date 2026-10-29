"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const sc = require("../../markers/shortcode");

const EDIT = { CMS_EDIT: "1" };

test("prints nothing unless CMS_EDIT is exactly 1", () => {
  for (const env of [{}, { CMS_EDIT: "" }, { CMS_EDIT: "0" }, { CMS_EDIT: "true" }, { CMS_EDIT: "11" }, { CMS_EDIT: " 1" }]) {
    assert.equal(sc.cms("hero.badge", "text", undefined, env), "", JSON.stringify(env));
  }
});

test("a normal build never even validates (and records nothing)", () => {
  const before = sc.problems.length;
  assert.equal(sc.cms("not a ref", "nonsense", { evil: 1 }, {}), "");
  assert.equal(sc.problems.length, before);
});

test("edit build: attributes in the fixed order", () => {
  assert.equal(sc.cms("hero.badge", "text", undefined, EDIT), ' data-cms="hero.badge" data-cms-kind="text"');
  assert.equal(
    sc.cms("how.story.0.src", "image", { cssvar: undefined, decorative: "how.story.0.decorative", alt: "how.story.0.alt" }, EDIT),
    ' data-cms="how.story.0.src" data-cms-kind="image" data-cms-alt="how.story.0.alt" data-cms-decorative="how.story.0.decorative"'
  );
  assert.equal(sc.cms("theme.paper", "color", { cssvar: "--paper" }, EDIT), ' data-cms="theme.paper" data-cms-kind="color" data-cms-cssvar="--paper"');
  assert.equal(sc.cms("a.b", "text", { href: "nav.items.1.url", hide: "motion.marquee" }, EDIT), ' data-cms="a.b" data-cms-kind="text" data-cms-href="nav.items.1.url" data-cms-hide="motion.marquee"');
});

test("unset template variables in opts are ignored", () => {
  assert.equal(sc.cms("a.b", "image", { alt: undefined, decorative: null, href: "" }, EDIT), ' data-cms="a.b" data-cms-kind="image"');
});

test("fails closed: invalid input gives nothing and is recorded", () => {
  const bad = [
    ['x"y.z', "text", undefined],
    ["hero", "text", undefined],
    ["hero.badge", "paragraph", undefined],
    ["hero.badge", "text", { onclick: "x" }],
    ["hero.badge", "text", { alt: 'a.b" onmouseover="x' }],
    ["hero.badge", "color", { cssvar: "paper" }],
    ["hero.badge", "color", { cssvar: "--Paper" }],
    ["hero.badge", "color", { cssvar: '--a" x="' }],
    ["hero.badge", "text", "alt"],
    ["hero.badge", "text", ["alt"]],
    [undefined, "text", undefined],
  ];
  for (const [ref, kind, opts] of bad) {
    const n = sc.problems.length;
    const origWarn = console.warn;
    console.warn = () => {};
    try {
      assert.equal(sc.cms(ref, kind, opts, EDIT), "", JSON.stringify([ref, kind, opts]));
    } finally {
      console.warn = origWarn;
    }
    assert.equal(sc.problems.length, n + 1);
  }
  sc.problems.length = 0;
});

test("every kind of the contract is accepted", () => {
  for (const k of ["text", "longtext", "markdown", "image", "link", "color", "toggle", "section", "item"]) {
    assert.match(sc.cms("a.b.0", k, undefined, EDIT), new RegExp('data-cms-kind="' + k + '"'));
  }
});

test("the Eleventy plugin registers the shortcode, and only that in a normal build", () => {
  const calls = { shortcodes: [], transforms: [], events: [] };
  const fake = {
    addShortcode: (n, f) => calls.shortcodes.push([n, f]),
    addTransform: (n) => calls.transforms.push(n),
    on: (n) => calls.events.push(n),
  };
  const old = process.env.CMS_EDIT;
  delete process.env.CMS_EDIT;
  try {
    require("../../../lib/eleventy/studio.js")(fake);
    assert.equal(calls.shortcodes.length, 1);
    assert.equal(calls.shortcodes[0][0], "cms");
    assert.equal(calls.shortcodes[0][1]("hero.badge", "text"), "");
    assert.deepEqual(calls.transforms, []);
    assert.deepEqual(calls.events, []);
    // the stub config of lib/reserved-ids.js --check has no addShortcode: must not throw
    require("../../../lib/eleventy/studio.js")({ addFilter() {}, addTransform() {}, on() {} });
  } finally {
    if (old !== undefined) process.env.CMS_EDIT = old;
  }
});

test("the edit-build plugin adds one transform, one event, and refuses unsafe API addresses", () => {
  const plug = require("../../../lib/eleventy/studio.js");
  const old = { e: process.env.CMS_EDIT, a: process.env.STUDIO_API_URL, p: process.env.STUDIO_APP_URL };
  try {
    process.env.CMS_EDIT = "1";
    process.env.STUDIO_API_URL = "http://localhost:8787";
    process.env.STUDIO_APP_URL = "https://studio.example.com";
    const t = [];
    const e = [];
    plug({ addShortcode() {}, addTransform: (n, f) => t.push([n, f]), on: (n) => e.push(n) });
    assert.equal(t.length, 1);
    assert.deepEqual(e, ["eleventy.after"]);
    const html = "<html><body><p>x</p></body></html>";
    const out = t[0][1].call({ page: { outputPath: "/x/index.html" } }, html);
    assert.equal(
      out,
      '<html><body><p>x</p><script src="/studio/overlay.js" defer data-studio data-api="http://localhost:8787" data-app="https://studio.example.com" data-content="/studio/content.json"></script></body></html>'
    );
    assert.equal(t[0][1].call({ page: { outputPath: "/x/a.xml" } }, html), html);
    assert.equal(t[0][1].call({ page: { outputPath: "/x/index.html" } }, "<p>no body</p>"), "<p>no body</p>");
    for (const bad of ["http://example.com", "javascript:alert(1)", 'https://a.com/"x', "//evil.com", "https://a.com:99999999x", "http://localhost.evil.com"]) {
      process.env.STUDIO_API_URL = bad;
      assert.throws(() => plug({ addShortcode() {}, addTransform() {}, on() {} }), /STUDIO_API_URL/, bad);
    }
    process.env.STUDIO_API_URL = "";
    process.env.STUDIO_APP_URL = "";
    const t2 = [];
    plug({ addShortcode() {}, addTransform: (n, f) => t2.push(f), on() {} });
    assert.ok(!/data-api|data-app/.test(t2[0].call({ page: { outputPath: "/a.html" } }, "<body></body>")));
  } finally {
    for (const [k, v] of [["CMS_EDIT", old.e], ["STUDIO_API_URL", old.a], ["STUDIO_APP_URL", old.p]]) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});
