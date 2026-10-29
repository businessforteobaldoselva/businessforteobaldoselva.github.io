#!/usr/bin/env node
"use strict";
// check-history (Studio unit D): static rules for the History / Help / Tour / Palette overlay extensions and for the
// restore service, plus pure-fixture proofs of the restore maths and a documentation completeness check.
//
//   node studio/guards/check-history.js [--root <repo>]
//
// 1. Overlay rules for studio/overlay/ext/*.js (same spirit as check-overlay, DESIGN 9, enforced here for unit D's files):
//    no innerHTML / outerHTML / insertAdjacentHTML / document.write / eval / new Function / string timers / srcdoc /
//    createElement / import() / on*-property assignment / document.cookie / postMessage / window.open;
//    NO network primitive at all (fetch, XMLHttpRequest, WebSocket, EventSource, sendBeacon): everything goes through
//    studio.api; no URL literal to another host and no CDN; every use of localStorage sits inside try/catch;
//    every el(...) call uses only tags and props that the contract's h() allows (so `style`, `onclick`, `<script>` fail here).
// 2. ext.css: no @import, no external url(), no expression().
// 3. The restore path (studio/api/services/history*.js) never calls a Git write method: its only way to write is
//    drafts.createFromOps (the validated pipeline, studio/ branches only).
// 4. invertDiff round-trips mutated copies of every real src/_data/*.json (expect on every replace/remove).
// 5. docs/STUDIO-RUNBOOK.md names every environment variable of DESIGN 7.7 and the exact GitHub App permissions;
//    studio/THREAT-MODEL.md exists with its required sections.
// 6. If studio/overlay/manifest.json exists, D's four ext files and ext.css are in the contract order.
// Exit 0 clean, 1 violations.

const fs = require("fs");
const path = require("path");

const argv = process.argv.slice(2);
const rootArg = argv.indexOf("--root") >= 0 ? argv[argv.indexOf("--root") + 1] : path.resolve(__dirname, "..", "..");
const ROOT = path.resolve(rootArg);
const acorn = require(path.join(ROOT, "node_modules", "acorn"));
const walk = require(path.join(ROOT, "node_modules", "acorn-walk"));

const problems = [];
const fail = (where, msg) => problems.push(where + ": " + msg);
const rel = (p) => path.relative(ROOT, p).split(path.sep).join("/");
const read = (p) => fs.readFileSync(p, "utf8");

// ---- the contract's h() allow-lists (DESIGN 10.2): tags we use must be inside "~25 HTML tags", props inside the list
const TAGS = new Set(["div", "span", "p", "ul", "ol", "li", "h2", "h3", "h4", "button", "a", "strong", "em", "label", "input", "select", "textarea", "section", "header", "footer", "nav"]);
const PROPS = new Set("class id type value placeholder title role tabindex hidden disabled checked min max rows for name href target rel src alt width height open autocomplete spellcheck on".split(" "));
const BANNED_PROPS = new Set(["innerHTML", "outerHTML", "insertAdjacentHTML", "srcdoc", "cookie", "createContextualFragment"]);
const NET_IDS = new Set(["fetch", "XMLHttpRequest", "WebSocket", "EventSource", "sendBeacon", "importScripts", "Worker", "SharedWorker"]);
const OKAY_HOSTS = /^(localhost|127\.0\.0\.1|\[::1\])$/;
const CDN = /(cdn|unpkg|jsdelivr|cdnjs|googleapis|gstatic|fonts\.|jquery|bootstrapcdn|cloudflare)/i;

