"use strict";
// Pure helpers for History / Restore. No I/O.
//   invertDiff(file, before, after) -> ops that turn `after` back into `before`; each carries `expect` = the value
//   `after` has, so applying them to a document that has moved on is detected as a conflict instead of overwriting.

const { diffOps, invertOps } = require("../../validate/diff");

// Accepts invertDiff(file, before, after) or invertDiff({ file, before, after }).
function invertDiff(file, before, after) {
  if (file && typeof file === "object") return invertOps(diffOps(file.file, file.before, file.after));
  return invertOps(diffOps(file, before, after));
}

// ---- helpers used by the history guard and tests to check `expect` and replay ops ----
function isObj(v) { return v !== null && typeof v === "object" && !Array.isArray(v); }
function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) if (!Object.prototype.hasOwnProperty.call(b, k) || !deepEqual(a[k], b[k])) return false;
  return true;
}

function unescapeSeg(s) { return s.replace(/~1/g, "/").replace(/~0/g, "~"); }
function parsePointer(p) {
  if (p === "") return [];
  if (p[0] !== "/") throw new Error("bad pointer");
  return p.slice(1).split("/").map(unescapeSeg);
}

function parsePointer(p) {
  if (p === "") return [];
  if (p[0] !== "/") throw new Error("bad pointer");
  return p.slice(1).split("/").map(unescapeSeg);
}

function getAt(doc, p) {
  let cur = doc;
  for (const s of parsePointer(p)) {
    if (cur === null || typeof cur !== "object" || !Object.prototype.hasOwnProperty.call(cur, s)) return { found: false };
    cur = cur[s];
  }
  return { found: true, value: cur };
}

function parentOf(doc, p) {
  const segs = parsePointer(p);
  const last = segs.pop();
  let cur = doc;
  for (const s of segs) {
    if (cur === null || typeof cur !== "object" || !Object.prototype.hasOwnProperty.call(cur, s)) return null;
    cur = cur[s];
  }
  return cur !== null && typeof cur === "object" ? { parent: cur, last } : null;
}

const clone = (x) => JSON.parse(JSON.stringify(x));

// Apply one replace/add/remove op to `doc` in place. Returns false when the pointer does not exist.
function applyOp(doc, op) {
  const at = parentOf(doc, op.path);
  if (!at) return false;
  const { parent, last } = at;
  const arr = Array.isArray(parent);
  if (op.op === "replace") {
    if (!Object.prototype.hasOwnProperty.call(parent, last)) return false;
    parent[last] = clone(op.value);
    return true;
  }
  if (op.op === "add") {
    if (arr) { const i = last === "-" ? parent.length : Number(last); if (!(i >= 0 && i <= parent.length)) return false; parent.splice(i, 0, clone(op.value)); } else parent[last] = clone(op.value);
    return true;
  }
  if (op.op === "remove") {
    if (!Object.prototype.hasOwnProperty.call(parent, last)) return false;
    if (arr) parent.splice(Number(last), 1); else delete parent[last];
    return true;
  }
  return false;
}

module.exports = { invertDiff, deepEqual, getAt, applyOp, parsePointer };
