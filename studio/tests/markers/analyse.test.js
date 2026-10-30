"use strict";
// The marker checks themselves: each kind of lie must be caught, honest markers must pass.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const A = require("../../markers/analyse");
const { parityProblems, passthroughOf, TAG_RE, ATTR_RE } = require("../../guards/check-markers");

const ROOT = path.resolve(__dirname, "..", "..", "..");
const schema = JSON.parse(fs.readFileSync(path.join(ROOT, "studio", "schema", "studio-schema.json"), "utf8"));
const content = JSON.parse(fs.readFileSync(path.join(ROOT, "studio", "tests", "fixtures", "content.sample.json"), "utf8"));
const safeUrl = (v) => (/^(\/(?!\/)|#|https?:|mailto:)/i.test(String(v)) ? v : "/");
const hero = content.files.hero.data;

function one(html) {
  const { markers } = A.markersOf(html);
  assert.equal(markers.length, 1);
  return markers[0];
}
const truth = (html) => A.truthProblems(content, one(html), safeUrl, { themeVars: { "--paper": "paper" } });
const shape = (html) => A.resolveProblems(schema, content, one(html));

test("an honest text marker passes; other text, other value, missing value fail", () => {
  assert.deepEqual(truth('<h1 data-cms="hero.headlineMain" data-cms-kind="text">' + hero.headlineMain + ' <span class="x">accent</span></h1>'), []);
  assert.equal(truth('<h1 data-cms="hero.headlineMain" data-cms-kind="text">Something else</h1>').length, 1);
  assert.equal(truth('<h1 data-cms="hero.nonsense" data-cms-kind="text">x</h1>').length, 1);
  assert.equal(truth('<h1 data-cms="nofile.x" data-cms-kind="text">x</h1>').length, 1);
});

test("br tags and whitespace do not matter for titles", () => {
  const c = { files: { t: { data: { title: "Line one<br />Line two" } } } };
  const m = one('<h2 data-cms="t.title" data-cms-kind="text">Line one<br />Line two</h2>');
  assert.deepEqual(A.truthProblems(c, m, safeUrl), []);
  const m2 = one('<h2 data-cms="t.title" data-cms-kind="text">Line one<br> Line  two</h2>');
  assert.deepEqual(A.truthProblems(c, m2, safeUrl), []);
});

test("markdown markers compare the rendered text", () => {
  const c = { files: { t: { data: { body: "Hello *there*\n\nSecond" } } } };
  assert.deepEqual(A.truthProblems(c, one('<div data-cms="t.body" data-cms-kind="markdown"><p>Hello <em>there</em></p><p>Second</p></div>'), safeUrl), []);
  assert.equal(A.truthProblems(c, one('<div data-cms="t.body" data-cms-kind="markdown"><p>Other</p></div>'), safeUrl).length, 1);
});

test("image markers: the picture file must be the one named, alt text and decorative flag must agree", () => {
  const c = { files: { t: { data: { src: "/images/story-1-spot.jpg", alt: "A spot", decorative: false } } } };
  const ok = '<picture><source srcset="/img/story-1-spot-abc1234567-480.webp"><img src="/img/story-1-spot-abc1234567-480.jpeg" alt="A spot" data-cms="t.src" data-cms-kind="image" data-cms-alt="t.alt" data-cms-decorative="t.decorative"></picture>';
  assert.deepEqual(A.truthProblems(c, one(ok), safeUrl), []);
  assert.equal(A.truthProblems(c, one(ok.replace(/story-1-spot/g, "other")), safeUrl).length, 1);
  assert.equal(A.truthProblems(c, one(ok.replace('alt="A spot"', 'alt="Different"')), safeUrl).length, 1);
  c.files.t.data.decorative = true;
  assert.equal(A.truthProblems(c, one(ok), safeUrl).length, 1, "decorative picture must have empty alt");
  assert.deepEqual(A.truthProblems(c, one(ok.replace('alt="A spot"', 'alt=""')), safeUrl), []);
  assert.equal(A.truthProblems(c, one('<p data-cms="t.src" data-cms-kind="image">x</p>'), safeUrl).length, 1, "no picture inside");
});

test("link markers: the address on the page is safeUrl(value)", () => {
  const c = { files: { t: { data: { label: "Go", url: "javascript:alert(1)", ok: "/about/" } } } };
  assert.deepEqual(A.truthProblems(c, one('<a href="/about/" data-cms="t.label" data-cms-kind="text" data-cms-href="t.ok">Go</a>'), safeUrl), []);
  assert.equal(A.truthProblems(c, one('<a href="javascript:alert(1)" data-cms="t.label" data-cms-kind="text" data-cms-href="t.url">Go</a>'), safeUrl).length, 1);
  assert.deepEqual(A.truthProblems(c, one('<a href="/" data-cms="t.label" data-cms-kind="text" data-cms-href="t.url">Go</a>'), safeUrl), []);
  assert.equal(A.truthProblems(c, one('<span data-cms="t.label" data-cms-kind="text" data-cms-href="t.ok">Go</span>'), safeUrl).length, 1, "needs an enclosing link");
});

test("colour and switch markers", () => {
  const html = (ref, extra) => '<body data-cms="' + ref + '" data-cms-kind="color"' + (extra || "") + "></body>";
  assert.deepEqual(truth(html("theme.paper", ' data-cms-cssvar="--paper"')), []);
  assert.equal(truth(html("theme.paper", ' data-cms-cssvar="--ink"')).length, 1, "wrong custom property");
  assert.equal(truth(html("theme.ink", ' data-cms-cssvar="--paper"')).length, 1);
  const bad = { files: { theme: { data: { paper: "red;}" } } } };
  assert.equal(A.truthProblems(bad, one(html("theme.paper")), safeUrl).length, 1, "not a hex colour");
  const sw = { files: { motion: { data: { marquee: "yes" } } } };
  assert.equal(A.truthProblems(sw, one('<i data-cms="motion.marquee" data-cms-kind="toggle"></i>'), safeUrl).length, 1);
  assert.deepEqual(A.truthProblems({ files: { motion: { data: {} } } }, one('<i data-cms="motion.marquee" data-cms-kind="toggle"></i>'), safeUrl), [], "unset switch = default");
});

test("resolveProblems: field must exist and the kind must fit the widget", () => {
  assert.deepEqual(shape('<h1 data-cms="hero.headlineMain" data-cms-kind="text"></h1>'), []);
  assert.equal(shape('<h1 data-cms="hero.subhead" data-cms-kind="text"></h1>').length, 1, "text widget needs longtext");
  assert.equal(shape('<h1 data-cms="hero.headlineMain" data-cms-kind="longtext"></h1>').length, 1);
  assert.equal(shape('<h1 data-cms="hero.invented" data-cms-kind="text"></h1>').length, 1);
  assert.equal(shape('<h1 data-cms="hero.headlineMain" data-cms-kind="image"></h1>').length, 1);
  assert.equal(shape('<h1 data-cms="hero.headlineMain" data-cms-kind="weird"></h1>').length, 1);
  assert.deepEqual(shape('<section data-cms="homepage.sections.3" data-cms-kind="section"></section>'), []);
  assert.equal(shape('<section data-cms="how.story.1" data-cms-kind="section"></section>').length, 1, "section is a homepage section");
  assert.deepEqual(shape('<figure data-cms="how.story.1" data-cms-kind="item"></figure>'), []);
  assert.equal(shape('<p data-cms="hero.badge" data-cms-kind="item"></p>').length, 1, "item needs a list item");
  assert.equal(shape('<img data-cms="how.story.1.src" data-cms-kind="image" data-cms-alt="how.story.1.decorative">').length, 1, "alt must be text");
  assert.equal(shape('<img data-cms="how.story.1.src" data-cms-kind="image" data-cms-decorative="how.story.1.alt">').length, 1, "decorative must be a switch");
  assert.equal(shape('<a data-cms="nav.skipLink" data-cms-kind="text" data-cms-href="hero.badge"></a>').length, 1, "href must be a link field");
  assert.deepEqual(shape('<a data-cms="problem.sourceText" data-cms-kind="text" data-cms-href="problem.sourceUrl"></a>'), []);
  assert.equal(shape('<i data-cms="theme.paper" data-cms-kind="color" data-cms-cssvar="paper"></i>').length, 1);
});

test("themeVarsOf reads the custom properties of theme-vars.njk", () => {
  const vars = A.themeVarsOf(fs.readFileSync(path.join(ROOT, "src", "_includes", "theme-vars.njk"), "utf8"));
  assert.equal(vars["--paper"], "paper");
  assert.equal(vars["--ink-deep"], "inkDeep");
  assert.equal(vars["--red"], "accent");
});

// ---------------------------------------------------------------- parity
function tmpSite(files) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "studio-parity-"));
  for (const [f, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true });
    fs.writeFileSync(path.join(d, f), text);
  }
  return d;
}
const TAG = '<script src="/studio/overlay.js" defer data-studio data-content="/studio/content.json"></script>';

