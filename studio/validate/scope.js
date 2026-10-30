"use strict";
// THE definition of what Studio may change (DESIGN 6.2). Imported by the validator, by every GitProvider and by the
// CI guard (studio/guards/check-scope.js). Nothing else in the repository is ever written through Studio.
//
//   data:   src/_data/<name>.json   (the file must already exist)
//   pages:  src/pages/<name>.md     (the file must already exist)
//   images: images/<name>.<ext>     (upload targets only; an existing file is never overwritten)

const DATA_RE = /^src\/_data\/[a-z0-9-]+\.json$/;
const PAGE_RE = /^src\/pages\/[a-z0-9-]+\.md$/;
const IMAGE_RE = /^images\/[A-Za-z0-9][A-Za-z0-9._-]{0,79}\.(?:jpg|jpeg|png|webp|gif|avif|svg)$/i;

// con, nul, com1 ...: names Windows cannot hold (one definition, shared with the picture rules)
const { WINDOWS_RESERVED } = require("../../scripts/lib/image-rules");

class ScopeError extends Error {
  constructor(message, path) { super(message); this.name = "ScopeError"; this.path = path; }
}

// "data" | "page" | "image" | null. Exact string match on the path as given: no normalisation, no decoding.
function classify(path) {
  if (typeof path !== "string" || path.length === 0 || path.length > 120) return null;
  if (/[\u0000-\u001f\u007f\%]/.test(path) || path.startsWith("/") || path.indexOf("..") >= 0 || path.indexOf("//") >= 0) return null;
  if (path !== path.normalize("NFC")) return null;
  if (DATA_RE.test(path)) return "data";
  if (PAGE_RE.test(path)) return "page";
  if (IMAGE_RE.test(path) && !/\.\.|\.$/.test(path) && !WINDOWS_RESERVED.test(path.slice(7).split(".")[0])) return "image";
  return null;
}

const isInScope = (path) => classify(path) !== null;

// Throws ScopeError unless `path` is in scope (optionally only for the given kinds).
function assertInScope(path, kinds) {
  const k = classify(path);
  if (!k || (kinds && kinds.indexOf(k) < 0)) throw new ScopeError("Studio may not touch " + JSON.stringify(String(path).slice(0, 80)), path);
  return k;
}

const BRANCH_PREFIX = "studio/";
const BRANCH_RE = /^studio\/[a-z0-9]{1,16}\/[a-z0-9][a-z0-9-]{1,60}$/;
function assertStudioBranch(name) {
  if (typeof name !== "string" || !BRANCH_RE.test(name)) throw new ScopeError("Studio only writes to studio/<user>/<name> branches", name);
  return name;
}

module.exports = { classify, isInScope, assertInScope, assertStudioBranch, ScopeError, DATA_RE, PAGE_RE, IMAGE_RE, BRANCH_PREFIX, BRANCH_RE };
