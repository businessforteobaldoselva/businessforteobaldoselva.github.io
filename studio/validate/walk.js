"use strict";
// Navigation of studio-schema.json (DESIGN section 4) by JSON-pointer segments, side by side with a document.
// Same semantics as studio/schema/resolve.js (unit A); kept here so the API has no dependency on that file.
// Pure, portable.

const { hasOwn, isPlainObject, isIndex } = require("./pointer");

const widgetOf = (f) => (f && f.widget) || "string";

function fileInfo(schema, path) {
  let m = /^src\/_data\/([a-z0-9-]+)\.json$/.exec(path);
  if (m) {
    const f = schema.files && hasOwn(schema.files, m[1]) ? schema.files[m[1]] : null;
    if (!f || f.path !== path) return null;
    return { key: m[1], path, kind: "data", label: f.label, fields: f.fields || [], body: null };
  }
  m = /^src\/pages\/([a-z0-9-]+)\.md$/.exec(path);
  if (m && schema.pages) return { key: "pages:" + m[1], path, kind: "page", label: 'Page "' + m[1] + '"', fields: schema.pages.fields || [], body: schema.pages.body || null };
  return null;
}

function nodeOfField(f) {
  const w = widgetOf(f);
  if (w === "object") return { type: "object", fields: f.fields || [], field: f };
  if (w === "list") return { type: "list", field: f };
  return { type: "leaf", field: f };
}

function rootNode(info) {
  return { type: "object", fields: info.fields, root: true, info, field: { name: "", label: info.label, widget: "object" } };
}

// The node an item of a list has, given the item's value (needed to pick the type of a typed list).
function itemNode(listField, value) {
  if (listField.types) {
    const key = listField.typeKey || "type";
    const name = isPlainObject(value) ? value[key] : undefined;
    const t = (listField.types || []).find((x) => x.name === name);
    if (!t) return null;
    return { type: "object", fields: t.fields || [], typeKey: key, typeName: t.name, field: { name: t.name, label: t.label, widget: "object" }, itemOf: listField };
  }
  if (listField.fields) return { type: "object", fields: listField.fields, field: listField, itemOf: listField };
  if (listField.field) return Object.assign({ itemOf: listField }, nodeOfField(listField.field));
  return null;
}

// child of `node` under `seg`; `value` is the document value AT `node` (used for typed lists). null = not in the schema.
function child(node, seg, value) {
  if (node.type === "object") {
    if (node.typeKey && seg === node.typeKey) return { type: "leaf", field: { name: node.typeKey, label: "Type", widget: "hidden" }, isTypeKey: true };
    if (node.root && node.info && node.info.kind === "page" && seg === "_body") return node.info.body ? nodeOfField(Object.assign({ name: "_body" }, node.info.body)) : null;
    const f = node.fields.find((x) => x.name === seg);
    return f ? nodeOfField(f) : null;
  }
  if (node.type === "list") {
    if (!isIndex(seg)) return null;
    const idx = Number(seg);
    const items = Array.isArray(value) ? value : [];
    return itemNode(node.field, items[idx]);
  }
  return null;
}

// resolve(schema, path, segs, doc) -> node | null.  doc = the parsed file (page: front matter + _body).
function resolve(schema, path, segs, doc) {
  const info = fileInfo(schema, path);
  if (!info) return null;
  let node = rootNode(info);
  let val = doc;
  for (const s of segs) {
    const next = child(node, s, val);
    if (!next) return null;
    node = next;
    if (Array.isArray(val)) val = val[Number(s)];
    else val = isPlainObject(val) && hasOwn(val, s) ? val[s] : undefined;
  }
  return node;
}

// "Our story" from "\ud83d\udcd6 Our story (the homepage block)"
function cleanLabel(l) {
  const s = String(l == null ? "" : l).replace(/^[^\p{L}\p{N}]+/u, "").replace(/\s*[(\u2014\u2013].*$/u, "").replace(/[:\s]+$/, "").trim();
  return s || String(l || "").trim();
}

// "Hero > Headline": a plain-English breadcrumb for PR text, the Changes panel and History.
function labelFor(schema, path, segs, doc) {
  const info = fileInfo(schema, path);
  if (!info) return path;
  const parts = [cleanLabel(info.label)];
  let node = rootNode(info);
  let val = doc;
  for (const s of segs) {
    const next = child(node, s, val);
    if (!next) { parts.push(s); break; }
    if (node.type === "list") {
      const lf = node.field;
      const singular = lf.label_singular || lf.labelSingular || "item";
      const typeLabel = next.typeName && next.field && next.field.label ? cleanLabel(next.field.label) : cleanLabel(singular);
      parts.push(typeLabel + " " + (Number(s) + 1));
    } else if (next.field && next.field.label) parts.push(cleanLabel(next.field.label));
    else parts.push(s);
    node = next;
    if (Array.isArray(val)) val = val[Number(s)];
    else val = isPlainObject(val) && hasOwn(val, s) ? val[s] : undefined;
  }
  // list label then the list itself would read "Page sections > Section 3"; fine
  return parts.join(" > ");
}

module.exports = { widgetOf, fileInfo, rootNode, nodeOfField, itemNode, child, resolve, labelFor, cleanLabel };
