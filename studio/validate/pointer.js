"use strict";
// RFC 6901 JSON pointers, restricted: no prototype-polluting segments, canonical array indexes only.
// Pure, portable (no fs / process / Buffer).

const FORBIDDEN_SEGS = new Set(["__proto__", "constructor", "prototype"]);
const INDEX_RE = /^(0|[1-9][0-9]{0,6})$/;

// parse("/a/0/b") -> ["a","0","b"]; throws PointerError. "" (the whole document) is refused: Studio edits inside files.
function parse(ptr) {
  if (typeof ptr !== "string" || ptr.length === 0 || ptr.length > 300) throw new PointerError("a pointer must be a non-empty string of at most 300 characters");
  if (ptr[0] !== "/") throw new PointerError("a pointer must start with /");
  const segs = ptr.slice(1).split("/").map((s) => {
    if (/~(?![01])/.test(s)) throw new PointerError("invalid ~ escape in the pointer");
    const seg = s.replace(/~1/g, "/").replace(/~0/g, "~");
    if (seg.length === 0) throw new PointerError("empty segment in the pointer");
    if (FORBIDDEN_SEGS.has(seg)) throw new PointerError("the segment " + JSON.stringify(seg) + " is not allowed");
    if (/[\u0000-\u001f\u007f]/.test(seg)) throw new PointerError("control characters in the pointer");
    return seg;
  });
  if (segs.length > 20) throw new PointerError("pointer too deep");
  return segs;
}

function format(segs) {
  return "/" + segs.map((s) => String(s).replace(/~/g, "~0").replace(/\//g, "~1")).join("/");
}

const isIndex = (s) => INDEX_RE.test(s);

class PointerError extends Error {
  constructor(message) { super(message); this.name = "PointerError"; }
}

const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v) && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);

// get(doc, segs) -> value or undefined (own properties only; never walks the prototype)
function get(doc, segs) {
  let cur = doc;
  for (const s of segs) {
    if (Array.isArray(cur)) { if (!isIndex(s) || Number(s) >= cur.length) return undefined; cur = cur[Number(s)]; }
    else if (isPlainObject(cur) && hasOwn(cur, s)) cur = cur[s];
    else return undefined;
  }
  return cur;
}

module.exports = { parse, format, get, isIndex, hasOwn, isPlainObject, PointerError, FORBIDDEN_SEGS };
