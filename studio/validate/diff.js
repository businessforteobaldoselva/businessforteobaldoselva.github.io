"use strict";
// Pointer-level diff of two documents of ONE file, as ops that apply in order and carry `expect`.
//   diffOps(file, before, after) -> [{ op, file, path, value?, expect? }]   (before -> after)
// Used by rebase (re-apply a draft's diff onto a newer main) and by history/restore (D inverts it).
// Within one array: paired items are compared index by index (recursing), then surplus items are removed from the
// end / appended, so the ops are valid when applied one after the other. Pure, portable.

const { format } = require("./pointer");
const { canon } = require("./jsontext");

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

function diffOps(file, before, after) {
  const ops = [];
  (function walk(a, b, segs) {
    if (canon(a) === canon(b)) return;
    if (isObj(a) && isObj(b)) {
      for (const k of Object.keys(a)) if (!Object.prototype.hasOwnProperty.call(b, k)) ops.push({ op: "remove", file, path: format(segs.concat(k)), expect: a[k] });
      for (const k of Object.keys(b)) if (Object.prototype.hasOwnProperty.call(a, k)) walk(a[k], b[k], segs.concat(k));
      for (const k of Object.keys(b)) if (!Object.prototype.hasOwnProperty.call(a, k)) ops.push({ op: "add", file, path: format(segs.concat(k)), value: b[k] });
      return;
    }
    if (Array.isArray(a) && Array.isArray(b)) {
      const n = Math.min(a.length, b.length);
      for (let i = 0; i < n; i += 1) walk(a[i], b[i], segs.concat(String(i)));
      for (let i = a.length - 1; i >= n; i -= 1) ops.push({ op: "remove", file, path: format(segs.concat(String(i))), expect: a[i] });
      for (let i = n; i < b.length; i += 1) ops.push({ op: "add", file, path: format(segs.concat(String(i))), value: b[i] });
      return;
    }
    ops.push({ op: "replace", file, path: format(segs), value: b, expect: a });
  })(before, after, []);
  return ops;
}

// ops that undo `ops` (before -> after becomes after -> before) when `ops` came from diffOps on a file
function invertOps(ops) {
  const out = [];
  for (let i = ops.length - 1; i >= 0; i -= 1) {
    const o = ops[i];
    if (o.op === "replace") out.push({ op: "replace", file: o.file, path: o.path, value: o.expect, expect: o.value });
    else if (o.op === "add") out.push({ op: "remove", file: o.file, path: o.path, expect: o.value });
    else if (o.op === "remove") out.push({ op: "add", file: o.file, path: o.path, value: o.expect });
  }
  return out;
}

module.exports = { diffOps, invertOps };
