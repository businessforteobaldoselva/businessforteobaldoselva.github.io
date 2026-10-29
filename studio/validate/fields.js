"use strict";
// Field validation of a WHOLE document against the generated schema (DESIGN 6 stage 5): the same rules the CMS
// applies (widget type, pattern, min/max, options, required) plus the code-level rules the site enforces when it
// builds (safeUrl, safeColor, anchors, tokens, redirects, picture names). The code rules are IMPORTED, not copied:
// lib/rules.js, lib/tokens.js, cms/redirect-rules.js, scripts/lib/image-rules.js.
// Pure, portable.

const rules = require("../../lib/rules");
const tokens = require("../../lib/tokens");
const redirects = require("../../cms/redirect-rules");
const { mk, key: problemKey } = require("./problem");
const { hasOwn, isPlainObject, get } = require("./pointer");
const { widgetOf } = require("./walk");
const { canon } = require("./jsontext");

const DEFAULT_LIMITS = { string: 20000, markdown: 60000, listItems: 200 };
// C0 controls except TAB and LF, DEL and C1 controls, line/paragraph separators, bidi override / isolate controls
const BAD_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;
const PICTURE_REF_RE = /^(?:\/?(images|videos)\/)?([A-Za-z0-9][A-Za-z0-9._-]{0,79})$/;
const PERMALINK_RESERVED = /^\/(cms|admin|assets|fonts|images|videos|frames|studio|api|\.netlify|\.well-known)\/$/i;

