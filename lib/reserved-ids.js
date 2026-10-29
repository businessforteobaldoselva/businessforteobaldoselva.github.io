"use strict";
const fs = require("fs");
const path = require("path");

// The ids the built-in site already uses.
//
// Editors choose "Link anchor" names for their own blocks and the form builder
// derives ids for added questions. Neither may ever reuse an id the page or its
// JavaScript relies on, otherwise the browser (getElementById, #fragment links,
// aria-labelledby ...) would pick the editor's element instead of the real one.
//
// The list is NOT written by hand: it is read from the templates, script
// partials and stylesheet in src/ every time the site is built, so adding an
// id to a template protects it automatically. What counts as "used":
//   - an id="..." attribute, or `el.id = "..."` / `{ id: "..." }` in a script
//     (a literal prefix before a {{ }} expression or a "+" is kept as a prefix)
//   - getElementById("..."), and every #name inside a querySelector string
//   - ids referenced by aria-controls / aria-labelledby / aria-describedby / for
//   - href="#name" links, and #name selectors in CSS (<style> blocks and .css)
//   - the form ids passed to hookForm("...") / enquiryForm("...")
//   - the ids of the form questions stored in the data files (brands.json ...)
//   - the homepage section types listed in src/index.njk (a section's name is
//     also the anchor the menu and the hero buttons jump to)
// Only the pages that can contain editor blocks are read (the homepage, the
// shared includes and src/pages); stand-alone tool pages such as the OG-image
// generator never share a document with an editor's block.
// Every id is also stored lower-cased, so "navLinks" blocks "navlinks" too.
// The list is read once, when Eleventy starts (restart `npm run serve` after
// adding an id to a template).
//
//   node lib/reserved-ids.js           print the list
//   node lib/reserved-ids.js --check   also verify that .eleventy.js and every
//                                      "Link anchor" pattern in cms/config.yml
//                                      reject every one of them (exit 1 if not)

const SCAN_EXT = /\.(njk|md|html|css|js)$/i;
const HEX_COLOUR = /^(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const cache = new Map();

function walk(dir, out) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return out;
  }
  entries.forEach((ent) => {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(full, out);
    else if (SCAN_EXT.test(ent.name)) out.push(full);
  });
  return out;
}

function styleText(file, text) {
  if (/\.css$/i.test(file)) return text;
  const blocks = [];
  text.replace(/<style[^>]*>([\s\S]*?)<\/style>/gi, (m, body) => {
    blocks.push(body);
    return m;
  });
  return blocks.join("\n");
}

