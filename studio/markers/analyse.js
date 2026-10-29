"use strict";
// Static analysis of the markers in a BUILT edit page (used by studio/guards/check-markers.js and the tests).
// Node only; needs htmlparser2 and markdown-it from the repo's devDependencies.

const { parseDocument } = require("htmlparser2");
const MarkdownIt = require("markdown-it");
const { parseRef } = require("./grammar");
const R = require("../schema/resolve");

const md = new MarkdownIt({ html: false, linkify: true }); // same options as the `md` filter in .eleventy.js

const collapse = (s) => String(s).replace(/[\s  -​  　]+/g, " ").trim().normalize("NFC");
const squash = (s) => String(s).replace(/<br\s*\/?\s*>/gi, "").replace(/[\s  -​  　]+/g, "").normalize("NFC");

const ATTR_OF = { alt: "data-cms-alt", decorative: "data-cms-decorative", href: "data-cms-href", hide: "data-cms-hide", cssvar: "data-cms-cssvar" };

function textOf(n) {
  if (n.type === "text") return n.data;
  if (n.type === "script" || n.type === "style") return "";
  return (n.children || []).map(textOf).join("");
}
// text nodes that are direct children of the element (child elements excluded)
function ownText(n) {
  return (n.children || []).filter((c) => c.type === "text").map((c) => c.data).join("");
}
function walk(n, fn) {
  fn(n);
  (n.children || []).forEach((c) => walk(c, fn));
}

// -> [{ ref, kind, opts: { alt, decorative, href, hide, cssvar }, node }]
function markersOf(html) {
  const doc = parseDocument(html, { decodeEntities: true });
  const out = [];
  walk(doc, (n) => {
    if (!n.attribs || n.attribs["data-cms"] === undefined) return;
    const opts = {};
    for (const k of Object.keys(ATTR_OF)) if (n.attribs[ATTR_OF[k]] !== undefined) opts[k] = n.attribs[ATTR_OF[k]];
    out.push({ ref: n.attribs["data-cms"], kind: n.attribs["data-cms-kind"], opts, node: n });
  });
  return { doc, markers: out };
}

function valueAt(content, ref) {
  const p = parseRef(ref);
  if (!p) return { found: false };
  const f = content.files[p.file];
  if (!f) return { found: false, noFile: true };
  let v = f.data;
  for (const s of p.segs) {
    if (v === null || typeof v !== "object" || !Object.prototype.hasOwnProperty.call(v, s)) return { found: false, file: f };
    v = v[s];
  }
  return { found: true, value: v, file: f, parsed: p };
}

const HEX_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const KIND_WIDGET = { text: "string", longtext: "text", markdown: "markdown", image: "image", color: "color", toggle: "boolean" };

// Every structural problem of one marker (does it resolve, is the kind right for the field). -> [string]
function resolveProblems(schema, content, m) {
  const probs = [];
  const p = parseRef(m.ref);
  if (!p) return ["invalid reference " + JSON.stringify(m.ref)];
  const f = content.files[p.file];
  if (!f) return [m.ref + ": file '" + p.file + "' is not editable content"];
  const res = R.resolve(schema, p.file, p.segs, f.data);
  if (!res) return [m.ref + ": no field in cms/config.yml for this reference"];
  const w = res.field.widget;
  const kind = m.kind;
  if (kind === "section") {
    if (!(p.file === "homepage" && p.segs.length === 2 && p.segs[0] === "sections" && res.indexInList !== null)) probs.push(m.ref + ": kind 'section' needs a homepage section (homepage.sections.N)");
  } else if (kind === "item") {
    if (res.indexInList === null) probs.push(m.ref + ": kind 'item' needs a list item");
  } else if (kind === "link") {
    if (!(w === "string" && res.field.x && res.field.x.rule === "url")) probs.push(m.ref + ": kind 'link' needs a link field (string with the link rule), found widget '" + w + "'");
  } else if (KIND_WIDGET[kind]) {
    if (w !== KIND_WIDGET[kind]) probs.push(m.ref + ": kind '" + kind + "' does not fit a '" + w + "' field (expects '" + KIND_WIDGET[kind] + "')");
  } else probs.push(m.ref + ": unknown kind " + JSON.stringify(kind));
  const sub = (key, ok, what) => {
    if (m.opts[key] === undefined) return;
    const q = parseRef(m.opts[key]);
    if (!q) return probs.push(m.ref + ": " + ATTR_OF[key] + " is not a valid reference");
    const qf = content.files[q.file];
    const qr = qf && R.resolve(schema, q.file, q.segs, qf.data);
    if (!qr) return probs.push(m.ref + ": " + ATTR_OF[key] + " " + m.opts[key] + " has no field in cms/config.yml");
    if (!ok(qr.field)) probs.push(m.ref + ": " + ATTR_OF[key] + " " + m.opts[key] + " must be " + what + ", found '" + qr.field.widget + "'");
  };
  sub("alt", (fl) => fl.widget === "string" || fl.widget === "text", "a text field");
  sub("decorative", (fl) => fl.widget === "boolean", "a switch (boolean)");
  sub("hide", (fl) => fl.widget === "boolean", "a switch (boolean)");
  sub("href", (fl) => fl.widget === "string" && fl.x && fl.x.rule === "url", "a link field");
  if (m.opts.cssvar !== undefined && !/^--[a-z0-9-]+$/.test(m.opts.cssvar)) probs.push(m.ref + ": invalid data-cms-cssvar");
  return probs;
}

