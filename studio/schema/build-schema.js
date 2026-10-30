#!/usr/bin/env node
"use strict";
// cms/config.yml -> studio/schema/studio-schema.json  (DESIGN.md section 4)
//
//   node studio/schema/build-schema.js            write the file
//   node studio/schema/build-schema.js --check    fail unless the committed file equals a fresh generation
//   node studio/schema/build-schema.js --stdout   print instead of writing
//   (all accept --root <repo>)
//
// Deterministic: config order, 2-space JSON, LF, no timestamps. Nothing is invented except `x`, the rules that
// live in code (links, anchors, colours, tokens, redirects, permalinks, images).

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT_DEFAULT = path.resolve(__dirname, "..", "..");

// The standard link pattern of the CMS ("Button link" fields). lib/rules.js (unit B) exports the same string as
// LINK_PATTERN_SOURCE; studio/guards/check-schema.js compares them once that file exists.
const { LINK_PATTERN_SOURCE } = require("../../lib/rules"); // single source of truth, shared with the API validator
const LIMITS = { string: 20000, markdown: 60000, listItems: 200 };
const FILE_PATH_RE = /^src\/_data\/([a-z][a-z0-9-]*)\.json$/;

const clean = (o) => {
  for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
  return o;
};

function load(root) {
  // the guard libraries come from the checkout this file lives in (a throwaway workspace has no scripts/ folder); the data from `root`
  const cmsconfig = require(path.join(__dirname, "..", "..", "scripts", "lib", "cmsconfig"));
  const cfg = cmsconfig.loadConfig(root);
  const raw = fs.readFileSync(path.join(root, "cms", "config.yml"), "utf8").replace(/\r\n/g, "\n");
  return { cmsconfig, cfg, sha: crypto.createHash("sha256").update(raw).digest("hex") };
}

function xFor(f, widget, ctx, tokenSpecs) {
  const name = f.name;
  const x = {};
  const pat = Array.isArray(f.pattern) ? f.pattern[0] : null;
  if (widget === "color") x.rule = "color";
  else if (widget === "image") {
    x.rule = "image";
    x.imageStyle = pat && /^\^\//.test(pat) ? "public-path" : "bare-name";
  } else if (ctx.file === "tokens" && ctx.tokenKey && tokenSpecs[ctx.tokenKey]) {
    x.rule = "token";
    const s = tokenSpecs[ctx.tokenKey];
    x.token = s.options ? { kind: "word", words: s.options.slice() } : { kind: "number", min: s.min, max: s.max, step: s.step };
  } else if (ctx.file === "redirects" && name === "fromLink") x.rule = "redirect-from";
  else if (ctx.file === "redirects" && name === "toLink") x.rule = "redirect-to";
  else if (ctx.file === "pages" && ctx.depth === 0 && name === "permalink") x.rule = "permalink";
  else if (name === "anchor" && pat && pat.indexOf("(?!(?:") >= 0) x.rule = "anchor";
  else if (pat === LINK_PATTERN_SOURCE) x.rule = "url";
  if (widget === "list") x.list = { reorder: true, add: f.allow_add !== false, remove: true };
  return Object.keys(x).length ? x : undefined;
}

function field(f, ctx, tokenSpecs) {
  const widget = f.widget || "string";
  const here = Object.assign({}, ctx);
  if (ctx.file === "tokens") here.tokenKey = ctx.tokenKey === undefined ? f.name : ctx.tokenKey + "." + f.name;
  const out = {
    name: f.name,
    label: f.label,
    hint: f.hint,
    widget,
    required: f.required === false ? false : true,
    default: f.default === undefined ? null : f.default,
  };
  if (Array.isArray(f.pattern)) {
    out.pattern = { source: String(f.pattern[0]), message: f.pattern[1] === undefined ? undefined : String(f.pattern[1]) };
    clean(out.pattern);
  }
  if (f.min !== undefined) out.min = f.min;
  if (f.max !== undefined) out.max = f.max;
  if (widget === "number") {
    if (f.value_type !== undefined) out.valueType = f.value_type === "int" ? "int" : "float";
    if (f.step !== undefined) out.step = f.step;
  }
  if (Array.isArray(f.options)) {
    out.options = f.options.map((o) => (o && typeof o === "object" ? { label: o.label, value: o.value } : { label: String(o), value: o }));
    out.multiple = f.multiple === true;
  }
  const child = Object.assign({}, here, { depth: (ctx.depth || 0) + 1 });
  if (Array.isArray(f.fields)) out.fields = f.fields.map((c) => field(c, child, tokenSpecs));
  if (f.field) out.field = field(f.field, child, tokenSpecs);
  if (Array.isArray(f.types)) {
    out.types = f.types.map((t) => ({ name: t.name, label: t.label, fields: (t.fields || []).map((c) => field(c, child, tokenSpecs)) }));
    out.typeKey = f.typeKey || "type";
  }
  const x = xFor(f, widget, here, tokenSpecs);
  if (x) out.x = x;
  return clean(out);
}

