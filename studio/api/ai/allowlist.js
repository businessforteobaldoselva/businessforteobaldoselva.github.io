"use strict";
// The AI allow-list (AI-DESIGN 8). DERIVED from studio-schema.json with the Phase 4 schema walker and the deny rules of
// policy.js; never hand-written. It answers one question for every op a model proposes: "may the AI write here?".
//
//   deriveAllowList(schema) -> AllowList
//   matchTarget(allow, file, pointer, doc, opts) -> { ok:true, target, template } | { ok:false, code }
//   snapshotLines(allow) -> sorted text lines (the committed snapshot the guard compares)
//
// A Target is { file, template, widget, rule, maxLen, ops, sensitive, modes }. file is a data file path or the
// pattern "src/pages/*.md". template is the schema path with numeric segments as `*` and typed list items as
// `*[typeName]` (so /sections/*[hero]/enabled and /sections/*[faq]/title are different targets).
// Pure, portable.

const policy = require("./policy");
const scope = require("../../validate/scope");
const P = require("../../validate/pointer");
const W = require("../../validate/walk");

const KEY = (file, template) => file + "\u0000" + template;
const fileKeyOf = (file) => (/^src\/pages\/[a-z0-9-]+\.md$/.test(file) ? policy.PAGES_FILE : file);

function maxLenOf(f) {
  const src = f.pattern && f.pattern.source;
  const m = src ? /\{0,(\d{1,6})\}\$$/.exec(src) : null;
  if (m) return Number(m[1]);
  return typeof f.max === "number" && (f.widget === "string" || f.widget === "text" || f.widget === "markdown") ? f.max : null;
}

function leafDenial(f, w) {
  const rule = f.x && f.x.rule;
  if (policy.DENIED_FIELD_NAMES.has(f.name)) return "field_name";
  if (w === "image" || w === "file" || rule === "image") return "image";
  if (policy.DENIED_RULES.has(rule)) return rule;
  if (!policy.ALLOWED_WIDGETS.has(w)) return w === "hidden" ? "hidden" : "widget";
  if (w === "number" && rule !== "token") return "number";
  if (w === "select" && !(Array.isArray(f.options) && f.options.length)) return "select";
  return null;
}

// can an item of these fields be built from allowed leaves alone? (every required field must be)
function buildable(fields) {
  return (fields || []).every((f) => {
    const w = W.widgetOf(f);
    if (f.required === false) return true;
    if (w === "object") return buildable(f.fields);
    if (w === "list") return !(typeof f.min === "number" && f.min > 0) || (!f.types && (f.fields ? buildable(f.fields) : f.field ? leafDenial(f.field, W.widgetOf(f.field)) === null : false));
    return leafDenial(f, w) === null;
  });
}

