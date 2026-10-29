#!/usr/bin/env node
"use strict";
// check-a11y: the accessibility gate. Builds the site (or reads a build) and, for every public page, checks
//
//   Colour contrast (WCAG 2.2 1.4.3 / 1.4.11)  every text / background pairing the page's real stylesheet and
//        markup produce, worked out from the built CSS and the colours in src/_data/theme.json, named by
//        theme colour role. Text, large text (3:1), symbols, placeholders, keyboard focus rings; in the page's
//        resting state and in hover / focus / pressed / toggled-class states; at a wide and a narrow screen.
//   Structure   one <h1>, no skipped heading level, lang, <title>, one <main>, skip link and its target, names of
//        links / buttons / form controls, alt text on every image, duplicate ids, tabindex above 0, aria-hidden on
//        something the keyboard can reach, ARIA references, video / audio, prefers-reduced-motion.
//
//   node scripts/check-a11y.js [--site <built site>] [--root .] [--max 200] [--github] [--write-pairs]
//                              [--no-pair-sync] [--strict-stale] [--unit] [--list-pairs]
//
// Errors fail the run (exit 1); warnings are listed. --github also prints workflow annotations
// (::error file=...) and appends the result to $GITHUB_STEP_SUMMARY (no comments, no tokens, no network).
// --write-pairs regenerates the pair table inside cms/contrast.js that the CMS colour preview uses.
// Exit code: 0 clean, 1 errors, 2 usage error / site does not build.

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { parseDocument } = require("htmlparser2");
const yaml = require("js-yaml");
const vm = require("vm");
const { runMain, mkTmp, removeTree, strictStale, parseArgs, readJson, readText, exists, listFiles, toPosix, collapse, clip, REPO_ROOT, SCRIPTS_DIR } = require("./lib/util");
const { eleventyBin, Workspace } = require("./lib/workspace");
const { Styler, resolveColor } = require("./lib/a11y-style");
const { parseSelector, elementKids } = require("./lib/a11y-css");
const { analysePage, pairKey } = require("./lib/a11y-contrast");
const { analyseStructure } = require("./lib/a11y-structure");
const CC = require("../cms/contrast.js");

const PASSTHROUGH_DIRS = new Set(["images", "frames", "fonts", "videos", "node_modules"]);
const MARK_BEGIN = "/* PAIRS:BEGIN */";
const MARK_END = "/* PAIRS:END */";

// ---------------------------------------------------------------- inputs
function pageUrlOf(siteDir, file) {
  const rel = toPosix(path.relative(siteDir, file));
  if (rel === "index.html") return "/";
  if (rel.endsWith("/index.html")) return "/" + rel.slice(0, -"index.html".length);
  return "/" + rel;
}

