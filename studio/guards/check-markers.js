#!/usr/bin/env node
"use strict";
// check-markers: the Studio markers (data-cms*) on an edit build (CMS_EDIT=1) are true, resolvable, stable and harmless.
//
//   node studio/guards/check-markers.js [--root .] [--update] [--warnings] [--no-hostile] [--max 200]
//                                       [--site-normal <built dir> --site-edit <built dir>]
//
// Builds the checkout twice (a normal build and a CMS_EDIT=1 build; or reads --site-normal / --site-edit) and proves
// (studio/DESIGN.md section 3.4):
//   a. every data-cms* value parses, its file/field exist in studio/schema/studio-schema.json, kind and widget are compatible;
//   b. marker truth: the element shows the value its marker names (text, markdown, picture file, alt text, link address);
//   c. coverage ratchet: the visible text of the home page and /about/ that carries a marker may not shrink
//      (studio/schema/marker-coverage.json; --update rewrites it; --warnings lists the unmarked leaves);
//   d. hostile: with attack strings in every field the edit build keeps the same markers and gains no handler / script;
//   e. parity (the hard constraint): minus data-cms* attributes and the one overlay <script> tag, every edit-build file is
//      byte-identical to the normal build; the edit build has exactly two extra files; a normal build has no marker and no studio/.

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const REPO = path.resolve(__dirname, "..", "..");
const S = path.join(REPO, "scripts", "lib");
const { parseArgs, mkTmp, removeTree, Report, readText, clip } = require(path.join(S, "util"));
const { eleventyBin, Workspace } = require(path.join(S, "workspace"));
const { markersOf, resolveProblems, truthProblems, themeVarsOf } = require("../markers/analyse");
const { parseRef } = require("../markers/grammar");

const CLEAN_ENV = { COVERED_IMG_FAST: "1", STUDIO_API_URL: "", STUDIO_APP_URL: "", REVIEW_ID: "", COMMIT_REF: "", HEAD: "" };
const TAG_RE = /<script src="\/studio\/overlay\.js"[^>]*><\/script>/g;
const ATTR_RE = / data-cms[a-z-]*="[^"]*"/g;
const COVERAGE_PAGES = ["index.html", "about/index.html"];

// Same behaviour as the site's `safeUrl` filter (.eleventy.js); lib/rules.js is preferred once it exists.
function loadSafeUrl(root) {
  try {
    const rules = require(path.join(root, "lib", "rules.js"));
    if (typeof rules.safeUrl === "function") return rules.safeUrl;
  } catch (e) {
    /* not there yet */
  }
  return (value) => {
    const v = typeof value === "string" ? value.trim() : "";
    if (!v) return "/";
    if (/^\/(?!\/)/.test(v) || v.startsWith("#")) return v;
    if (/^(https?|mailto):/i.test(v)) return v;
    return "/";
  };
}

function build(dir, out, edit) {
  const env = Object.assign({}, process.env, CLEAN_ENV, { CMS_EDIT: edit ? "1" : "" });
  const r = spawnSync(process.execPath, [eleventyBin(REPO), "--quiet", "--output=" + out], { cwd: dir, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env });
  return { ok: r.status === 0 && fs.existsSync(out), out, log: (r.stdout || "") + (r.stderr || "") };
}

function listFiles(dir) {
  const out = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(path.relative(dir, p).split(path.sep).join("/"));
    }
  })(dir);
  return out.sort();
}

const isText = (f) => /\.(html|xml|css|txt|json|js|svg|webmanifest)$/i.test(f) || /^_redirects$|^_headers$/.test(f);
const htmlFiles = (dir) => listFiles(dir).filter((f) => f.endsWith(".html"));

function markerKey(m) {
  return [m.ref, m.kind].concat(["alt", "decorative", "href", "hide", "cssvar"].map((k) => (m.opts[k] === undefined ? "" : k + "=" + m.opts[k]))).join("|");
}

