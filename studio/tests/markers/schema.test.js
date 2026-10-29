"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { build, serialise } = require("../../schema/build-schema");
const R = require("../../schema/resolve");
const { readFiles } = require("../../markers/snapshot");

const ROOT = path.resolve(__dirname, "..", "..", "..");
const schema = JSON.parse(fs.readFileSync(path.join(ROOT, "studio", "schema", "studio-schema.json"), "utf8"));
const files = readFiles(ROOT);

test("the committed schema is exactly what cms/config.yml generates", () => {
  assert.equal(fs.readFileSync(path.join(ROOT, "studio", "schema", "studio-schema.json"), "utf8").replace(/\r\n/g, "\n"), serialise(build(ROOT)));
});

test("configSha256 hashes cms/config.yml with LF line ends", () => {
  const raw = fs.readFileSync(path.join(ROOT, "cms", "config.yml"), "utf8").replace(/\r\n/g, "\n");
  assert.equal(schema.configSha256, crypto.createHash("sha256").update(raw).digest("hex"));
});

test("every data file has a schema entry, and the pages share one schema", () => {
  for (const key of Object.keys(files)) {
    if (key.startsWith("pages:")) assert.ok(schema.pages && schema.pages.fields.length);
    else assert.ok(schema.files[key], key + " has no schema entry");
  }
  for (const [key, f] of Object.entries(schema.files)) assert.equal(f.path, "src/_data/" + key + ".json");
  assert.equal(schema.pages.folder, "src/pages");
  assert.equal(schema.pages.body.widget, "hidden");
  assert.deepEqual(schema.limits, { string: 20000, markdown: 60000, listItems: 200 });
});

test("rules that live in code are attached", () => {
  const find = (file, ...segs) => R.resolve(schema, file, segs, files[file].data).field;
  assert.equal(find("theme", "paper").x.rule, "color");
  assert.equal(find("problem", "sourceUrl").x.rule, "url");
  assert.equal(R.resolve(schema, "nav", ["items", "0", "url"], { items: [{ type: "link", url: "/x/" }] }).field.x.rule, "url");
  assert.equal(find("how", "story", "0", "src").x.rule, "image");
  assert.ok(["public-path", "bare-name"].includes(find("how", "story", "0", "src").x.imageStyle));
  assert.equal(R.resolve(schema, "redirects", ["items", "0", "fromLink"], { items: [{ fromLink: "/a/", toLink: "/b/" }] }).field.x.rule, "redirect-from");
  assert.equal(find("tokens", "text", "lead", "min").x.rule, "token");
  assert.equal(find("tokens", "text", "lead", "min").x.token.kind, "number");
  assert.equal(find("tokens", "fonts", "display").x.token.kind, "word");
  assert.deepEqual(find("tokens", "fonts", "display").x.token.words, ["motor", "openSauce"]);
  assert.equal(find("homepage", "sections").x.list.reorder, true);
  assert.deepEqual(find("homepage", "sections").x.list, { reorder: true, add: true, remove: true });
  const anchor = schema.pages.fields.find((f) => f.name === "sections").types.find((t) => t.name === "text").fields.find((f) => f.name === "anchor");
  assert.equal(anchor.x.rule, "anchor");
  assert.equal(schema.pages.fields.find((f) => f.name === "permalink").x.rule, "permalink");
});

test("reserved ids are the ones lib/reserved-ids.js reads from the templates", () => {
  const ids = require("../../../lib/reserved-ids").reservedIds(ROOT).sorted();
  assert.deepEqual(schema.reservedIds, ids);
  assert.ok(schema.reservedIds.includes("brands") && schema.reservedIds.includes("top"));
});

test("fields keep the config verbatim (hint, pattern, bounds, options)", () => {
  const f = R.resolve(schema, "hero", ["headlineMain"], files.hero.data).field;
  assert.equal(f.widget, "string");
  assert.equal(f.required, true);
  assert.equal(typeof f.label, "string");
  const motion = R.resolve(schema, "motion", ["speed"], files.motion.data).field;
  assert.equal(motion.widget, "select");
  assert.ok(motion.options.every((o) => "label" in o && "value" in o));
  const num = R.resolve(schema, "tokens", ["text", "baseSize"], files.tokens.data).field;
  assert.equal(num.valueType, "int");
  assert.equal(typeof num.min, "number");
  const email = R.resolve(schema, "site", ["contactEmail"], files.site.data).field;
  assert.ok(new RegExp(email.pattern.source).test("hello@example.com"));
  assert.ok(!new RegExp(email.pattern.source).test("not an email"));
});

// ---------------------------------------------------------------- resolver
test("resolve: objects, lists, typed lists, list items", () => {
  const home = files.homepage.data;
  const r = R.resolve(schema, "homepage", ["sections", "3"], home);
  assert.equal(r.indexInList, 3);
  assert.equal(r.list.name, "sections");
  assert.equal(r.itemType.name, home.sections[3].type);
  assert.equal(r.field.widget, "object");
  const en = R.resolve(schema, "homepage", ["sections", "3", "enabled"], home);
  assert.equal(en.field.widget, "boolean");
  assert.equal(en.parent.widget, "object");
  const item = R.resolve(schema, "how", ["story", "2"], files.how.data);
  assert.equal(item.indexInList, 2);
  assert.equal(item.itemType, null);
  assert.equal(R.resolve(schema, "how", ["story", "2", "title"], files.how.data).field.name, "title");
  const scalarItem = R.resolve(schema, "brands", ["chips", "1"], files.brands.data);
  assert.equal(scalarItem.field.widget, "string");
  assert.equal(scalarItem.indexInList, 1);
  const marquee = R.resolve(schema, "homepage", ["sections", "1", "items", "0"], home);
  assert.equal(marquee.field.widget, "string");
});