const ptr = (segs) => (segs.length ? "/" + segs.map((s) => String(s).replace(/~/g, "~0").replace(/\//g, "~1")).join("/") : "");

function reservedHas(reserved, id) {
  if (!reserved) return false;
  if (typeof reserved.has === "function") return reserved.has(id) || reserved.has(String(id).toLowerCase());
  return false;
}

// validateDocument(ctx, info, doc, headDoc) -> { problems, warnings, refs }
//   refs: [{ dir, name, path (repo path), ptr, widget, changed }] picture references for the caller to check
function validateDocument(ctx, info, doc, headDoc) {
  const limits = Object.assign({}, DEFAULT_LIMITS, (ctx.schema && ctx.schema.limits) || {}, ctx.limits || {});
  const file = info.path;
  const problems = [];
  const warnings = [];
  const refs = [];
  const add = (code, segs, message, hint, value) => problems.push(mk(code, file, ptr(segs), message, hint, value));

  function checkObject(fields, obj, segs, opts) {
    if (!isPlainObject(obj)) { add("type", segs, "This should be a group of settings, not a single value."); return; }
    const names = new Set(fields.map((f) => f.name));
    if (opts && opts.typeKey) names.add(opts.typeKey);
    if (opts && opts.root && info.kind === "page") names.add("_body");
    for (const k of Object.keys(obj)) {
      if (!names.has(k)) add("unknown_field", segs.concat(k), "\u201c" + k + "\u201d is not a setting the editor knows about.", "Studio can only change settings that exist in the website editor.");
    }
    for (const f of fields) {
      const w = widgetOf(f);
      if (!hasOwn(obj, f.name) || obj[f.name] === undefined) {
        const hasDefault = f.default !== undefined && f.default !== null;
        if (f.required !== false && !hasDefault && w !== "hidden" && w !== "boolean" && w !== "list" && w !== "object") add("required", segs.concat(f.name), "\u201c" + (f.label || f.name) + "\u201d is required.");
        else if (f.required !== false && !hasDefault && (w === "list" || w === "object") && (f.min || 0) > 0) add("required", segs.concat(f.name), "\u201c" + (f.label || f.name) + "\u201d is required.");
        continue;
      }
      checkValue(f, obj[f.name], segs.concat(f.name));
    }
  }

  function checkList(f, v, segs) {
    if (!Array.isArray(v)) { add("type", segs, "This should be a list.", undefined, v); return; }
    if (v.length > limits.listItems) { add("max_items", segs, "A list can hold at most " + limits.listItems + " items.", undefined, v.length); return; }
    if (typeof f.min === "number" && v.length < f.min) add("min_items", segs, "\u201c" + (f.label || f.name) + "\u201d needs at least " + f.min + (f.min === 1 ? " item." : " items."), undefined, v.length);
    if (typeof f.max === "number" && v.length > f.max) add("max_items", segs, "\u201c" + (f.label || f.name) + "\u201d can have at most " + f.max + (f.max === 1 ? " item." : " items."), undefined, v.length);
    v.forEach((item, i) => {
      const s = segs.concat(String(i));
      if (f.types) {
        const typeKey = f.typeKey || "type";
        if (!isPlainObject(item)) { add("type", s, "Each item must be a group of settings."); return; }
        const t = f.types.find((x) => x.name === item[typeKey]);
        if (!t) { add("option", s.concat(typeKey), "The block type " + JSON.stringify(String(item[typeKey]).slice(0, 40)) + " does not exist.", undefined, item[typeKey]); return; }
        checkObject(t.fields || [], item, s, { typeKey });
      } else if (f.fields) checkObject(f.fields, item, s, {});
      else if (f.field) checkValue(Object.assign({}, f.field, { name: f.field.name || f.name }), item, s);
      else if (!isPlainObject(item) && typeof item !== "string") add("type", s, "Unsupported list item.");
    });
  }

  function checkString(f, v, segs, w) {
    if (typeof v !== "string") { add("type", segs, "\u201c" + (f.label || f.name) + "\u201d must be text.", undefined, v); return; }
    const max = w === "markdown" ? limits.markdown : limits.string;
    if (v.length > max) { add("too_large", segs, "This text is too long (" + v.length + " characters; the limit is " + max + ").", undefined, v); return; }
    if (BAD_CHARS.test(v)) { add("encoding", segs, "This text contains an invisible control character that is not allowed.", "Retype the text, or paste it as plain text.", v); return; }
    if (w === "string" && v.indexOf("\n") >= 0) { add("encoding", segs, "\u201c" + (f.label || f.name) + "\u201d must be on one line.", undefined, v); return; }
    if (v.trim() === "") {
      if (f.required !== false && w !== "hidden") add("required", segs, "\u201c" + (f.label || f.name) + "\u201d cannot be empty.");
      return;
    }
    if (f.pattern && f.pattern.source) {
      let re = null;
      try { re = new RegExp(f.pattern.source); } catch (e) { re = null; }
      if (re && !re.test(v)) add("pattern", segs, f.pattern.message || "This does not look right.", undefined, v);
    }
    const rule = f.x && f.x.rule;
    if (rule === "url" && rules.safeUrl(v) !== v) add("url", segs, "This link is not allowed.", "Use an address like /about/, #section, https://example.com or mailto:someone@example.com.", v);
    else if (rule === "anchor") {
      if (!/^[a-z0-9-]+$/.test(v)) add("anchor", segs, "A link anchor may only use lowercase letters, numbers and dashes.", undefined, v);
      else if (rules.safeAnchor(v, ctx.reservedIds) !== v || reservedHas(ctx.reservedIds, v)) add("anchor", segs, "\u201c" + v + "\u201d is already used by the website itself.", "Choose another anchor name.", v);
    } else if (rule === "permalink") {
      if (PERMALINK_RESERVED.test(v) || v === "/") add("permalink", segs, "This page address is reserved by the website.", undefined, v);
      else if (ctx.pagePermalinks) {
        for (const [p, link] of ctx.pagePermalinks) if (p !== file && link === v) add("permalink", segs, "Another page already uses this address.", undefined, v);
      }
    }
  }

  function checkPicture(f, v, segs, w) {
    if (typeof v !== "string") { add("type", segs, "\u201c" + (f.label || f.name) + "\u201d must be a picture file name.", undefined, v); return; }
    if (v === "") {
      if (f.required !== false) add("required", segs, "\u201c" + (f.label || f.name) + "\u201d needs a picture.");
      return;
    }
    const m = PICTURE_REF_RE.exec(v);
    if (!m || v.length > 120) { add("image", segs, "This is not a picture from the website\u2019s library.", "Pick or upload a picture; web addresses and other folders are not accepted.", v); return; }
    const dir = m[1] || "images";
    const name = m[2];
    if (f.pattern && f.pattern.source) {
      let re = null;
      try { re = new RegExp(f.pattern.source); } catch (e) { re = null; }
      if (re && !re.test(name)) add("pattern", segs, f.pattern.message || "This file name is not allowed.", undefined, v);
    }
    const before = headDoc ? get(headDoc, segs) : undefined;
    refs.push({ dir, name, path: dir + "/" + name, ptr: ptr(segs), widget: w, changed: before !== v });
  }

  function checkValue(f, v, segs) {
    const w = widgetOf(f);
    switch (w) {
      case "object": checkObject(f.fields || [], v, segs, {}); return;
      case "list": checkList(f, v, segs); return;
      case "string": case "text": case "markdown": checkString(f, v, segs, w); return;
      case "boolean": if (typeof v !== "boolean") add("type", segs, "\u201c" + (f.label || f.name) + "\u201d must be on or off.", undefined, v); return;
      case "number": {
        if (typeof v !== "number" || !Number.isFinite(v)) { add("type", segs, "\u201c" + (f.label || f.name) + "\u201d must be a number.", undefined, v); return; }
        if ((f.valueType || f.value_type) === "int" && !Number.isInteger(v)) add("type", segs, "\u201c" + (f.label || f.name) + "\u201d must be a whole number.", undefined, v);
        const tk = f.x && f.x.token && f.x.token.kind === "number" ? f.x.token : null;
        const lo = tk ? tk.min : f.min;
        const hi = tk ? tk.max : f.max;
        if ((typeof lo === "number" && v < lo) || (typeof hi === "number" && v > hi)) add(tk ? "token" : "range", segs, "\u201c" + (f.label || f.name) + "\u201d must be between " + lo + " and " + hi + ".", undefined, v);
        return;
      }
      case "select": {
        const allowed = (f.options || []).map((o) => (o && typeof o === "object" ? o.value : o));
        const vals = f.multiple ? (Array.isArray(v) ? v : null) : [v];
        if (!vals) { add("type", segs, "This should be a list of choices."); return; }
        for (const x of vals) if (allowed.indexOf(x) < 0) add("option", segs, JSON.stringify(String(x).slice(0, 40)) + " is not one of the choices.", "Choose one of: " + allowed.slice(0, 12).map(String).join(", "), x);
        return;
      }
      case "color":
        if (typeof v !== "string" || rules.safeColor(v, null) !== v) add("color", segs, "This is not a valid colour.", "Use a hex colour such as #F26B3A.", v);
        return;
      case "image": case "file": checkPicture(f, v, segs, w); return;
      default: {
        // hidden and widgets Studio cannot edit: only the value already there (or the default) is acceptable
        const before = headDoc ? get(headDoc, segs) : undefined;
        if (canon(v) === canon(before) || (f.default !== undefined && canon(v) === canon(f.default))) return;
        add("unknown_field", segs, "\u201c" + (f.label || f.name) + "\u201d cannot be changed in Studio.");
      }
    }
  }

  checkObject(info.fields, doc, [], { root: true });
  if (info.kind === "page" && info.body && isPlainObject(doc) && hasOwn(doc, "_body")) checkString(Object.assign({ name: "_body", label: "Page text" }, info.body), doc._body, ["_body"], widgetOf(info.body) === "markdown" ? "markdown" : widgetOf(info.body));

  // ---- file-level code rules
  if (isPlainObject(doc)) {
    if (info.key === "tokens") {
      for (const t of tokens.TOKENS) {
        const raw = tokens.getAt(doc, t.key);
        if (raw === undefined) continue;
        const segs = t.key.split(".");
        const comp = tokens.value(doc, t.key);
        const seen = (s) => problems.some((q) => q.path === ptr(s)); // the field-level check already said it
        if (t.kind === "select" || t.kind === "num") {
          if (raw !== comp && !seen(segs)) add("token", segs, "\u201c" + t.key + "\u201d is outside the allowed range.", t.kind === "num" ? "Allowed: " + t.min + " to " + t.max + "." : "Allowed: " + Object.keys(t.options).join(", "), raw);
        } else if (isPlainObject(raw)) {
          for (const p of Object.keys(t.bounds)) {
            if (raw[p] !== comp[p] && !seen(segs.concat(p))) add("token", segs.concat(p), "\u201c" + t.key + " (" + p + ")\u201d is outside the allowed range.", "Allowed: " + t.bounds[p][0] + " to " + t.bounds[p][1] + ".", raw[p]);
          }
        }
      }
    }
    if (info.key === "redirects" && Array.isArray(doc.items)) {
      const res = redirects.analyse(doc.items, ctx.pagePaths ? { pages: ctx.pagePaths } : undefined);
      for (const d of res.dropped) add("redirect", ["items", String(d.index)], "This redirect would be ignored: " + d.reason + ".");
      for (const d of res.ineffective) warnings.push(mk("redirect", file, "/items/" + d.index, d.reason));
    }
  }
  return { problems, warnings, refs };
}

module.exports = { validateDocument, DEFAULT_LIMITS, problemKey, PICTURE_REF_RE };
