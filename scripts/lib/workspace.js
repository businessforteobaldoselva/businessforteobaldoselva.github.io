"use strict";
// A throwaway copy of the site that can be edited and built without touching the real checkout.
// Everything is copied except node_modules (linked; the link is removed before anything is deleted)
// and frames/ (21 MB of scroll-scrub stills that are only referenced by URL, never read at build
// time). Eleventy cannot passthrough-copy linked folders on Windows, hence real copies.

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { mkTmp, linkDir, removeTree, readText } = require("./util");

const OMIT = new Set(["frames"]);
const SKIP = new Set([".git", ".cache", "_site", ".claude", "scripts", ".github", "node_modules", ".gitignore", ".nojekyll", "package-lock.json"]);

function eleventyBin(root) {
  const pkg = path.join(root, "node_modules", "@11ty", "eleventy", "package.json");
  const json = JSON.parse(fs.readFileSync(pkg, "utf8"));
  const bin = typeof json.bin === "string" ? json.bin : json.bin.eleventy;
  return path.join(path.dirname(pkg), bin);
}

class Workspace {
  constructor(root, opts) {
    const o = opts || {};
    this.root = root;
    this.dir = mkTmp(o.prefix || "covered-guard-");
    this.outDirs = [];
    this.populate();
  }

  populate() {
    const { root, dir } = this;
    linkDir(path.join(root, "node_modules"), path.join(dir, "node_modules"));
    for (const name of fs.readdirSync(root)) {
      if (SKIP.has(name) || name.startsWith("_out_")) continue;
      const from = path.join(root, name);
      const to = path.join(dir, name);
      if (OMIT.has(name)) continue;
      fs.cpSync(from, to, { recursive: true });
    }
  }

  file(rel) {
    return path.join(this.dir, ...rel.split("/"));
  }
  read(rel) {
    return readText(this.file(rel));
  }
  write(rel, text) {
    fs.mkdirSync(path.dirname(this.file(rel)), { recursive: true });
    fs.writeFileSync(this.file(rel), text);
  }
  readJson(rel) {
    return JSON.parse(this.read(rel));
  }
  writeJson(rel, data) {
    this.write(rel, JSON.stringify(data, null, 2) + "\n");
  }

  // -> { ok, out, ms, log }
  build(name) {
    const out = path.join(this.dir, "_out_" + (name || "site"));
    this.outDirs.push(out);
    const t0 = Date.now();
    const r = spawnSync(process.execPath, [eleventyBin(this.root), "--quiet", "--output=" + out], {
      cwd: this.dir,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      // one small WebP + original per picture: the guards rebuild the site dozens of times (check-images builds the full set)
      env: Object.assign({}, process.env, { COVERED_IMG_FAST: "1" }),
    });
    return { ok: r.status === 0 && fs.existsSync(out), out, ms: Date.now() - t0, log: (r.stdout || "") + (r.stderr || "") };
  }

  cleanup() {
    removeTree(this.dir);
  }
}

module.exports = { Workspace, eleventyBin };
