#!/usr/bin/env node
"use strict";
// check-cms: cms/config.yml must be well formed, and it must cover the content.
//
//   node scripts/check-cms.js [--root .] [--max 200] [--warnings]
//
// Structure   field names / labels / widgets, select options, patterns, list types, defaults,
//             preview templates registered for real collections / files, previews.js parses
// Coverage    every key in src/_data/*.json, every front-matter key of src/pages/*.md has a visible
//             (not widget: hidden) CMS field of the right kind; every data file has a CMS entry;
//             every stored value is valid for its own field (select option, pattern, boolean ...)
//             and every required field has data (otherwise the CMS refuses to save the entry)
// Deliberate exceptions live in scripts/wiring-ignore.json (a reason per entry; unused entries fail).
// Exit code: 0 clean, 1 violations, 2 usage error.

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { runMain, strictStale, parseArgs, readJson, readText, exists, Report, REPO_ROOT, SCRIPTS_DIR, clip } = require("./lib/util");
const { loadSources, schemaPath, pathString } = require("./lib/data");
const { KNOWN_WIDGETS, loadConfig, widgetOf, contentCollections, listItemFields, alignData } = require("./lib/cmsconfig");
const { IgnoreList } = require("./lib/ignore");

const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);

function main() {
  const args = parseArgs(process.argv.slice(2), { root: "string", max: "number", warnings: "boolean", strictStale: "boolean" });
  if (args.help) {
    console.log("usage: node scripts/check-cms.js [--root <repo root>] [--max <n>] [--warnings]");
    return 0;
  }
  const root = path.resolve(args.root || REPO_ROOT);
  const report = new Report("check-cms");
  const warnings = [];

  let cfg;
  try {
    cfg = loadConfig(root);
  } catch (e) {
    report.add("CMS config", "cms/config.yml does not parse", e.message.split("\n").slice(0, 6).join("\n"));
    return report.print({ max: args.max || 200 });
  }
  const ignoreFile = path.join(SCRIPTS_DIR, "wiring-ignore.json");
  const ignore = new IgnoreList(exists(ignoreFile) ? readJson(ignoreFile) : {});
  ignore.problems.forEach((p) => report.add("wiring-ignore.json", p));

  // ------------------------------------------------------------------ structure
  const S = "CMS config structure";
  if (cfg.media_folder !== "images") report.add(S, "media_folder must be \"images\" (uploads land in /images)", "found " + JSON.stringify(cfg.media_folder));
  if (cfg.public_folder !== "/images") report.add(S, "public_folder must be \"/images\" (image paths are stored as /images/name.jpg)", "found " + JSON.stringify(cfg.public_folder));
  if (!cfg.backend || !cfg.backend.name) report.add(S, "backend is missing");
  if (!Array.isArray(cfg.collections) || !cfg.collections.length) report.add(S, "collections is missing or empty");

  let fieldCount = 0;
  const collectionNames = new Set();
  const fileEntryNames = new Set();
  const optionValues = (f) => (f.options || []).map((o) => (o && typeof o === "object" ? o.value : o));

  const checkFieldList = (fields, where) => {
    if (!Array.isArray(fields) || !fields.length) {
      report.add(S, where + ": has no fields");
      return;
    }
    const seen = new Set();
    for (const f of fields) {
      fieldCount += 1;
      const at = where + "." + (f && f.name ? f.name : "?");
      if (!f || typeof f !== "object" || !f.name) {
        report.add(S, where + ": a field has no name");
        continue;
      }
      if (!/^[a-z][A-Za-z0-9]*$/.test(f.name)) report.add(S, at + ": name must be camelCase (letters and digits, starting with a lower-case letter)", "found " + JSON.stringify(f.name));
      if (seen.has(f.name)) report.add(S, at + ": duplicate field name among its siblings");
      seen.add(f.name);
      if (!f.label || typeof f.label !== "string") report.add(S, at + ": needs a plain-English label");
      const w = widgetOf(f);
      if (!KNOWN_WIDGETS.has(w)) {
        report.add(S, at + ": unknown widget " + JSON.stringify(w));
        continue;
      }
      if (f.hint !== undefined && typeof f.hint !== "string") report.add(S, at + ": hint must be a string");
      if (f.required !== undefined && typeof f.required !== "boolean") report.add(S, at + ": required must be true or false");
      if (f.pattern !== undefined) {
        if (!Array.isArray(f.pattern) || f.pattern.length !== 2 || typeof f.pattern[0] !== "string" || typeof f.pattern[1] !== "string" || !f.pattern[1]) {
          report.add(S, at + ": pattern must be [regular expression, message for the editor]");
        } else {
          try {
            const re = new RegExp(f.pattern[0]);
            // Decap tests an image/file widget's pattern against the file NAME only (last path segment),
            // so a pattern that needs a folder prefix rejects every value and blocks Publish.
            if ((w === "image" || w === "file") && !["jpg", "png", "webp", "gif", "avif", "svg", "mp4", "webm", "m4v"].some((x) => re.test("some-file_1." + x))) {
              report.add(S, at + ": an image/file pattern must match a bare file name like some-file.jpg (Decap checks the name only, not the folder)", f.pattern[0].slice(0, 60));
            }
          } catch (e) {
            report.add(S, at + ": pattern is not a valid regular expression", e.message);
          }
        }
      }
      if (w === "select") {
        const vals = optionValues(f);
        if (!vals.length) report.add(S, at + ": select has no options");
        if (new Set(vals).size !== vals.length) report.add(S, at + ": select has duplicate option values");
        for (const o of f.options || []) if (o && typeof o === "object" && (o.label === undefined || o.value === undefined)) report.add(S, at + ": an option object needs both label and value");
        if (f.default !== undefined && !vals.includes(f.default)) report.add(S, at + ": default " + JSON.stringify(f.default) + " is not one of the options");
      }
      if (w === "boolean" && f.default !== undefined && typeof f.default !== "boolean") report.add(S, at + ": default must be true or false");
      if (w === "number" && f.default !== undefined && typeof f.default !== "number") report.add(S, at + ": default must be a number");
      if (f.min !== undefined && typeof f.min !== "number") report.add(S, at + ": min must be a number");
      if (f.max !== undefined && typeof f.max !== "number") report.add(S, at + ": max must be a number");
      if (typeof f.min === "number" && typeof f.max === "number" && f.min > f.max) report.add(S, at + ": min is larger than max");
      if (w === "object") {
        if (!f.fields) report.add(S, at + ": object widget needs fields");
        else checkFieldList(f.fields, at);
      }
      if (w === "list") {
        const shapes = ["fields", "field", "types"].filter((k) => f[k] !== undefined);
        if (shapes.length > 1) report.add(S, at + ": list has more than one of fields / field / types");
        if (f.fields) checkFieldList(f.fields, at);
        if (f.field) checkFieldList([f.field], at + "[]");
        if (f.types) {
          const tn = new Set();
          for (const t of f.types) {
            const tat = at + "<" + (t && t.name) + ">";
            if (!t || !t.name) {
              report.add(S, at + ": a list type has no name");
              continue;
            }
            if (tn.has(t.name)) report.add(S, tat + ": duplicate type name");
            tn.add(t.name);
            if (!t.label) report.add(S, tat + ": type needs a label");
            const tkey = f.typeKey || "type";
            if ((t.fields || []).some((x) => x && x.name === tkey)) report.add(S, tat + ": a field is named \"" + tkey + "\", which the CMS uses to remember the item type");
            checkFieldList(t.fields, tat);
          }
        }
        if (f.summary !== undefined) {
          const names = new Set();
          for (const x of f.fields || []) names.add(x.name);
          for (const t of f.types || []) for (const x of t.fields || []) names.add(x.name);
          if (f.field) names.add(f.field.name);
          const re = /\{\{\s*fields\.([A-Za-z0-9_]+)/g;
          let m;
          while ((m = re.exec(String(f.summary)))) if (names.size && !names.has(m[1])) report.add(S, at + ": summary refers to a field that does not exist: fields." + m[1]);
        }
        if ((f.fields || f.types) && !f.summary) warnings.push(at + ": list of objects has no summary (items show as \"item 1, item 2\" in the CMS)");
        if (!f.label_singular) warnings.push(at + ": list has no label_singular (the add button reads \"Add item\")");
      }
      if (w === "object" && f.required === false && Array.isArray(f.fields)) {
        const req = f.fields.filter((k) => k && k.required !== false && widgetOf(k) !== "hidden").map((k) => k.name);
        if (req.length) warnings.push(at + ": optional object has required children (" + req.join(", ") + "): the CMS may still demand them when the object is left empty");
      }
    }
  };

  for (const c of cfg.collections || []) {
    if (!c.name) {
      report.add(S, "a collection has no name");
      continue;
    }
    if (collectionNames.has(c.name)) report.add(S, "duplicate collection name " + c.name);
    collectionNames.add(c.name);
    if (!c.label) report.add(S, "collection " + c.name + " needs a label");
    if (c.files) {
      const names = new Set();
      for (const e of c.files) {
        if (!e.name) {
          report.add(S, "a file entry of " + c.name + " has no name");
          continue;
        }
        if (names.has(e.name)) report.add(S, "duplicate file entry name " + e.name);
        names.add(e.name);
        fileEntryNames.add(e.name);
        if (!e.label) report.add(S, "file entry " + e.name + " needs a label");
        if (!e.file) report.add(S, "file entry " + e.name + " has no file");
        else if (!exists(path.join(root, e.file))) report.add(S, "file entry " + e.name + " points at " + e.file + ", which does not exist");
        checkFieldList(e.fields, e.name);
      }
    } else if (c.folder) {
      if (!exists(path.join(root, c.folder))) report.add(S, "collection " + c.name + " folder " + c.folder + " does not exist");
      checkFieldList(c.fields, c.name);
    } else report.add(S, "collection " + c.name + " has neither files nor folder");
  }

  // preview templates
  const previewFile = path.join(root, "cms", "previews.js");
  let previewNames = [];
  if (exists(previewFile)) {
    const src = readText(previewFile);
    try {
      new vm.Script(src, { filename: "cms/previews.js" });
    } catch (e) {
      report.add("Previews", "cms/previews.js has a syntax error", e.message);
    }
    previewNames = [...src.matchAll(/registerPreviewTemplate\(\s*["']([^"']+)["']/g)].map((m) => m[1]);
    for (const n of previewNames) if (!collectionNames.has(n) && !fileEntryNames.has(n)) report.add("Previews", "a preview is registered for \"" + n + "\", which is no collection or file entry in cms/config.yml (it would never show)");
    const dup = previewNames.filter((n, i) => previewNames.indexOf(n) !== i);
    for (const n of new Set(dup)) report.add("Previews", "preview \"" + n + "\" is registered twice (the later one silently replaces the earlier)");
    for (const e of contentCollections(cfg)) if (e.kind === "file" && !previewNames.includes(e.name)) warnings.push("no preview registered for " + e.name);
  } else report.add("Previews", "cms/previews.js is missing");

  // ------------------------------------------------------------------ coverage
  const C = "CMS coverage";
  const { sources, problems } = loadSources(root);
  problems.forEach((p) => report.add(C, p));
  const entries = contentCollections(cfg);

  const checkValue = (ev, src) => {
    const f = ev.field;
    const w = widgetOf(f);
    const v = ev.value;
    const where = src.file + " > " + pathString(ev.path);
    // "" and null are how the CMS stores a cleared field; fine for optional fields, a save-blocker for required ones
    const blank = v === null || v === undefined || (v === "" && ["string", "text", "markdown", "image", "file", "select", "color", "datetime"].includes(w));
    if (blank) {
      if (f.required !== false && w !== "boolean" && w !== "list" && w !== "object" && !ev.listItem) report.add(C, where + ": required field holds no value", "The CMS would refuse to save this entry until it is filled.");
      return;
    }
    if (w === "list" || w === "object") return;
    if (w === "boolean" && typeof v !== "boolean") report.add(C, where + ": must be true or false", "found " + JSON.stringify(v));
    else if (w === "number" && typeof v !== "number") report.add(C, where + ": must be a number", "found " + JSON.stringify(v));
    else if (w === "select") {
      const vals = optionValues(f);
      if (!vals.includes(v)) report.add(C, where + ": " + JSON.stringify(v) + " is not one of this select's options", "options: " + vals.join(", "));
    } else if (["string", "text", "markdown", "image", "file", "color", "datetime"].includes(w) && typeof v !== "string") {
      report.add(C, where + ": must be text", "found " + JSON.stringify(v));
    }
    if (typeof v === "string" && Array.isArray(f.pattern) && v !== "") {
      try {
        if (!new RegExp(f.pattern[0]).test(w === "image" || w === "file" ? v.split("/").pop() : v)) report.add(C, where + ": the stored value breaks its own CMS pattern", JSON.stringify(clip(v, 60)) + " vs " + f.pattern[0].slice(0, 60) + " (" + f.pattern[1] + ")");
      } catch (e) {
        /* reported above */
      }
    }
    if (typeof v === "number" && typeof f.min === "number" && v < f.min) report.add(C, where + ": " + v + " is below the field's minimum " + f.min);
    if (typeof v === "number" && typeof f.max === "number" && v > f.max) report.add(C, where + ": " + v + " is above the field's maximum " + f.max);
  };

  const used = { entries: new Set() };
  for (const src of sources) {
    if (src.kind === "njk") continue;
    let entry = null;
    if (src.kind === "data") entry = entries.find((e) => e.kind === "file" && e.file === src.file);
    else entry = entries.find((e) => e.kind === "folder" && e.folder === path.posix.dirname(src.file));
    if (!entry) {
      report.add(C, src.file + " has no entry in cms/config.yml", src.kind === "data" ? "Add it to the 'content' collection's files so editors can change it." : "Add a folder collection for " + path.posix.dirname(src.file) + ".");
      continue;
    }
    used.entries.add(entry.name);
    alignData(src.data, entry.fields, [], (ev) => {
      const schema = schemaPath(ev.path);
      if (ev.problem) {
        const m = ignore.match(src.name, schema, "cms");
        if (m) return;
        const where = src.file + " > " + pathString(ev.path);
        const label = { "no-field": "has no CMS field - editors cannot change it", hidden: "is hidden in the CMS (widget: hidden) - editors cannot change it", "type-mismatch": "has the wrong shape for its CMS field (expected " + ev.expected + ")", "missing-type": "is a list item whose type " + JSON.stringify(ev.typeValue) + " is not defined by the CMS list" }[ev.problem];
        report.add(C, where + " " + label, ev.problem === "hidden" ? "If the value must not be edited, add it to scripts/wiring-ignore.json with a reason." : "");
        return;
      }
      if (ev.value !== null && typeof ev.value === "object") return;
      checkValue(ev, src);
    });
    // required fields without a data key
    const missing = (obj, fields, p) => {
      for (const f of fields || []) {
        const w = widgetOf(f);
        if (w === "hidden") continue;
        const v = obj[f.name];
        if (v === undefined) {
          if (f.required !== false && w !== "boolean" && w !== "list" && w !== "object") {
            const sp = schemaPath(p.concat(f.name));
            if (!ignore.match(src.name, sp, "cms")) report.add(C, src.file + " > " + pathString(p.concat(f.name)) + ": the CMS marks this field required but the data has no value", 'Either give it a value or mark the field `required: false`.');
          }
          continue;
        }
        if (w === "object" && isObj(v)) missing(v, f.fields, p.concat(f.name));
        else if (w === "list" && Array.isArray(v)) {
          v.forEach((it, i) => {
            const sub = listItemFields(f, it);
            if (sub && sub.fields && isObj(it)) missing(it, sub.fields, p.concat(f.name, i));
            else if (sub && sub.single && isObj(it) && sub.single.fields) missing(it, sub.single.fields, p.concat(f.name, i));
          });
        }
      }
    };
    missing(src.data, entry.fields, []);
    // a page's markdown body has no CMS field: not editable
    if (src.kind === "page" && src.body && src.body.trim() && !entry.fields.some((f) => f.name === "body")) {
      const m = ignore.match(src.name, "body", "cms");
      if (!m) report.add(C, src.file + " has a markdown body that the CMS cannot edit", "The 'pages' collection has no body field; move the words into a section or add a body field.");
    }
  }
  for (const e of entries) {
    if (e.kind === "file" && /\.json$/.test(e.file) && exists(path.join(root, e.file)) && !used.entries.has(e.name)) report.add(C, "CMS entry " + e.name + " (" + e.file + ") was not matched with any data source");
  }
  // data files nobody can edit are caught above; front matter of src/*.njk is developer-owned
  const dev = sources.filter((s) => s.kind === "njk" && Object.keys(s.data).length);
  const notes = [];
  if (dev.length) notes.push("  developer-owned front matter (not CMS-editable; scanned by check-copy, tokenised by check-wiring): " + dev.map((s) => s.file).join(", "));

  const unusedIgnores = ignore.unused("cms");
  if (strictStale(args)) {
    for (const e of unusedIgnores) report.add("wiring-ignore.json", "entry '" + e.path + "' skipped nothing in the CMS check", "Remove it, or fix the path. Unused entries would silently excuse the same field in future.");
  } else if (unusedIgnores.length) warnings.push(unusedIgnores.length + " wiring-ignore entr" + (unusedIgnores.length === 1 ? "y" : "ies") + " skipped nothing in the CMS check (" + unusedIgnores.map((e) => e.path).join(", ") + "); --strict-stale makes that an error");

  report.note("check-cms: " + (cfg.collections || []).length + " collections, " + entries.filter((e) => e.kind === "file").length + " data-file entries, " + fieldCount + " field definitions, " + previewNames.length + " previews; " + sources.filter((s) => s.kind !== "njk").length + " content sources checked against the config");
  notes.forEach((n) => report.note(n));
  if (warnings.length) {
    report.note("  " + warnings.length + " convention warning" + (warnings.length === 1 ? "" : "s") + " (not failures" + (args.warnings ? "" : "; --warnings lists them") + ")");
    if (args.warnings) warnings.forEach((w) => report.note("    ~ " + w));
  }
  return report.print({ max: args.max || 200, okMessage: "OK - the CMS config is well formed and covers every key of the content" });
}

runMain("check-cms", main);
