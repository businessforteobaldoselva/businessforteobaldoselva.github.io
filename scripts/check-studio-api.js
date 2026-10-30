#!/usr/bin/env node
"use strict";
// check:studio-api - static rules for the Studio API (unit B) and, unless --static, its unit test suite.
//
//   node scripts/check-studio-api.js [--root <repo>] [--static] [--selftest]
//
// Static rules over studio/api, studio/validate, studio/dev, studio/sql, the adapters and the Studio workflows:
//   1. no file writes (fs write/append/mkdir/rm/rename/copy, createWriteStream) outside the allow-list
//      (providers/git/local-git.js, dev/server.js);
//   2. no eval / new Function / child_process / vm / worker outside providers/git/local-git.js and dev/server.js;
//   3. no secrets in files: PEM private keys, JWT-shaped strings, GitHub / Supabase / Netlify token shapes, and
//      long literals assigned to names like secret / token / key / password / pepper;
//   4. the dev auth stub: only reachable through providers/auth/dev.js, which keeps its production refusals;
//   5. every outbound HTTP call in the portable code goes through an injected `fetch` (no http/https modules);
//   6. only the five fixed environment names may read process.env (adapters, dev).
// The tests themselves are run by `check:studio` too; running them here as well keeps this guard self-contained.

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const argv = process.argv.slice(2);
const argOf = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const root = path.resolve(argOf("--root") || path.resolve(__dirname, ".."));
const STATIC_ONLY = argv.includes("--static");

const WRITE_OK = new Set(["studio/api/providers/git/local-git.js", "studio/dev/server.js"]);
const EXEC_OK = new Set(["studio/api/providers/git/local-git.js", "studio/dev/server.js"]);
const ENV_OK = [/^studio\/api\/adapters\//, /^studio\/dev\//, /^studio\/api\/providers\/git\/local-git\.js$/];

function walk(dir, out) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}
const rel = (p) => path.relative(root, p).split(path.sep).join("/");

function stripComments(src) {
  let s = src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  return s.split("\n").map((line) => {
    let q = null;
    for (let i = 0; i < line.length; i += 1) {
      const c = line[i];
      if (q) { if (c === "\\") i += 1; else if (c === q) q = null; }
      else if (c === '"' || c === "'" || c === "`") q = c;
      else if (c === "/" && line[i + 1] === "/" && (i === 0 || line[i - 1] !== ":")) return line.slice(0, i);
    }
    return line;
  }).join("\n");
}