test("parity: edit build = normal build + data-cms attributes + one overlay tag + two files", () => {
  const normal = tmpSite({ "index.html": "<html><body><h1 id=\"a\">Hi</h1></body></html>", "a.css": "x{}" });
  const edit = tmpSite({
    "index.html": "<html><body><h1 id=\"a\" data-cms=\"hero.badge\" data-cms-kind=\"text\">Hi</h1>" + TAG + "</body></html>",
    "a.css": "x{}",
    "studio/overlay.js": "//",
    "studio/content.json": "{}",
  });
  try {
    assert.deepEqual(parityProblems(normal, edit).probs, []);
    // a marker that changes the page
    fs.writeFileSync(path.join(edit, "index.html"), "<html><body><h1 id=\"a\" class=\"x\" data-cms=\"hero.badge\" data-cms-kind=\"text\">Hi</h1>" + TAG + "</body></html>");
    assert.match(parityProblems(normal, edit).probs.join("\n"), /index\.html: differs/);
    // a missing overlay tag
    fs.writeFileSync(path.join(edit, "index.html"), "<html><body><h1 id=\"a\">Hi</h1></body></html>");
    assert.match(parityProblems(normal, edit).probs.join("\n"), /expected exactly one overlay/);
    // two overlay tags
    fs.writeFileSync(path.join(edit, "index.html"), "<html><body><h1 id=\"a\">Hi</h1>" + TAG + TAG + "</body></html>");
    assert.match(parityProblems(normal, edit).probs.join("\n"), /found 2/);
    // a changed non-html file
    fs.writeFileSync(path.join(edit, "index.html"), "<html><body><h1 id=\"a\">Hi</h1>" + TAG + "</body></html>");
    fs.writeFileSync(path.join(edit, "a.css"), "x{color:red}");
    assert.match(parityProblems(normal, edit).probs.join("\n"), /a\.css: differs/);
    fs.writeFileSync(path.join(edit, "a.css"), "x{}");
    // an extra file
    fs.writeFileSync(path.join(edit, "extra.txt"), "x");
    assert.match(parityProblems(normal, edit).probs.join("\n"), /must add exactly/);
  } finally {
    fs.rmSync(normal, { recursive: true, force: true });
    fs.rmSync(edit, { recursive: true, force: true });
  }
});