function deriveAllowList(schema) {
  const targets = [];
  const index = new Map(); // KEY(fileKey, template) -> { kind: "leaf"|"list"|"object"|"denied", target?, reason? }

  function visit(fields, tmpl, file) {
    for (const f of fields || []) {
      const w = W.widgetOf(f);
      const t = tmpl + "/" + f.name;
      if (policy.DENIED_FIELD_NAMES.has(f.name)) { index.set(KEY(file, t), { kind: "denied", reason: "field_name" }); continue; }
      if (w === "object") { index.set(KEY(file, t), { kind: "object" }); visit(f.fields, t, file); continue; }
      if (w === "list") { list(f, t, file); continue; }
      const why = leafDenial(f, w);
      if (why) { index.set(KEY(file, t), { kind: "denied", reason: why }); continue; }
      leaf(f, w, t, file, fields);
    }
  }

  function leaf(f, w, t, file, siblings) {
    const rule = (f.x && f.x.rule) || null;
    const sensitive = rule === "url" || policy.SENSITIVE_NAME_RE.test(f.name);
    const modes = policy.BASE_MODES.slice();
    const isAlt = (f.name === "alt" && (siblings || []).some((s) => W.widgetOf(s) === "image")) || (f.name === "shareImageAlt" && (siblings || []).some((s) => s.name === "shareImage"));
    if (isAlt) modes.push("alt_text");
    const isPage = file === policy.PAGES_FILE;
    if (policy.META_NAMES.has(f.name) || (isPage && policy.META_PAGE_NAMES.has(f.name))) modes.push("meta_description");
    const target = { file, template: t, widget: w, rule, maxLen: maxLenOf(f), ops: ["replace", "add"], sensitive, modes };
    targets.push(target);
    index.set(KEY(file, t), { kind: "leaf", target });
  }

  function list(f, t, file) {
    const typed = !!f.types;
    const lx = (f.x && f.x.list) || {};
    const listKey = (file === policy.PAGES_FILE ? "pages" : file.replace(/^src\/_data\/|\.json$/g, "")) + ":" + t;
    let ops = [];
    if (lx.remove !== false) ops.push("remove");
    if (!typed && lx.add !== false && (f.fields ? buildable(f.fields) : f.field ? leafDenial(f.field, W.widgetOf(f.field)) === null : false)) ops.push("add");
    if (lx.reorder !== false) ops.push("move");
    if (policy.LIST_OPS_OVERRIDE[listKey]) ops = ops.filter((o) => policy.LIST_OPS_OVERRIDE[listKey].indexOf(o) >= 0);
    const sensitive = /"rule":"url"/.test(JSON.stringify(f.fields || f.types || f.field || {})) || (f.fields || []).some((x) => policy.SENSITIVE_NAME_RE.test(x.name));
    const target = { file, template: t, widget: "list", rule: null, maxLen: null, ops, sensitive, modes: policy.BASE_MODES.slice(), typed, min: typeof f.min === "number" ? f.min : null, max: typeof f.max === "number" ? f.max : null };
    targets.push(target);
    index.set(KEY(file, t), { kind: "list", target });
    const item = t + "/*";
    if (typed) {
      for (const ty of f.types) {
        index.set(KEY(file, item + "[" + ty.name + "]"), { kind: "object" });
        visit(ty.fields, item + "[" + ty.name + "]", file);
      }
    } else if (f.fields) {
      index.set(KEY(file, item), { kind: "object", listItem: true });
      visit(f.fields, item, file);
    } else if (f.field) {
      const w = W.widgetOf(f.field);
      const ff = Object.assign({}, f.field, { name: f.field.name || "item" });
      const why = leafDenial(ff, w);
      if (why) index.set(KEY(file, item), { kind: "denied", reason: why, listItem: true });
      else leaf(ff, w, item, file, []);
    }
  }

  for (const [stem, f] of Object.entries((schema && schema.files) || {})) {
    if (policy.DENIED_FILE_STEMS.has(stem)) continue;
    if (!f.path || scope.classify(f.path) !== "data") continue;
    index.set(KEY(f.path, ""), { kind: "object" });
    visit(f.fields, "", f.path);
  }
  if (schema && schema.pages) {
    index.set(KEY(policy.PAGES_FILE, ""), { kind: "object" });
    visit(schema.pages.fields, "", policy.PAGES_FILE);
    // the page body is markdown text
    const body = { file: policy.PAGES_FILE, template: "/_body", widget: "markdown", rule: null, maxLen: null, ops: ["replace", "add"], sensitive: false, modes: policy.BASE_MODES.slice() };
    targets.push(body);
    index.set(KEY(policy.PAGES_FILE, "/_body"), { kind: "leaf", target: body });
  }
  targets.sort((a, b) => (a.file + a.template < b.file + b.template ? -1 : a.file + a.template > b.file + b.template ? 1 : 0));
  return { version: 1, targets, index, schema };
}

// the template of a concrete pointer, walking the schema beside the document: { template, node, value } | null (not in the schema)
function templateOf(allow, file, segs, doc) {
  const info = W.fileInfo(allow.schema, file);
  if (!info) return null;
  let node = W.rootNode(info);
  let val = doc;
  let tmpl = "";
  for (const s of segs) {
    const next = W.child(node, s, val);
    if (!next) return null;
    if (node.type === "list") tmpl += "/*" + (next.typeName ? "[" + next.typeName + "]" : "");
    else tmpl += "/" + s;
    node = next;
    if (Array.isArray(val)) val = val[Number(s)];
    else val = P.isPlainObject(val) && P.hasOwn(val, s) ? val[s] : undefined;
  }
  return { template: tmpl, node, value: val };
}

const lookup = (allow, file, template) => allow.index.get(KEY(fileKeyOf(file), template)) || null;

function parentList(allow, file, template) {
  const i = template.lastIndexOf("/*");
  if (i < 0) return null;
  return lookup(allow, file, template.slice(0, i));
}

