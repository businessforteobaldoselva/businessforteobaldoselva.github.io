"use strict";
// Supabase JWT verification with vectors generated at test time (HS256, RS256, ES256) and every way a token can be wrong.
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const { createSupabaseAuth } = require("../../api/providers/auth/supabase");

const URL_ = "https://abcd.supabase.co";
const ISS = URL_ + "/auth/v1";
const SECRET = "super-secret-jwt-secret-at-least-32-chars!!";
const NOW = new Date("2026-10-29T12:00:00Z");
const nowS = Math.floor(NOW.getTime() / 1000);
const b64u = (b) => Buffer.from(b).toString("base64url");
const SUB = "4ce9d419-e0c5-40cd-b421-fc9138ed7895";

const claims = (over) => Object.assign({ iss: ISS, aud: "authenticated", role: "authenticated", sub: SUB, email: "Molly@Covered.Test", exp: nowS + 3600, iat: nowS - 10, user_metadata: { full_name: "Molly <b>M</b>" } }, over || {});
function sign(header, payload, alg, key) {
  const input = b64u(JSON.stringify(header)) + "." + b64u(JSON.stringify(payload));
  let sig;
  if (alg === "HS256") sig = crypto.createHmac("sha256", key).update(input).digest();
  else if (alg === "RS256") sig = crypto.sign("sha256", Buffer.from(input), key);
  else if (alg === "ES256") sig = crypto.sign("sha256", Buffer.from(input), { key, dsaEncoding: "ieee-p1363" });
  else sig = Buffer.alloc(0);
  return input + "." + b64u(sig);
}
const hs = (over, hdr) => sign(Object.assign({ alg: "HS256", typ: "JWT" }, hdr || {}), claims(over), "HS256", SECRET);
const hsAuth = () => createSupabaseAuth({ supabaseUrl: URL_, mode: "hs256", jwtSecret: SECRET, now: () => NOW });

const rsa = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const ec = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
const jwk = (pub, kid, extra) => Object.assign(pub.export({ format: "jwk" }), { kid, use: "sig" }, extra || {});
function jwksFetch(keys, counter) {
  return async (url) => {
    if (counter) counter.n += 1;
    assert.equal(String(url), ISS + "/.well-known/jwks.json");
    return { ok: true, status: 200, json: async () => ({ keys }) };
  };
}
const rsTok = (over, hdr) => sign(Object.assign({ alg: "RS256", typ: "JWT", kid: "rsa1" }, hdr || {}), claims(over), "RS256", rsa.privateKey);
const esTok = (over, hdr) => sign(Object.assign({ alg: "ES256", typ: "JWT", kid: "ec1" }, hdr || {}), claims(over), "ES256", ec.privateKey);
const jAuth = (keys, counter, now) => createSupabaseAuth({ supabaseUrl: URL_, mode: "jwks", fetch: jwksFetch(keys, counter), now: () => now || NOW });
const KEYS = () => [jwk(rsa.publicKey, "rsa1", { alg: "RS256" }), jwk(ec.publicKey, "ec1", { alg: "ES256" })];

async function bad(auth, token, code) {
  await assert.rejects(() => auth.verify(token, { now: NOW }), (e) => e.name === "AuthError" && (!code || e.code === code), code || "any AuthError");
}

test("HS256: a good token verifies and the identity is normalised and safe", async () => {
  const u = await hsAuth().verify(hs(), { now: NOW });
  assert.equal(u.userId, SUB);
  assert.equal(u.email, "molly@covered.test");
  assert.equal(u.name.includes("<"), false);
});

test("RS256 and ES256 via JWKS verify; keys are cached", async () => {
  const counter = { n: 0 };
  const auth = jAuth(KEYS(), counter);
  assert.equal((await auth.verify(rsTok(), { now: NOW })).email, "molly@covered.test");
  assert.equal((await auth.verify(esTok(), { now: NOW })).email, "molly@covered.test");
  assert.equal((await auth.verify(rsTok(), { now: NOW })).userId, SUB);
  assert.equal(counter.n, 1);
});