function checkOverlayFile(file) {
  const where = rel(file);
  const src = read(file);
  let ast;
  try {
    ast = acorn.parse(src, { ecmaVersion: 2020, sourceType: "script", locations: true });
  } catch (e) {
    fail(where, "does not parse: " + e.message);
    return;
  }
  if (!/^\(function \(S\) \{\s*\n\s*"use strict";/.test(src)) fail(where, 'must start with (function (S) { "use strict";');
  if (!/\}\)\(typeof window !== "undefined" \? window\.__CoveredStudioBoot : null\);\s*$/.test(src)) fail(where, "must end with })(typeof window !== \"undefined\" ? window.__CoveredStudioBoot : null);");
  const at = (n) => where + ":" + (n.loc ? n.loc.start.line : "?");

  walk.ancestor(ast, {
    MemberExpression(n, _s, anc) {
      const name = !n.computed && n.property.type === "Identifier" ? n.property.name : n.computed && n.property.type === "Literal" ? String(n.property.value) : "";
      if (BANNED_PROPS.has(name)) fail(at(n), "uses ." + name + " (editor/server text must only reach the DOM as text nodes)");
      if (name === "write" || name === "writeln") { if (n.object.type === "Identifier" && n.object.name === "document") fail(at(n), "uses document." + name); }
      if (name === "open" && n.object.type === "Identifier" && n.object.name === "window") fail(at(n), "uses window.open");
      if (name === "postMessage") fail(at(n), "uses postMessage (only the login broker in unit C may)");
      if (name === "localStorage" || (n.object.type === "Identifier" && n.object.name === "localStorage")) {
        if (!anc.some((a) => a.type === "TryStatement")) fail(at(n), "localStorage used outside try/catch");
      }
    },
    Identifier(n, _s, anc) {
      if (n.name === "eval") fail(at(n), "uses eval");
      if (n.name === "localStorage" && !anc.some((a) => a.type === "TryStatement")) {
        const parent = anc[anc.length - 2];
        if (!(parent && parent.type === "MemberExpression" && parent.property === n)) fail(at(n), "localStorage used outside try/catch");
      }
      if (NET_IDS.has(n.name)) {
        const parent = anc[anc.length - 2];
        const isProp = parent && parent.type === "MemberExpression" && parent.property === n && !parent.computed;
        const isKey = parent && parent.type === "Property" && parent.key === n && !parent.computed;
        if (!isProp && !isKey) fail(at(n), "references " + n.name + ": all network access must go through studio.api");
        else if (isProp && n.name === "sendBeacon") fail(at(n), "uses sendBeacon");
      }
    },
    NewExpression(n) {
      if (n.callee.type === "Identifier" && n.callee.name === "Function") fail(at(n), "uses new Function");
    },
    ImportExpression(n) { fail(at(n), "uses dynamic import()"); },
    CallExpression(n) {
      const c = n.callee;
      if (c.type === "Identifier" && c.name === "Function") fail(at(n), "calls Function()");
      const cname = c.type === "Identifier" ? c.name : c.type === "MemberExpression" && !c.computed ? c.property.name : "";
      if (cname === "createElement" || cname === "createElementNS") fail(at(n), "uses " + cname + " (h() is the only element factory)");
      if ((cname === "setTimeout" || cname === "setInterval") && n.arguments[0] && (n.arguments[0].type === "Literal" || n.arguments[0].type === "TemplateLiteral")) fail(at(n), cname + " with a string");
      if (cname === "el" && c.type === "Identifier") {
        const tag = n.arguments[0];
        if (!tag || tag.type !== "Literal" || !TAGS.has(tag.value)) fail(at(n), "el() tag is not a literal from the allowed list: " + (tag && tag.value));
        const props = n.arguments[1];
        if (props && props.type === "ObjectExpression") {
          for (const p of props.properties) {
            if (p.type !== "Property" || p.computed) { fail(at(n), "el() props must be plain keys"); continue; }
            const k = p.key.type === "Identifier" ? p.key.name : String(p.key.value);
            if (!(PROPS.has(k) || /^aria-[a-z]+$/.test(k) || /^data-[a-z-]+$/.test(k))) fail(at(n), "el() prop not allowed by h(): " + k);
            if (k === "on" && p.value.type === "ObjectExpression") {
              for (const q of p.value.properties) { const ek = q.key && (q.key.name || q.key.value); if (/^on/i.test(String(ek))) fail(at(n), "event name must not start with 'on': " + ek); }
            }
          }
        }
      }
    },
    AssignmentExpression(n) {
      const l = n.left;
      if (l.type === "MemberExpression" && !l.computed && /^on[a-z]+$/.test(l.property.name)) fail(at(n), "assigns the " + l.property.name + " handler property");
      if (l.type === "MemberExpression" && !l.computed && (l.property.name === "href" || l.property.name === "src") && l.object.type === "Identifier") fail(at(n), "assigns ." + l.property.name + " directly (use h() so safeHref applies)");
    },
    Literal(n) {
      if (typeof n.value !== "string") return;
      for (const m of n.value.matchAll(/(?:https?:)?\/\/([A-Za-z0-9.\-[\]:]+)/g)) {
        const host = m[1].replace(/:\d+$/, "");
        if (!OKAY_HOSTS.test(host)) fail(at(n), "URL literal to another host: " + m[0]);
        if (CDN.test(host)) fail(at(n), "CDN host: " + m[0]);
      }
    },
  });
  // the same URL rule for template literals / comments is not needed: templates are not used for URLs here
}

