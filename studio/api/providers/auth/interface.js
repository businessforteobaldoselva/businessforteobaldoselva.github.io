"use strict";
// AuthProvider interface (DESIGN 8.1):
//   verify(token, { now, url, env }) -> Promise<{ userId, email, name }>   throws AuthError(code) on ANY failure
// The caller never learns WHY a token failed beyond the code (the message is for logs, the client sees "unauthorized").

class AuthError extends Error {
  constructor(code, message) { super(message || code); this.name = "AuthError"; this.code = code; }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function b64urlToBytes(s) {
  if (typeof s !== "string" || !/^[A-Za-z0-9_-]*$/.test(s)) throw new AuthError("malformed", "bad base64url");
  const b = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(b);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

function b64urlToJson(s) {
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(b64urlToBytes(s))); } catch (e) { throw new AuthError("malformed", "bad token part"); }
}

// A display name that is safe to show anywhere: no control characters, no markup, <= 60 chars.
function cleanName(s, fallback) {
  const t = String(s == null ? "" : s).replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069<>`]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);
  return t || fallback || "Someone";
}

module.exports = { AuthError, UUID_RE, b64urlToBytes, b64urlToJson, cleanName };
