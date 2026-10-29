"use strict";
// Stage 3 + 4 of the pipeline: resolve every pointer in the schema and apply RFC 6902 ops (a restricted subset)
// to deep clones of the documents. Atomic: the caller discards everything if any problem is returned.
//   replace  an existing value
//   add      a new item in a schema list (index or "-"), or an absent optional key of an object
//   remove   a list item, or an optional (required:false) key
//   move     reorders inside ONE list
// `expect` (optional) is the value the client believed was there; compared with the document AS IT IS when the
// op runs (sequential, like RFC 6902 "test"); every mismatch is collected into `conflicts`.
// Pure, portable.

const P = require("./pointer");
const { resolve, widgetOf } = require("./walk");
const { canon } = require("./jsontext");
const { mk } = require("./problem");

const MAX_DEPTH = 20;

// A value an op may carry: plain JSON only. Returns a clean deep copy (CRLF -> LF) or throws a string reason.
function cleanValue(v, depth) {
  if (depth > MAX_DEPTH) throw "the value is nested too deeply";
  if (v === null || typeof v === "boolean") return v;
  if (typeof v === "string") return v.replace(/\r\n/g, "\n");
  if (typeof v === "number") { if (!Number.isFinite(v)) throw "numbers must be finite"; return v; }
  if (Array.isArray(v)) return v.map((x) => cleanValue(x, depth + 1));
  if (P.isPlainObject(v)) {
    const out = {};
    for (const k of Object.keys(v)) {
      if (P.FORBIDDEN_SEGS.has(k)) throw "the key " + JSON.stringify(k) + " is not allowed";
      Object.defineProperty(out, k, { value: cleanValue(v[k], depth + 1), enumerable: true, writable: true, configurable: true });
    }
    return out;
  }
  throw "the value is not plain data";
}

function setIn(parent, key, value) {
  if (Array.isArray(parent)) parent[Number(key)] = value;
  else Object.defineProperty(parent, key, { value, enumerable: true, writable: true, configurable: true });
}