function closest(node, name) {
  for (let n = node; n; n = n.parent) if (n.name === name) return n;
  return null;
}
function find(node, name) {
  let hit = null;
  walk(node, (n) => {
    if (!hit && n.name === name && n !== node) hit = n;
  });
  return hit;
}
const stemOf = (v) => String(v).split(/[?#]/)[0].split("/").pop().replace(/\.[^.]+$/, "");

// Does the marker tell the truth about the page? -> [string]. `safeUrl` is the site's link filter.
// ctx.themeVars: { "--paper": "paper", ... } as declared in src/_includes/theme-vars.njk (optional).
function truthProblems(content, m, safeUrl, ctx) {
  const probs = [];
  const got = valueAt(content, m.ref);
  if (!got.found && m.kind === "toggle") return probs; // an unset switch means its default
  if (!got.found) return [m.ref + ": the value does not exist in the content data"];
  const v = got.value;
  const n = m.node;
  if (m.kind === "text" || m.kind === "longtext") {
    if (typeof v !== "string" && typeof v !== "number") probs.push(m.ref + ": value is not text");
    else if (squash(ownText(n)) !== squash(v)) probs.push(m.ref + ": element text " + JSON.stringify(collapse(ownText(n)).slice(0, 60)) + " differs from the value " + JSON.stringify(collapse(v).slice(0, 60)));
  } else if (m.kind === "markdown") {
    const want = squash(textOf(parseDocument(md.render(String(v)), { decodeEntities: true })));
    if (squash(textOf(n)) !== want) probs.push(m.ref + ": the rendered text of the element differs from the markdown value");
  } else if (m.kind === "image") {
    const stem = stemOf(v);
    const holder = n.name === "img" || n.name === "image" ? n : find(n, "img") || find(n, "image");
    if (!holder) return [m.ref + ": image marker is not on (or around) an <img>"];
    const urls = [holder.attribs.src, holder.attribs.srcset, holder.attribs.href, holder.attribs["xlink:href"]];
    const picture = holder.parent && holder.parent.name === "picture" ? holder.parent : null;
    if (picture) walk(picture, (c) => c.name === "source" && urls.push(c.attribs.srcset, c.attribs.src));
    if (!stem || !urls.some((u) => u && String(u).includes(stem))) probs.push(m.ref + ": the picture's address does not contain '" + stem + "'");
    if (m.opts.decorative !== undefined || m.opts.alt !== undefined) {
      const dec = m.opts.decorative !== undefined ? valueAt(content, m.opts.decorative) : { found: false };
      const alt = m.opts.alt !== undefined ? valueAt(content, m.opts.alt) : { found: false };
      const have = holder.attribs.alt === undefined ? "" : collapse(holder.attribs.alt);
      if (dec.found && dec.value === true) {
        if (have !== "") probs.push(m.ref + ": marked decorative but has alt text");
      } else if (alt.found && collapse(alt.value) !== have) probs.push(m.ref + ": alt text on the page differs from " + m.opts.alt);
    }
  } else if (m.kind === "link") {
    const a = closest(n, "a");
    if (!a || a.attribs.href !== safeUrl(v)) probs.push(m.ref + ": the link address on the page differs from safeUrl(value)");
  }
  if (m.kind === "toggle" && typeof v !== "boolean") probs.push(m.ref + ": a switch must hold true or false");
  if (m.kind === "color") {
    if (typeof v !== "string" || !HEX_RE.test(v.trim())) probs.push(m.ref + ": not a hex colour");
    const themes = ctx && ctx.themeVars;
    if (m.opts.cssvar !== undefined && themes) {
      const key = parseRef(m.ref).segs[parseRef(m.ref).segs.length - 1];
      if (themes[m.opts.cssvar] !== key || parseRef(m.ref).file !== "theme") probs.push(m.ref + ": " + m.opts.cssvar + " is not set from this theme colour in theme-vars.njk");
    }
  }
  if (m.opts.href !== undefined) {
    const hv = valueAt(content, m.opts.href);
    const a = closest(n, "a");
    if (!hv.found) probs.push(m.ref + ": data-cms-href " + m.opts.href + " does not exist in the content data");
    else if (!a) probs.push(m.ref + ": data-cms-href but no enclosing <a>");
    else if (a.attribs.href !== safeUrl(hv.value)) probs.push(m.ref + ": the <a> address differs from safeUrl(" + m.opts.href + ")");
  }
  if (m.kind === "section" || m.kind === "item") {
    const sec = parseRef(m.ref);
    if (m.kind === "section" && got.found && got.value && got.value.enabled === false) probs.push(m.ref + ": a hidden section is on the page");
    void sec;
  }
  return probs;
}

// --css-var -> theme.json key, read from theme-vars.njk text
function themeVarsOf(text) {
  const out = {};
  const re = /(--[a-z0-9-]+):\s*\{\{\s*theme\.([A-Za-z0-9_]+)\s*\|\s*safeColor/g;
  let m;
  while ((m = re.exec(text))) out[m[1]] = m[2];
  return out;
}

module.exports = { themeVarsOf, markersOf, valueAt, resolveProblems, truthProblems, ownText, textOf, collapse, squash, walk, ATTR_OF };
