#!/usr/bin/env node
"use strict";
// check-previews: the live previews in cms/previews.js must survive whatever an entry holds.
//
//   node scripts/check-previews.js [--root .] [--max 200] [--warnings]
//
// Smoke      every registered preview is rendered with the real data and with ~40 broken variants of
//            it (empty entry, empty strings, nulls, emptied lists, huge strings, random keys / items
//            removed, each key missing in turn). Must not throw, must return an element, must not
//            print "undefined" / "NaN" / "[object Object]" that the real data does not.
// Hostile    markup typed into any text field must not reach the preview as live HTML
//            (dangerouslySetInnerHTML) and a "javascript:" value must not reach a link. Sinks that
//            already existed are listed with a reason in scripts/previews-known-issues.json; any new
//            one fails, and a listed one that has been fixed must be removed from the list.
// Coverage   (information only) how many of the editable fields show up in their preview.
// Exit code: 0 clean, 1 violations, 2 usage error.

const path = require("path");
const { runMain, strictStale, parseArgs, readJson, exists, Report, REPO_ROOT, SCRIPTS_DIR, collapse } = require("./lib/util");
const { loadSources, pathString } = require("./lib/data");
const { loadConfig, contentCollections } = require("./lib/cmsconfig");
const { loadPreviews, render, flatten, variants, mapLeaves } = require("./lib/previews");
const { makePlan, mutateData, groupBySource } = require("./lib/sentinel");
const { parseDocument } = require("htmlparser2");

const BAD_TEXT = /\b(undefined|NaN|Infinity)\b|\[object Object\]/;
const PAYLOAD = '<img src=x onerror=alert(1)></p><script>alert(2)</script>';
const JS_URL = "javascript:alert(1)";

// True when an HTML string held by a dangerouslySetInnerHTML sink would create a live element other
// than <br> (the one thing the site's safeTitle filter lets through) or a live on* handler. Escaped
// text such as "&lt;img onerror=...&gt;" is only text and is fine, so this parses instead of matching text.
function liveHazard(html) {
  let bad = false;
  const walk = (nodes) => {
    for (const n of nodes || []) {
      if (n.type === "tag" || n.type === "script" || n.type === "style") {
        if (n.name !== "br") bad = true;
        if (Object.keys(n.attribs || {}).some((a) => /^on/i.test(a))) bad = true;
        walk(n.children);
      }
    }
  };
  walk(parseDocument(String(html)).children);
  return bad;
}

function whereOf(e) {
  return (e.stack || String(e)).split("\n").filter((l) => /previews\.js/.test(l)).slice(0, 1).join("").trim().replace(/^at /, "");
}