function scanText(file, text, ids, prefixes) {
  const addId = (v) => {
    const s = String(v || "").trim();
    if (s && /^[A-Za-z_][\w:.-]*$/.test(s)) ids.add(s);
  };
  const addLiteral = (value, afterQuote) => {
    // Literal text before a template expression / string concatenation is a prefix.
    const brace = value.search(/[{]/);
    if (brace >= 0 || /^\s*\+/.test(afterQuote || "")) {
      const prefix = brace >= 0 ? value.slice(0, brace) : value;
      if (/^[A-Za-z][\w-]*$/.test(prefix)) prefixes.add(prefix);
      return;
    }
    value.split(/\s+/).forEach(addId);
  };

  // id="..." attributes, `x.id = "..."` and `"id": "..."` in scripts
  const idAttr = /(?<![\w-])["']?id["']?\s*[=:]\s*("([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = idAttr.exec(text))) {
    const value = m[2] !== undefined ? m[2] : m[3];
    const after = text.slice(m.index + m[0].length, m.index + m[0].length + 12);
    addLiteral(value, after);
  }

  const patterns = [
    [/getElementById\(\s*["']([^"']+)["']/g, 1],
    [/(?<![\w-])(?:aria-controls|aria-labelledby|aria-describedby|aria-owns|for)\s*=\s*"([^"{]+)"/g, 1],
    [/href\s*=\s*"#([A-Za-z][\w-]*)"/g, 1],
    [/(?:hookForm|enquiryForm)\(\s*["']([^"']+)["']/g, 1],
  ];
  patterns.forEach(([re, group]) => {
    let hit;
    while ((hit = re.exec(text))) hit[group].split(/\s+/).forEach(addId);
  });

  // #name inside querySelector("...") / querySelectorAll("...") strings
  const qs = /querySelector(?:All)?\(\s*(["'])((?:\\.|(?!\1)[^\\])*)\1/g;
  while ((m = qs.exec(text))) {
    const sel = /#([A-Za-z_][\w-]*)/g;
    let t;
    while ((t = sel.exec(m[2]))) addId(t[1]);
  }

  // #name selectors in stylesheets
  const css = styleText(file, text);
  if (css) {
    const sel = /#([A-Za-z_][\w-]*)/g;
    let t;
    while ((t = sel.exec(css))) if (!HEX_COLOUR.test(t[1])) addId(t[1]);
  }
}

function load(root) {
  const key = path.resolve(root);
  if (cache.has(key)) return cache.get(key);
  const found = new Set();
  const prefixes = new Set();
  const src = path.join(key, "src");
  const files = [path.join(src, "index.njk")]
    .concat(walk(path.join(src, "_includes"), []))
    .concat(walk(path.join(src, "pages"), []));
  files.forEach((file) => {
    let text = "";
    try {
      text = fs.readFileSync(file, "utf8");
    } catch (e) {
      return;
    }
    scanText(file, text, found, prefixes);
    // homepage section types, e.g. {% set builtinSections = ["hero", "marquee", ...] %}
    const list = /builtinSections\s*=\s*\[([^\]]*)\]/.exec(text);
    if (list) (list[1].match(/"([^"]+)"/g) || []).forEach((s) => found.add(s.slice(1, -1)));
  });
  // Ids the page itself uses (templates, scripts, styles, section names).
  const pageIds = new Set(found);
  // Form questions keep their original ids in the data files ("bName" ...).
  try {
    const dataDir = path.join(src, "_data");
    fs.readdirSync(dataDir)
      .filter((f) => /\.json$/.test(f))
      .forEach((f) => {
        let data = null;
        try {
          data = JSON.parse(fs.readFileSync(path.join(dataDir, f), "utf8"));
        } catch (e) {
          return;
        }
        const fields = data && data.form && Array.isArray(data.form.fields) ? data.form.fields : [];
        fields.forEach((q) => {
          if (q && typeof q.id === "string" && /^[A-Za-z][\w-]*$/.test(q.id)) found.add(q.id);
        });
      });
  } catch (e) {
    /* no data folder: nothing to add */
  }
  const exact = new Set(found);
  const lower = new Set();
  found.forEach((id) => lower.add(id.toLowerCase()));
  const pageLower = new Set();
  pageIds.forEach((id) => pageLower.add(id.toLowerCase()));
  const prefixList = Array.from(prefixes).sort();
  const startsWithPrefix = (v) => prefixList.some((p) => v.toLowerCase().startsWith(p.toLowerCase()));
  const result = {
    // every id as written in the templates and data files
    exact,
    // all of them lower-cased (what a lowercase "Link anchor" could collide with)
    lower,
    prefixes: prefixList,
    // true when `id` is, or case-insensitively equals, a built-in id or starts with a built-in prefix
    has(id) {
      const v = String(id == null ? "" : id);
      return exact.has(v) || lower.has(v.toLowerCase()) || startsWithPrefix(v);
    },
    // same, but only for ids the page itself uses (not the form questions' own
    // stored ids): the form builder checks derived and stored ids against this
    hasPageId(id) {
      const v = String(id == null ? "" : id);
      return pageIds.has(v) || pageLower.has(v.toLowerCase()) || startsWithPrefix(v);
    },
    // the lowercase ids, sorted: what the CMS "Link anchor" patterns must list
    sorted() {
      return Array.from(lower).sort();
    },
  };
  cache.set(key, result);
  return result;
}

module.exports = { reservedIds: load };

// ---------------------------------------------------------------------------
// Command line: print the list, or verify .eleventy.js and the CMS patterns.
if (require.main === module) {
  const root = path.resolve(__dirname, "..");
  const ids = load(root);
  const list = ids.sorted();
  if (!process.argv.includes("--check")) {
    console.log(list.join("\n"));
    console.log("prefixes: " + ids.prefixes.join(", "));
    process.exit(0);
  }

  const problems = [];

  // 1. the server-side filter (.eleventy.js safeAnchor)
  const filters = {};
  const fake = {
    addFilter: (n, f) => { filters[n] = f; },
    addTransform() {}, addPassthroughCopy() {}, addGlobalData() {},
    addPlugin: (p) => p(fake),
  };
  require(path.join(root, ".eleventy.js"))(fake);
  list.forEach((id) => {
    if (filters.safeAnchor(id) !== "") problems.push('safeAnchor accepts the built-in id "' + id + '"');
  });
  ids.prefixes.forEach((p) => {
    if (filters.safeAnchor(p + "1") !== "") problems.push('safeAnchor accepts an id starting with "' + p + '"');
  });
  ["our-story", "join-us", "more-questions", "our-numbers", "text", "stats"].forEach((id) => {
    if (filters.safeAnchor(id) !== id) problems.push('safeAnchor rejects the free name "' + id + '"');
  });

  // 2. every "Link anchor" pattern in cms/config.yml
  const yaml = require("js-yaml");
  const cfg = yaml.load(fs.readFileSync(path.join(root, "cms", "config.yml"), "utf8"));
  let anchorFields = 0;
  (function visit(node) {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!node || typeof node !== "object") return;
    if (node.name === "anchor" && node.widget) {
      anchorFields += 1;
      const pat = Array.isArray(node.pattern) ? node.pattern[0] : null;
      if (!pat) {
        problems.push("an anchor field has no pattern");
      } else {
        const re = new RegExp(pat);
        list.forEach((id) => {
          if (re.test(id)) problems.push('a CMS anchor pattern accepts the built-in id "' + id + '"');
        });
        ids.prefixes.forEach((p) => {
          if (re.test(p + "1")) problems.push('a CMS anchor pattern accepts an id starting with "' + p + '"');
        });
        ["our-story", "join-us", "more-questions", "our-numbers", "text", "stats"].forEach((id) => {
          if (!re.test(id)) problems.push('a CMS anchor pattern rejects the free name "' + id + '"');
        });
      }
    }
    Object.keys(node).forEach((k) => visit(node[k]));
  })(cfg);
  if (!anchorFields) problems.push("no anchor fields found in cms/config.yml");

  const unique = Array.from(new Set(problems));
  if (unique.length) {
    unique.forEach((p) => console.error("RESERVED IDS: " + p));
    process.exit(1);
  }
  console.log("reserved ids OK: " + list.length + " ids, " + ids.prefixes.length + " prefix(es), " + anchorFields + " CMS anchor fields");
}
