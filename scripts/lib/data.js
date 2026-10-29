"use strict";
// Loading of the editable content: src/_data/*.json, front matter + body of src/pages/*.md and
// front matter of src/*.njk. Also string-leaf enumeration and path helpers.

const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");
const { readText, listFiles, toPosix } = require("./util");

// "---\n<yaml>\n---\n<body>"  ->  { front: <object>, body: <string>, hasFront: bool }
function splitFrontMatter(text) {
  const m = /^---\n([\s\S]*?)\n---[ \t]*(?:\n([\s\S]*))?$/.exec(text);
  if (!m) return { front: {}, body: text, hasFront: false };
  let front = yaml.load(m[1]);
  if (front === null || front === undefined) front = {};
  if (typeof front !== "object" || Array.isArray(front)) throw new Error("front matter is not a mapping");
  return { front, body: m[2] || "", hasFront: true };
}

function joinFrontMatter(front, body) {
  return "---\n" + yaml.dump(front, { lineWidth: -1, noRefs: true }) + "---\n" + (body || "");
}

// Everything the CMS (or a developer) can change without touching a template.
// Each source: { kind: "data"|"page"|"njk", file (posix, relative), name, data (object), body? }
function loadSources(root) {
  const sources = [];
  const dataDir = path.join(root, "src", "_data");
  const problems = [];
  if (fs.existsSync(dataDir)) {
    for (const f of fs.readdirSync(dataDir).sort()) {
      const p = path.join(dataDir, f);
      if (fs.statSync(p).isDirectory()) {
        problems.push("src/_data/" + f + "/ is a directory; the guards only understand flat src/_data/*.json files");
        continue;
      }
      if (!f.endsWith(".json")) {
        problems.push("src/_data/" + f + " is not a .json file; data that is not plain JSON cannot be edited in the CMS and is invisible to the guards");
        continue;
      }
      sources.push({ kind: "data", file: "src/_data/" + f, name: f.replace(/\.json$/, ""), data: JSON.parse(readText(p)) });
    }
  }
  const pagesDir = path.join(root, "src", "pages");
  for (const p of listFiles(pagesDir, (f) => /\.(md|markdown)$/.test(f)).sort()) {
    const rel = toPosix(path.relative(root, p));
    let parts;
    try {
      parts = splitFrontMatter(readText(p));
    } catch (e) {
      problems.push(rel + ": " + e.message);
      continue;
    }
    sources.push({ kind: "page", file: rel, name: path.basename(p).replace(/\.[^.]+$/, ""), data: parts.front, body: parts.body });
  }
  const srcDir = path.join(root, "src");
  if (fs.existsSync(srcDir)) {
    for (const f of fs.readdirSync(srcDir).sort()) {
      if (!/\.njk$/.test(f)) continue;
      const rel = "src/" + f;
      let parts;
      try {
        parts = splitFrontMatter(readText(path.join(srcDir, f)));
      } catch (e) {
        problems.push(rel + ": " + e.message);
        continue;
      }
      if (!parts.hasFront) continue;
      sources.push({ kind: "njk", file: rel, name: f.replace(/\.njk$/, ""), data: parts.front, body: parts.body });
    }
  }
  return { sources, problems };
}

// Every scalar in a value: { path: ["a", 0, "b"], value }
function leaves(value, pathSoFar, out) {
  out = out || [];
  pathSoFar = pathSoFar || [];
  if (Array.isArray(value)) value.forEach((v, i) => leaves(v, pathSoFar.concat(i), out));
  else if (value && typeof value === "object") for (const k of Object.keys(value)) leaves(value[k], pathSoFar.concat(k), out);
  else out.push({ path: pathSoFar, value });
  return out;
}

// ["brands","form","fields",2,"label"]  ->  "brands.form.fields[2].label"
function pathString(p) {
  return p.reduce((acc, k) => (typeof k === "number" ? acc + "[" + k + "]" : acc ? acc + "." + k : String(k)), "");
}
// ... -> "brands.form.fields[].label"  (what wiring-ignore entries are written against)
function schemaPath(p) {
  return p.reduce((acc, k) => (typeof k === "number" ? acc + "[]" : acc ? acc + "." + k : String(k)), "");
}

// Match a wiring-ignore style path pattern ("a.b[].c", "a.*.c", trailing ".**") against a schema path.
function patternToRegExp(pattern) {
  let re = "";
  const s = String(pattern);
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (c === "*" && s[i + 1] === "*") {
      re += ".*";
      i += 1;
    } else if (c === "*") re += "[^.\\[\\]]*";
    else re += c.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp("^" + re + "$");
}

function getAt(obj, p) {
  let cur = obj;
  for (const k of p) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[k];
  }
  return cur;
}
function setAt(obj, p, value) {
  let cur = obj;
  for (let i = 0; i < p.length - 1; i += 1) cur = cur[p[i]];
  cur[p[p.length - 1]] = value;
}

module.exports = { splitFrontMatter, joinFrontMatter, loadSources, leaves, pathString, schemaPath, patternToRegExp, getAt, setAt };