function checkCss(file) {
  const where = rel(file);
  const css = read(file);
  if (/@import/i.test(css)) fail(where, "@import");
  if (/expression\s*\(/i.test(css)) fail(where, "expression()");
  for (const m of css.matchAll(/url\(\s*['"]?([^'")]+)/gi)) if (!/^data:image\//.test(m[1])) fail(where, "url(" + m[1] + ") is not an inline data image");
  if (/behavior\s*:|-moz-binding/i.test(css)) fail(where, "script-capable CSS property");
}

// ---- 1/2: the overlay extension files
const extDir = path.join(ROOT, "studio", "overlay", "ext");
const EXPECT = ["history.js", "help.js", "tour.js", "palette.js", "ext.css"];
for (const f of EXPECT) {
  const p = path.join(extDir, f);
  if (!fs.existsSync(p)) { fail("studio/overlay/ext/" + f, "missing"); continue; }
  if (f.endsWith(".js")) checkOverlayFile(p); else checkCss(p);
}

// ---- 3: restore never writes to Git itself
const GIT_WRITES = /\b(commitFiles|createBranch|resetBranch|openPr|updatePr|markReady|closePr|deleteBranch|merge|force)\b\s*[:(]/;
for (const f of ["history.js", "history-diff.js"]) {
  const p = path.join(ROOT, "studio", "api", "services", f);
  if (!fs.existsSync(p)) { fail("studio/api/services/" + f, "missing"); continue; }
  const text = read(p).replace(/\/\/[^\n]*/g, ""); // comments may explain the rule
  const m = GIT_WRITES.exec(text);
  if (m) fail("studio/api/services/" + f, "calls a Git write method (" + m[1] + "): restore must go through drafts.createFromOps");
  if (/\bfetch\s*\(|require\(["'](?:node:)?(?:fs|child_process|http|https|net|path)["']\)/.test(text)) fail("studio/api/services/" + f, "must stay portable: no fetch / node:* modules");
  if (/\bprocess\b|\bBuffer\b/.test(text)) fail("studio/api/services/" + f, "must stay portable: no process / Buffer");
}
{
  const p = path.join(ROOT, "studio", "api", "services", "history.js");
  if (fs.existsSync(p) && !/drafts\.createFromOps\(/.test(read(p))) fail("studio/api/services/history.js", "restore must call drafts.createFromOps");
  if (fs.existsSync(p) && !/labels:\s*\["studio-draft",\s*"studio-revert"\]/.test(read(p))) fail("studio/api/services/history.js", "restore drafts must carry the studio-draft and studio-revert labels");
}

// ---- 4: restore maths on real data
try {
  const D = require(path.join(ROOT, "studio", "api", "services", "history-diff.js"));
  const dataDir = path.join(ROOT, "src", "_data");
  let n = 0;
  let seed = 7;
  const rnd = (k) => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return (((t ^ (t >>> 14)) >>> 0) % 4294967296) % k; };
  const mutate = (v, depth) => {
    if (Array.isArray(v)) {
      const a = v.map((x) => (rnd(3) ? x : mutate(x, depth + 1)));
      if (a.length > 1 && rnd(2) === 0) a.reverse();
      if (a.length && rnd(3) === 0) a.splice(rnd(a.length), 1);
      if (a.length && rnd(3) === 0) a.push(JSON.parse(JSON.stringify(a[rnd(a.length)])));
      return a;
    }
    if (v && typeof v === "object") { const o = {}; for (const k of Object.keys(v)) o[k] = rnd(2) ? mutate(v[k], depth + 1) : v[k]; return o; }
    if (typeof v === "string") return rnd(2) ? v + " edited" : v;
    if (typeof v === "boolean") return rnd(2) ? !v : v;
    return v;
  };
  for (const f of fs.readdirSync(dataDir).filter((x) => x.endsWith(".json"))) {
    const before = JSON.parse(read(path.join(dataDir, f)));
    for (let i = 0; i < 12; i++) {
      const after = mutate(JSON.parse(JSON.stringify(before)), 0);
      const ops = D.invertDiff({ file: "src/_data/" + f, before, after });
      const doc = JSON.parse(JSON.stringify(after));
      let ok = true;
      for (const op of ops) {
        if (op.op === "replace" || op.op === "remove") {
          const here = D.getAt(doc, op.path);
          if (!("expect" in op) || !here.found || !D.deepEqual(here.value, op.expect)) { fail("invertDiff " + f, op.op + " " + op.path + " has no matching expect"); ok = false; break; }
        }
        if (!D.applyOp(doc, op)) { fail("invertDiff " + f, "cannot apply " + op.op + " " + op.path); ok = false; break; }
      }
      if (ok && !D.deepEqual(doc, before)) fail("invertDiff " + f, "inverse ops do not restore the original (mutation " + i + ")");
      n++;
    }
  }
  if (!n) fail("invertDiff", "no data files found to test");
} catch (e) {
  fail("invertDiff", "could not run: " + e.message);
}

// ---- 5: docs
{
  const design = path.join(ROOT, "studio", "DESIGN.md");
  const runbook = path.join(ROOT, "docs", "STUDIO-RUNBOOK.md");
  const threat = path.join(ROOT, "studio", "THREAT-MODEL.md");
  if (!fs.existsSync(runbook)) fail("docs/STUDIO-RUNBOOK.md", "missing");
  else {
    const text = read(runbook);
    if (fs.existsSync(design)) {
      const d = read(design);
      const start = d.indexOf("### 7.7 Environment");
      const end = d.indexOf("## 8. Auth", start);
      const section = start >= 0 ? d.slice(start, end > start ? end : undefined) : "";
      const names = new Set((section.match(/\b(?:STUDIO|GITHUB|SUPABASE)_[A-Z0-9_]+\b/g) || []));
      for (const nme of names) if (!text.includes(nme)) fail("docs/STUDIO-RUNBOOK.md", "does not mention environment variable " + nme);
      if (!names.size) fail("docs/STUDIO-RUNBOOK.md", "could not read the environment table of studio/DESIGN.md 7.7");
    }
    for (const must of ["Contents", "Pull requests", "Metadata", "Checks", "Commit statuses", "studio/sql/001_studio_roles.sql", "CMS_EDIT", "npm run studio:dev", "Restore", "Publish", "main"]) {
      if (!text.includes(must)) fail("docs/STUDIO-RUNBOOK.md", "must mention: " + must);
    }
  }
  if (!fs.existsSync(threat)) fail("studio/THREAT-MODEL.md", "missing");
  else {
    const text = read(threat);
    for (const h of ["Assets", "Trust boundaries", "Threats", "Residual risks", "What an attacker gets"]) if (!text.includes("## " + h)) fail("studio/THREAT-MODEL.md", "missing section: " + h);
  }
}

// ---- 6: manifest order (only once unit C has merged it)
{
  const mp = path.join(ROOT, "studio", "overlay", "manifest.json");
  if (fs.existsSync(mp)) {
    try {
      const m = JSON.parse(read(mp));
      const list = JSON.stringify(m);
      const idx = ["ext/history.js", "ext/help.js", "ext/tour.js", "ext/palette.js"].map((f) => list.indexOf(f));
      if (idx.some((i) => i < 0)) fail("studio/overlay/manifest.json", "does not list all of ext/history.js, ext/help.js, ext/tour.js, ext/palette.js");
      else if (idx.some((v, i) => i && v < idx[i - 1])) fail("studio/overlay/manifest.json", "ext files are not in the contract order (history, help, tour, palette)");
      if (list.indexOf("ext/ext.css") < 0) fail("studio/overlay/manifest.json", "ext/ext.css is not listed");
      const mainAt = list.indexOf("main.js");
      if (mainAt >= 0 && idx.every((i) => i >= 0) && idx[3] > mainAt) fail("studio/overlay/manifest.json", "ext files must come before main.js");
    } catch (e) { fail("studio/overlay/manifest.json", "does not parse: " + e.message); }
  } else {
    console.log("note: studio/overlay/manifest.json is not present yet (unit C); manifest order not checked");
  }
}

if (problems.length) {
  console.error("check-history: " + problems.length + " problem(s)");
  for (const p of problems) console.error("  - " + p);
  process.exit(1);
}
console.log("check-history: OK (overlay ext rules, restore path, invertDiff on real data, docs)");
