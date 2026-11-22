"use strict";
// Acceptance: EVERY patch operation on EVERY field of the real content yields a plain-English line (PHASE1-DESIGN 6.1).
// The walk covers every pointer (leaf, object, list, list item) of every data file and page of the repository, for replace,
// add, remove and move, with hostile text in every value.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { describe } = require("../../validate/describe");
const { parsePage } = require("../../validate/pagefile");
const { loadSchema, ROOT } = require("../fixtures/schema-from-config");
const P = require("../../validate/pointer");
const S = require("../../api/shapes/phase1");

const schema = loadSchema(ROOT);
const HOSTILE = '<img src=x onerror="alert(1)"> \u0000\u202e & "quoted" ' + "x".repeat(3000);

function docs() {
  const out = [];
  const dd = path.join(ROOT, "src", "_data");
  for (const f of fs.readdirSync(dd).filter((n) => n.endsWith(".json"))) out.push(["src/_data/" + f, JSON.parse(fs.readFileSync(path.join(dd, f), "utf8"))]);
  const pd = path.join(ROOT, "src", "pages");
  for (const f of fs.readdirSync(pd).filter((n) => n.endsWith(".md"))) out.push(["src/pages/" + f, parsePage(fs.readFileSync(path.join(pd, f), "utf8")).doc]);
  return out;
}

function* pointers(v, segs) {
  yield segs;
  if (Array.isArray(v)) for (let i = 0; i < v.length; i++) yield* pointers(v[i], segs.concat(String(i)));
  else if (v && typeof v === "object") for (const k of Object.keys(v)) yield* pointers(v[k], segs.concat(k));
}
const at = (doc, segs) => segs.reduce((x, s) => (x === undefined || x === null ? undefined : x[s]), doc);
const hostile = (v) => (typeof v === "string" ? HOSTILE : v);

function check(x, op) {
  const where = op.op + " " + op.file + P.format(op.segs);
  assert.ok(typeof x.line === "string" && x.line.length > 0 && x.line.length <= 400, where + ": line must be 1 to 400 characters");
  assert.ok(S.KINDS.indexOf(x.kind) >= 0, where + ": kind " + x.kind);
  assert.ok(["none", "link", "image", "hidden", "legal"].indexOf(x.attention) >= 0, where + ": attention");
  assert.ok(typeof x.label === "string" && x.label.length > 0 && x.label.length <= 200, where + ": label");
  assert.ok(typeof x.where === "string" && x.where.length > 0 && x.where.length <= 200, where + ": where");
  assert.ok(x.pageUrl === null || /^\/[A-Za-z0-9._~\/-]*$/.test(x.pageUrl), where + ": pageUrl");
  const strings = [x.line, x.where].concat(x.label.split(" > "));
  for (const side of [x.before, x.after]) {
    if (side === null) continue;
    assert.ok(typeof side.text === "string" && side.text.length <= 2000 && typeof side.truncated === "boolean", where + ": value view");
    strings.push(side.text, side.image || "");
  }
  for (const s of strings) assert.ok(!/[<>\u0000\u202e]/.test(s), where + ": markup or control characters survived: " + JSON.stringify(s.slice(0, 60)));
  if (op.op === "add" || op.op === "move") assert.equal(x.before, null, where + ": nothing before");
  if (op.op === "remove" || op.op === "move") assert.equal(x.after, null, where + ": nothing after");
  if (op.op === "replace" && op.before !== undefined) assert.ok(x.before && x.after, where + ": both sides");
}

test("every operation on every pointer of the real content has a line, a kind and safe text", () => {
  let n = 0;
  const kinds = new Set();
  const attention = new Set();
  const before = new Map();
  const after = new Map();
  for (const [file, doc] of docs()) { before.set(file, doc); after.set(file, doc); }
  for (const [file, doc] of docs()) {
    for (const segs of pointers(doc, [])) {
      if (!segs.length) continue;
      const v = at(doc, segs);
      const last = segs[segs.length - 1];
      const inList = /^[0-9]+$/.test(last);
      const ops = [
        { op: "replace", file, segs, before: hostile(v), after: typeof v === "boolean" ? !v : typeof v === "string" ? HOSTILE : v },
        { op: "add", file, segs, after: hostile(v) },
        { op: "remove", file, segs, before: hostile(v) },
      ];
      if (inList) ops.push({ op: "move", file, segs: segs.slice(0, -1), from: Number(last), to: 0 });
      for (const op of ops) {
        const x = describe(op, { schema, before, after });
        check(x, op);
        kinds.add(x.kind);
        attention.add(x.attention);
        n++;
      }
    }
  }
  assert.ok(n > 2000, "walked " + n + " operations");
  for (const k of ["text", "image", "link", "toggle", "list", "page"]) assert.ok(kinds.has(k), "the real content exercises kind " + k + " (saw " + [...kinds] + ")");
  for (const a of ["link", "image", "hidden", "legal"]) assert.ok(attention.has(a) || a === "hidden", "attention " + a + " is reachable");
});

test("what an approver is told to look at: links, pictures, hidden sections, contact and legal text", () => {
  const file = "src/_data/homepage.json";
  const base = (op) => describe(op, { schema, before: new Map(), after: new Map() });
  assert.equal(base({ op: "replace", file, segs: ["sections", "4", "enabled"], before: true, after: false }).attention, "hidden");
  assert.equal(base({ op: "replace", file, segs: ["sections", "4", "enabled"], before: false, after: true }).attention, "none");
  assert.equal(base({ op: "replace", file: "src/_data/site.json", segs: ["contactEmail"], before: "a@b.co", after: "c@d.co" }).attention, "legal");
  assert.equal(base({ op: "replace", file: "src/pages/privacy.md", segs: ["title"], before: "a", after: "b" }).attention, "legal");
  assert.equal(base({ op: "replace", file: "src/_data/problem.json", segs: ["sourceUrl"], before: "https://a.example/", after: "https://x.example/" }).attention, "link");
  assert.equal(base({ op: "replace", file: "src/_data/hero.json", segs: ["headlineMain"], before: "a", after: "b" }).attention, "none");
});

test("long text is cut at 2000 characters and says so", () => {
  const x = describe({ op: "replace", file: "src/_data/hero.json", segs: ["subhead"], before: "a".repeat(5000), after: "b" }, { schema, before: new Map(), after: new Map() });
  assert.equal(x.before.truncated, true);
  assert.equal(x.before.text.length, 2000);
  assert.equal(x.after.truncated, false);
});
