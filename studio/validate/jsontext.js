"use strict";
// Format-preserving JSON editing. The data files are hand-formatted (pretty-printed, but with compact
// one-line objects such as `{ "q": "...", "a": "..." }`), so re-printing a whole file with JSON.stringify would
// rewrite lines nobody touched. Instead: parse the text WITH positions, then rebuild only the nodes whose value
// changed and splice them into the original text. No edit => the text is returned byte for byte.
//
//   parseWithRanges(text) -> ast            (strict JSON; duplicate keys and "__proto__" are refused)
//   patchText(text, ast, newValue) -> text  (newValue is the whole document after the edit)
//
// Pure, portable (no fs / Buffer / process).

const WS = " \t\r\n";
const NUM_RE = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;

class JsonTextError extends Error {
  constructor(message, at) { super(message); this.name = "JsonTextError"; this.at = at; }
}

function setOwn(obj, key, value) {
  Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });
}

function parseWithRanges(text) {
  if (typeof text !== "string") throw new JsonTextError("not text", 0);
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const skip = () => { while (i < text.length && WS.indexOf(text[i]) >= 0) i += 1; };
  const fail = (m) => { throw new JsonTextError(m + " at position " + i, i); };

  function value(depth) {
    if (depth > 64) fail("nested too deeply");
    skip();
    const c = text[i];
    const start = i;
    if (c === "{") {
      i += 1;
      const members = [];
      const val = {};
      skip();
      if (text[i] === "}") { i += 1; return { kind: "object", start, end: i, members, value: val }; }
      for (;;) {
        skip();
        if (text[i] !== '"') fail("expected a string key");
        const keyStart = i;
        const key = string();
        if (key === "__proto__") fail("the key __proto__ is not allowed");
        if (members.some((m) => m.key === key)) fail("duplicate key " + JSON.stringify(key));
        const keyEnd = i;
        skip();
        if (text[i] !== ":") fail("expected :");
        i += 1;
        const node = value(depth + 1);
        members.push({ key, keyStart, keyEnd, node });
        setOwn(val, key, node.value);
        skip();
        if (text[i] === ",") { i += 1; continue; }
        if (text[i] === "}") { i += 1; break; }
        fail("expected , or }");
      }
      return { kind: "object", start, end: i, members, value: val };
    }
    if (c === "[") {
      i += 1;
      const elements = [];
      const val = [];
      skip();
      if (text[i] === "]") { i += 1; return { kind: "array", start, end: i, elements, value: val }; }
      for (;;) {
        const node = value(depth + 1);
        elements.push(node);
        val.push(node.value);
        skip();
        if (text[i] === ",") { i += 1; continue; }
        if (text[i] === "]") { i += 1; break; }
        fail("expected , or ]");
      }
      return { kind: "array", start, end: i, elements, value: val };
    }
    if (c === '"') { const s = string(); return { kind: "scalar", start, end: i, value: s }; }
    if (text.startsWith("true", i)) { i += 4; return { kind: "scalar", start, end: i, value: true }; }
    if (text.startsWith("false", i)) { i += 5; return { kind: "scalar", start, end: i, value: false }; }
    if (text.startsWith("null", i)) { i += 4; return { kind: "scalar", start, end: i, value: null }; }
    NUM_RE.lastIndex = i;
    const m = NUM_RE.exec(text);
    if (!m) fail("unexpected character");
    i += m[0].length;
    return { kind: "scalar", start, end: i, value: Number(m[0]) };
  }

  function string() {
    const s = i;
    i += 1;
    while (i < text.length && text[i] !== '"') {
      if (text[i] === "\\") i += 2;
      else if (text.charCodeAt(i) < 0x20) fail("control character in a string");
      else i += 1;
    }
    if (text[i] !== '"') fail("unterminated string");
    i += 1;
    try { return JSON.parse(text.slice(s, i)); } catch (e) { return fail("bad string"); }
  }

  const root = value(0);
  skip();
  if (i !== text.length) fail("unexpected text after the value");
  return root;
}

// canonical form (sorted keys) for "is this the same value?"
function canon(v) {
  if (Array.isArray(v)) return "[" + v.map(canon).join(",") + "]";
  if (v && typeof v === "object") return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canon(v[k])).join(",") + "}";
  return JSON.stringify(v);
}

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

function eolOf(text) { return text.indexOf("\r\n") >= 0 ? "\r\n" : "\n"; }

