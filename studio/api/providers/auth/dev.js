"use strict";
// Development auth stub. It is IMPOSSIBLE to enable in production (DESIGN 8.4): every call re-checks that
//   * STUDIO_DEV === "1"
//   * STUDIO_ENV is set and is not "production" (the default when unset IS production)
//   * the request's host is localhost, 127.0.0.1 or [::1]
//   * none of the real-secret variables is set (GITHUB_APP_PRIVATE_KEY, SUPABASE_JWT_SECRET)
// Tokens look like  dev:<role>:<email>  and the email must end in .test or @localhost. Who the person is and which
// role they hold is decided by the (in-memory) role store, never by the token.

const { AuthError } = require("./interface");

const SECRET_VARS = ["GITHUB_APP_PRIVATE_KEY", "SUPABASE_JWT_SECRET"];
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function assertDevAllowed(env, requestUrl) {
  const e = env || {};
  if (e.STUDIO_DEV !== "1") throw new AuthError("dev_disabled", "STUDIO_DEV is not 1");
  if ((e.STUDIO_ENV || "production") === "production") throw new AuthError("dev_disabled", "STUDIO_ENV is production");
  for (const k of SECRET_VARS) if (e[k]) throw new AuthError("dev_disabled", k + " is set");
  let host = "";
  try { host = new URL(requestUrl).hostname.toLowerCase(); } catch (err) { throw new AuthError("dev_disabled", "no request host"); }
  if (!LOCAL_HOSTS.has(host)) throw new AuthError("dev_disabled", "not a local host");
}

function stableUuid(email) {
  // deterministic v4-shaped id from the email (dev only; not secret, not a hash used for security)
  let h = 0x811c9dc5;
  const bytes = [];
  for (let round = 0; round < 16; round += 1) {
    for (let i = 0; i < email.length; i += 1) { h ^= email.charCodeAt(i) + round; h = Math.imul(h, 16777619) >>> 0; }
    bytes.push(h & 255);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
  return hex.slice(0, 8) + "-" + hex.slice(8, 12) + "-" + hex.slice(12, 16) + "-" + hex.slice(16, 20) + "-" + hex.slice(20, 32);
}

// Start-up check (no request yet: pass any local URL) + a provider that re-checks on every verify().
function createDevAuth(env, requestUrl) {
  assertDevAllowed(env, requestUrl);
  return {
    mode: "dev",
    async verify(token, opts) {
      assertDevAllowed(env, opts && opts.url);
      const m2 = /^dev:(editor|approver|admin):([a-z0-9._+-]+@(?:[a-z0-9-]+\.)*test|[a-z0-9._+-]+@localhost)$/.exec(String(token));
      if (!m2) throw new AuthError("malformed", "dev token");
      const email = m2[2];
      return { userId: stableUuid(email), email, name: email.split("@")[0].replace(/^./, (c) => c.toUpperCase()) };
    },
  };
}

module.exports = { createDevAuth, assertDevAllowed, stableUuid, SECRET_VARS };
