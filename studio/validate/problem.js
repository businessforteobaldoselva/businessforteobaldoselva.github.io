"use strict";
// The Problem shape of DESIGN section 6: { code, file, path, message, hint?, value? }.

const CODES = new Set(["pattern", "required", "type", "range", "option", "url", "color", "anchor", "redirect", "token", "image", "path_forbidden", "pointer_invalid", "unknown_field", "too_large", "min_items", "max_items", "permalink", "encoding"]);

function clip(v) {
  let s;
  try { s = typeof v === "string" ? v : JSON.stringify(v); } catch (e) { s = String(v); }
  if (s === undefined) return undefined;
  s = s.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069\u2028\u2029]/g, " ");
  return s.length > 80 ? s.slice(0, 79) + "\u2026" : s;
}

function mk(code, file, path, message, hint, value) {
  if (!CODES.has(code)) throw new Error("unknown problem code " + code);
  const p = { code, file: file || "", path: path || "", message };
  if (hint) p.hint = hint;
  if (value !== undefined) p.value = clip(value);
  return p;
}

const key = (p) => p.code + "\u0000" + p.file + "\u0000" + p.path + "\u0000" + p.message;

module.exports = { mk, clip, key, CODES };