test("parity: a normal build must contain no marker and no studio/ path", () => {
  const normal = tmpSite({ "index.html": '<body><h1 data-cms="a.b">x</h1></body>', "studio/overlay.js": "//" });
  const edit = tmpSite({ "index.html": '<body><h1 data-cms="a.b">x</h1>' + TAG + "</body>", "studio/overlay.js": "//", "studio/content.json": "{}" });
  try {
    const text = parityProblems(normal, edit).probs.join("\n");
    assert.match(text, /no data-cms attribute/);
    assert.match(text, /no studio\/ path/);
  } finally {
    fs.rmSync(normal, { recursive: true, force: true });
    fs.rmSync(edit, { recursive: true, force: true });
  }
});

test("the strip patterns remove only what the contract allows", () => {
  const s = '<p a="1" data-cms="x.y" data-cms-kind="text" data-cms-alt="x.z" data-cms-cssvar="--a" class="c">t</p>' + TAG;
  assert.equal(s.replace(TAG_RE, "").replace(ATTR_RE, ""), '<p a="1" class="c">t</p>');
  assert.equal('<p data-other="1">'.replace(ATTR_RE, ""), '<p data-other="1">');
});

test("the passthrough folders are read from .eleventy.js", () => {
  const list = passthroughOf(ROOT);
  assert.ok(list.includes("admin") && list.includes("cms") && list.includes("images"));
});