test("alg=none, algorithm confusion, wrong mode and weak algs are refused", async () => {
  const none = b64u(JSON.stringify({ alg: "none", typ: "JWT" })) + "." + b64u(JSON.stringify(claims())) + ".";
  await bad(hsAuth(), none);
  await bad(hsAuth(), b64u(JSON.stringify({ alg: "NONE", typ: "JWT" })) + "." + b64u(JSON.stringify(claims())) + ".AAAA");
  await bad(jAuth(KEYS()), none);
  // an RS256 token offered to an hs256 deployment, and an HS256 token to a jwks one
  await bad(hsAuth(), rsTok(), "bad_alg");
  await bad(jAuth(KEYS()), hs(undefined, { kid: "rsa1" }), "bad_alg");
  // classic confusion: HS256 signed with the PUBLIC key text, kid pointing at the RSA key
  const pem = rsa.publicKey.export({ type: "spki", format: "pem" });
  await bad(jAuth(KEYS()), sign({ alg: "HS256", typ: "JWT", kid: "rsa1" }, claims(), "HS256", pem), "bad_alg");
  for (const alg of ["HS384", "RS512", "PS256", "ES512", "EdDSA"]) await bad(jAuth(KEYS()), sign({ alg, typ: "JWT", kid: "rsa1" }, claims(), "RS256", rsa.privateKey), "bad_alg");
  // a key of the wrong type for the header alg
  await bad(jAuth(KEYS()), sign({ alg: "ES256", typ: "JWT", kid: "rsa1" }, claims(), "ES256", ec.privateKey));
  await bad(jAuth([jwk(rsa.publicKey, "rsa1", { alg: "RS384" })]), rsTok());
  await bad(jAuth([jwk(rsa.publicKey, "rsa1", { use: "enc" })]), rsTok());
});

test("header rules: typ, kid required in jwks mode, no embedded keys or crit", async () => {
  await bad(hsAuth(), hs(undefined, { typ: "JWE" }), "bad_header");
  await bad(jAuth(KEYS()), rsTok(undefined, { kid: undefined }), "bad_header");
  await bad(jAuth(KEYS()), rsTok(undefined, { kid: "x".repeat(200) }), "bad_header");
  await bad(hsAuth(), hs(undefined, { jwk: { kty: "oct" } }), "bad_header");
  await bad(hsAuth(), hs(undefined, { jku: "https://evil.example/keys" }), "bad_header");
  await bad(hsAuth(), hs(undefined, { crit: ["exp"] }), "bad_header");
  const noTyp = sign({ alg: "HS256" }, claims(), "HS256", SECRET);
  assert.equal((await hsAuth().verify(noTyp, { now: NOW })).userId, SUB); // typ is optional
});

test("signature: tampered payload, wrong secret, truncated, garbage, oversized", async () => {
  const t = hs();
  const parts = t.split(".");
  const forged = parts[0] + "." + b64u(JSON.stringify(claims({ sub: "11111111-1111-4111-8111-111111111111" }))) + "." + parts[2];
  await bad(hsAuth(), forged, "bad_signature");
  await bad(createSupabaseAuth({ supabaseUrl: URL_, mode: "hs256", jwtSecret: "another-secret-another-secret-123456", now: () => NOW }), t, "bad_signature");
  await bad(hsAuth(), t.slice(0, -4));
  for (const g of ["", "a.b", "a.b.c.d", "....", "!!!.???.***", "x".repeat(8193), null, undefined, 42, {}]) await bad(hsAuth(), g);
  const es = esTok();
  const mid = es.lastIndexOf(".") + 20;
  await bad(jAuth(KEYS()), es.slice(0, mid) + (es[mid] === "A" ? "B" : "A") + es.slice(mid + 1));
});

