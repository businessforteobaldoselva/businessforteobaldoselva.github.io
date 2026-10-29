"use strict";
// Studio overlay bundler. `bundle()` returns the text of ONE plain browser script (served at /studio/overlay.js by
// lib/eleventy/studio.js in CMS_EDIT=1 builds). It is the concatenation of the files named in manifest.json, in order,
// the stylesheet(s) as JS strings, and the generated editing rules (studio/schema/studio-schema.json) as data.
// No network, no eval: a missing optional file is skipped with a warning (unit D's ext/ files may not be there yet).
//
//   const { bundle } = require("./studio/overlay/bundle.js");
//   bundle({ schemaPath?, warn? }) -> string
//   node studio/overlay/bundle.js [--out file] [--stats]
const fs = require("fs");
const path = require("path");

const DIR = __dirname;

function readManifest() {
  return JSON.parse(fs.readFileSync(path.join(DIR, "manifest.json"), "utf8"));
}

function bundle(opts) {
  opts = opts || {};
  const warn = opts.warn || ((m) => console.warn("[studio overlay] " + m));
  const manifest = readManifest();
  const out = [];
  out.push(
    '(function () {\n"use strict";\n' +
      "if (window.__CoveredStudioBoot) return;\n" +
      "var q = [];\n" +
      "var S = { _q: q, css: [], schema: null, studio: null, ready: function (fn) { if (S.studio) fn(S.studio); else q.push(fn); } };\n" +
      "window.__CoveredStudioBoot = S;\n"
  );
  for (const rel of manifest.styles || []) {
    const file = path.resolve(DIR, rel);
    if (!fs.existsSync(file)) {
      warn("skipping missing stylesheet " + rel);
      continue;
    }
    out.push("S.css.push(" + JSON.stringify(fs.readFileSync(file, "utf8")) + ");\n");
  }
  const schemaPath = opts.schemaPath || path.resolve(DIR, "..", "schema", "studio-schema.json");
  if (fs.existsSync(schemaPath)) {
    // re-serialised (so it is valid JS whatever the file holds) and compact
    out.push("S.schema = " + JSON.stringify(JSON.parse(fs.readFileSync(schemaPath, "utf8"))) + ";\n");
  } else {
    warn("no generated schema at " + schemaPath + " (run `npm run studio:schema`); the overlay will report missing rules");
  }
  for (const rel of manifest.scripts) {
    const file = path.resolve(DIR, rel);
    if (!fs.existsSync(file)) {
      warn("skipping missing script " + rel);
      continue;
    }
    out.push("/* ---- " + rel + " ---- */\n" + fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n") + "\n");
  }
  out.push("})();\n");
  return out.join("");
}

module.exports = { bundle, DIR };

if (require.main === module) {
  const args = process.argv.slice(2);
  const text = bundle({});
  const i = args.indexOf("--out");
  if (i >= 0) fs.writeFileSync(args[i + 1], text);
  if (args.includes("--stats") || i < 0) console.log("overlay bundle: " + (Buffer.byteLength(text) / 1024).toFixed(1) + " KiB");
}
