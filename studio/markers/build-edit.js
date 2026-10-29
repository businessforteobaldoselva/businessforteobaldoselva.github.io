#!/usr/bin/env node
"use strict";
// npm run studio:build-edit  ->  an edit build (CMS_EDIT=1) of the checkout in _site-edit/
//
//   node studio/markers/build-edit.js [--out _site-edit] [--root .]
//
// STUDIO_API_URL defaults to http://localhost:8787 (the studio:dev API); STUDIO_APP_URL is left alone (unset = the
// overlay runs "unconfigured" unless the dev server supplies it). Nothing here touches the network.

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const argv = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const root = path.resolve(opt("--root", path.resolve(__dirname, "..", "..")));
const out = path.resolve(root, opt("--out", "_site-edit"));

if (path.relative(root, out).startsWith("..") || out === root) {
  console.error("studio:build-edit: the output folder must be a sub-folder of the checkout, got " + out);
  process.exit(2);
}
const pkg = path.join(root, "node_modules", "@11ty", "eleventy", "package.json");
const json = JSON.parse(fs.readFileSync(pkg, "utf8"));
const bin = path.join(path.dirname(pkg), typeof json.bin === "string" ? json.bin : json.bin.eleventy);

// Eleventy never clears its output folder: start clean so an old file cannot hide in the edit build.
fs.rmSync(out, { recursive: true, force: true });
const env = Object.assign({}, process.env, { CMS_EDIT: "1", STUDIO_API_URL: process.env.STUDIO_API_URL || "http://localhost:8787" });
const r = spawnSync(process.execPath, [bin, "--output=" + out], { cwd: root, stdio: "inherit", env });
if (r.status === 0) console.log("studio:build-edit: wrote " + path.relative(root, out) + " (open it with the Studio dev server: npm run studio:dev)");
process.exit(r.status === null ? 1 : r.status);