test("claims: iss, aud, role, sub, email, expiry, not-before, issued-at", async () => {
  const a = hsAuth();
  await bad(a, hs({ iss: "https://evil.example/auth/v1" }), "bad_claims");
  await bad(a, hs({ iss: ISS + "/" }), "bad_claims");
  await bad(a, hs({ aud: "anon" }), "bad_claims");
  await bad(a, hs({ aud: undefined }), "bad_claims");
  assert.equal((await a.verify(hs({ aud: ["x", "authenticated"] }), { now: NOW })).userId, SUB);
  for (const role of ["anon", "service_role", "supabase_admin", undefined]) await bad(a, hs({ role }), "bad_claims");
  for (const sub of ["not-a-uuid", "", undefined, 5, "' OR 1=1 --"]) await bad(a, hs({ sub }), "bad_claims");
  for (const email of [undefined, "", "no-at-sign", "a b@c.d", "<x>@y.z", 5]) await bad(a, hs({ email }), "bad_claims");
  await bad(a, hs({ email_verified: false }), "bad_claims");
  await bad(a, hs({ exp: nowS - 31 }), "expired");
  await bad(a, hs({ exp: undefined }), "expired");
  await bad(a, hs({ exp: "9999999999" }), "expired");
  assert.equal((await a.verify(hs({ exp: nowS - 10 }), { now: NOW })).userId, SUB); // 30 s leeway
  await bad(a, hs({ nbf: nowS + 60 }), "bad_claims");
  await bad(a, hs({ iat: nowS + 3600 }), "bad_claims");
  assert.equal((await a.verify(hs({ nbf: nowS + 20, iat: nowS + 20 }), { now: NOW })).userId, SUB);
});

test("metadata never grants anything: app_metadata / user_metadata roles are ignored", async () => {
  const u = await hsAuth().verify(hs({ app_metadata: { role: "admin" }, user_metadata: { role: "admin", full_name: "Admin" } }), { now: NOW });
  assert.deepEqual(Object.keys(u).sort(), ["email", "name", "userId"]);
});

test("JWKS: unknown kid triggers ONE refetch, then is rate limited; failures are AuthErrors", async () => {
  const counter = { n: 0 };
  let t = NOW;
  const auth = createSupabaseAuth({ supabaseUrl: URL_, mode: "jwks", fetch: jwksFetch(KEYS(), counter), now: () => t });
  await bad(auth, rsTok(undefined, { kid: "ghost" }), "unknown_kid");
  assert.equal(counter.n, 2); // first load + one forced refetch
  await bad(auth, rsTok(undefined, { kid: "ghost2" }), "unknown_kid");
  assert.equal(counter.n, 2); // inside the 30 s window: no hammering of the key endpoint
  t = new Date(t.getTime() + 31000);
  await bad(auth, rsTok(undefined, { kid: "ghost3" }), "unknown_kid");
  assert.equal(counter.n, 3);
  const down = createSupabaseAuth({ supabaseUrl: URL_, mode: "jwks", fetch: async () => ({ ok: false, status: 503 }), now: () => NOW });
  await bad(down, rsTok(), "keys_unavailable");
  const boom = createSupabaseAuth({ supabaseUrl: URL_, mode: "jwks", fetch: async () => { throw new Error("net"); }, now: () => NOW });
  await bad(boom, rsTok(), "keys_unavailable");
  // the key set is refreshed after its 10 minute life
  const c2 = { n: 0 };
  t = NOW;
  const auth2 = createSupabaseAuth({ supabaseUrl: URL_, mode: "jwks", fetch: jwksFetch(KEYS(), c2), now: () => t });
  await auth2.verify(rsTok(), { now: NOW });
  t = new Date(NOW.getTime() + 11 * 60000);
  await auth2.verify(rsTok({ exp: Math.floor(t.getTime() / 1000) + 600 }), { now: t });
  assert.equal(c2.n, 2);
});

test("construction refuses weak or missing configuration", () => {
  assert.throws(() => createSupabaseAuth({ supabaseUrl: "http://evil.example", mode: "hs256", jwtSecret: SECRET }), /https/);
  assert.throws(() => createSupabaseAuth({ supabaseUrl: URL_, mode: "hs256", jwtSecret: "short" }), /SECRET/);
  assert.throws(() => createSupabaseAuth({ supabaseUrl: URL_, mode: "none" }), /MODE/);
  assert.throws(() => createSupabaseAuth({ supabaseUrl: "", mode: "jwks" }), /https/);
});
