"use strict";
// Pure pointer-level diff and its inverse (studio/DESIGN.md 7.6). No fs, no process, no Node-only API.
//
//   invertDiff({ file, before, after }) -> ops
//
// `before` is the parsed document at the merge commit's first parent (P), `after` the parsed document at the merge
// commit (M). The returned ops turn M back into P. Each op carries `expect` = the value M has, so applying them
// to a main that has moved on is refused (409 conflict) instead of silently overwriting somebody else's work.
// Op order is meaningful: ops are meant to be applied one after the other to the document (later list indexes first).

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

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const esc = (s) => String(s).replace(/~/g, "~0").replace(/\//g, "~1");
const key = (v) => JSON.stringify(v);

function lcsTable(a, b) {
  const n = a.length;
  const m = b.length;
  const t = [];
  for (let i = 0; i <= n; i++) t.push(new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      t[i][j] = a[i] === b[j] ? t[i + 1][j + 1] + 1 : Math.max(t[i + 1][j], t[i][j + 1]);
    }
  }
  return t;
}

function isPermutation(sa, sb) {
  if (sa.length !== sb.length) return false;
  const x = sa.slice().sort();
  const y = sb.slice().sort();
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}

// Inverse ops for one array: turn `b` (after) back into `a` (before) at `path`.
function arrayOps(file, path, a, b, out) {
  const sa = a.map(key);
  const sb = b.map(key);
  // Pure reorder: emit moves.
  if (sa.length === sb.length && isPermutation(sa, sb)) {
    const cur = sb.slice();
    for (let t = 0; t < sa.length; t++) {
      if (cur[t] === sa[t]) continue;
      let from = -1;
      for (let i = t + 1; i < cur.length; i++) if (cur[i] === sa[t]) { from = i; break; }
      out.push({ op: "move", file, from: path + "/" + from, path: path + "/" + t });
      cur.splice(t, 0, cur.splice(from, 1)[0]);
    }
    return;
  }
  // Align with an LCS; walk the gaps and emit ops from the END of the array so earlier indexes stay valid.
  const t = lcsTable(sa, sb);
  const hunks = [];
  let i = 0;
  let j = 0;
  let hi = 0;
  let hj = 0;
  while (i < sa.length || j < sb.length) {
    if (i < sa.length && j < sb.length && sa[i] === sb[j]) {
      if (i > hi || j > hj) hunks.push({ a0: hi, a1: i, b0: hj, b1: j });
      i++; j++; hi = i; hj = j;
    } else if (j < sb.length && (i >= sa.length || t[i][j + 1] >= t[i + 1][j])) {
      j++;
    } else {
      i++;
    }
  }
  if (hi < sa.length || hj < sb.length) hunks.push({ a0: hi, a1: sa.length, b0: hj, b1: sb.length });
  for (let h = hunks.length - 1; h >= 0; h--) {
    const { a0, a1, b0, b1 } = hunks[h];
    const na = a1 - a0;
    const nb = b1 - b0;
    if (na === nb) {
      for (let k = 0; k < na; k++) diffInto(file, path + "/" + (b0 + k), a[a0 + k], b[b0 + k], out);
      continue;
    }
    for (let k = b1 - 1; k >= b0; k--) out.push({ op: "remove", file, path: path + "/" + k, expect: clone(b[k]) });
    for (let k = 0; k < na; k++) out.push({ op: "add", file, path: path + "/" + (b0 + k), value: clone(a[a0 + k]) });
  }
}

function diffInto(file, path, a, b, out) {
  if (deepEqual(a, b)) return;
  if (isObj(a) && isObj(b)) {
    const keys = Object.keys(b).concat(Object.keys(a).filter((k) => !Object.prototype.hasOwnProperty.call(b, k)));
    for (const k of keys) {
      const p = path + "/" + esc(k);
      const inA = Object.prototype.hasOwnProperty.call(a, k);
      const inB = Object.prototype.hasOwnProperty.call(b, k);
      if (inA && inB) diffInto(file, p, a[k], b[k], out);
      else if (inA) out.push({ op: "add", file, path: p, value: clone(a[k]) });
      else out.push({ op: "remove", file, path: p, expect: clone(b[k]) });
    }
    return;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    arrayOps(file, path, a, b, out);
    return;
  }
  out.push({ op: "replace", file, path, value: clone(a), expect: clone(b) });
}

function invertDiff(input) {
  const out = [];
  diffInto(input.file, "", input.before, input.after, out);
  // The root has no pointer of its own; every op path starts with "/" because keys add "/key".
  return out;
}

// ---- tiny RFC 6901 helpers used by the restore service to check `expect` against the CURRENT main ----
function unescapeSeg(s) { return s.replace(/~1/g, "/").replace(/~0/g, "~"); }
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
// Apply one op (replace/add/remove/move) to `doc` in place. Returns false when the pointer does not exist.
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
  if (op.op === "move") {
    const from = parentOf(doc, op.from);
    if (!from || !Array.isArray(from.parent) || !arr || from.parent !== parent) return false;
    const f = Number(from.last);
    const t = Number(last);
    if (!(f >= 0 && f < parent.length && t >= 0 && t < parent.length)) return false;
    parent.splice(t, 0, parent.splice(f, 1)[0]);
    return true;
  }
  return false;
}

const api = { invertDiff, deepEqual, getAt, applyOp, parsePointer };
if (typeof module === "object" && module.exports) module.exports = api;