// names given to addPassthroughCopy in .eleventy.js
function passthroughOf(root) {
  try {
    const text = readText(path.join(root, ".eleventy.js"));
    return Array.from(text.matchAll(/addPassthroughCopy\(\s*"([^"]+)"/g)).map((m) => m[1]);
  } catch (e) {
    return [];
  }
}

// ---------------------------------------------------------------- (e) parity
// passthrough: folders/files .eleventy.js copies as they are (admin/, cms/ ...): Eleventy never renders them, so no overlay tag.
function parityProblems(normalDir, editDir, passthrough) {
  const pass = (passthrough || []).map((x) => String(x).replace(/\/+$/, ""));
  const probs = [];
  const nf = listFiles(normalDir);
  const ef = listFiles(editDir);
  const nset = new Set(nf);
  const eset = new Set(ef);
  const extra = ef.filter((f) => !nset.has(f));
  const missing = nf.filter((f) => !eset.has(f));
  const want = ["studio/content.json", "studio/overlay.js"];
  if (extra.join(",") !== want.join(",")) probs.push("the edit build must add exactly " + want.join(" and ") + ", it adds: " + (extra.join(", ") || "nothing"));
  if (missing.length) probs.push("the edit build lacks files of the normal build: " + missing.slice(0, 5).join(", "));
  for (const f of nf) {
    if (/(^|\/)studio\//.test(f)) probs.push("a normal build must contain no studio/ path, found " + f);
    if (isText(f) && /data-cms/.test(readText(path.join(normalDir, f)))) probs.push("a normal build must contain no data-cms attribute, found one in " + f);
  }
  let pages = 0;
  for (const f of nf) {
    if (!eset.has(f)) continue;
    const a = fs.readFileSync(path.join(normalDir, f));
    const bRaw = fs.readFileSync(path.join(editDir, f));
    let b = bRaw;
    if (f.endsWith(".html")) {
      const text = bRaw.toString("utf8");
      const tags = (text.match(TAG_RE) || []).length;
      const hasBody = text.includes("</body>");
      const copied = pass.some((x) => f === x || f.startsWith(x + "/"));
      if (hasBody && !copied && tags !== 1) probs.push(f + ": expected exactly one overlay <script> tag, found " + tags);
      if (!hasBody && tags) probs.push(f + ": overlay tag in a page without </body>");
      b = Buffer.from(text.replace(TAG_RE, "").replace(ATTR_RE, ""), "utf8");
      pages += 1;
    }
    if (!a.equals(b)) {
      const at = firstDiff(a, b);
      probs.push(f + ": differs from the normal build after removing data-cms* attributes and the overlay tag (first difference at byte " + at.at + ")\n  normal: " + JSON.stringify(at.a) + "\n  edit:   " + JSON.stringify(at.b));
    }
  }
  return { probs, pages };
}
function firstDiff(a, b) {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  return { at: i, a: a.slice(Math.max(0, i - 40), i + 60).toString("utf8"), b: b.slice(Math.max(0, i - 40), i + 60).toString("utf8") };
}

// ---------------------------------------------------------------- (c) coverage
function coverage(root, normalDir, markedKeys) {
  const { loadSources } = require(path.join(S, "data"));
  const { leaves } = require(path.join(S, "data"));
  const { Corpus, norm } = require(path.join(S, "corpus"));
  const { extractPage } = require(path.join(S, "html"));
  const texts = new Set();
  for (const f of COVERAGE_PAGES) {
    const p = path.join(normalDir, f);
    if (!fs.existsSync(p)) continue;
    for (const it of extractPage(readText(p)).items) if (it.kind === "text" || it.kind === "attr" || it.kind === "meta" || it.kind === "title") texts.add(norm(it.text));
  }
  const textList = Array.from(texts);
  const traced = new Map(); // key -> value
  const { sources } = loadSources(root);
  for (const s of sources) {
    if (s.kind === "njk") continue;
    const file = s.kind === "page" ? "pages:" + s.name : s.name;
    for (const l of leaves(s.data)) {
      if (typeof l.value !== "string" || !l.value.trim()) continue;
      const c = new Corpus();
      c.addLeaf(l.value);
      let hit = false;
      for (const e of c.exact) if (texts.has(e)) hit = true;
      if (!hit) for (const t of textList) if (c.has(t)) { hit = true; break; }
      if (hit) traced.set(file + "#/" + l.path.join("/"), l.value);
    }
  }
  const covered = [];
  const unmarked = [];
  for (const [k, v] of traced) (markedKeys.has(k) ? covered : unmarked).push(k === undefined ? "" : k + "\t" + clip(v, 60));
  return { covered: covered.map((x) => x.split("\t")[0]).sort(), unmarked: unmarked.sort() };
}

// ---------------------------------------------------------------- main
function main() {
  const args = parseArgs(process.argv.slice(2), { root: "string", update: "boolean", warnings: "boolean", noHostile: "boolean", max: "number", siteNormal: "string", siteEdit: "string" });
  if (args.help) {
    console.log("usage: node studio/guards/check-markers.js [--root <repo>] [--update] [--warnings] [--no-hostile] [--max <n>] [--site-normal <dir> --site-edit <dir>]");
    return 0;
  }
  const root = path.resolve(args.root || REPO);
  const report = new Report("check-markers");
  const safeUrl = loadSafeUrl(root);
  const tmp = mkTmp("covered-markers-");
  const workspaces = [];
  try {
    let normalDir = args.siteNormal && path.resolve(args.siteNormal);
    let editDir = args.siteEdit && path.resolve(args.siteEdit);
    if (!normalDir || !editDir) {
      // the checkout is built in place (like check-copy): Eleventy only reads it
      const n = build(root, path.join(tmp, "normal"), false);
      if (!n.ok) {
        report.add("Build", "the normal build fails", n.log.split("\n").slice(-15).join("\n"));
        return report.print();
      }
      const e = build(root, path.join(tmp, "edit"), true);
      if (!e.ok) {
        report.add("Build", "the CMS_EDIT=1 build fails", e.log.split("\n").slice(-15).join("\n"));
        return report.print();
      }
      normalDir = n.out;
      editDir = e.out;
    }

    const schemaFile = path.join(root, "studio", "schema", "studio-schema.json");
    const contentFile = path.join(editDir, "studio", "content.json");
    if (!fs.existsSync(schemaFile)) report.add("Schema", "studio/schema/studio-schema.json is missing", "Run: npm run studio:schema");
    if (!fs.existsSync(contentFile)) report.add("Content snapshot", "the edit build has no studio/content.json");
    if (report.failed) return report.print();
    const schema = JSON.parse(readText(schemaFile));
    const content = JSON.parse(readText(contentFile));

    // ---- (a) + (b)
    const themeFile = path.join(root, "src", "_includes", "theme-vars.njk");
    const themeVars = fs.existsSync(themeFile) ? themeVarsOf(readText(themeFile)) : null;
    const markedKeys = new Set();
    const allMarkers = new Map(); // page -> [marker]
    let total = 0;
    const kinds = {};
    for (const f of htmlFiles(editDir)) {
      const { markers } = markersOf(readText(path.join(editDir, f)));
      allMarkers.set(f, markers);
      for (const m of markers) {
        total += 1;
        kinds[m.kind] = (kinds[m.kind] || 0) + 1;
        const where = (s) => f + ": " + s;
        for (const p of resolveProblems(schema, content, m)) report.add("Marker does not match the CMS schema", where(p));
        for (const p of truthProblems(content, m, safeUrl, { themeVars })) report.add("Marker does not tell the truth", where(p));
        if (COVERAGE_PAGES.includes(f)) {
          const toKey = (ref) => {
            const q = parseRef(ref);
            return q ? q.file + "#/" + q.segs.join("/") : null;
          };
          markedKeys.add(toKey(m.ref));
          if (m.opts.alt) markedKeys.add(toKey(m.opts.alt));
        }
      }
    }
    report.note("markers: " + total + " on " + allMarkers.size + " pages (" + Object.keys(kinds).sort().map((k) => k + " " + kinds[k]).join(", ") + ")");
    if (total === 0) report.add("Markers", "the edit build contains no markers at all");

    // ---- (c) coverage ratchet
    const cov = coverage(root, normalDir, markedKeys);
    const covFile = path.join(root, "studio", "schema", "marker-coverage.json");
    if (args.update) {
      fs.writeFileSync(covFile, JSON.stringify({ version: 1, note: "Visible text of / and /about/ that carries a Studio marker. May only grow. Update with: node studio/guards/check-markers.js --update", count: cov.covered.length, covered: cov.covered }, null, 2) + "\n");
      report.note("coverage: wrote " + cov.covered.length + " covered leaves to studio/schema/marker-coverage.json");
    } else if (!fs.existsSync(covFile)) {
      report.add("Coverage ratchet", "studio/schema/marker-coverage.json is missing", "Run: node studio/guards/check-markers.js --update");
    } else {
      const have = JSON.parse(readText(covFile));
      const now = new Set(cov.covered);
      const lost = (have.covered || []).filter((k) => !now.has(k));
      for (const k of lost) report.add("Coverage ratchet", "no longer editable in place: " + k, "A marker was removed (or the text moved). Restore the marker, or run --update if this is deliberate.");
      report.note("coverage: " + cov.covered.length + " visible text fields editable in place (ratchet " + (have.count || 0) + "), " + cov.unmarked.length + " visible but Fields-panel-only");
      if (cov.covered.length > (have.count || 0)) report.note("  (more than the ratchet: run with --update to raise it)");
    }
    if (args.warnings) {
      report.note("Fields panel only (visible text without a marker):");
      for (const u of cov.unmarked) report.note("  " + u.replace("\t", "   "));
    }

    // ---- (e) parity
    const par = parityProblems(normalDir, editDir, passthroughOf(root));
    for (const p of par.probs) report.add("Parity: production output must be unchanged", p);
    report.note("parity: " + par.pages + " html pages identical to the normal build once data-cms* and the overlay tag are removed");

    // ---- (d) hostile
    if (!args.noHostile && !report.failed) hostile(root, report, workspaces);
    return report.print({ max: args.max || 200, okMessage: "OK" });
  } finally {
    for (const w of workspaces) w.cleanup();
    removeTree(tmp);
  }
}

function hostile(root, report, workspaces) {
  const { loadSources } = require(path.join(S, "data"));
  const { loadConfig } = require(path.join(S, "cmsconfig"));
  const { makePlan, applyPlan } = require(path.join(S, "sentinel"));
  const { analysePage } = require(path.join(S, "hostile"));
  const cfg = loadConfig(root);
  const { sources } = loadSources(root);
  const plan = makePlan(sources, cfg, null);
  const SKIP = new Set(["permalink", "layout"]);
  plan.edits = plan.edits.filter((e) => e.dev !== true && !SKIP.has(String(e.path[e.path.length - 1])));
  const payload = (s) => s + ' HXAPP<img src=x onerror=alert(1)></script><script>alert(2)</script></style><script>alert(3)</script>"\'><svg onload=alert(4)>{{ 90911 + 6 }}{% if true %}HXTPL{% endif %}';
  const run = (label, opts) => {
    const ws = new Workspace(root, { prefix: "covered-markers-" });
    workspaces.push(ws);
    applyPlan(ws, plan, sources, opts);
    const b = build(ws.dir, path.join(ws.dir, "_out_" + label), true);
    return { ws, b };
  };
  const ref = run("ref", {});
  if (!ref.b.ok) return report.add("Hostile", "the reference edit build does not build", ref.b.log.split("\n").slice(-12).join("\n"));
  const bad = run("hostile", { payload });
  if (!bad.b.ok) return report.add("Hostile", "the edit build with attack strings in every field does not build", bad.b.log.split("\n").slice(-12).join("\n"));
  let pages = 0;
  let markers = 0;
  for (const f of htmlFiles(ref.b.out)) {
    const hp = path.join(bad.b.out, f);
    if (!fs.existsSync(hp)) {
      report.add("Hostile", f + ": page missing from the hostile build");
      continue;
    }
    const a = markersOf(readText(path.join(ref.b.out, f))).markers.map(markerKey).sort();
    const b = markersOf(readText(hp)).markers.map(markerKey).sort();
    markers += a.length;
    pages += 1;
    // The attack build may hold more list items than the reference (the test plan adds some), so a new marker is fine
    // when it is the same field of another list item; a marker for a field the reference never had, or one that
    // disappeared, means a reference was built from data.
    const shape = (k) => k.replace(/\.[0-9]+(?=[.|])/g, ".#");
    const setA = new Set(a);
    const setB = new Set(b);
    const shapesA = new Set(a.map(shape));
    const lost = a.filter((x) => !setB.has(x)).slice(0, 3);
    const odd = b.filter((x) => !setA.has(x) && !shapesA.has(shape(x))).slice(0, 3);
    if (lost.length || odd.length) {
      const detail = (lost.length ? "lost: " + lost.join("; ") + " " : "") + (odd.length ? "new: " + odd.join("; ") : "");
      report.add("Hostile: markers must come from the template, never from data", f + ": the markers changed when the data changed", detail);
    }
    const ha = analysePage(readText(path.join(ref.b.out, f)));
    const hb = analysePage(readText(hp));
    const known = new Set(ha.handlers.map((x) => x.el + "|" + x.attr + "|" + x.value));
    for (const x of hb.handlers) if (!known.has(x.el + "|" + x.attr + "|" + x.value)) report.add("Hostile: injection", f + ": <" + x.el + "> gained attribute " + x.attr, clip(x.value, 80));
    if (hb.scripts.length > ha.scripts.length) report.add("Hostile: injection", f + ": " + (hb.scripts.length - ha.scripts.length) + " extra <script> element(s) (only the overlay tag is allowed)");
    const overlay = (s) => s.filter((x) => x.attribs && x.attribs.src === "/studio/overlay.js").length;
    if (overlay(hb.scripts) !== overlay(ha.scripts)) report.add("Hostile: injection", f + ": the overlay script tag count changed");
  }
  report.note("hostile: " + markers + " markers on " + pages + " pages unchanged with attack strings in every field");
}

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (e) {
    console.error(e && e.stack ? e.stack : e);
    process.exitCode = 2;
  }
}

module.exports = { passthroughOf, parityProblems, markerKey, TAG_RE, ATTR_RE };