// src/_includes/theme-vars.njk -> { "--paper": { key: "paper", def: "#FFF8EC", label } }  (labels come from the CMS config)
function themeVarMap(root) {
  const vars = {};
  const file = path.join(root, "src", "_includes", "theme-vars.njk");
  if (!exists(file)) return vars;
  const re = /(--[\w-]+)\s*:\s*\{\{\s*theme\.(\w+)\s*\|\s*safeColor\("(#[0-9A-Fa-f]{3,8})"\)/g;
  const text = readText(file);
  let m;
  while ((m = re.exec(text))) vars[m[1]] = { key: m[2], def: m[3].toUpperCase(), label: m[2] };
  try {
    const cfg = yaml.load(readText(path.join(root, "cms", "config.yml")));
    for (const col of cfg.collections || []) {
      for (const f of col.files || []) {
        if (f.name !== "theme") continue;
        for (const fld of f.fields || []) for (const v of Object.values(vars)) if (v.key === fld.name) v.label = String(fld.label || fld.name).replace(/\s*\(.*\)\s*$/, "");
      }
    }
  } catch (e) {
    /* labels fall back to the theme.json key */
  }
  return vars;
}

function freshBuild(root) {
  const tmp = mkTmp("covered-a11y-");
  const out = path.join(tmp, "site");
  const r = spawnSync(process.execPath, [eleventyBin(root), "--quiet", "--output=" + out], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { ok: r.status === 0 && exists(out), out, tmp, log: (r.stdout || "") + (r.stderr || "") };
}

function findPages(siteDir) {
  return listFiles(siteDir, (f) => /\.html?$/i.test(f))
    .filter((f) => !PASSTHROUGH_DIRS.has(toPosix(path.relative(siteDir, f)).split("/")[0]))
    .sort((a, b) => (pageUrlOf(siteDir, a) === "/" ? -1 : pageUrlOf(siteDir, b) === "/" ? 1 : a < b ? -1 : 1));
}

function textOfNode(n) {
  let t = "";
  for (const k of n.children || []) t += k.type === "text" ? k.data : k.children ? textOfNode(k) : "";
  return t;
}
function walkTags(n, fn) {
  fn(n);
  for (const k of elementKids(n)) walkTags(k, fn);
}

// source file an editor / developer would change for a page (for annotations)
function sourceFor(root, url) {
  if (url === "/") return "src/index.njk";
  const slug = url.replace(/^\/|\/$/g, "");
  for (const c of ["src/pages/" + slug + ".md", "src/" + slug + ".njk"]) if (exists(path.join(root, c))) return c;
  return "src/index.njk";
}

// ---------------------------------------------------------------- the analysis
function analyseSite(siteDir, root, cfg, vars, known) {
  const themeVars = new Set(Object.keys(vars));
  const exemptSel = (cfg.exempt || []).map((e) => parseSelector(e.selector)).filter(Boolean);
  const allowFile = path.join(SCRIPTS_DIR, "copy-allowlist.json");
  const excluded = (exists(allowFile) ? readJson(allowFile).excludePages || [] : []).map((e) => e.path);
  const result = { pages: [], skipped: [], findings: [], pairs: new Map(), unresolved: [], noRing: [], values: null, unsupported: new Map(), stats: { texts: 0, variants: 0 }, motion: { css: false, script: false }, indexable: new Map() };
  const sheetCache = new Map();
  const readSheet = (href) => {
    if (!sheetCache.has(href)) {
      const f = path.join(siteDir, href.split(/[?#]/)[0].replace(/^\/+/, ""));
      sheetCache.set(href, exists(f) ? readText(f) : null);
    }
    return sheetCache.get(href);
  };
  const stylerCache = new Map();

  for (const file of findPages(siteDir)) {
    const url = pageUrlOf(siteDir, file);
    if (excluded.some((p) => url === p || url.startsWith(p))) {
      result.skipped.push(url);
      continue;
    }
    const html = readText(file);
    const doc = parseDocument(html, { decodeEntities: true });
    const sheets = [];
    const scripts = [];
    let robots = "";
    walkTags(doc.children.find((k) => k.type === "tag") || doc, (n) => {
      if (n.name === "style") sheets.push(textOfNode(n));
      else if (n.name === "link" && /stylesheet/i.test((n.attribs || {}).rel || "") && (n.attribs || {}).href && !/^(https?:)?\/\//i.test(n.attribs.href)) {
        const css = readSheet(n.attribs.href);
        if (css !== null) sheets.push(css);
      } else if (n.name === "script") {
        if ((n.attribs || {}).src && !/^(https?:)?\/\//i.test(n.attribs.src)) {
          const js = readSheet(n.attribs.src);
          if (js) scripts.push(js);
        } else scripts.push(textOfNode(n));
      } else if (n.name === "meta" && /^robots$/i.test((n.attribs || {}).name || "")) robots += " " + (n.attribs.content || "");
    });
    const indexable = !/noindex/i.test(robots);
    result.indexable.set(url, indexable);
    result.pages.push(url);

    const cacheKey = sheets.join("\u0000");
    if (!stylerCache.has(cacheKey)) stylerCache.set(cacheKey, new Styler(sheets));
    const styler = stylerCache.get(cacheKey);
    const motion = { reducedMotionCss: styler.info.reducedMotion, reducedMotionScript: scripts.some((s) => /prefers-reduced-motion/.test(s)), animations: styler.info.animations };
    if (motion.reducedMotionCss) result.motion.css = true;
    if (motion.reducedMotionScript) result.motion.script = true;

    const ctx = styler.newCtx({ w: 1280, h: 800 });
    if (!result.values) {
      const rootEl = doc.children.find((k) => k.type === "tag" && k.name === "html");
      const rootVars = rootEl ? styler.computed(rootEl, ctx).vars : {};
      result.values = {};
      for (const name of themeVars) {
        const col = rootVars[name] !== undefined ? resolveColor("var(" + name + ")", rootVars, null) : null;
        if (col) result.values[name] = col.c.a >= 1 ? CC.toHex(col.c) : "rgba(" + col.c.r + "," + col.c.g + "," + col.c.b + "," + col.c.a + ")";
      }
    }

    const st = analyseStructure({ doc, styler, ctx, url, config: cfg, motion });
    for (const f of st) result.findings.push(f);

    const r = analysePage({ doc, styler, url, themeVars, pairs: result.pairs, unresolved: result.unresolved, stateClasses: (cfg.stateClasses || {}).list || [], exempt: exemptSel });
    result.stats.texts += r.stats.texts;
    result.stats.variants += r.stats.variants;
    for (const x of r.noRing) result.noRing.push(x);
    for (const [k, v] of styler.unsupported) result.unsupported.set(k, (result.unsupported.get(k) || 0) + v);
    result.styler = styler;
  }
  return result;
}

// ---------------------------------------------------------------- reporting helpers
const KIND_WORD = { t: "text", l: "large text", u: "symbol / graphic" };
function layerLabel(layer, vars) {
  return CC.layerName(layer, Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, v])));
}
function rolesOf(pair, vars, res) {
  const key = (l) => {
    const name = l.indexOf("@") > 0 && l.slice(0, 2) === "--" ? l.slice(0, l.indexOf("@")) : l;
    return name.slice(0, 2) === "--" && vars[name] ? " [" + vars[name].key + "]" : "";
  };
  const withHex = (label, hex) => (label.toLowerCase().includes(hex.toLowerCase()) ? label : label + " " + hex);
  const fgLabel = pair.what === "placeholder" && pair.fg === "#757575" ? "the browser's default placeholder grey" : layerLabel(pair.fg, vars) + key(pair.fg);
  const fgText = withHex(fgLabel, res.fg);
  const bgText = withHex(pair.bg.map((l) => layerLabel(l, vars) + key(l)).join(" under "), res.bg);
  return { fgText, bgText };
}
const needText = (n) => (Number.isInteger(n) ? n : n.toFixed(1)) + ":1";

function whereText(p) {
  return p.places.map((x) => x.url + " " + x.desc + (x.state ? " " + x.state : "")).join("; ") + (p.pages.size > 1 ? "  (" + p.pages.size + " pages)" : "");
}

// ---------------------------------------------------------------- pair table for the CMS
function pairTable(maps, vars, known) {
  const themed = [];
  const seen = new Set();
  const all = [];
  for (const m of maps) for (const p of m.values()) if (!seen.has(p.key)) {
    seen.add(p.key);
    all.push(p);
  }
  for (const p of all) {
    const tokens = [p.fg].concat(p.bg, p.alt || []).filter((l) => l.slice(0, 2) === "--");
    if (!tokens.length) continue;
    const entry = { fg: p.fg, bg: p.bg, k: p.k };
    if (p.alt) entry.alt = p.alt;
    if (p.soft) entry.soft = 1;
    const kn = (known || []).find((k) => k.kind === "contrast" && k.key === p.key);
    if (kn) entry.kn = kn.ratio;
    entry.what = p.what;
    entry.on = p.places[0] ? p.places[0].desc + (p.places[0].state ? " " + p.places[0].state : "") : "";
    themed.push(entry);
  }
  themed.sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : 1);
  const varsOut = {};
  for (const k of Object.keys(vars).sort()) varsOut[k] = { key: vars[k].key, def: vars[k].def, label: vars[k].label };
  return { vars: varsOut, pairs: themed };
}
function pairBlock(table) {
  const lines = [MARK_BEGIN, "  var VARS = " + JSON.stringify(table.vars, null, 2).replace(/\n/g, "\n  ") + ";", "  var PAIRS = ["];
  table.pairs.forEach((p, i) => lines.push("    " + JSON.stringify(p) + (i < table.pairs.length - 1 ? "," : "")));
  lines.push("  ];", "  " + MARK_END);
  return lines.join("\n");
}
function currentBlock(text) {
  const a = text.indexOf(MARK_BEGIN);
  const b = text.indexOf(MARK_END);
  if (a < 0 || b < 0) return null;
  return { start: a, end: b + MARK_END.length, text: text.slice(a, b + MARK_END.length) };
}

// The pairs of the site with EVERY optional field, list-item type and yes / no switch turned on (the same
// throwaway copy check-wiring builds), in two dropdown variants. The CMS table is the union of these and the
// real site, so an editor who switches a feature off or adds a block the site does not use yet cannot make it
// "out of date". -> [Map]
function maximalPairMaps(root, cfg, vars, known) {
  const { loadSources } = require("./lib/data");
  const { loadConfig } = require("./lib/cmsconfig");
  const { IgnoreList } = require("./lib/ignore");
  const { makePlan, applyPlan } = require("./lib/sentinel");
  const sources = loadSources(root).sources;
  const ignoreFile = path.join(SCRIPTS_DIR, "wiring-ignore.json");
  const ignore = new IgnoreList(exists(ignoreFile) ? readJson(ignoreFile) : {});
  const plan = makePlan(sources, loadConfig(root), (name, schema, check, injected) => ignore.match(name, schema, check, injected), { switches: true });
  const maps = [];
  for (const variant of [0, 1]) {
    const ws = new Workspace(root, { prefix: "covered-a11y-max-" });
    try {
      applyPlan(ws, plan, sources, { variant });
      const b = ws.build("max");
      if (!b.ok) throw new Error("the every-option copy of the site does not build:\n" + b.log.split("\n").slice(-8).join("\n"));
      maps.push(analyseSite(b.out, root, cfg, vars, known).pairs);
    } finally {
      ws.cleanup();
    }
  }
  return maps;
}

// VARS and PAIRS of a cms/contrast.js file (run in a sandbox: it is a plain script)
function readTable(file) {
  const box = { module: { exports: {} } };
  vm.runInNewContext(readText(file), box, { filename: file, timeout: 5000 });
  return box.module.exports;
}

// ---------------------------------------------------------------- main
function main() {
  const args = parseArgs(process.argv.slice(2), { site: "string", root: "string", max: "number", github: "boolean", writePairs: "boolean", noPairSync: "boolean", maximal: "boolean", strictStale: "boolean", unit: "boolean", listPairs: "boolean" });
  if (args.help) {
    console.log("usage: node scripts/check-a11y.js [--site <built site; default: build the checkout into a temp folder>] [--root <repo root>] [--max <n>] [--github] [--write-pairs] [--maximal] [--no-pair-sync] [--strict-stale] [--unit] [--list-pairs]");
    return 0;
  }
  if (args.unit) return require("./lib/a11y-unit").run();
  const root = path.resolve(args.root || REPO_ROOT);
  let siteDir = args.site ? path.resolve(args.site) : null;
  let tmp = null;
  if (siteDir) {
    if (!exists(siteDir)) {
      console.error("check-a11y: built site not found at " + siteDir + "\n  Pass an existing build with --site <dir>, or omit --site to build the checkout.");
      return 2;
    }
  } else {
    const b = freshBuild(root);
    tmp = b.tmp;
    if (!b.ok) {
      console.error("check-a11y: the site does not build\n" + b.log.split("\n").slice(-20).join("\n"));
      removeTree(b.tmp);
      return 2;
    }
    siteDir = b.out;
  }
  try {
    return run(args, root, siteDir);
  } finally {
    if (tmp) removeTree(tmp);
  }
}

function run(args, root, siteDir) {
  const cfg = readJson(path.join(SCRIPTS_DIR, "a11y-config.json"));
  const vars = themeVarMap(root);
  const knownFile = path.join(SCRIPTS_DIR, "a11y-known-issues.json");
  const known = exists(knownFile) ? readJson(knownFile).entries || [] : [];
  const strict = strictStale(args);
  const res = analyseSite(siteDir, root, cfg, vars, known);
  const errors = [];
  const warnings = [];
  const knownHit = [];
  const stale = [];
  const addFinding = (list, f) => list.push(f);

  // ---- structure
  for (const f of res.findings) {
    const entry = known.find((k) => k.rule === f.rule && (!k.url || k.url === f.url) && (!k.where || f.where === k.where || f.message.includes(k.where)));
    if (entry) {
      entry.used = true;
      knownHit.push({ kind: "structure", f, entry });
      continue;
    }
    const sev = f.severity === "error" && res.indexable.get(f.url) === false ? "warn" : f.severity;
    const item = { group: sev === "error" ? "structure" : "structure", rule: f.rule, url: f.url, where: f.where, message: f.message, noindex: res.indexable.get(f.url) === false, source: sourceFor(root, f.url) };
    addFinding(sev === "error" ? errors : warnings, item);
  }

  // ---- contrast
  const values = res.values || {};
  let evaluated = 0;
  let passing = 0;
  const pairResults = [];
  for (const p of res.pairs.values()) {
    const r = CC.evaluatePair(p, values);
    if (!r) {
      warnings.push({ group: "contrast", rule: "contrast-unresolved", url: p.places[0] ? p.places[0].url : "", where: p.places[0] ? p.places[0].desc : "", message: "could not work out the colours of a pairing (" + p.key + ")", source: "src/_data/theme.json" });
      continue;
    }
    evaluated += 1;
    pairResults.push({ p, r });
    if (r.status === "pass") {
      passing += 1;
      continue;
    }
    const names = rolesOf(p, vars, r);
    const ratioText = CC.fmt(r.ratio, r.need) + ":1" + (r.altRatio !== null ? " (" + CC.fmt(r.altRatio, r.need) + ":1 against the other side of the ring)" : "");
    const msg = (p.what === "focus ring" ? "keyboard focus ring" : KIND_WORD[p.k]) + " contrast " + ratioText + ", needs " + needText(r.need) + ": " + names.fgText + " on " + names.bgText;
    const detail = "seen at " + whereText(p) + (p.picture ? "\n(a picture is also painted behind this text; this check can only see its plain background colour)" : "");
    const nonTheme = ![p.fg].concat(p.bg).some((l) => l.slice(0, 2) === "--");
    const sev = r.status === "warn" ? "warn" : "error";
    // known issues: an existing defect that was recorded with a reason; it may not get worse
    const entry = known.find((k) => k.kind === "contrast" && k.key === p.key);
    if (entry) {
      entry.used = true;
      if (Number(CC.fmt(r.ratio, r.need)) < entry.ratio - 0.05) {
        errors.push({ group: "contrast", rule: "contrast", url: "", where: "", message: "a known low-contrast pairing got WORSE (recorded " + entry.ratio + ":1, now " + ratioText + "): " + names.fgText + " on " + names.bgText, detail, source: "src/_data/theme.json" });
      } else knownHit.push({ kind: "contrast", f: { message: msg, detail }, entry });
      continue;
    }
    (sev === "error" ? errors : warnings).push({ group: "contrast", rule: "contrast", url: "", where: "", message: msg, detail, source: nonTheme ? "src/_includes/site-styles.css" : "src/_data/theme.json", fix: nonTheme ? "These colours are fixed in the stylesheet, not in the CMS." : "Change one of the two colours under \u201CColours & theme\u201D in the CMS (or keep the roles apart by at least " + needText(r.need) + ")." });
  }
  for (const u of res.unresolved) warnings.push({ group: "contrast", rule: "contrast-unresolved", url: u.url, where: u.where, message: u.why, source: "src/_includes/site-styles.css" });
  // text drawn over a picture is not measurable
  const pictureCount = [...res.pairs.values()].filter((p) => p.picture).length;

  // ---- focus rings that do not exist
  const ringSeen = new Set();
  for (const x of res.noRing) {
    const k = x.where;
    if (ringSeen.has(k)) continue;
    ringSeen.add(k);
    warnings.push({ group: "structure", rule: "focus-visible", url: x.url, where: x.where, message: "no visible outline when this control has keyboard focus (fine only if the stylesheet marks focus some other way)", source: "src/_includes/site-styles.css" });
  }

  // ---- stale entries in the known-issues file and the config
  for (const k of known) {
    if (!k.used) stale.push("a11y-known-issues.json entry " + (k.key || k.rule + " " + (k.where || "")) + " matches nothing any more (fixed, or the markup changed)");
    if (!k.reason || collapse(k.reason).length < 20) errors.push({ group: "config", rule: "known-issue", message: "scripts/a11y-known-issues.json entry needs a reason of at least 20 characters: " + JSON.stringify(k).slice(0, 90), source: "scripts/a11y-known-issues.json" });
  }
  const css = res.styler ? res.styler.rules : [];
  for (const cl of (cfg.stateClasses || {}).list || []) {
    if (!css.some((r) => r.sels.some((s) => s.parts.some((p) => p.c.classes.includes(cl))))) stale.push("a11y-config.json stateClasses entry '" + cl + "' is used by no stylesheet rule");
  }
  for (const s of stale) (strict ? errors : warnings).push({ group: "config", rule: "stale", message: s, source: "scripts/a11y-known-issues.json" });

  // ---- the CMS pair table must know every pairing the site really contains
  const cmsFile = path.join(root, "cms", "contrast.js");
  const siteMaps = [res.pairs];
  let maxMaps = [];
  if (args.writePairs || args.maximal) maxMaps = maximalPairMaps(root, cfg, vars, known);
  if (args.writePairs) {
    const table = pairTable(siteMaps.concat(maxMaps), vars, known);
    const block = pairBlock(table);
    const text = fs.readFileSync(cmsFile, "utf8");
    const cur = currentBlock(text);
    if (!cur) {
      console.error("check-a11y: cms/contrast.js has no PAIRS markers");
      return 2;
    }
    const eol = text.includes("\r\n") ? "\r\n" : "\n";
    fs.writeFileSync(cmsFile, text.slice(0, cur.start) + block.replace(/\n/g, eol) + text.slice(cur.end));
    console.log("check-a11y: wrote " + table.pairs.length + " colour pairings to cms/contrast.js (the site, plus the site with every optional field switched on)");
  } else if (!args.noPairSync) {
    if (!exists(cmsFile)) errors.push({ group: "cms", rule: "pair-table", message: "cms/contrast.js is missing", source: "cms/contrast.js" });
    else {
      let table = null;
      try {
        table = readTable(cmsFile);
      } catch (e) {
        errors.push({ group: "cms", rule: "pair-table", message: "cms/contrast.js does not load: " + e.message, source: "cms/contrast.js" });
      }
      if (table) {
        const known2 = new Set((table.PAIRS || []).map((e) => pairKey(e.fg, e.bg, e.k, e.alt || null, e.what)));
        const wantVars = JSON.stringify(Object.fromEntries(Object.keys(vars).sort().map((k) => [k, { key: vars[k].key, def: vars[k].def, label: vars[k].label }])));
        if (JSON.stringify(table.VARS) !== wantVars) errors.push({ group: "cms", rule: "pair-table", message: "the theme colour names / defaults in cms/contrast.js no longer match src/_includes/theme-vars.njk and the CMS labels. Run: node scripts/check-a11y.js --write-pairs", source: "cms/contrast.js" });
        const missing = [];
        for (const m of siteMaps.concat(maxMaps)) for (const p of m.values()) {
          const themed = [p.fg].concat(p.bg, p.alt || []).some((l) => l.slice(0, 2) === "--");
          if (themed && !known2.has(p.key) && !missing.some((x) => x.key === p.key)) missing.push(p);
        }
        if (missing.length) {
          errors.push({ group: "cms", rule: "pair-table", message: missing.length + " colour pairing" + (missing.length === 1 ? "" : "s") + " in the site's stylesheet and templates " + (missing.length === 1 ? "is" : "are") + " not in the table behind the live contrast report in the CMS (cms/contrast.js), e.g. " + missing.slice(0, 2).map((p) => p.key).join("  /  ") + ". Run: node scripts/check-a11y.js --write-pairs", source: "cms/contrast.js" });
        }
      }
    }
  }

  if (args.listPairs) {
    for (const { p, r } of pairResults.sort((a, b) => a.r.ratio - b.r.ratio)) console.log(CC.fmt(r.ratio, r.need).padStart(6) + " need " + needText(r.need).padEnd(5) + " " + r.status.padEnd(4) + " " + p.what.padEnd(17) + p.key);
  }

  // ---- output
  return output(args, root, { res, errors, warnings, knownHit, evaluated, passing, vars, pictureCount, pairResults, siteDir });
}

// ---------------------------------------------------------------- output
function ghEscape(s, prop) {
  let t = String(s).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
  if (prop) t = t.replace(/:/g, "%3A").replace(/,/g, "%2C");
  return t;
}
const oneLine = (s) => collapse(String(s));
function mdCode(s) {
  return "`" + oneLine(s).replace(/`/g, "'").replace(/\|/g, "\\|").replace(/[<>]/g, "") + "`";
}
function mdText(s) {
  return oneLine(s).replace(/([\\`*_{}\[\]()#+!|<>~&])/g, "\\$1");
}

function output(args, root, d) {
  const { res, errors, warnings, knownHit, evaluated, passing, vars } = d;
  const max = args.max || 200;
  console.log("check-a11y: " + res.pages.length + " page(s) (" + res.pages.join(" ") + "), " + res.skipped.length + " internal tool page(s) skipped");
  console.log("  contrast: " + evaluated + " distinct colour pairings from " + res.stats.texts + " text runs and " + res.stats.variants + " hover / focus / toggled-state variants; " + passing + " pass, " + (evaluated - passing) + " do not");
  if (res.unsupported.size) console.log("  note: selectors this check could not interpret (never matched): " + [...res.unsupported].map(([k, v]) => k + " x" + v).join(", "));
  if (d.pictureCount) console.log("  note: " + d.pictureCount + " pairing(s) have a picture painted behind the text; only the plain background colour behind it is measured");
  if (knownHit.length) console.log("  known issues recorded in scripts/a11y-known-issues.json (not failing; they may not get worse): " + knownHit.length);

  const printList = (label, list) => {
    if (!list.length) return;
    console.log("\n== " + label + " (" + list.length + ")");
    let shown = 0;
    for (const it of list) {
      if (shown >= max) break;
      shown += 1;
      const where = it.url ? it.url + (it.where ? " " + it.where : "") : "";
      console.log("  - " + (it.rule ? "[" + it.rule + "] " : "") + oneLine(it.message) + (where ? "\n      on " + oneLine(where) + (it.noindex ? " (page is not indexed)" : "") : ""));
      if (it.detail) console.log("      " + String(it.detail).split("\n").map(oneLine).join("\n      "));
      if (it.fix) console.log("      " + oneLine(it.fix));
    }
    if (list.length > shown) console.log("  ... " + (list.length - shown) + " more (use --max <n>)");
  };
  printList("ERRORS", errors);
  printList("WARNINGS", warnings);
  if (knownHit.length) {
    console.log("\n== KNOWN ISSUES (recorded, not failing)");
    for (const k of knownHit) console.log("  - " + oneLine(k.f.message) + "\n      why recorded: " + oneLine(k.entry.reason));
  }

  if (args.github) writeGithub(root, d);

  const code = errors.length ? 1 : 0;
  if (code) console.log("\nCHECK-A11Y FAILED: " + errors.length + " error" + (errors.length === 1 ? "" : "s") + ", " + warnings.length + " warning" + (warnings.length === 1 ? "" : "s"));
  else console.log("\nCHECK-A11Y OK" + (warnings.length ? " (" + warnings.length + " warning" + (warnings.length === 1 ? "" : "s") + " listed above)" : ""));
  return code;
}

// annotations + job summary; nothing here needs a token or write permission
function writeGithub(root, d) {
  const { res, errors, warnings, knownHit, evaluated, passing, vars } = d;
  const annotate = (level, it) => {
    const file = it.source || "src/index.njk";
    const title = (it.rule || "accessibility") + (it.url ? " " + it.url : "");
    console.log("::" + level + " file=" + ghEscape(file, true) + ",title=" + ghEscape(oneLine(title), true) + "::" + ghEscape(oneLine(it.message) + (it.where ? " (" + oneLine(it.where) + ")" : "")));
  };
  console.log("");
  for (const it of errors.slice(0, 40)) annotate("error", it);
  for (const it of warnings.slice(0, 40)) annotate("warning", it);
  const lines = [];
  lines.push("## Accessibility gate: " + (errors.length ? "FAILED" : "passed"));
  lines.push("");
  lines.push("| | |");
  lines.push("|---|---|");
  lines.push("| Pages checked | " + res.pages.length + " (" + res.pages.map(mdCode).join(" ") + ") |");
  lines.push("| Errors | **" + errors.length + "** |");
  lines.push("| Warnings | " + warnings.length + " |");
  lines.push("| Known issues (recorded, not failing) | " + knownHit.length + " |");
  lines.push("| Colour pairings measured | " + evaluated + " (" + passing + " pass) |");
  lines.push("");
  const section = (title, list) => {
    if (!list.length) return;
    lines.push("### " + title + " (" + list.length + ")");
    lines.push("");
    for (const it of list.slice(0, 60)) lines.push("- " + (it.rule ? mdCode(it.rule) + " " : "") + mdText(it.message) + (it.url ? " on " + mdCode(it.url + (it.where ? " " + it.where : "")) : "") + (it.detail ? "<br>" + mdText(String(it.detail).split("\n")[0]) : ""));
    if (list.length > 60) lines.push("- ... and " + (list.length - 60) + " more");
    lines.push("");
  };
  section("Errors (these fail the check)", errors);
  section("Warnings", warnings);
  if (knownHit.length) {
    lines.push("### Known issues (recorded in `scripts/a11y-known-issues.json`)");
    lines.push("");
    for (const k of knownHit) lines.push("- " + mdText(k.f.message) + "<br>Why: " + mdText(k.entry.reason));
    lines.push("");
  }
  lines.push("<details><summary>What this check covers</summary>");
  lines.push("");
  lines.push("Contrast (WCAG 2.2 1.4.3, 1.4.11): every text, symbol, placeholder and keyboard-focus-ring colour against what is behind it, read from the built stylesheet and `theme.json`, in the resting state and in hover, focus, pressed and toggled states, at a wide and a narrow screen. Structure: headings, landmarks, lang, title, skip link, link / button / form-control names, image alt text, duplicate ids, tabindex, aria-hidden misuse, video and audio, reduced motion. Not covered: text over photos and video, text size and spacing changes, target size, anything that needs a real screen reader.");
  lines.push("");
  lines.push("</details>");
  const target = process.env.GITHUB_STEP_SUMMARY;
  if (target) {
    try {
      fs.appendFileSync(target, lines.join("\n") + "\n");
    } catch (e) {
      console.log("::warning::could not write the job summary: " + ghEscape(e.message));
    }
  } else console.log("\n(no GITHUB_STEP_SUMMARY set: the summary would read)\n" + lines.join("\n"));
}

runMain("check-a11y", main);