test("resolve: typed list items need the document, unknown things are null", () => {
  assert.equal(R.resolve(schema, "homepage", ["sections", "3"], undefined), null);
  assert.equal(R.resolve(schema, "homepage", ["sections", "999"], files.homepage.data), null);
  assert.equal(R.resolve(schema, "hero", ["nope"], files.hero.data), null);
  assert.equal(R.resolve(schema, "nope", ["x"], {}), null);
  assert.equal(R.resolve(schema, "hero", [], files.hero.data), null);
  assert.equal(R.resolve(schema, "hero", ["badge", "x"], files.hero.data), null, "no children below a string");
  assert.equal(R.resolve(schema, "how", ["story", "01"], files.how.data), null, "indexes are canonical decimals");
  assert.equal(R.resolve(schema, "how", ["story", "-"], files.how.data), null);
  assert.equal(R.resolve(schema, "how", ["story", "x"], files.how.data), null);
  assert.equal(R.resolve(schema, "pages:nope", ["title"], {}) === null, false, "any page file shares the page schema");
  assert.equal(R.resolve(schema, "hero", ["__proto__"], files.hero.data), null);
  assert.equal(R.resolve(schema, "hero", ["constructor"], files.hero.data), null);
  assert.equal(R.resolve(schema, "__proto__", ["x"], {}), null);
});

test("resolve: page front matter and the read-only body", () => {
  const about = files["pages:about"].data;
  assert.equal(R.resolve(schema, "pages:about", ["title"], about).field.widget, "string");
  const heading = R.resolve(schema, "pages:about", ["sections", "1", "heading"], about);
  assert.equal(heading.field.name, "heading");
  assert.equal(heading.parent.widget, "object");
  assert.equal(R.resolve(schema, "pages:about", ["sections", "0"], about).itemType.name, about.sections[0].type);
  assert.equal(R.resolve(schema, "pages:about", ["_body"], about).field.widget, "hidden");
  assert.equal(R.resolve(schema, "pages:about", ["_body", "x"], about), null);
  assert.equal(R.resolve(schema, "hero", ["_body"], files.hero.data), null);
});

test("every leaf of every current file resolves", () => {
  let n = 0;
  const walk = (key, v, segs, doc) => {
    if (v && typeof v === "object") {
      const keys = Array.isArray(v) ? v.map((_, i) => String(i)) : Object.keys(v);
      for (const k of keys) {
        if (!Array.isArray(v) && k === "type" && segs.length >= 2 && /^\d+$/.test(segs[segs.length - 1]) && key.indexOf("pages:") === 0 === false && false) continue;
        walk(key, v[k], segs.concat(k), doc);
      }
      return;
    }
    const last = segs[segs.length - 1];
    if (last === "type" && segs.length >= 3 && /^\d+$/.test(segs[segs.length - 2])) return; // the type key of a typed-list item is structure, not a field
    if (last === "_body") return;
    n += 1;
    assert.ok(R.resolve(schema, key, segs, doc), key + "." + segs.join("."));
  };
  for (const [key, f] of Object.entries(files)) walk(key, f.data, [], f.data);
  assert.ok(n > 600, "walked " + n);
});

test("labelFor gives plain-English breadcrumbs", () => {
  assert.equal(R.labelFor(schema, "hero", ["headlineMain"], files.hero.data), "Hero > Headline — main part");
  assert.equal(R.labelFor(schema, "how", ["story", "2", "title"], files.how.data), "How It Works > Story strip > Item 3 > Title");
  const l = R.labelFor(schema, "homepage", ["sections", "3", "enabled"], files.homepage.data);
  assert.match(l, /^Page layout .* > Homepage sections > .* 4 > Show this section$/);
  assert.match(R.labelFor(schema, "pages:about", ["sections", "1", "heading"], files["pages:about"].data), /^Pages > Page sections > Text section 2 > Heading$/);
  assert.equal(R.labelFor(schema, "pages:about", ["_body"], files["pages:about"].data), "Pages > Page text");
  assert.equal(R.labelFor(schema, "nope", ["x"], {}), "nope");
  assert.match(R.labelFor(schema, "hero", ["mystery"], files.hero.data), /mystery$/);
});

test("fieldsAt lists the children for generated forms", () => {
  assert.equal(R.fieldsAt(schema, "hero", [], files.hero.data).length, schema.files.hero.fields.length);
  assert.deepEqual(R.fieldsAt(schema, "how", ["story", "0"], files.how.data).map((f) => f.name), ["src", "title", "caption", "alt", "decorative"]);
  assert.deepEqual(R.fieldsAt(schema, "tokens", ["text", "lead"], files.tokens.data).map((f) => f.name), ["min", "fluid", "max"]);
  assert.deepEqual(R.fieldsAt(schema, "hero", ["badge"], files.hero.data), []);
  assert.ok(R.fieldsAt(schema, "homepage", ["sections", "1"], files.homepage.data).some((f) => f.name === "items"));
  assert.deepEqual(R.fieldsAt(schema, "nope", [], {}), []);
});

test("the sample content fixture is a consistent subset of the real data", () => {
  const sample = JSON.parse(fs.readFileSync(path.join(ROOT, "studio", "tests", "fixtures", "content.sample.json"), "utf8"));
  assert.equal(sample.schemaVersion, 1);
  for (const [k, f] of Object.entries(sample.files)) {
    assert.deepEqual(f, files[k], k + " drifted from the real data; regenerate the fixture");
  }
});
