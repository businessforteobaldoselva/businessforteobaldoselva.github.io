/* COVERED Studio overlay - core/schema-client.js
   Walks the generated studio-schema.json (DESIGN section 4) for a ref: which field is it, what are its rules,
   what is it called in plain English, which fields sit below it. Self-contained (no dependency on the
   markers/schema units); behaviour follows section 4 of the design. Pure: runs under node for the tests. */
(function (S) {
  "use strict";
  var U = S.util;

  function create(schema) {
    schema = schema || { files: {}, pages: { fields: [] }, limits: { string: 20000, markdown: 60000, listItems: 200 } };
    var limits = schema.limits || { string: 20000, markdown: 60000, listItems: 200 };

    function fileSchema(fileKey) {
      if (fileKey.indexOf("pages:") === 0) return schema.pages ? { fields: schema.pages.fields || [], body: schema.pages.body || null, label: schema.pages.label || "Pages" } : null;
      var f = schema.files && schema.files[fileKey];
      return f ? { fields: f.fields || [], label: f.label || fileKey, path: f.path } : null;
    }
    function widgetOf(f) { return (f && f.widget) || "string"; }
    function findField(fields, name) {
      for (var i = 0; i < (fields || []).length; i += 1) if (fields[i].name === name) return fields[i];
      return null;
    }
    // The pseudo-field of one list item (its fields come from `field`, `fields` or the typed list's `types`).
    function itemField(listField, item, index) {
      var base;
      if (listField.types) {
        var key = listField.typeKey || "type";
        var t = null;
        for (var i = 0; i < listField.types.length; i += 1) if (item && listField.types[i].name === item[key]) t = listField.types[i];
        if (!t) return null;
        base = { name: String(index), label: t.label || t.name, widget: "object", fields: t.fields || [], _type: t.name };
      } else if (listField.fields) {
        base = { name: String(index), label: listField.label_singular || listField.label || "Item", widget: "object", fields: listField.fields };
      } else if (listField.field) {
        base = Object.assign({}, listField.field);
      } else return null;
      base._item = true;
      base._list = listField;
      return base;
    }

    // resolve(fileKey, segs, doc) -> { field, parent, itemOf } | null   (null = not an editable field)
    function resolve(fileKey, segs, doc) {
      var fs = fileSchema(fileKey);
      if (!fs) return null;
      var field = { name: "", label: fs.label, widget: "object", fields: fs.fields };
      var cur = doc;
      var parent = null;
      for (var i = 0; i < segs.length; i += 1) {
        var seg = segs[i];
        var w = widgetOf(field);
        var next = null;
        if (w === "object" && field.fields) {
          if (seg === "_body" && fs.body && i === 0 && fileKey.indexOf("pages:") === 0) next = fs.body;
          else next = findField(field.fields, seg);
          cur = cur && typeof cur === "object" ? cur[seg] : undefined;
        } else if (w === "list" && /^\d+$/.test(seg)) {
          var idx = Number(seg);
          cur = Array.isArray(cur) ? cur[idx] : undefined;
          next = itemField(field, cur, idx);
        }
        if (!next) return null;
        parent = field;
        field = next;
      }
      return { field: field, parent: parent };
    }
    function stripEmoji(s) { return String(s || "").replace(/^[^\p{L}\p{N}]+/u, "").replace(/\s+/g, " ").replace(/\s*\([^)]*\)\s*$/, "").trim(); }
    function labelFor(fileKey, segs, doc) {
      var fs = fileSchema(fileKey);
      if (!fs) return fileKey + "." + segs.join(".");
      var parts = [stripEmoji(fileKey.indexOf("pages:") === 0 ? "Page " + fileKey.slice(6) : fs.label)];
      var field = { widget: "object", fields: fs.fields };
      var cur = doc;
      for (var i = 0; i < segs.length; i += 1) {
        var seg = segs[i];
        var w = widgetOf(field);
        var next = null;
        if (w === "object" && field.fields) {
          next = seg === "_body" && fs.body && fileKey.indexOf("pages:") === 0 ? fs.body : findField(field.fields, seg);
          cur = cur && typeof cur === "object" ? cur[seg] : undefined;
          if (next) parts.push(stripEmoji(next.label || next.name));
        } else if (w === "list" && /^\d+$/.test(seg)) {
          cur = Array.isArray(cur) ? cur[Number(seg)] : undefined;
          next = itemField(field, cur, Number(seg));
          if (next) parts.push(stripEmoji(next.label) + (field.types ? "" : " " + (Number(seg) + 1)));
        }
        if (!next) { parts.push(seg); break; }
        field = next;
      }
      // "Hero > Hero > Headline" is noise: drop an immediate repeat
      return parts.filter(function (p, i) { return i === 0 || p !== parts[i - 1]; }).join(" > ");
    }
    // Short name of one list item ("The problem", "Story card 2") - what a founder calls it.
    function itemName(fileKey, segs, doc) {
      var full = labelFor(fileKey, segs, doc);
      var i = full.lastIndexOf(" > ");
      return i >= 0 ? full.slice(i + 3) : full;
    }
    // Children of a ref as { name, field }; for a list, its current items.
    function childrenOf(field, value) {
      var w = widgetOf(field);
      var out = [];
      if (w === "object") (field.fields || []).forEach(function (f) { out.push({ seg: f.name, field: f }); });
      else if (w === "list" && Array.isArray(value)) value.forEach(function (it, i) { var f = itemField(field, it, i); if (f) out.push({ seg: String(i), field: f }); });
      return out;
    }
    // Every leaf (non-object, non-list) field below a field, with its segs - used by the Fields panel.
    function leaves(fileKey, doc, maxRows) {
      var fs = fileSchema(fileKey);
      var rows = [];
      if (!fs) return rows;
      var start = { widget: "object", fields: fs.fields };
      function walk(field, value, segs) {
        if (rows.length >= (maxRows || 2000)) return;
        var w = widgetOf(field);
        if (w === "object" && field.fields) {
          field.fields.forEach(function (f) { walk(f, value && typeof value === "object" ? value[f.name] : undefined, segs.concat(f.name)); });
        } else if (w === "list") {
          if (Array.isArray(value)) value.forEach(function (it, i) { var f = itemField(field, it, i); if (f) walk(f, it, segs.concat(String(i))); });
        } else if (w === "hidden") {
          /* not editable */
        } else {
          rows.push({ segs: segs, field: field, value: value });
        }
      }
      walk(start, doc, []);
      if (fs.body && fileKey.indexOf("pages:") === 0) rows.push({ segs: ["_body"], field: fs.body, value: doc ? doc._body : undefined });
      return rows;
    }
    // How a picture field writes its value (x.imageStyle), derived from its pattern when absent.
    function imageStyle(field) {
      var st = field && field.x && field.x.imageStyle;
      if (st) return st;
      var src = field && field.pattern && field.pattern.source ? field.pattern.source : "";
      return src.indexOf("/images/") >= 0 ? "public-path" : "bare-name";
    }
    return { raw: schema, limits: limits, fileSchema: fileSchema, resolve: resolve, labelFor: labelFor, itemName: itemName, childrenOf: childrenOf, leaves: leaves, imageStyle: imageStyle, widgetOf: widgetOf, stripEmoji: stripEmoji, itemField: itemField };
  }

  S.schemaClient = { create: create };
})(window.__CoveredStudioBoot);
