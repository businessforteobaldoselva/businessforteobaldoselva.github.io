"use strict";
// src/pages/*.md = YAML front matter between --- lines, then the markdown body.
// parsePage(text) -> { eol, doc }   doc = the front matter object plus `_body` (the markdown, LF line ends)
// serializePage(doc, eol) -> text   front matter dumped by js-yaml, EOLs as in the original file
// Round-trip law (tested over every page): serializePage(parsePage(t).doc, parsePage(t).eol) === t.
// js-yaml is the one runtime dependency (the same parser Eleventy's front matter reader uses).

const yaml = require("js-yaml");
const { hasOwn, isPlainObject } = require("./pointer");

class PageError extends Error {
  constructor(message) { super(message); this.name = "PageError"; }
}

function plainOnly(v, path) {
  if (v === null || typeof v === "string" || typeof v === "boolean") return v;
  if (typeof v === "number") { if (!Number.isFinite(v)) throw new PageError("a number in the front matter is not finite at " + path); return v; }
  if (Array.isArray(v)) return v.map((x, i) => plainOnly(x, path + "/" + i));
  if (isPlainObject(v)) {
    const out = {};
    for (const k of Object.keys(v)) {
      if (k === "__proto__") throw new PageError("the key __proto__ is not allowed");
      Object.defineProperty(out, k, { value: plainOnly(v[k], path + "/" + k), enumerable: true, writable: true, configurable: true });
    }
    return out;
  }
  throw new PageError("the front matter holds a value that is not plain data (a date or object type) at " + (path || "/"));
}

function parsePage(text) {
  if (typeof text !== "string") throw new PageError("not text");
  const eol = text.indexOf("\r\n") >= 0 ? "\r\n" : "\n";
  const t = text.replace(/\r\n/g, "\n");
  if (/\r/.test(t)) throw new PageError("the file mixes line-ending styles");
  if (!t.startsWith("---\n")) throw new PageError("the page has no front matter");
  const m = /\n---(\n|$)/.exec(t.slice(3));
  if (!m) throw new PageError("the front matter is not closed with ---");
  const fmText = t.slice(4, 3 + m.index + 1);
  const body = t.slice(3 + m.index + 1 + 3 + m[1].length);
  let fm;
  try { fm = yaml.load(fmText); } catch (e) { throw new PageError("the front matter is not valid YAML: " + String(e.message).split("\n")[0]); }
  if (fm === undefined || fm === null) fm = {};
  if (!isPlainObject(fm)) throw new PageError("the front matter must be a set of name: value lines");
  const doc = plainOnly(fm, "");
  if (hasOwn(doc, "_body")) throw new PageError("front matter keys may not start with _");
  doc._body = body;
  return { eol, doc, hasTrailingFence: m[1] === "\n" };
}

function serializePage(doc, eol) {
  const fm = {};
  for (const k of Object.keys(doc)) if (k !== "_body") fm[k] = doc[k];
  const body = typeof doc._body === "string" ? doc._body : "";
  const y = yaml.dump(fm, { lineWidth: -1, noRefs: true, quotingType: '"', forceQuotes: false, sortKeys: false, noCompatMode: true });
  const out = "---\n" + (Object.keys(fm).length ? y : "") + "---\n" + body;
  return eol === "\r\n" ? out.replace(/\n/g, "\r\n") : out;
}

module.exports = { parsePage, serializePage, PageError };
