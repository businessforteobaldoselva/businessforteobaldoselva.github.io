#!/usr/bin/env node
"use strict";
// check:validator-parity - the Studio validator and the CMS must agree.
//
//   node studio/guards/check-validator-parity.js [--root <repo>] [--mutations 30]
//
// 1. The validator accepts every data file and page that is in the repository today (no false positives).
// 2. Up to N mutations of real values (wrong type, bad option, pattern break, empty required) are applied one at a
//    time to a throwaway copy; `scripts/check-cms.js` must reject each copy AND the validator must report a problem
//    for the same document. The two judges agreeing is the "single source of truth" proof.
// Exit 0 clean, 1 on any disagreement.

const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..", "..");
const argv = process.argv.slice(2);
const argOf = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const root = path.resolve(argOf("--root", ROOT));
const MAX = Number(argOf("--mutations", 30));

const { loadSchema } = require("../tests/fixtures/schema-from-config");
const { validateDocument } = require("../validate/fields");
const { fileInfo } = require("../validate/walk");
const { parsePage } = require("../validate/pagefile");
const { reservedIds } = require(path.join(ROOT, "lib", "reserved-ids"));

const schema = loadSchema(root);
const ctx = { schema, reservedIds: reservedIds(root), now: () => new Date() };
const failures = [];
const fail = (m) => failures.push(m);

// ---- real files -------------------------------------------------------------------------------------------------
const docs = new Map(); // repo path -> doc
for (const f of fs.readdirSync(path.join(root, "src", "_data")).filter((n) => /\.json$/.test(n))) {
  const p = "src/_data/" + f;
  if (!fileInfo(schema, p)) continue; // not editable content
  docs.set(p, JSON.parse(fs.readFileSync(path.join(root, p), "utf8")));
}
for (const f of fs.readdirSync(path.join(root, "src", "pages")).filter((n) => /\.md$/.test(n))) {
  const p = "src/pages/" + f;
  docs.set(p, parsePage(fs.readFileSync(path.join(root, p), "utf8")).doc);
}
for (const [p, doc] of docs) {
  const info = fileInfo(schema, p);
  const r = validateDocument(ctx, info, doc, doc);
  for (const pr of r.problems) fail("validator rejects the repository's own " + p + pr.path + ": " + pr.message);
}

// ---- mutations --------------------------------------------------------------------------------------------------
function leaves(fields, obj, segs, out, info) {
  for (const f of fields) {
    if (!obj || typeof obj !== "object" || !(f.name in obj)) continue;
    const w = f.widget || "string";
    const here = segs.concat(f.name);
    if (w === "object") leaves(f.fields || [], obj[f.name], here, out, info);
    else if (w === "list" && Array.isArray(obj[f.name])) {
      obj[f.name].slice(0, 2).forEach((item, i) => {
        const s = here.concat(String(i));
        if (f.types) { const t = f.types.find((x) => x.name === item.type); if (t) leaves(t.fields, item, s, out, info); }
        else if (f.fields) leaves(f.fields, item, s, out, info);
      });
    } else out.push({ f, w, segs: here, value: obj[f.name], info });
  }
}
const setAt = (doc, segs, v) => { let o = doc; for (const s of segs.slice(0, -1)) o = o[s]; o[segs[segs.length - 1]] = v; };

const cands = [];
for (const [p, doc] of docs) {
  const info = fileInfo(schema, p);
  const lv = [];
  leaves(info.fields, doc, [], lv, info);
  for (const l of lv) {
    const { f, w, value } = l;
    const x = f.x && f.x.rule;
    if (x) continue; // code rules (links, colours, tokens, anchors, redirects...) are covered by the unit tests
    if (w === "boolean") cands.push({ kind: "boolean", p, l, bad: "yes" });
    else if (w === "select" && !f.multiple) cands.push({ kind: "option", p, l, bad: "__not_an_option__" });
    else if ((w === "string" || w === "text") && f.pattern && f.pattern.source) {
      let re = null;
      try { re = new RegExp(f.pattern.source); } catch (e) { re = null; }
      const bad = ["!!!", "a b c", "<>", "x"].find((s) => re && !re.test(s));
      if (bad) cands.push({ kind: "pattern", p, l, bad });
    } else if ((w === "string" || w === "text") && f.required !== false && typeof value === "string") cands.push({ kind: "empty", p, l, bad: "" });
  }
}
const byKind = {};
for (const c of cands) (byKind[c.kind] = byKind[c.kind] || []).push(c);
const picked = [];
for (let round = 0; picked.length < MAX; round += 1) {
  let any = false;
  for (const k of Object.keys(byKind).sort()) {
    const c = byKind[k][round * 3];
    if (c && picked.length < MAX) { picked.push(c); any = true; }
  }
  if (!any) break;
}

function writeCopy(dir, p, doc) {
  fs.cpSync(path.join(root, "cms"), path.join(dir, "cms"), { recursive: true });
  fs.cpSync(path.join(root, "src", "_data"), path.join(dir, "src", "_data"), { recursive: true });
  fs.cpSync(path.join(root, "src", "pages"), path.join(dir, "src", "pages"), { recursive: true });
  fs.mkdirSync(path.join(dir, "requests"), { recursive: true });
  if (/\.json$/.test(p)) fs.writeFileSync(path.join(dir, p), JSON.stringify(doc, null, 2) + "\n");
  else {
    const yaml = require("js-yaml");
    const fm = Object.assign({}, doc);
    const body = fm._body || "";
    delete fm._body;
    fs.writeFileSync(path.join(dir, p), "---\n" + yaml.dump(fm, { lineWidth: -1 }) + "---\n" + body);
  }
}
function cmsRejects(p, doc) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "studio-parity-"));
  try {
    writeCopy(dir, p, doc);
    const r = spawnSync(process.execPath, [path.join(ROOT, "scripts", "check-cms.js"), "--root", dir], { encoding: "utf8" });
    return { rejected: r.status !== 0, out: (r.stdout || "") + (r.stderr || "") };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// control: an unmodified copy must pass check-cms, otherwise the comparison means nothing
{
  const first = [...docs].find(([p]) => /\.json$/.test(p));
  const c = cmsRejects(first[0], JSON.parse(JSON.stringify(first[1])));
  if (c.rejected) fail("control run: check-cms rejects an unmodified copy:\n" + c.out.split("\n").slice(0, 8).join("\n"));
}

let compared = 0;
for (const c of picked) {
  const doc = JSON.parse(JSON.stringify(docs.get(c.p)));
  setAt(doc, c.l.segs, c.bad);
  const v = validateDocument(ctx, c.l.info, doc, docs.get(c.p));
  const m = cmsRejects(c.p, doc);
  compared += 1;
  const label = c.kind + " " + c.p + "#" + c.l.segs.join("/") + " = " + JSON.stringify(c.bad);
  if (!m.rejected) fail("check-cms ACCEPTED an invalid value (a blind spot of the CMS guard): " + label);
  else if (!v.problems.length) fail("the Studio validator ACCEPTED what check-cms rejects: " + label);
}

if (failures.length) {
  console.log("== Studio validator parity ==");
  for (const f of failures.slice(0, 40)) console.log("  - " + f);
  console.log("\nCHECK-VALIDATOR-PARITY FAILED: " + failures.length + " problem(s)");
  process.exit(1);
}
console.log("check-validator-parity: ok (" + docs.size + " repository files accepted; " + compared + " mutations judged the same by check-cms and the Studio validator)");
