"use strict";
// /studio/content.json (DESIGN.md section 3.3): the editable content of the checkout, as the overlay sees it.
// Self-contained on purpose (fs + js-yaml only): the throwaway workspaces of the guards do not copy scripts/.

const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");

const readText = (f) => fs.readFileSync(f, "utf8").replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");

// "---\n<yaml>\n---\n<body>" -> { front, body }
function splitFrontMatter(text) {
  const m = /^---\n([\s\S]*?)\n---[ \t]*(?:\n([\s\S]*))?$/.exec(text);
  if (!m) return { front: {}, body: text };
  let front = yaml.load(m[1]);
  if (front === null || front === undefined) front = {};
  if (typeof front !== "object" || Array.isArray(front)) throw new Error("front matter is not a mapping");
  return { front, body: m[2] || "" };
}

// -> { "how": { path, data }, "pages:about": { path, data: { ...front, _body } } }
function readFiles(root) {
  const files = {};
  const dataDir = path.join(root, "src", "_data");
  if (fs.existsSync(dataDir)) {
    for (const f of fs.readdirSync(dataDir).sort()) {
      if (!/^[a-z][a-z0-9-]*\.json$/.test(f)) continue;
      files[f.replace(/\.json$/, "")] = { path: "src/_data/" + f, data: JSON.parse(readText(path.join(dataDir, f))) };
    }
  }
  const pagesDir = path.join(root, "src", "pages");
  if (fs.existsSync(pagesDir)) {
    for (const f of fs.readdirSync(pagesDir).sort()) {
      if (!/^[a-z0-9-]+\.md$/.test(f)) continue;
      const parts = splitFrontMatter(readText(path.join(pagesDir, f)));
      files["pages:" + f.replace(/\.md$/, "")] = { path: "src/pages/" + f, data: Object.assign({}, parts.front, { _body: parts.body }) };
    }
  }
  return files;
}

function git(root, args) {
  try {
    return require("child_process").execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 }).trim() || null;
  } catch (e) {
    return null;
  }
}

function buildInfo(root, env) {
  const e = env || process.env;
  const sha40 = (s) => (typeof s === "string" && /^[0-9a-f]{40}$/i.test(s.trim()) ? s.trim().toLowerCase() : null);
  const sha = sha40(e.COMMIT_REF) || sha40(e.GITHUB_SHA) || sha40(git(root, ["rev-parse", "HEAD"]));
  const branch = e.HEAD || e.GITHUB_HEAD_REF || git(root, ["branch", "--show-current"]) || null;
  const pr = /^[0-9]{1,9}$/.test(String(e.REVIEW_ID || "")) ? Number(e.REVIEW_ID) : null;
  return { sha, branch: branch ? String(branch).slice(0, 200) : null, builtAt: new Date().toISOString(), prNumber: pr };
}

function schemaSha(root) {
  try {
    return JSON.parse(readText(path.join(root, "studio", "schema", "studio-schema.json"))).configSha256 || null;
  } catch (e) {
    return null;
  }
}

function snapshot(root, env) {
  return { schemaVersion: 1, build: buildInfo(root, env), schemaSha256: schemaSha(root), files: readFiles(root) };
}

module.exports = { snapshot, readFiles, splitFrontMatter, buildInfo, readText };
