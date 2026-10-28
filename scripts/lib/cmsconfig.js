"use strict";
// Reading cms/config.yml and walking it side by side with data.

const path = require("path");
const yaml = require("js-yaml");
const { readText } = require("./util");

const KNOWN_WIDGETS = new Set([
  "string", "text", "markdown", "image", "file", "boolean", "select", "number", "list", "object",
  "hidden", "datetime", "color", "map", "code", "relation", "uuid",
]);
// Widgets whose value is free text an editor types.
const TEXT_WIDGETS = new Set(["string", "text", "markdown"]);

function loadConfig(root) {
  const file = path.join(root, "cms", "config.yml");
  return yaml.load(readText(file)); // js-yaml throws on duplicate keys / bad syntax
}

const widgetOf = (f) => (f && f.widget) || "string";

// Collections that edit repository content under src/:
//  - files collection: one entry per data file { collection, name, file, fields, kind: "file" }
//  - folder collection under src/: one entry { collection, name, folder, fields, kind: "folder" }
function contentCollections(cfg) {
  const out = [];
  for (const c of cfg.collections || []) {
    if (c.files) {
      for (const e of c.files) out.push({ collection: c.name, name: e.name, file: e.file, fields: e.fields || [], kind: "file" });
    } else if (c.folder && /^src\//.test(c.folder)) {
      out.push({ collection: c.name, name: c.name, folder: c.folder.replace(/\/$/, ""), fields: c.fields || [], kind: "folder" });
    }
  }
  return out;
}

// Child definitions an item of a list takes.
function listItemFields(field, item) {
  if (field.types) {
    const key = field.typeKey || "type";
    const t = (field.types || []).find((x) => x.name === (item && item[key]));
    return t ? { fields: t.fields || [], typeKey: key, typeName: t.name } : { missingType: item && item[key], typeKey: key };
  }
  if (field.fields) return { fields: field.fields };
  if (field.field) return { single: field.field };
  return null;
}

// Walk `value` (an object) alongside `fields` (config). visit(event) is called for every data node:
//   { path, value, field, key, problem?, listItem?, typeName? }
//   problem: "no-field" | "hidden" | "type-mismatch" | "missing-type"
function alignData(value, fields, basePath, visit) {
  const byName = new Map();
  for (const f of fields || []) byName.set(f.name, f);
  for (const k of Object.keys(value || {})) alignNode(value[k], byName.get(k), basePath.concat(k), visit, k);
}

function alignNode(val, field, p, visit, keyName) {
  if (!field) {
    visit({ path: p, value: val, field: null, problem: "no-field", key: keyName });
    return;
  }
  const w = widgetOf(field);
  if (w === "hidden") {
    visit({ path: p, value: val, field, problem: "hidden", key: keyName });
    return;
  }
  if (Array.isArray(val)) {
    if (w !== "list") {
      visit({ path: p, value: val, field, problem: "type-mismatch", key: keyName, expected: w });
      return;
    }
    visit({ path: p, value: val, field, key: keyName });
    val.forEach((item, i) => {
      const sub = listItemFields(field, item);
      const ip = p.concat(i);
      if (!sub) {
        if (item && typeof item === "object") visit({ path: ip, value: item, field, problem: "type-mismatch", key: keyName, expected: "plain list item" });
        else visit({ path: ip, value: item, field: { name: keyName, widget: "string", label: field.label }, listItem: true, key: keyName });
        return;
      }
      if (sub.single) {
        const sf = sub.single;
        if (item && typeof item === "object" && !Array.isArray(item)) {
          if (widgetOf(sf) === "object") {
            visit({ path: ip, value: item, field: sf, listItem: true, key: keyName });
            alignData(item, sf.fields, ip, visit);
          } else visit({ path: ip, value: item, field: sf, problem: "type-mismatch", key: keyName, expected: widgetOf(sf) });
        } else visit({ path: ip, value: item, field: sf, listItem: true, key: keyName });
        return;
      }
      if (!sub.fields) {
        visit({ path: ip, value: item, field, problem: "missing-type", key: keyName, typeValue: sub.missingType });
        return;
      }
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        visit({ path: ip, value: item, field, problem: "type-mismatch", key: keyName, expected: "object" });
        return;
      }
      visit({ path: ip, value: item, field, listItem: true, key: keyName, typeName: sub.typeName });
      const rest = {};
      for (const kk of Object.keys(item)) if (!(field.types && kk === sub.typeKey)) rest[kk] = item[kk];
      alignData(rest, sub.fields, ip, visit);
    });
    return;
  }
  if (val && typeof val === "object") {
    if (w !== "object") {
      visit({ path: p, value: val, field, problem: "type-mismatch", key: keyName, expected: w });
      return;
    }
    visit({ path: p, value: val, field, key: keyName });
    alignData(val, field.fields, p, visit);
    return;
  }
  if ((w === "list" || w === "object") && val !== null && val !== "" && val !== undefined) {
    visit({ path: p, value: val, field, problem: "type-mismatch", key: keyName, expected: w });
    return;
  }
  visit({ path: p, value: val, field, key: keyName });
}

// Visit every field definition (recursively) with a readable path like "brands.form.fields.label".
function walkFields(fields, basePath, visit) {
  for (const f of fields || []) {
    const p = basePath ? basePath + "." + f.name : f.name;
    visit(f, p, false);
    walkFields(f.fields, p, visit);
    if (f.field) walkFields([f.field], p, visit);
    for (const t of f.types || []) {
      visit(t, p + "<" + t.name + ">", true);
      walkFields(t.fields, p + "<" + t.name + ">", visit);
    }
  }
}

module.exports = { KNOWN_WIDGETS, TEXT_WIDGETS, loadConfig, widgetOf, contentCollections, listItemFields, alignData, alignNode, walkFields };
