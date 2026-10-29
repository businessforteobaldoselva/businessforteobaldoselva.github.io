"use strict";
// Draft ids and branch names (DESIGN 7.4). Ids never contain an email or a name.
//   userKey = "u" + first 7 chars of base32(sha256(userId));  slug = [a-z0-9-]{3,40} from the title
//   draft id = userKey + "--" + slug;   branch = "studio/" + userKey + "/" + slug
// Portable (crypto.subtle).

const B32 = "abcdefghijklmnopqrstuvwxyz234567";

async function sha256Bytes(text) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

function base32(bytes) {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

async function userKey(userId) {
  return "u" + base32(await sha256Bytes(String(userId).toLowerCase())).slice(0, 7);
}

function slugify(title) {
  const s = String(title || "").toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/g, "");
  return s.length >= 3 ? s : "draft";
}

// deterministic 4-char suffix from an idempotency key: a retried create picks the same branch name
async function keySuffix(key) {
  return base32(await sha256Bytes("slug:" + key)).slice(0, 4).replace(/[^a-z0-9]/g, "x");
}

const branchOf = (uk, slug) => "studio/" + uk + "/" + slug;
const idOf = (uk, slug) => uk + "--" + slug;

// "u7k2m9qa--summer-edits" -> { userKey, slug, branch } | null
function parseId(id) {
  const m = /^(u[a-z2-7]{7})--([a-z0-9][a-z0-9-]{1,50})$/.exec(String(id));
  return m ? { userKey: m[1], slug: m[2], branch: branchOf(m[1], m[2]) } : null;
}
// "studio/u7k2m9qa/summer-edits" -> id | null
function idFromBranch(branch) {
  const m = /^studio\/(u[a-z2-7]{7})\/([a-z0-9][a-z0-9-]{1,50})$/.exec(String(branch));
  return m ? idOf(m[1], m[2]) : null;
}

module.exports = { userKey, slugify, keySuffix, branchOf, idOf, parseId, idFromBranch, base32 };