// May `op` write at `pointer` of `file`?  `doc` = the current parsed document of that file (needed for typed lists);
// opts = { op, mode, filesSent }.  Never throws.
function matchTarget(allow, file, pointer, doc, opts) {
  const o = opts || {};
  const op = o.op || "replace";
  const bad = (code) => ({ ok: false, code });
  if (typeof file !== "string" || typeof pointer !== "string") return bad("path_outside_allowlist");
  const kind = scope.classify(file);
  if (kind !== "data" && kind !== "page") return bad("path_outside_allowlist");
  if (o.filesSent && !o.filesSent.has(file)) return bad("path_outside_allowlist");
  if (!allow.index.has(KEY(fileKeyOf(file), ""))) return bad(W.fileInfo(allow.schema, file) ? "forbidden_target" : "path_outside_allowlist");
  let segs;
  try { segs = P.parse(pointer); } catch (e) { return bad(/not allowed/.test(e.message) ? "proto_key" : "path_outside_allowlist"); }
  const append = segs[segs.length - 1] === "-";
  if (append && op !== "add") return bad("path_outside_allowlist");
  const lookSegs = append ? segs.slice(0, -1).concat("0") : segs;
  const t = templateOf(allow, file, lookSegs, doc);
  if (!t) return bad("path_outside_allowlist");
  const hit = lookup(allow, file, t.template);
  if (!hit) return bad("forbidden_target");
  const modeOk = (target) => !o.mode || target.modes.indexOf(o.mode) >= 0;

  if (op === "replace") {
    if (hit.kind !== "leaf" || hit.target.ops.indexOf("replace") < 0) return bad(hit.kind === "denied" ? "forbidden_target" : "bad_op_shape");
    return modeOk(hit.target) ? { ok: true, target: hit.target, template: t.template } : bad("path_outside_allowlist");
  }
  if (op === "add") {
    if (append || t.node.itemOf) {
      const pl = parentList(allow, file, t.template);
      if (!pl || pl.kind !== "list" || pl.target.ops.indexOf("add") < 0) return bad("forbidden_target");
      return modeOk(pl.target) ? { ok: true, target: pl.target, template: pl.target.template, list: true } : bad("path_outside_allowlist");
    }
    if (hit.kind !== "leaf" || hit.target.ops.indexOf("add") < 0) return bad(hit.kind === "denied" ? "forbidden_target" : "bad_op_shape");
    return modeOk(hit.target) ? { ok: true, target: hit.target, template: t.template } : bad("path_outside_allowlist");
  }
  // remove / move act on a list item
  if (!t.node.itemOf) return bad("forbidden_target");
  const pl = parentList(allow, file, t.template);
  if (!pl || pl.kind !== "list" || pl.target.ops.indexOf(op) < 0) return bad("forbidden_target");
  return modeOk(pl.target) ? { ok: true, target: pl.target, template: pl.target.template, list: true } : bad("path_outside_allowlist");
}

// Does the VALUE of an `add` fit the list's item shape, key by key, using only allowed leaves? -> null | violation code
function checkAddedValue(allow, file, listTemplate, value) {
  const walkV = (tmpl, v, depth) => {
    if (depth > 6) return "too_large";
    if (Array.isArray(v)) {
      for (const x of v) { const r = walkV(tmpl + "/*", x, depth + 1); if (r) return r; }
      return null;
    }
    if (P.isPlainObject(v)) {
      for (const k of Object.keys(v)) {
        if (P.FORBIDDEN_SEGS.has(k)) return "proto_key";
        const hit = lookup(allow, file, tmpl + "/" + k);
        if (!hit || hit.kind === "denied") return "forbidden_target";
        if (hit.kind === "leaf") { if (v[k] !== null && typeof v[k] === "object") return "bad_op_shape"; continue; }
        const r = walkV(tmpl + "/" + k, v[k], depth + 1);
        if (r) return r;
      }
      return null;
    }
    return null;
  };
  const itemT = listTemplate + "/*";
  const hit = lookup(allow, file, itemT);
  if (hit && hit.kind === "leaf") return value !== null && typeof value === "object" ? "bad_op_shape" : null;
  if (!hit || hit.kind !== "object") return "forbidden_target";
  if (!P.isPlainObject(value)) return "bad_op_shape";
  return walkV(itemT, value, 0);
}

function snapshotLines(allow) {
  return allow.targets.map((t) => [t.file, t.template, t.widget, t.rule || "-", t.ops.join("+"), t.sensitive ? "sensitive" : "-", t.modes.join("+")].join(" "));
}

module.exports = { deriveAllowList, matchTarget, checkAddedValue, templateOf, lookup, snapshotLines, fileKeyOf, KEY, buildable, leafDenial, maxLenOf };