const WRITE_RE = /\b(?:fs|fsp|promises)\s*\.\s*(?:writeFile|writeFileSync|appendFile|appendFileSync|mkdir|mkdirSync|mkdtemp|mkdtempSync|rm|rmSync|rmdir|rmdirSync|unlink|unlinkSync|rename|renameSync|copyFile|copyFileSync|cp|cpSync|createWriteStream|symlink|symlinkSync|truncate|truncateSync)\b|\bcreateWriteStream\b/;
const EXEC_RE = /\beval\s*\(|\bnew\s+Function\s*\(|\bFunction\s*\(\s*["'`]|\bchild_process\b|\brequire\s*\(\s*["'](?:node:)?(?:vm|worker_threads|cluster)["']\s*\)|\bspawnSync?\b|\bexecSync?\b|\bexecFile(?:Sync)?\b|\bfork\s*\(/;
const HTTP_RE = /\brequire\s*\(\s*["'](?:node:)?(?:https?|net|tls|dgram|http2)["']\s*\)|\bXMLHttpRequest\b|\bnet\.connect\b|(?:^|[^\w$.])fetch\s*\(|\bglobalThis\s*\.\s*fetch\b|\bWebSocket\b|\bEventSource\b|\bnavigator\s*\.\s*sendBeacon\b/;
// a dynamic import() or a computed require() can load anything, including the modules the rules above look for
const DYNAMIC_RE = /(?:^|[^\w$.])import\s*\(|\brequire\s*\(\s*[^"'\s)]/;
const ENV_RE = /\bprocess\s*\.\s*env\b/;
const SECRET_PATTERNS = [
  [/-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----[\s\S]{20,}?-----END/, "a PEM private key"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, "a JWT"],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}\b/, "a GitHub token"],
  [/\bgithub_pat_[A-Za-z0-9_]{30,}\b/, "a GitHub fine-grained token"],
  [/\bsbp_[a-f0-9]{30,}\b|\bsb_secret_[A-Za-z0-9_-]{20,}\b/, "a Supabase secret key"],
  [/\bnfp_[A-Za-z0-9]{30,}\b/, "a Netlify token"],
  [/\bAKIA[0-9A-Z]{16}\b/, "an AWS key id"],
  [/\bxox[abpr]-[A-Za-z0-9-]{20,}\b/, "a Slack token"],
  [/\b(?:secret|token|password|passwd|pepper|apikey|api_key|private_?key)\w*["']?\s*[:=]\s*["'][A-Za-z0-9+\/=_-]{24,}["']/i, "a long literal assigned to a secret-like name"],
];
// test fixtures generate keys at run time; a literal that merely NAMES a variable is fine
const SECRET_SKIP = [/^studio\/tests\//, /^scripts\/selftest\.js$/];

function main() {
  const problems = [];
  const add = (f, m) => problems.push(f + ": " + m);

  const code = []
    .concat(walk(path.join(root, "studio", "api"), []))
    .concat(walk(path.join(root, "studio", "validate"), []))
    .concat(walk(path.join(root, "studio", "dev"), []))
    .filter((p) => /\.(js|mjs)$/.test(p));
  for (const f of code) {
    const r = rel(f);
    const src = stripComments(fs.readFileSync(f, "utf8"));
    if (!WRITE_OK.has(r) && WRITE_RE.test(src)) add(r, "writes to the file system (only local-git.js and dev/server.js may)");
    if (!EXEC_OK.has(r) && EXEC_RE.test(src)) add(r, "uses eval / Function / child_process / vm (only local-git.js and dev/server.js may)");
    // the documented default (use the platform fetch when none was injected) and a Worker's own `fetch(req, env)` method are fine
    const httpSrc = src.replace(/\(\.\.\.a\)\s*=>\s*fetch\(\.\.\.a\)/g, "").replace(/\basync\s+fetch\s*\(/g, "async handle(");
    if (HTTP_RE.test(httpSrc) && !/^studio\/dev\//.test(r) && r !== "studio/api/adapters/node.js") add(r, "makes HTTP calls without the injected fetch (a bare fetch(), sockets and WebSocket are not allowed)");
    if (DYNAMIC_RE.test(src) && !EXEC_OK.has(r) && !/^studio\/dev\//.test(r) && !/^studio\/api\/adapters\//.test(r)) add(r, "loads code by a dynamic import() or a computed require()");
    if (ENV_RE.test(src) && !ENV_OK.some((re) => re.test(r))) add(r, "reads process.env (configuration must come in as an object: loadConfig(env))");
  }

  // dev stub gate
  const devFile = path.join(root, "studio", "api", "providers", "auth", "dev.js");
  if (fs.existsSync(devFile)) {
    const d = fs.readFileSync(devFile, "utf8");
    for (const must of ["STUDIO_DEV", "STUDIO_ENV", "production", "localhost"]) if (d.indexOf(must) < 0) add("studio/api/providers/auth/dev.js", "the dev auth stub no longer mentions " + must + " (its production refusal is missing)");
  }
  const configFile = path.join(root, "studio", "api", "config.js");
  if (fs.existsSync(configFile)) {
    const c = fs.readFileSync(configFile, "utf8");
    if (!/createDevAuth|auth\/dev/.test(c)) add("studio/api/config.js", "does not reference the dev auth stub gate");
  }
  for (const f of code) {
    const r = rel(f);
    if (r === "studio/api/providers/auth/dev.js" || /^studio\/dev\//.test(r)) continue;
    if (/providers\/auth\/dev/.test(fs.readFileSync(f, "utf8")) && r !== "studio/api/config.js") add(r, "imports the dev auth stub (only config.js may, behind config.dev)");
  }

  // secrets: every file of the API, validator, dev tooling, SQL, adapters and the two workflows
  const scan = []
    .concat(walk(path.join(root, "studio"), []).filter((p) => !/studio\/(DESIGN|NOTES)/.test(rel(p)) && /\.(js|mjs|json|sql|md|yml|html)$/.test(p)))
    .concat(walk(path.join(root, ".github"), []))
    // the rest of the repository too: a token in the site, the CMS, the scripts, the docs or the root files is just as leaked
    .concat(["src", "cms", "scripts", "lib", "docs", "admin", "design", "requests"].flatMap((d) => walk(path.join(root, d), []).filter((p) => /\.(js|mjs|json|md|yml|yaml|html|njk|toml|txt)$/.test(p))))
    .concat(fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isFile() && e.name !== "package-lock.json" && /\.(js|mjs|json|md|yml|yaml|html|toml|txt)$/i.test(e.name)).map((e) => path.join(root, e.name)));
  for (const f of scan) {
    const r = rel(f);
    if (SECRET_SKIP.some((re) => re.test(r))) continue;
    const src = fs.readFileSync(f, "utf8");
    for (const [re, what] of SECRET_PATTERNS) {
      if (what === "a JWT") {
        // a Supabase ANON key is a JWT that is public by design (role "anon"); every other JWT is a leaked credential
        const all = src.match(new RegExp(re.source, "g")) || [];
        if (all.some((j) => { try { return JSON.parse(Buffer.from(j.split(".")[1], "base64url").toString("utf8")).role !== "anon"; } catch (e) { return true; } })) add(r, "looks like it contains " + what + " that is not an anon key");
      } else if (re.test(src)) add(r, "looks like it contains " + what);
    }
  }
  // no .env files anywhere in studio/
  for (const f of walk(path.join(root, "studio"), [])) if (/(^|\/)\.env/.test(rel(f))) add(rel(f), "an environment file must never be committed");

  // the SQL must keep its safety header and RLS
  const sql = path.join(root, "studio", "sql", "001_studio_roles.sql");
  if (!fs.existsSync(sql)) add("studio/sql/001_studio_roles.sql", "missing");
  else {
    const s = fs.readFileSync(sql, "utf8");
    if (!/^-- REVIEW BEFORE APPLYING/.test(s)) add("studio/sql/001_studio_roles.sql", "must start with the REVIEW BEFORE APPLYING header");
    if (!/enable row level security/i.test(s) || !/revoke all on public\.studio_roles from anon/i.test(s)) add("studio/sql/001_studio_roles.sql", "RLS or the anon revoke is missing");
    if (/service_role/i.test(s.replace(/--.*$/gm, ""))) add("studio/sql/001_studio_roles.sql", "must not use the service role");
  }

  if (problems.length) {
    console.log("== Studio API static rules ==");
    for (const p of problems.slice(0, 60)) console.log("  - " + p);
    console.log("\nCHECK-STUDIO-API FAILED: " + problems.length + " problem(s)");
    return 1;
  }
  console.log("check-studio-api: static rules ok (" + code.length + " source files, " + scan.length + " files scanned for secrets)");
  if (STATIC_ONLY) return 0;

  const tests = walk(path.join(root, "studio", "tests", "api"), []).filter((p) => /\.test\.js$/.test(p)).sort();
  const r = spawnSync(process.execPath, ["--test", "--test-concurrency=4"].concat(tests), { cwd: root, stdio: "inherit" });
  return r.status === 0 ? 0 : 1;
}

process.exit(main());
