"use strict";
// The corpus of editable text: every string (and number) an editor can change without touching a
// template, expanded into the shapes it can take on a built page:
//   - the whole string, each line of it, each run between <br /> / inline tags, markdown rendered
//     the way the site renders it (html off and html on), so `*free*` and [links](…) split correctly
//   - strings with {placeholders}: the pieces around a placeholder, the string with the placeholder
//     removed, and a pattern in which the placeholder matches any short text
// Matching is exact on the normalised text (whitespace collapsed), never "contains": a hard-coded
// "and" or "Close" cannot hide because the same letters occur inside some long sentence.

const MarkdownIt = require("markdown-it");
const { parseDocument } = require("htmlparser2");
const { collapse, escapeRegExp } = require("./util");
const { leaves } = require("./data");
const { htmlItems } = require("./jsscan");

const mdSite = new MarkdownIt({ html: false, linkify: true }); // same options as .eleventy.js `md` filter
const mdPage = new MarkdownIt({ html: true, linkify: true }); // Eleventy's default for page bodies

const norm = (s) => collapse(String(s)).normalize("NFC");
const hasCopyChars = (t) => /\p{L}/u.test(t) || /[^\x00-\x7f]/.test(t);
const PLACEHOLDER = /\{[A-Za-z][A-Za-z0-9_.]*\}/g;

function htmlRuns(html) {
  const doc = parseDocument(html, { decodeEntities: true });
  const runs = [];
  (function walk(n) {
    if (n.type === "text") {
      const t = collapse(n.data);
      if (t) runs.push(t);
    } else if (n.type !== "style" && n.type !== "script" && n.children) n.children.forEach(walk);
  })(doc);
  return runs;
}

class Corpus {
  constructor() {
    this.exact = new Set();
    this.patterns = []; // { re, src }
    this.size = 0;
  }

  add(s) {
    const t = norm(s);
    if (t && hasCopyChars(t) && !this.exact.has(t)) {
      this.exact.add(t);
      this.size += 1;
    }
  }

  addVariants(str) {
    const base = String(str);
    this.add(base);
    for (const line of base.split(/\n+/)) this.add(line);
    // HTML shape: <br />, inline tags
    if (/<[A-Za-z/]/.test(base)) {
      const runs = htmlRuns(base);
      runs.forEach((r) => this.add(r));
      this.add(runs.join(" "));
    }
    // Markdown shapes
    for (const md of [mdSite, mdPage]) {
      let html;
      try {
        html = md.render(base);
      } catch (e) {
        continue;
      }
      const runs = htmlRuns(html);
      runs.forEach((r) => this.add(r));
      this.add(runs.join(" "));
      for (const it of htmlItems(html)) if (it.kind === "html-attr") this.add(it.text);
    }
  }

  addLeaf(value) {
    const str = typeof value === "number" ? String(value) : value;
    if (typeof str !== "string" || !str.trim()) return;
    this.addVariants(str);
    if (PLACEHOLDER.test(str)) {
      PLACEHOLDER.lastIndex = 0;
      const pieces = str.split(PLACEHOLDER).map((p) => p.trim()).filter(Boolean);
      pieces.forEach((p) => this.addVariants(p));
      this.addVariants(str.replace(/ ?\{[A-Za-z][A-Za-z0-9_.]*\} ?/g, " ").trim());
      this.addVariants(str.replace(PLACEHOLDER, ""));
      // a pattern in which each placeholder stands for any short run of text
      const literal = str.replace(PLACEHOLDER, "").replace(/\s+/g, "");
      if (literal.length >= 3) {
        const src = str
          .split(PLACEHOLDER)
          .map((p) => escapeRegExp(norm(p)).replace(/ /g, "\\s*"))
          .join("[^\\n]{0,300}");
        this.patterns.push({ re: new RegExp("^" + src + "$"), src: str });
      }
    }
  }

  has(text) {
    const t = norm(text);
    if (this.exact.has(t)) return "exact";
    for (const p of this.patterns) if (p.re.test(t)) return "placeholder";
    return null;
  }

  // A picture / video path on a built page: the editable path itself, or a WebP sibling the site
  // derives from an editable .jpg / .png path (x.webp, x-480.webp). The site's own origin is ignored.
  hasMedia(url) {
    let p = String(url).trim().split(/[?#]/)[0].replace(/^https?:\/\/(www\.)?coveredaccess\.com/i, "");
    p = p.replace(/^\/+/, "");
    const stems = [p];
    const m = /^(.*?)(-480)?\.webp$/i.exec(p);
    if (m) for (const ext of [".jpg", ".jpeg", ".png", ".webp"]) stems.push(m[1] + ext);
    for (const s of stems) if (this.exact.has(norm(s)) || this.exact.has(norm("/" + s))) return true;
    return false;
  }

  // A link that leaves the site: the editable URL, or a mailto: / tel: made of editable parts.
  hasLink(url) {
    const u = String(url).trim();
    if (this.exact.has(norm(u)) || this.exact.has(norm(u.replace(/\/$/, ""))) || this.exact.has(norm(u + "/"))) return true;
    const mail = /^mailto:([^?]*)(?:\?(.*))?$/i.exec(u);
    if (mail) {
      const safe = (s) => {
        try {
          return decodeURIComponent(s);
        } catch (e) {
          return s;
        }
      };
      const addr = safe(mail[1]);
      if (addr && !this.exact.has(norm(addr))) return false;
      for (const part of (mail[2] || "").split("&").filter(Boolean)) {
        const val = safe(part.slice(part.indexOf("=") + 1).replace(/\+/g, " "));
        if (val && !this.has(val)) return false;
      }
      return true;
    }
    const tel = /^(tel|sms):(.*)$/i.exec(u);
    if (tel) return [...this.exact].some((e) => e.replace(/[^\d+]/g, "") === tel[2].replace(/[^\d+]/g, "") && /\d/.test(e));
    return false;
  }
}

function buildCorpus(sources, markdownBodies) {
  const c = new Corpus();
  for (const s of sources) {
    for (const l of leaves(s.data)) c.addLeaf(l.value);
    if (typeof s.body === "string" && s.body.trim()) c.addVariants(s.body);
  }
  return c;
}

module.exports = { Corpus, buildCorpus, norm, hasCopyChars };
