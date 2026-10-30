"use strict";
// TEST HELPER (Node only). Builds a studio-schema.json-shaped object (DESIGN section 4) straight from cms/config.yml.
// Unit A owns the real generator (studio/schema/build-schema.js -> studio-schema.json, committed). This helper lets
// the API tests and guards run before A is merged, and `loadSchema()` prefers A's committed file as soon as it exists.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { loadConfig } = require("../../../scripts/lib/cmsconfig");
const tokens = require("../../../lib/tokens");
const { LINK_PATTERN_SOURCE } = require("../../../lib/rules");

const ROOT = path.resolve(__dirname, "..", "..", "..");

function conv(f, ctx) {
  const widget = f.widget || "string";
  const o = { name: f.name, label: f.label || f.name };
  if (f.hint) o.hint = f.hint;
  o.widget = widget;
  o.required = f.required !== false;
  o.default = f.default === undefined ? null : f.default;
  if (Array.isArray(f.pattern)) o.pattern = { source: f.pattern[0], message: f.pattern[1] };
  if (f.min !== undefined) o.min = f.min;
  if (f.max !== undefined) o.max = f.max;
  if (f.value_type) o.valueType = f.value_type;
  if (f.label_singular) o.label_singular = f.label_singular;
  if (Array.isArray(f.options)) o.options = f.options.map((x) => (x && typeof x === "object" ? { label: x.label, value: x.value } : { label: String(x), value: x }));
  if (f.multiple) o.multiple = true;
  const here = ctx.path.concat(f.name);
  const sub = (x) => conv(x, { file: ctx.file, path: here });
  if (f.fields) o.fields = f.fields.map(sub);
  if (f.field) o.field = conv(f.field, { file: ctx.file, path: here });
  if (f.types) { o.types = f.types.map((t) => ({ name: t.name, label: t.label, fields: (t.fields || []).map((x) => conv(x, { file: ctx.file, path: here })) })); o.typeKey = f.typeKey || "type"; }
  const x = {};
  const src = o.pattern && o.pattern.source;
  if (src === LINK_PATTERN_SOURCE) x.rule = "url";
  else if (f.name === "anchor" && src) x.rule = "anchor";
  else if (widget === "color") x.rule = "color";
  else if (ctx.file === "tokens" && widget !== "object") {
    x.rule = "token";
    const spec = tokens.fieldSpecs()[here.join(".")];
    if (spec && spec.options) x.token = { kind: "word", words: spec.options };
    else if (spec) x.token = { kind: "number", min: spec.min, max: spec.max, step: spec.step };
  } else if (ctx.file === "redirects" && f.name === "fromLink") x.rule = "redirect-from";
  else if (ctx.file === "redirects" && f.name === "toLink") x.rule = "redirect-to";
  else if (ctx.file === "pages" && f.name === "permalink") x.rule = "permalink";
  else if (widget === "image") { x.rule = "image"; x.imageStyle = src && /^\^\[A-Za-z0-9\._-\]\+\\./.test(src) ? "bare-name" : "public-path"; }
  if (Object.keys(x).length) o.x = x;
  return o;
}

function build(root) {
  const cfg = loadConfig(root || ROOT);
  const files = {};
  let pages = null;
  for (const col of cfg.collections) {
    if (col.files) {
      for (const e of col.files) files[e.name] = { path: e.file, kind: "data", label: e.label, collection: col.name, fields: e.fields.map((f) => conv(f, { file: e.name, path: [] })) };
    } else if (col.folder === "src/pages") {
      const fields = col.fields.map((f) => conv(f, { file: "pages", path: [] }));
      pages = { folder: "src/pages", label: col.label, fields: fields.filter((f) => f.name !== "body"), body: { name: "_body", label: "Page text", widget: "markdown", required: false, default: null } };
    }
  }
  const text = fs.readFileSync(path.join(root || ROOT, "cms", "config.yml"), "utf8").replace(/\r\n/g, "\n");
  return { schemaVersion: 1, configSha256: crypto.createHash("sha256").update(text).digest("hex"), reservedIds: [], files, pages, limits: { string: 20000, markdown: 60000, listItems: 200 } };
}

// Unit A's committed schema when present, else the helper's own.
function loadSchema(root) {
  const p = path.join(root || ROOT, "studio", "schema", "studio-schema.json");
  if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf8"));
  return build(root);
}

module.exports = { build, loadSchema, ROOT };
