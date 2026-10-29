#!/usr/bin/env node
"use strict";
// check-tokens: the "Type & spacing" design tokens (src/_data/tokens.json) must stay bounded, wired and in sync.
//
//   node scripts/check-tokens.js [--root .] [--max 200] [--static] [--write]
//
// An editor (or a stolen editor session) must never be able to break the site through a design token. The token table
// lives in lib/tokens.js; this guard proves, in three layers:
//
//   1. Static    - every token has a CMS field with exactly the filter's bounds / options / default (and nothing
//                  extra); the shipped defaults declared in src/_includes/site-styles.css equal the table (so the
//                  untouched site renders as before); every --tk-* variable is used by the stylesheet through
//                  var(), and every var(--tk-*) in the stylesheet is declared; cms/previews.js carries a copy of
//                  the table (regenerate it with --write).
//   2. Filter    - hostile and nonsense values pushed through the REAL Eleventy filters (strings, markup, template
//                  syntax, NaN-like and huge numbers, objects, arrays, prototype keys) always come out as numbers inside
//                  the bounds / listed words, checked against the table independently of the code that clamps.
//   3. Builds    - the site is built (a) with the shipped data, (b) with hostile tokens.json, (c) with every
//                  number at its lowest and its highest allowed value and every choice moved: the emitted
//                  declarations must be exactly the validated ones, inside the bounds, must follow the data (the token
//                  really reaches the page), and no attack string may appear anywhere in the output.
//
// --static runs layer 1 and 2 only (no builds). Exit code: 0 clean, 1 violations, 2 usage error.

const fs = require("fs");
const path = require("path");
const { runMain, parseArgs, Report, REPO_ROOT, readText, clip } = require("./lib/util");
const { loadConfig, contentCollections, widgetOf } = require("./lib/cmsconfig");

const ATTACK = 'red;}</style><script>HXCSSalert(8)</script><style>{{ 90911 + 6 }}';
const MARK = /HXCSS|alert\(8\)|90917|<script>HX/;
const NUM = "(-?\\d+(?:\\.\\d+)?)";

function loadTokens(root) {
  // a fresh copy per root, so --root <other checkout> / a mutated workspace is judged by its own table
  const file = path.join(root, "lib", "tokens.js");
  delete require.cache[require.resolve(file)];
  return require(file);
}

function loadFilters(root) {
  const filters = {};
  const file = path.join(root, "lib", "eleventy", "tokens.js");
  delete require.cache[require.resolve(file)];
  require(file)({ addFilter: (n, fn) => (filters[n] = fn) });
  return filters;
}

// The inside of a TOKENS block: { cssName: value } (minified or not, any spacing)
function declsIn(text) {
  const out = {};
  const re = /(--tk-[a-z0-9-]+)\s*:\s*([^;}]+?)\s*(?:;|(?=\}))/g;
  let m;
  while ((m = re.exec(text))) out[m[1]] = m[2].replace(/,\s+/g, ",");
  return out;
}
const squash = (s) => String(s).replace(/,\s+/g, ",").replace(/\s+/g, " ").trim();

// Does `value` (as printed in CSS) satisfy token t's grammar and bounds? -> null | reason
function badValue(t, value) {
  const v = squash(value);
  if (t.kind === "select") return Object.values(t.options).map(squash).includes(v) ? null : "not one of the allowed values: " + v;
  const inRange = (n, lo, hi, what) => (n >= lo - 1e-9 && n <= hi + 1e-9 ? null : what + " " + n + " is outside " + lo + ".." + hi);
  if (t.kind === "num") {
    const m = new RegExp("^" + NUM + t.unit + "$").exec(v);
    if (!m) return "does not look like a number in " + (t.unit || "no unit") + ": " + v;
    return inRange(+m[1], t.min, t.max, "value");
  }
  let m;
  let parts;
  if (t.kind === "clampfit") {
    m = new RegExp("^clamp\\(" + NUM + "rem,min\\(" + NUM + "vw," + NUM + "vh\\)," + NUM + "rem\\)$").exec(v);
    parts = ["min", "fluid", "vh", "max"];
  } else {
    m = new RegExp("^clamp\\(" + NUM + "rem," + NUM + (t.kind === "clampvh" ? "vh" : "vw") + "," + NUM + "rem\\)$").exec(v);
    parts = ["min", "fluid", "max"];
  }
  if (!m) return "does not look like the expected clamp(): " + v;
  const n = {};
  parts.forEach((p, i) => (n[p] = +m[i + 1]));
  for (const p of parts) {
    const bad = inRange(n[p], t.bounds[p][0], t.bounds[p][1], p);
    if (bad) return bad;
  }
  return n.max >= n.min ? null : "the largest size is below the smallest";
}