function build(root) {
  const { cmsconfig, cfg, sha } = load(root);
  const tokenSpecs = require(path.join(root, "lib", "tokens")).fieldSpecs();
  const reserved = require(path.join(root, "lib", "reserved-ids")).reservedIds(root).sorted(); // lower-case ids, as the CMS anchor patterns list them
  const schema = { schemaVersion: 1, configSha256: sha, reservedIds: reserved, files: {}, pages: null, limits: LIMITS };
  for (const e of cmsconfig.contentCollections(cfg)) {
    const coll = cfg.collections.find((c) => c.name === e.collection);
    if (e.kind === "file") {
      const m = FILE_PATH_RE.exec(e.file);
      if (!m) throw new Error("studio schema: unsupported content file " + e.file);
      if (m[1] !== e.name) throw new Error("studio schema: entry name '" + e.name + "' differs from file stem '" + m[1] + "' (refs use the stem)");
      const ctx = { file: e.name, depth: 0 };
      schema.files[e.name] = clean({
        path: e.file,
        kind: "data",
        label: (coll.files.find((x) => x.name === e.name) || {}).label,
        collection: e.collection,
        fields: e.fields.map((f) => field(f, ctx, tokenSpecs)),
      });
    } else if (e.folder === "src/pages") {
      const ctx = { file: "pages", depth: 0 };
      schema.pages = clean({
        folder: "src/pages",
        label: coll.label,
        fields: e.fields.map((f) => field(f, ctx, tokenSpecs)),
        // The CMS has no body field for pages and page.njk never renders one, so the body is declared
        // read-only (hidden widget): it exists in the file but may only be re-sent unchanged.
        body: { name: "_body", label: "Page body (not editable in the CMS)", widget: "hidden", required: false, default: null },
      });
    }
  }
  if (!schema.pages) throw new Error("studio schema: the pages folder collection (src/pages) is missing from cms/config.yml");
  const bad = (fields, where) => {
    for (const f of fields) {
      if (/^_/.test(f.name)) throw new Error("studio schema: field names starting with '_' are reserved (" + where + "." + f.name + ")");
      if (!/^[A-Za-z0-9_-]+$/.test(f.name)) throw new Error("studio schema: field name '" + f.name + "' is not a valid reference segment (" + where + ")");
      bad(f.fields || [], where + "." + f.name);
      if (f.field) bad([f.field], where + "." + f.name);
      for (const t of f.types || []) bad(t.fields, where + "." + f.name + "<" + t.name + ">");
    }
  };
  for (const [k, f] of Object.entries(schema.files)) bad(f.fields, k);
  bad(schema.pages.fields, "pages");
  return schema;
}

const serialise = (schema) => JSON.stringify(schema, null, 2) + "\n";

if (require.main === module) {
  const argv = process.argv.slice(2);
  const ri = argv.indexOf("--root");
  const root = ri >= 0 ? path.resolve(argv[ri + 1]) : ROOT_DEFAULT;
  const target = path.join(root, "studio", "schema", "studio-schema.json");
  let text;
  try {
    text = serialise(build(root));
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  if (argv.includes("--stdout")) process.stdout.write(text);
  else if (argv.includes("--check")) {
    const have = fs.existsSync(target) ? fs.readFileSync(target, "utf8").replace(/\r\n/g, "\n") : null;
    if (have !== text) {
      console.error("studio-schema.json is " + (have === null ? "missing" : "out of date") + ". Run: npm run studio:schema");
      process.exit(1);
    }
    console.log("studio-schema.json is up to date");
  } else {
    fs.writeFileSync(target, text);
    console.log("wrote " + path.relative(root, target) + " (" + text.length + " bytes)");
  }
}

module.exports = { build, serialise, LINK_PATTERN_SOURCE, LIMITS };