function main() {
  const args = parseArgs(process.argv.slice(2), { root: "string", max: "number", warnings: "boolean", strictStale: "boolean" });
  if (args.help) {
    console.log("usage: node scripts/check-previews.js [--root <repo root>] [--max <n>] [--warnings]");
    return 0;
  }
  const root = path.resolve(args.root || REPO_ROOT);
  const report = new Report("check-previews");
  const cfg = loadConfig(root);
  const { sources } = loadSources(root);
  const file = path.join(root, "cms", "previews.js");
  let pv;
  try {
    pv = loadPreviews(file);
  } catch (e) {
    report.add("Load", "cms/previews.js could not be loaded", e.message);
    return report.print({ max: args.max || 200 });
  }
  const knownFile = path.join(SCRIPTS_DIR, "previews-known-issues.json");
  const known = (exists(knownFile) ? readJson(knownFile).entries : []) || [];
  const knownUse = new Map(known.map((k) => [k, 0]));
  for (const k of known) {
    const ok = k.template && (k.kind === "undefined-text" || (k.kind === "live-html" && k.tag)) && k.reason && collapse(k.reason).length >= 20;
    if (!ok) report.add("previews-known-issues.json", "entry needs template, kind (live-html with tag, or undefined-text) and a reason of at least 20 characters: " + JSON.stringify(k).slice(0, 80));
  }

  // which sources feed which template
  const entries = contentCollections(cfg);
  const feeds = {};
  for (const e of entries) {
    if (!pv.templates[e.name]) continue;
    feeds[e.name] = sources.filter((s) => (e.kind === "file" ? s.kind === "data" && s.file === e.file : s.kind === "page" && path.posix.dirname(s.file) === e.folder));
  }
  const registered = Object.keys(pv.templates);
  for (const n of registered) if (!feeds[n]) report.add("Load", "preview '" + n + "' has no data to render (no matching collection / file entry)");

  let renders = 0;
  const knownSeen = new Set();
  const newSinks = new Map();
  const coverage = [];

  for (const name of registered) {
    const comp = pv.templates[name];
    if (!comp || typeof comp.render !== "function") {
      report.add("Load", "preview '" + name + "' has no render() method");
      continue;
    }
    for (const src of feeds[name] || []) {
      const label = name + (src.kind === "page" ? " (" + src.name + ")" : "");
      // ---------------- smoke
      let baseline = null;
      for (const v of variants(src.data)) {
        renders += 1;
        let tree;
        try {
          tree = render(comp, v.data);
        } catch (e) {
          report.add("Preview crashes", label + " with " + v.label, e.message + (whereOf(e) ? "\n" + whereOf(e) : ""));
          continue;
        }
        if (tree === undefined) {
          report.add("Preview crashes", label + " with " + v.label, "render() returned undefined (React needs an element or null)");
          continue;
        }
        const flat = flatten(tree);
        const all = flat.text.concat(flat.attrs.map((a) => a.value), flat.html.map((h) => h.html)).join("\n");
        if (v.label === "real data") {
          baseline = all;
          if (tree === null) report.add("Preview crashes", label + " renders nothing for the real data");
        } else if (BAD_TEXT.test(all) && !(baseline && BAD_TEXT.test(baseline))) {
          const m = BAD_TEXT.exec(all);
          const kn = known.find((x) => x.kind === "undefined-text" && x.template === name);
          if (kn) knownUse.set(kn, knownUse.get(kn) + 1);
          else report.add("Preview shows broken text", label + " with " + v.label + ' prints "' + m[0] + '"', "A missing field needs a fallback (see g(entry, path, fallback) in cms/previews.js). If it cannot be fixed now, list it in scripts/previews-known-issues.json with a reason.");
        }
      }
      // ---------------- hostile text
      const hostileData = mapLeaves(src.data, (x) => (typeof x === "string" && x.trim() ? x + PAYLOAD : x));
      let tree;
      try {
        renders += 1;
        tree = render(comp, hostileData);
      } catch (e) {
        report.add("Preview crashes", label + " with markup typed into every field", e.message);
        tree = null;
      }
      if (tree) {
        const flat = flatten(tree);
        for (const h of flat.html) {
          if (!liveHazard(h.html)) continue;
          const key = name + "|" + h.tag + "|" + h.cls;
          const k = known.find((x) => x.kind === "live-html" && x.template === name && x.tag === h.tag && (x.class || "") === h.cls);
          if (k) {
            knownUse.set(k, knownUse.get(k) + 1);
            knownSeen.add(key);
          } else if (!newSinks.has(key)) newSinks.set(key, { name, tag: h.tag, cls: h.cls, label });
        }
      }
      const urlData = mapLeaves(src.data, (x) => (typeof x === "string" && x.trim() ? JS_URL : x));
      try {
        renders += 1;
        const flat = flatten(render(comp, urlData));
        for (const l of flat.links) {
          if (/^\s*(javascript|vbscript):/i.test(l.value) || /^\s*data:text\/html/i.test(l.value)) {
            report.add("Hostile link", label + " puts a typed value straight into <" + l.tag + " " + l.name + '="…">', "A visitor of the preview could be sent to a javascript: URL; pass links through a check like the site's safeUrl filter.");
            break;
          }
        }
      } catch (e) {
        /* crash already reported by the smoke pass */
      }
    }
  }
  for (const s of newSinks.values()) {
    report.add(
      "Hostile markup reaches the preview as live HTML",
      "preview '" + s.name + "' renders typed text into <" + s.tag + (s.cls ? ' class="' + s.cls + '"' : "") + "> through dangerouslySetInnerHTML without escaping",
      "An editor (or anyone who can commit data) could run script inside the CMS, where the Netlify login lives. Escape the text first, keeping only <br> (what the site's safeTitle filter does). If this is a known issue that cannot be fixed now, add it to scripts/previews-known-issues.json with a reason."
    );
  }
  const staleKnown = [...knownUse].filter(([, n]) => n === 0).map(([k]) => k);
  if (strictStale(args)) {
    for (const k of staleKnown) report.add("previews-known-issues.json", "entry for '" + k.template + "' (" + k.kind + (k.tag ? " <" + k.tag + ">" : "") + ") no longer matches anything", "It has been fixed (or removed): delete the entry so the guard covers it again.");
  } else if (staleKnown.length) report.note("  note: " + staleKnown.length + " known-issue entr" + (staleKnown.length === 1 ? "y" : "ies") + " match nothing now (" + staleKnown.map((k) => k.template + " " + k.kind).join(", ") + "); --strict-stale makes that an error");

  // ---------------- coverage (information)
  const plan = makePlan(sources, cfg, null);
  const bySrc = groupBySource(plan);
  const missingByTemplate = {};
  let planted = 0;
  let shown = 0;
  for (const name of registered) {
    const comp = pv.templates[name];
    for (const src of feeds[name] || []) {
      const edits = (bySrc.get(src.file) || []).filter((e) => !e.dev);
      if (!edits.length) continue;
      const data = mutateData(src, edits, (e) => "/images/" + e.token + ".jpg");
      let hay = "";
      try {
        const flat = flatten(render(comp, data));
        hay = flat.text.concat(flat.attrs.map((a) => a.value), flat.html.map((h) => h.html)).join("\n").toLowerCase();
      } catch (e) {
        continue;
      }
      for (const e of edits) {
        if (e.synth || e.injected) continue;
        planted += 1;
        if (hay.includes(e.token)) shown += 1;
        else (missingByTemplate[name] = missingByTemplate[name] || []).push(pathString([src.name].concat(e.path)));
      }
    }
  }

  report.note("check-previews: " + registered.length + " previews, " + renders + " renders (real data, broken variants, hostile text, hostile links)");
  const stillKnown = [...knownUse.values()].filter((n) => n > 0).length;
  report.note("  known preview issues listed with reasons: " + known.length + " (" + stillKnown + " still present)" + (known.length ? "; see scripts/previews-known-issues.json" : ""));
  report.note("  preview coverage (information only): " + shown + " of " + planted + " editable values appear in their preview" + (args.warnings ? "" : "  (--warnings lists the rest)"));
  if (args.warnings) for (const [n, list] of Object.entries(missingByTemplate)) report.note("    ~ " + n + " does not show: " + list.map((p) => p.replace(/^[^.]+\./, "")).join(", "));
  return report.print({ max: args.max || 200, okMessage: "OK - every preview survives empty, broken and hostile entries" });
}

runMain("check-previews", main);
