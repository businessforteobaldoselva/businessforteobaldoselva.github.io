#!/usr/bin/env node
"use strict";
// check:portability - the Studio API core must run unchanged on Node, Netlify Functions and Cloudflare Workers.
//
//   node studio/guards/check-portability.js [--root <repo>]
//
// The PORTABLE SET (DESIGN 7.1) may only use Web APIs: fetch, Request, Response, URL, crypto.subtle, TextEncoder,
// atob/btoa, structuredClone. It must not mention Buffer, fs, path, child_process, process, __dirname, or require any
// node: module or Node built-in. The repository modules the validator imports (lib/rules.js, lib/tokens.js,
// cms/redirect-rules.js, scripts/lib/image-rules.js) are held to the same rule, and every relative require of a
// portable file must itself be portable (transitive). Third-party packages: js-yaml only (pure JavaScript).
// Node-only code lives in adapters/node.js, providers/git/local-git.js, providers/git/mock-memory.js and dev/.

const fs = require("fs");
const path = require("path");

const argv = process.argv.slice(2);
const argOf = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const root = path.resolve(argOf("--root", path.resolve(__dirname, "..", "..")));

const NODE_ONLY = new Set([
  "studio/api/adapters/node.js", "studio/api/providers/git/local-git.js", "studio/api/providers/git/mock-memory.js",
]);
const EXTRA_PORTABLE = ["lib/rules.js", "lib/tokens.js", "cms/redirect-rules.js", "scripts/lib/image-rules.js"];
const BUILTINS = "assert async_hooks buffer child_process cluster console constants crypto dgram dns domain events fs http http2 https inspector module net os path perf_hooks process punycode querystring readline repl stream string_decoder timers tls tty url util v8 vm worker_threads zlib".split(" ");
const ALLOWED_PACKAGES = new Set(["js-yaml"]);

function walk(dir, out) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(js|mjs)$/.test(e.name)) out.push(p);
  }
  return out;
}
const rel = (p) => path.relative(root, p).split(path.sep).join("/");

function strip(src) {
  // remove comments (good enough for a guard: block comments, then full-line and trailing // comments outside quotes)
  let s = src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  s = s.split("\n").map((line) => {
    let q = null;
    for (let i = 0; i < line.length; i += 1) {
      const c = line[i];
      if (q) { if (c === "\\") i += 1; else if (c === q) q = null; }
      else if (c === '"' || c === "'" || c === "`") q = c;
      else if (c === "/" && line[i + 1] === "/" && (i === 0 || line[i - 1] !== ":")) return line.slice(0, i);
    }
    return line;
  }).join("\n");
  return s;
}

const BAD = [
  [/\bBuffer\b/, "Buffer (use Uint8Array, TextEncoder, atob/btoa)"],
  [/\bprocess\s*\./, "process (config comes in as an env object)"],
  [/\b__dirname\b|\b__filename\b/, "__dirname / __filename"],
  [/\bchild_process\b/, "child_process"],
  [/\brequire\s*\(\s*["']node:/, 'require("node:...")'],
  [/\bfrom\s+["']node:/, 'import from "node:..."'],
  [/\bfs\s*\.\s*(read|write|exists|mkdir|stat|readdir|append|rm|copy)/i, "fs access"],
];

function problemsIn(file) {
  const problems = [];
  const src = strip(fs.readFileSync(file, "utf8"));
  for (const [re, what] of BAD) if (re.test(src)) problems.push(rel(file) + ": uses " + what);
  const req = /require\s*\(\s*(["'])([^"']+)\1\s*\)/g;
  let m;
  while ((m = req.exec(src))) {
    const spec = m[2];
    if (spec.startsWith(".")) continue;
    const bare = spec.replace(/^node:/, "").split("/")[0];
    if (BUILTINS.indexOf(bare) >= 0) problems.push(rel(file) + ": requires the Node built-in " + JSON.stringify(spec));
    else if (!ALLOWED_PACKAGES.has(spec)) problems.push(rel(file) + ": requires the package " + JSON.stringify(spec) + " (only " + [...ALLOWED_PACKAGES].join(", ") + " is allowed in the portable set)");
  }
  return problems;
}

function portableSet() {
  const set = new Set();
  for (const f of walk(path.join(root, "studio", "api"), []).concat(walk(path.join(root, "studio", "validate"), []))) {
    if (!NODE_ONLY.has(rel(f))) set.add(f);
  }
  for (const e of EXTRA_PORTABLE) if (fs.existsSync(path.join(root, e))) set.add(path.join(root, e));
  return set;
}

function main() {
  const set = portableSet();
  const problems = [];
  const seen = new Set();
  const queue = [...set];
  while (queue.length) {
    const f = queue.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    problems.push(...problemsIn(f));
    // transitive: relative requires must land on portable files
    const src = strip(fs.readFileSync(f, "utf8"));
    const req = /require\s*\(\s*(["'])(\.[^"']*)\1\s*\)/g;
    let m;
    while ((m = req.exec(src))) {
      let target = path.resolve(path.dirname(f), m[2]);
      if (!/\.(js|mjs|json)$/.test(target)) target += fs.existsSync(target + ".js") ? ".js" : fs.existsSync(path.join(target, "index.js")) ? "/index.js" : ".js";
      if (/\.json$/.test(target)) continue;
      if (NODE_ONLY.has(rel(target))) problems.push(rel(f) + ": requires Node-only module " + rel(target));
      else if (fs.existsSync(target) && !seen.has(target)) {
        if (!/^(studio|lib|cms|scripts\/lib)\//.test(rel(target))) problems.push(rel(f) + ": requires " + rel(target) + " outside the portable areas");
        else queue.push(target);
      }
    }
  }
  if (problems.length) {
    console.log("== Studio API portability ==");
    for (const p of [...new Set(problems)].slice(0, 60)) console.log("  - " + p);
    console.log("\nCHECK-PORTABILITY FAILED: " + new Set(problems).size + " problem(s)");
    return 1;
  }
  console.log("check-portability: ok (" + seen.size + " portable files use Web APIs only)");
  return 0;
}

process.exit(main());