// A brand-new value. inline: one line, in the house style `{ "k": v }` / `["a", "b"]`.
function fresh(v, indent, inline, eol) {
  if (Array.isArray(v)) {
    if (!v.length) return "[]";
    if (inline) return "[" + v.map((x) => fresh(x, indent, true, eol)).join(", ") + "]";
    const pad = indent + "  ";
    return "[" + eol + pad + v.map((x) => fresh(x, pad, false, eol)).join("," + eol + pad) + eol + indent + "]";
  }
  if (isObj(v)) {
    const keys = Object.keys(v);
    if (!keys.length) return "{}";
    if (inline) return "{ " + keys.map((k) => JSON.stringify(k) + ": " + fresh(v[k], indent, true, eol)).join(", ") + " }";
    const pad = indent + "  ";
    return "{" + eol + pad + keys.map((k) => JSON.stringify(k) + ": " + fresh(v[k], pad, false, eol)).join("," + eol + pad) + eol + indent + "}";
  }
  return JSON.stringify(v);
}

function lineIndent(text, pos) {
  const ls = text.lastIndexOf("\n", pos - 1) + 1;
  const m = /^[ \t]*/.exec(text.slice(ls, pos));
  return m ? m[0] : "";
}

function patchNode(text, node, nv, indent, eol) {
  const same = canon(node.value) === canon(nv);
  if (same) return text.slice(node.start, node.end);
  const oneLine = text.slice(node.start, node.end).indexOf("\n") < 0;

  if (node.kind === "object" && isObj(nv)) {
    const keys = Object.keys(nv);
    if (!node.members.length || !keys.length) return fresh(nv, indent, oneLine && node.members.length > 0, eol);
    const first = node.members[0];
    const last = node.members[node.members.length - 1];
    const lead = text.slice(node.start + 1, first.keyStart);
    const trail = text.slice(last.node.end, node.end - 1);
    const multi = lead.indexOf("\n") >= 0;
    const sep = node.members.length >= 2 ? text.slice(first.node.end, node.members[1].keyStart) : multi ? "," + lead : ", ";
    const childIndent = multi ? lead.slice(lead.lastIndexOf("\n") + 1) : indent;
    const parts = keys.map((k) => {
      const old = node.members.find((m) => m.key === k);
      if (old) return text.slice(old.keyStart, old.node.start) + patchNode(text, old.node, nv[k], childIndent, eol);
      return JSON.stringify(k) + ": " + fresh(nv[k], childIndent, !multi, eol);
    });
    return "{" + lead + parts.join(sep) + trail + "}";
  }

  if (node.kind === "array" && Array.isArray(nv)) {
    if (!node.elements.length || !nv.length) return fresh(nv, indent, oneLine && node.elements.length > 0, eol);
    const first = node.elements[0];
    const last = node.elements[node.elements.length - 1];
    const lead = text.slice(node.start + 1, first.start);
    const trail = text.slice(last.end, node.end - 1);
    const multi = lead.indexOf("\n") >= 0;
    const sep = node.elements.length >= 2 ? text.slice(first.end, node.elements[1].start) : multi ? "," + lead : ", ";
    const childIndent = multi ? lead.slice(lead.lastIndexOf("\n") + 1) : indent;
    // unchanged elements keep their exact text wherever they moved to
    const pool = new Map();
    node.elements.forEach((el, idx) => {
      const k = canon(el.value);
      if (!pool.has(k)) pool.set(k, []);
      pool.get(k).push(idx);
    });
    const used = new Set();
    const reuse = nv.map((x) => {
      const q = pool.get(canon(x));
      if (q && q.length) { const idx = q.shift(); used.add(idx); return idx; }
      return -1;
    });
    const hint = node.elements.find((e) => e.kind !== "scalar");
    const hintInline = hint ? text.slice(hint.start, hint.end).indexOf("\n") < 0 : !multi;
    const parts = nv.map((x, j) => {
      if (reuse[j] >= 0) { const el = node.elements[reuse[j]]; return text.slice(el.start, el.end); }
      const same = node.elements[j];
      if (same && !used.has(j) && ((same.kind === "object" && isObj(x)) || (same.kind === "array" && Array.isArray(x)))) {
        used.add(j);
        return patchNode(text, same, x, childIndent, eol);
      }
      return fresh(x, childIndent, hintInline, eol);
    });
    return "[" + lead + parts.join(sep) + trail + "]";
  }

  return fresh(nv, indent, oneLine, eol);
}

// New text of the whole file for `newValue`; surrounding whitespace / EOLs / BOM stay as they were.
function patchText(text, ast, newValue) {
  const eol = eolOf(text);
  const body = patchNode(text, ast, newValue, lineIndent(text, ast.start), eol);
  return text.slice(0, ast.start) + body + text.slice(ast.end);
}

module.exports = { parseWithRanges, patchText, canon, JsonTextError, eolOf };