// ------------------------------------------------------------------ layer 1
function staticChecks(root, T, report) {
  const S = "Tokens: CMS / table / stylesheet in sync";
  // ---- CMS fields
  const cfg = loadConfig(root);
  const entry = contentCollections(cfg).find((e) => e.file === "src/_data/tokens.json");
  if (!entry) {
    report.add(S, "cms/config.yml has no entry for src/_data/tokens.json", "Add the “Type & spacing” entry (generated from lib/tokens.js).");
  } else {
    const specs = T.fieldSpecs();
    const found = new Set();
    const walk = (fields, prefix) => {
      for (const f of fields || []) {
        const p = prefix ? prefix + "." + f.name : f.name;
        const w = widgetOf(f);
        if (w === "object") {
          walk(f.fields, p);
          continue;
        }
        found.add(p);
        const sp = specs[p];
        if (!sp) {
          report.add(S, "CMS field " + p + " is not a token", "lib/tokens.js has no token with this key, so nothing validates it.");
          continue;
        }
        if (!String(f.hint || "").trim()) report.add(S, "CMS field " + p + " has no plain-English hint");
        if (sp.options) {
          const vals = (f.options || []).map((o) => (o && typeof o === "object" ? o.value : o));
          if (w !== "select" || JSON.stringify(vals) !== JSON.stringify(sp.options)) report.add(S, "CMS field " + p + " must be a select of exactly " + JSON.stringify(sp.options), "found " + JSON.stringify(vals));
        } else {
          if (w !== "number") report.add(S, "CMS field " + p + " must be a number widget", "found " + w);
          for (const k of ["min", "max", "step"]) if (f[k] !== sp[k]) report.add(S, "CMS field " + p + ": " + k + " must be " + sp[k] + " (the bound the build enforces)", "found " + f[k]);
        }
      }
    };
    walk(entry.fields, "");
    for (const k of Object.keys(specs)) if (!found.has(k)) report.add(S, "token " + k + " has no CMS field");
  }

  // ---- sizes that must stay LARGE text (WCAG: 24px) because their colours only pass at 3:1
  const baseMin = (T.TOKENS.find((x) => x.key === "text.baseSize") || {}).min;
  for (const t of T.TOKENS.filter((x) => x.largeText)) {
    const px = t.bounds.min[0] * 16 * (baseMin / 100);
    if (!(px >= 24)) report.add(S, "token " + t.key + " can be set so small (" + Math.round(px * 10) / 10 + "px with the page text at " + baseMin + "%) that it stops being large text", "Its colours pass the accessibility check only as large text (24px or more). Raise the lowest allowed 'min' in lib/tokens.js and the CMS field.");
  }
  // ---- stylesheet defaults
  const cssFile = path.join(root, "src", "_includes", "site-styles.css");
  const css = readText(cssFile);
  const bm = /\/\* TOKENS-BEGIN[\s\S]*?\*\/([\s\S]*?)\/\* TOKENS-END \*\//.exec(css);
  if (!bm) {
    report.add(S, "site-styles.css has no TOKENS-BEGIN … TOKENS-END block of shipped defaults");
  } else {
    const have = declsIn(bm[1]);
    const want = Object.fromEntries(T.cssVars({}));
    for (const [k, v] of Object.entries(want)) {
      if (!(k in have)) report.add(S, "site-styles.css does not declare the default of " + k);
      else if (squash(have[k]) !== squash(v)) report.add(S, "site-styles.css default of " + k + " differs from the table", "stylesheet: " + have[k] + "   table: " + v + "  (the untouched site would change)");
    }
    for (const k of Object.keys(have)) if (!(k in want)) report.add(S, "site-styles.css declares " + k + " which is not a token");
  }
  // ---- var() usage
  const outside = css.replace(/\/\* TOKENS-BEGIN[\s\S]*?\/\* TOKENS-END \*\//, "");
  const used = new Set();
  outside.replace(/var\(\s*(--tk-[a-z0-9-]+)\s*\)/g, (m, n) => used.add(n));
  const declared = new Set(T.cssVars({}).map((x) => x[0]));
  for (const n of declared) if (!used.has(n)) report.add(S, n + " is declared but nothing in site-styles.css uses it", "A dead token: the CMS field would change nothing.");
  for (const n of used) if (!declared.has(n)) report.add(S, "site-styles.css uses var(" + n + ") which is not a token");
  // shadow: the alpha must come from the filter, not a literal
  const tv = readText(path.join(root, "src", "_includes", "theme-vars.njk"));
  if (!/tokens\s*\|\s*tokenValue\(\s*["']shape\.shadow["']\s*\)/.test(tv)) report.add(S, "theme-vars.njk does not build --shadow from the validated shape.shadow token");
  if (!/\{\{\s*tokens\s*\|\s*tokenVars\s*\|\s*safe\s*\}\}/.test(tv)) report.add(S, "theme-vars.njk does not print the validated tokens (tokens | tokenVars)");
  // ---- previews copy
  const pv = fs.readFileSync(path.join(root, "cms", "previews.js"), "utf8");
  const pm = /\/\* TOKEN-SPEC:BEGIN \*\/\s*var TOKEN_SPEC = ([\s\S]*?);\s*\/\* TOKEN-SPEC:END \*\//.exec(pv);
  let copy = null;
  try {
    copy = pm ? JSON.parse(pm[1]) : null;
  } catch (e) {
    /* reported below */
  }
  if (!copy) report.add(S, "cms/previews.js has no readable TOKEN_SPEC copy", "Run: node scripts/check-tokens.js --write");
  else if (JSON.stringify(copy) !== JSON.stringify(JSON.parse(JSON.stringify(T.TOKENS)))) report.add(S, "cms/previews.js TOKEN_SPEC is out of date with lib/tokens.js", "The live preview would use other limits than the site. Run: node scripts/check-tokens.js --write");
}

function writePreviewSpec(root, T) {
  const file = path.join(root, "cms", "previews.js");
  let pv = fs.readFileSync(file, "utf8");
  const eol = pv.includes("\r\n") ? "\r\n" : "\n";
  const body = "/* TOKEN-SPEC:BEGIN */" + eol + "  var TOKEN_SPEC = [" + eol + JSON.parse(JSON.stringify(T.TOKENS)).map((t) => "    " + JSON.stringify(t)).join("," + eol) + eol + "  ];" + eol + "  /* TOKEN-SPEC:END */";
  const re = /\/\* TOKEN-SPEC:BEGIN \*\/[\s\S]*?\/\* TOKEN-SPEC:END \*\//;
  if (!re.test(pv)) throw new Error("cms/previews.js has no TOKEN-SPEC markers");
  pv = pv.replace(re, () => body);
  fs.writeFileSync(file, pv);
}

// ------------------------------------------------------------------ layer 2
function hostileDocs(T) {
  const docs = [];
  const ATT = [ATTACK, "1;}</style>", "calc(1px", "url(//evil.example/x)", "__proto__", "constructor", "", " ", "1e999", "NaN", "-0", "0x10", "١٢٣", "<b>1</b>"];
  const NONSENSE = [1e308, -1e308, 1e-300, 0, -0, 123456789.123456789, -7, null, true, false, [], [1, 2], {}, { min: ATTACK }, { min: 1e99, fluid: -1e99, max: "x" }, { __proto__: { min: 5 } }];
  const set = (doc, key, v) => {
    const [a, b, c] = key.split(".");
    doc[a] = doc[a] || {};
    if (c) {
      doc[a][b] = doc[a][b] && typeof doc[a][b] === "object" && !Array.isArray(doc[a][b]) ? doc[a][b] : {};
      doc[a][b][c] = v;
    } else doc[a][b] = v;
  };
  // every token receives every kind of nonsense in turn (one doc per nonsense value)
  for (const v of ATT.concat(NONSENSE)) {
    const doc = {};
    for (const t of T.TOKENS) {
      if (t.bounds) for (const p of Object.keys(t.bounds)) set(doc, t.key + "." + p, v);
      else set(doc, t.key, v);
    }
    docs.push(doc);
  }
  // whole objects / arrays / scalars where a group should be
  for (const v of ["x", 5, null, [], ATTACK]) docs.push({ fonts: v, text: v, lines: v, tracking: v, weights: v, space: v, shape: v });
  for (const v of [undefined, null, 0, "", "x", [], ATTACK]) docs.push(v);
  // the step objects replaced by scalars
  const d2 = {};
  for (const t of T.TOKENS) if (t.bounds) set(d2, t.key, ATTACK);
  docs.push(d2);
  return docs;
}

function filterChecks(root, T, report) {
  const S = "Tokens: values are bounded by the build";
  const F = loadFilters(root);
  const byCss = new Map(T.TOKENS.filter((t) => t.css).map((t) => [t.css, t]));
  const docs = hostileDocs(T);
  let checked = 0;
  for (const [i, doc] of docs.entries()) {
    let text;
    let alpha;
    try {
      text = F.tokenVars(doc);
      alpha = F.tokenValue(doc, "shape.shadow");
    } catch (e) {
      report.add(S, "the filter throws on hostile input #" + i, e.message);
      continue;
    }
    const lines = String(text).split("\n").filter((l) => l.trim());
    if (lines.length !== byCss.size) report.add(S, "tokenVars printed " + lines.length + " lines instead of " + byCss.size + " for hostile input #" + i);
    for (const l of lines) {
      const m = /^\s*(--tk-[a-z0-9-]+): ([^;]*);$/.exec(l);
      if (!m) {
        report.add(S, "tokenVars printed a line that is not a plain declaration", clip(l));
        continue;
      }
      const t = byCss.get(m[1]);
      const bad = t ? badValue(t, m[2]) : "unknown variable";
      checked += 1;
      if (bad) report.add(S, m[1] + " escaped its bounds with hostile input #" + i + " (" + clip(JSON.stringify(doc) || "undefined", 70) + ")", bad + "   printed: " + clip(l));
    }
    const sh = T.TOKENS.find((t) => t.key === "shape.shadow");
    if (typeof alpha !== "number" || !(alpha >= sh.min && alpha <= sh.max)) report.add(S, "shape.shadow escaped its bounds with hostile input #" + i, String(alpha));
    if (MARK.test(String(text))) report.add(S, "hostile text reached the printed declarations (input #" + i + ")", clip(text));
  }
  // a typo on the one thing most likely to break a page
  const t1 = F.tokenVars({ text: { title: { min: 50, fluid: 900, max: 0 } } });
  const m = /--tk-title: ([^;]*);/.exec(t1);
  if (!m || badValue(T.TOKENS.find((t) => t.key === "text.title"), m[1])) report.add(S, "a huge section-title size was not clamped", m ? m[1] : "missing");
  report.note("  filter: " + docs.length + " hostile token documents through tokenVars / tokenValue, " + checked + " printed declarations checked against the table");
}

// ------------------------------------------------------------------ layer 3
const extremeDoc = (T, which) => {
  const doc = {};
  const set = (key, v) => {
    const [a, b, c] = key.split(".");
    doc[a] = doc[a] || {};
    if (c) (doc[a][b] = doc[a][b] || {})[c] = v;
    else doc[a][b] = v;
  };
  for (const t of T.TOKENS) {
    if (t.kind === "select") {
      const opts = Object.keys(t.options);
      set(t.key, opts[(opts.indexOf(t.def) + (which === "min" ? 1 : 2)) % opts.length]);
    } else if (t.kind === "num") set(t.key, which === "min" ? t.min : t.max);
    else for (const p of Object.keys(t.bounds)) set(t.key + "." + p, t.bounds[p][which === "min" ? 0 : 1]);
  }
  return doc;
};

function buildChecks(root, T, report) {
  const S = "Tokens: built pages";
  const { Workspace } = require("./lib/workspace");
  const ws = new Workspace(root, { prefix: "covered-tokens-" });
  try {
    const hostile = (() => {
      // each token gets a different kind of nonsense, strings in number fields and markup in selects among them
      const bad = [ATTACK, 1e30, -1e30, "999", null, [], { min: ATTACK, max: 1e30 }, true];
      const doc = {};
      T.TOKENS.forEach((t, i) => {
        const v = bad[i % bad.length];
        const [a, b] = t.key.split(".");
        doc[a] = doc[a] || {};
        doc[a][b] = t.bounds ? { min: v, fluid: bad[(i + 1) % bad.length], max: bad[(i + 2) % bad.length], vh: bad[(i + 3) % bad.length] } : v;
      });
      return doc;
    })();
    const runs = [
      { id: "shipped data", doc: null },
      { id: "hostile tokens.json", doc: hostile },
      { id: "every number at its lowest, every choice moved", doc: extremeDoc(T, "min"), mustDiffer: true },
      { id: "every number at its highest, every choice moved", doc: extremeDoc(T, "max"), mustDiffer: true },
    ];
    const shipped = JSON.parse(readText(path.join(root, "src", "_data", "tokens.json")));
    for (const run of runs) {
      if (run.doc) ws.writeJson("src/_data/tokens.json", run.doc);
      else ws.writeJson("src/_data/tokens.json", shipped);
      const b = ws.build(run.id.replace(/\W+/g, "-"));
      if (!b.ok) {
        report.add(S, "'" + run.id + "': the site no longer builds", b.log.split("\n").slice(-10).join("\n"));
        continue;
      }
      const data = run.doc === null ? shipped : run.doc;
      const want = Object.fromEntries(T.cssVars(data));
      const dflt = Object.fromEntries(T.cssVars({}));
      const css = readText(path.join(b.out, "assets", "site.css"));
      const html = readText(path.join(b.out, "index.html"));
      // the override block is the LAST TOKENS block (theme-vars.njk); the first holds the shipped defaults
      const blocks = [...css.matchAll(/\/\* TOKENS-BEGIN[\s\S]*?\*\/([\s\S]*?)\/\* TOKENS-END \*\//g)].map((m) => declsIn(m[1]));
      const got = blocks[blocks.length - 1] || {};
      if (blocks.length < 2) report.add(S, "'" + run.id + "': assets/site.css does not contain the token override block", "found " + blocks.length + " TOKENS block(s)");
      const inlineDecls = (() => {
        const o = {};
        for (const m of html.matchAll(/<style>([\s\S]*?)<\/style>/g)) Object.assign(o, declsIn(m[1])); // later declarations win, like the cascade
        return o;
      })();
      let differs = 0;
      for (const [k, v] of Object.entries(want)) {
        const t = T.TOKENS.find((x) => x.css === k);
        if (squash(got[k]) !== squash(v)) report.add(S, "'" + run.id + "': " + k + " in assets/site.css is not the validated value", "printed " + got[k] + "   expected " + v);
        if (squash(inlineDecls[k]) !== squash(v)) report.add(S, "'" + run.id + "': " + k + " in the home page <style> is not the validated value", "printed " + inlineDecls[k] + "   expected " + v);
        const bad = badValue(t, got[k] === undefined ? "" : got[k]);
        if (bad) report.add(S, "'" + run.id + "': " + k + " is out of bounds in the built css", bad);
        if (squash(v) !== squash(dflt[k])) differs += 1;
      }
      if (run.mustDiffer && differs < Object.keys(want).length * 0.9) report.add(S, "'" + run.id + "': only " + differs + " of " + Object.keys(want).length + " tokens changed the built css", "A token that does not follow its data is not wired.");
      // --shadow follows shape.shadow
      const sm = /--shadow:\s*0 10px 30px rgba\(\s*\d+,\s*\d+,\s*\d+,\s*([0-9.]+)\)/.exec(css.slice(css.lastIndexOf("CMS theme overrides")));
      const wantAlpha = T.value(data, "shape.shadow");
      if (!sm || Math.abs(+sm[1] - wantAlpha) > 1e-9) report.add(S, "'" + run.id + "': --shadow does not follow shape.shadow", "printed alpha " + (sm ? sm[1] : "none") + "   expected " + wantAlpha);
      if (sm && !(+sm[1] >= 0 && +sm[1] <= 0.4)) report.add(S, "'" + run.id + "': the shadow strength escaped its bounds", sm[1]);
      // nothing from the attack strings anywhere in the output
      for (const f of fs.readdirSync(b.out, { recursive: true })) {
        if (!/\.(html|css|js|json|xml|txt)$/.test(f) || /^(cms|admin)[\\/]/.test(f)) continue;
        const text = readText(path.join(b.out, f));
        if (MARK.test(text)) report.add(S, "'" + run.id + "': attack text reached " + f, clip(text.slice(Math.max(0, text.search(MARK) - 40))));
      }
      // the html still has a single set of style blocks (nothing injected)
      if (/<script>HX|<style>\s*\{\{/.test(html)) report.add(S, "'" + run.id + "': markup from tokens.json reached the home page");
    }
  } finally {
    ws.cleanup();
  }
  report.note("  builds: shipped / hostile / lowest / highest values built and compared declaration by declaration with the table");
}

function main() {
  const args = parseArgs(process.argv.slice(2), { root: "string", max: "number", static: "boolean", write: "boolean" });
  if (args.help) {
    console.log("usage: node scripts/check-tokens.js [--root <repo root>] [--max <n>] [--static] [--write]");
    return 0;
  }
  const root = path.resolve(args.root || REPO_ROOT);
  const report = new Report("check-tokens");
  const T = loadTokens(root);
  if (args.write) {
    writePreviewSpec(root, T);
    console.log("cms/previews.js: TOKEN_SPEC rewritten from lib/tokens.js");
  }
  staticChecks(root, T, report);
  filterChecks(root, T, report);
  if (!args.static) buildChecks(root, T, report);
  report.note("check-tokens: " + T.TOKENS.length + " tokens (" + Object.keys(T.fieldSpecs()).length + " CMS fields)");
  return report.print({ max: args.max || 200, okMessage: "OK - every design token is bounded, wired to the stylesheet and matches the CMS" });
}

runMain("check-tokens", main);
