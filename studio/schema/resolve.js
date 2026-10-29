"use strict";
// Resolver for studio-schema.json (DESIGN.md section 4). UMD, no dependencies: used by the validator (Node)
// and the overlay (browser, concatenated into overlay.js).
//
//   resolve(schema, fileKey, segs, doc) -> { field, parent, itemType, list, indexInList } | null
//   labelFor(schema, fileKey, segs, doc) -> "Our story > Heading"
//   fieldsAt(schema, fileKey, segs, doc) -> [Field]
//
//   fileKey   "how" | "pages:about"           segs   ["story", "2", "title"]           doc   the file's data (page: front matter + _body)
// A pointer to a list item (…, "sections", "3") resolves to a synthesised object field describing that item
// (the type's fields for typed lists). A typed list needs `doc` to learn the item's type; without it: null.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.CoveredStudioResolve = factory();
})(typeof self !== "undefined" ? self : this, function () {
  var INDEX_RE = /^(?:0|[1-9][0-9]{0,5})$/;

  function isObj(v) {
    return v !== null && typeof v === "object" && !Array.isArray(v);
  }

  function fileEntry(schema, fileKey) {
    if (typeof fileKey !== "string") return null;
    if (fileKey.indexOf("pages:") === 0) {
      if (!schema.pages) return null;
      return { fields: schema.pages.fields, label: schema.pages.label, body: schema.pages.body, page: true };
    }
    var f = Object.prototype.hasOwnProperty.call(schema.files, fileKey) ? schema.files[fileKey] : null;
    return f ? { fields: f.fields, label: f.label, body: null, page: false } : null;
  }

  function byName(fields, name) {
    for (var i = 0; i < (fields || []).length; i++) if (fields[i].name === name) return fields[i];
    return null;
  }

  function typeOf(listField, item) {
    var key = listField.typeKey || "type";
    if (!isObj(item)) return null;
    var types = listField.types || [];
    for (var i = 0; i < types.length; i++) if (types[i].name === item[key]) return types[i];
    return null;
  }

  // The field describing ONE item of `listField`, or null when it cannot be told.
  function itemField(listField, item) {
    if (listField.types) {
      var t = typeOf(listField, item);
      return t ? { field: { name: t.name, label: t.label, widget: "object", required: true, fields: t.fields }, itemType: t } : null;
    }
    if (listField.fields) {
      return { field: { name: listField.name, label: listField.label, widget: "object", required: true, fields: listField.fields }, itemType: null };
    }
    if (listField.field) return { field: listField.field, itemType: null };
    return null;
  }

  function childrenOf(field, node) {
    // fields a node of `field` may hold (objects only)
    return field && field.widget === "object" ? field.fields || [] : [];
  }

  function resolve(schema, fileKey, segs, doc) {
    var entry = fileEntry(schema, fileKey);
    if (!entry || !Array.isArray(segs) || !segs.length) return null;
    var fields = entry.fields;
    var parent = null;
    var node = doc;
    var cur = null; // result so far
    var i = 0;
    if (segs[0] === "_body") {
      if (!entry.page || segs.length !== 1) return null;
      return { field: entry.body, parent: null, itemType: null, list: null, indexInList: null };
    }
    while (i < segs.length) {
      var seg = String(segs[i]);
      var f = byName(fields, seg);
      if (!f) return null;
      parent = cur ? cur.field : null;
      node = isObj(node) ? node[seg] : undefined;
      cur = { field: f, parent: parent, itemType: null, list: null, indexInList: null };
      i += 1;
      if (i >= segs.length) return cur;
      if (f.widget === "list") {
        var idx = String(segs[i]);
        if (!INDEX_RE.test(idx)) return null;
        node = Array.isArray(node) ? node[Number(idx)] : undefined;
        var it = itemField(f, node);
        if (!it) return null;
        cur = { field: it.field, parent: f, itemType: it.itemType, list: f, indexInList: Number(idx) };
        i += 1;
        if (i >= segs.length) return cur;
        fields = childrenOf(it.field);
      } else if (f.widget === "object") {
        fields = f.fields || [];
      } else {
        return null; // scalar with trailing segments
      }
    }
    return cur;
  }

  function fieldsAt(schema, fileKey, segs, doc) {
    var entry = fileEntry(schema, fileKey);
    if (!entry) return [];
    if (!segs || !segs.length) return entry.fields;
    var r = resolve(schema, fileKey, segs, doc);
    if (!r) return [];
    if (r.field.widget === "object") return r.field.fields || [];
    if (r.field.widget === "list") {
      var node = doc;
      for (var i = 0; i < segs.length; i++) node = node === undefined || node === null ? undefined : node[segs[i]];
      // children of a list = fields of its first item (types differ per item, so only the item itself knows)
      var first = Array.isArray(node) ? itemField(r.field, node[0]) : null;
      return first && first.field.fields ? first.field.fields : [];
    }
    return [];
  }

  // Leading emoji / pictographs / variation selectors are decoration in cms/config.yml labels.
  function plain(label) {
    var s = String(label || "").replace(/^[^A-Za-z0-9(]+/, "").replace(/\s+/g, " ").trim();
    var short = s.replace(/\s*\([^)]*\)/g, "").trim();
    return short || s;
  }

  function labelFor(schema, fileKey, segs, doc) {
    var entry = fileEntry(schema, fileKey);
    if (!entry) return String(fileKey);
    var parts = [plain(entry.label) || String(fileKey)];
    if (segs && segs.length && segs[0] === "_body") {
      parts.push("Page text");
      return parts.join(" > ");
    }
    var fields = entry.fields;
    var node = doc;
    var cur = null;
    for (var i = 0; segs && i < segs.length; i++) {
      var seg = String(segs[i]);
      if (cur && cur.field.widget === "list" && INDEX_RE.test(seg)) {
        node = Array.isArray(node) ? node[Number(seg)] : undefined;
        var it = itemField(cur.field, node);
        var n = Number(seg) + 1;
        parts.push(it && it.itemType ? plain(it.itemType.label) + " " + n : "Item " + n);
        cur = it ? { field: it.field } : null;
        fields = cur ? childrenOf(cur.field) : [];
        if (!cur) {
          for (var j = i + 1; j < segs.length; j++) parts.push(String(segs[j]));
          break;
        }
        continue;
      }
      var f = byName(fields, seg);
      if (!f) {
        parts.push(seg);
        continue;
      }
      node = isObj(node) ? node[seg] : undefined;
      parts.push(plain(f.label) || f.name);
      cur = { field: f };
      fields = f.widget === "object" ? f.fields || [] : [];
    }
    return parts.join(" > ");
  }

  return { resolve: resolve, labelFor: labelFor, fieldsAt: fieldsAt };
});
