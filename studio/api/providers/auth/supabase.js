"use strict";
// Supabase Auth JWT verification with WebCrypto only (DESIGN 8.2). Portable.
//   mode "hs256": only alg HS256, key = SUPABASE_JWT_SECRET (HMAC).
//   mode "jwks" : only RS256 / ES256, key = the JWK with the token's `kid` from {SUPABASE_URL}/auth/v1/.well-known/jwks.json
// The header's `alg` NEVER chooses the key type: the configured mode does. "none", a missing kid in jwks mode, a typ other
// than JWT, an oversized token, wrong iss / aud / role, expiry, and not-yet-valid tokens are all refused.
// user_metadata / app_metadata are never used for authorisation (only the display name is read from user_metadata).

const { AuthError, UUID_RE, b64urlToBytes, b64urlToJson, cleanName } = require("./interface");

const LEEWAY_S = 30;
const MAX_TOKEN = 8192;
const JWKS_TTL_MS = 10 * 60 * 1000;
const JWKS_MIN_REFETCH_MS = 30 * 1000;

function createSupabaseAuth({ supabaseUrl, mode, jwtSecret, fetch: fetchFn, now }) {
  if (!/^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(supabaseUrl || "") && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(supabaseUrl || "")) throw new Error("SUPABASE_URL must be an https origin");
  if (mode !== "hs256" && mode !== "jwks") throw new Error("STUDIO_JWT_MODE must be hs256 or jwks");
  if (mode === "hs256" && !(typeof jwtSecret === "string" && jwtSecret.length >= 16)) throw new Error("SUPABASE_JWT_SECRET is required for hs256");
  const issuer = supabaseUrl.replace(/\/+$/, "") + "/auth/v1";
  const clock = now || (() => new Date());
  const doFetch = fetchFn || ((...a) => fetch(...a));
  let hmacKey = null;
  let jwks = { at: 0, keys: new Map() };
  let forcedAt = 0;

  async function getHmacKey() {
    if (!hmacKey) hmacKey = await crypto.subtle.importKey("raw", new TextEncoder().encode(jwtSecret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
    return hmacKey;
  }

  async function loadJwks(force) {
    const t = clock().getTime();
    if (!force && t - jwks.at < JWKS_TTL_MS) return;
    if (force) {
      if (t - forcedAt < JWKS_MIN_REFETCH_MS) return; // rate limit refetches triggered by unknown kids
      forcedAt = t;
    }
    let res;
    try { res = await doFetch(issuer + "/.well-known/jwks.json", { headers: { Accept: "application/json" } }); } catch (e) { throw new AuthError("keys_unavailable", "cannot fetch the signing keys"); }
    if (!res.ok) throw new AuthError("keys_unavailable", "signing keys: HTTP " + res.status);
    let body;
    try { body = await res.json(); } catch (e) { throw new AuthError("keys_unavailable", "signing keys are not JSON"); }
    const keys = new Map();
    for (const k of (body && body.keys) || []) if (k && typeof k.kid === "string") keys.set(k.kid, k);
    jwks = { at: t, keys };
  }

  async function jwkFor(kid, alg) {
    await loadJwks(false);
    if (!jwks.keys.has(kid)) await loadJwks(true);
    const jwk = jwks.keys.get(kid);
    if (!jwk) throw new AuthError("unknown_kid", "unknown signing key");
    if (jwk.use && jwk.use !== "sig") throw new AuthError("bad_key", "key is not for signatures");
    if (jwk.alg && jwk.alg !== alg) throw new AuthError("bad_key", "key algorithm mismatch");
    if ((alg === "RS256" && jwk.kty !== "RSA") || (alg === "ES256" && (jwk.kty !== "EC" || jwk.crv !== "P-256"))) throw new AuthError("bad_key", "key type mismatch");
    const algo = alg === "RS256" ? { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } : { name: "ECDSA", namedCurve: "P-256" };
    const clean = { kty: jwk.kty, n: jwk.n, e: jwk.e, crv: jwk.crv, x: jwk.x, y: jwk.y, ext: true };
    Object.keys(clean).forEach((k) => clean[k] === undefined && delete clean[k]);
    return crypto.subtle.importKey("jwk", clean, algo, false, ["verify"]);
  }

  async function verify(token, opts) {
    if (typeof token !== "string" || token.length < 20 || token.length > MAX_TOKEN) throw new AuthError("malformed", "token size");
    const parts = token.split(".");
    if (parts.length !== 3) throw new AuthError("malformed", "token parts");
    const header = b64urlToJson(parts[0]);
    const claims = b64urlToJson(parts[1]);
    if (!header || typeof header !== "object" || Array.isArray(header) || !claims || typeof claims !== "object" || Array.isArray(claims)) throw new AuthError("malformed", "token json");
    if (header.typ !== undefined && header.typ !== "JWT") throw new AuthError("bad_header", "typ");
    if (header.crit !== undefined || header.jku !== undefined || header.jwk !== undefined || header.x5u !== undefined) throw new AuthError("bad_header", "unsupported header");
    const signed = new TextEncoder().encode(parts[0] + "." + parts[1]);
    const sig = b64urlToBytes(parts[2]);
    let ok = false;
    if (mode === "hs256") {
      if (header.alg !== "HS256") throw new AuthError("bad_alg", "expected HS256");
      ok = await crypto.subtle.verify("HMAC", await getHmacKey(), sig, signed);
    } else {
      if (header.alg !== "RS256" && header.alg !== "ES256") throw new AuthError("bad_alg", "expected RS256 or ES256");
      if (typeof header.kid !== "string" || !header.kid || header.kid.length > 100) throw new AuthError("bad_header", "kid required");
      const key = await jwkFor(header.kid, header.alg);
      ok = await crypto.subtle.verify(header.alg === "RS256" ? { name: "RSASSA-PKCS1-v1_5" } : { name: "ECDSA", hash: "SHA-256" }, key, sig, signed);
    }
    if (!ok) throw new AuthError("bad_signature", "signature");

    const nowS = Math.floor(((opts && opts.now) || clock()).getTime() / 1000);
    if (claims.iss !== issuer) throw new AuthError("bad_claims", "iss");
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (aud.indexOf("authenticated") < 0) throw new AuthError("bad_claims", "aud");
    if (claims.role !== "authenticated") throw new AuthError("bad_claims", "role");
    if (typeof claims.sub !== "string" || !UUID_RE.test(claims.sub)) throw new AuthError("bad_claims", "sub");
    if (typeof claims.exp !== "number" || !(claims.exp > nowS - LEEWAY_S)) throw new AuthError("expired", "exp");
    if (claims.nbf !== undefined && !(typeof claims.nbf === "number" && claims.nbf <= nowS + LEEWAY_S)) throw new AuthError("bad_claims", "nbf");
    if (claims.iat !== undefined && !(typeof claims.iat === "number" && claims.iat <= nowS + LEEWAY_S)) throw new AuthError("bad_claims", "iat");
    if (typeof claims.email !== "string" || !/^[^\s@<>]+@[^\s@<>]+$/.test(claims.email) || claims.email.length > 254) throw new AuthError("bad_claims", "email");
    if (claims.email_verified === false) throw new AuthError("bad_claims", "email_verified");
    const meta = claims.user_metadata && typeof claims.user_metadata === "object" ? claims.user_metadata : {};
    const email = claims.email.toLowerCase();
    return { userId: claims.sub.toLowerCase(), email, name: cleanName(meta.full_name || meta.name, email.split("@")[0]) };
  }

  return { verify, mode, issuer };
}

module.exports = { createSupabaseAuth };