// docs: Map<repoPath, { info, doc }>   (doc is mutated: pass clones)
// -> { problems, conflicts: [{file,path,expected,actual}], touched: Set<repoPath>, applied: [{op, file, segs, before, after}] }
function applyOps(schema, ops, docs) {
  const problems = [];
  const conflicts = [];
  const touched = new Set();
  const applied = [];

  ops.forEach((op, i) => {
    const file = op.file;
    const entry = docs.get(file);
    const bad = (code, path, msg, hint, value) => problems.push(mk(code, file, path || (typeof op.path === "string" ? op.path : ""), "Change " + (i + 1) + ": " + msg, hint, value));
    if (!entry) { bad("path_forbidden", "", "that file is not available."); return; }
    const doc = entry.doc;
    let segs, fromSegs;
    try {
      segs = P.parse(op.path);
      if (op.op === "move") fromSegs = P.parse(op.from);
    } catch (e) { bad("pointer_invalid", "", e.message); return; }

    const checkExpect = (current) => {
      if (Object.prototype.hasOwnProperty.call(op, "expect") && canon(current) !== canon(op.expect)) {
        conflicts.push({ file, path: P.format(segs), expected: op.expect, actual: current === undefined ? null : current, op: i });
      }
    };
    const parentSegs = segs.slice(0, -1);
    const last = segs[segs.length - 1];
    const parent = parentSegs.length ? P.get(doc, parentSegs) : doc;

    if (op.op === "replace") {
      const target = P.get(doc, segs);
      if (target === undefined) { bad("pointer_invalid", "", "there is nothing at " + P.format(segs) + " to replace."); return; }
      if (!resolve(schema, file, segs, doc)) { bad("unknown_field", "", P.format(segs) + " is not a setting the editor knows about."); return; }
      let value;
      try { value = cleanValue(op.value, 0); } catch (r) { bad("type", "", String(r)); return; }
      if (op.value === undefined) { bad("type", "", "replace needs a value."); return; }
      checkExpect(target);
      setIn(parent, last, value);
      touched.add(file);
      applied.push({ op: "replace", file, segs, before: target, after: value });
      return;
    }

    if (op.op === "add") {
      if (parent === undefined || parent === null || typeof parent !== "object") { bad("pointer_invalid", "", "the place to add to does not exist."); return; }
      let value;
      try { value = cleanValue(op.value, 0); } catch (r) { bad("type", "", String(r)); return; }
      if (op.value === undefined) { bad("type", "", "add needs a value."); return; }
      if (Array.isArray(parent)) {
        const listNode = resolve(schema, file, parentSegs, doc);
        if (!listNode || listNode.type !== "list") { bad("unknown_field", "", "items can only be added to a list."); return; }
        let at;
        if (last === "-") at = parent.length;
        else if (P.isIndex(last) && Number(last) <= parent.length) at = Number(last);
        else { bad("pointer_invalid", "", "the position " + JSON.stringify(last) + " is outside the list."); return; }
        checkExpect(undefined);
        parent.splice(at, 0, value);
        touched.add(file);
        applied.push({ op: "add", file, segs: parentSegs.concat(String(at)), before: undefined, after: value });
        return;
      }
      const parentNode = parentSegs.length ? resolve(schema, file, parentSegs, doc) : resolve(schema, file, [], doc);
      if (!parentNode || parentNode.type !== "object") { bad("unknown_field", "", "settings cannot be added here."); return; }
      if (!resolve(schema, file, segs, doc)) { bad("unknown_field", "", JSON.stringify(last) + " is not a setting the editor knows about."); return; }
      if (P.hasOwn(parent, last)) { bad("pointer_invalid", "", JSON.stringify(last) + " is already set; use replace."); return; }
      checkExpect(undefined);
      setIn(parent, last, value);
      touched.add(file);
      applied.push({ op: "add", file, segs, before: undefined, after: value });
      return;
    }

    if (op.op === "remove") {
      const target = P.get(doc, segs);
      if (target === undefined) { bad("pointer_invalid", "", "there is nothing at " + P.format(segs) + " to remove."); return; }
      checkExpect(target);
      if (Array.isArray(parent)) {
        const listNode = resolve(schema, file, parentSegs, doc);
        if (!listNode || listNode.type !== "list") { bad("unknown_field", "", "items can only be removed from a list."); return; }
        parent.splice(Number(last), 1);
      } else {
        const node = resolve(schema, file, segs, doc);
        if (!node || !node.field || node.isTypeKey) { bad("unknown_field", "", P.format(segs) + " cannot be removed."); return; }
        if (node.field.required !== false || widgetOf(node.field) === "hidden") { bad("required", "", "\u201c" + (node.field.label || last) + "\u201d is required and cannot be removed."); return; }
        delete parent[last];
      }
      touched.add(file);
      applied.push({ op: "remove", file, segs, before: target, after: undefined });
      return;
    }

    if (op.op === "move") {
      const sameParent = fromSegs.length === segs.length && fromSegs.slice(0, -1).every((s, k) => s === parentSegs[k]);
      if (!sameParent || !Array.isArray(parent)) { bad("pointer_invalid", "", "items can only be moved inside one list."); return; }
      const listNode = resolve(schema, file, parentSegs, doc);
      if (!listNode || listNode.type !== "list") { bad("unknown_field", "", "items can only be moved inside a list."); return; }
      const a = fromSegs[fromSegs.length - 1];
      if (!P.isIndex(a) || !P.isIndex(last) || Number(a) >= parent.length || Number(last) >= parent.length) { bad("pointer_invalid", "", "the move is outside the list."); return; }
      if (Object.prototype.hasOwnProperty.call(op, "expect")) checkExpect(parent[Number(a)]);
      const [item] = parent.splice(Number(a), 1);
      parent.splice(Number(last), 0, item);
      touched.add(file);
      applied.push({ op: "move", file, segs, from: Number(a), to: Number(last), before: item, after: item });
      return;
    }

    bad("pointer_invalid", "", "unknown operation " + JSON.stringify(String(op.op).slice(0, 20)) + ".");
  });

  return { problems, conflicts, touched, applied };
}

module.exports = { applyOps, cleanValue };
