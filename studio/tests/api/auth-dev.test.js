"use strict";
// The dev auth stub cannot be switched on in production (DESIGN 8.4): three required scenarios plus the config refusals.
const test = require("node:test");
const assert = require("node:assert/strict");
const { createDevAuth, assertDevAllowed } = require("../../api/providers/auth/dev");
const { loadConfig, ConfigError } = require("../../api/config");

const DEV = { STUDIO_DEV: "1", STUDIO_ENV: "development" };

test("production env + STUDIO_DEV=1: start-up throws", () => {
  assert.throws(() => createDevAuth({ STUDIO_DEV: "1", STUDIO_ENV: "production" }, "http://localhost/"), /production/);
  assert.throws(() => createDevAuth({ STUDIO_DEV: "1" }, "http://localhost/"), /production/); // unset STUDIO_ENV means production
  assert.throws(() => loadConfig({ STUDIO_DEV: "1", STUDIO_ENV: "production", STUDIO_ALLOWED_ORIGINS: "http://localhost:8080" }), ConfigError);
  assert.throws(() => loadConfig({ STUDIO_DEV: "1", STUDIO_ALLOWED_ORIGINS: "http://localhost:8080" }), /production/);
});

test("localhost + STUDIO_DEV unset: dev: tokens are refused", async () => {
  assert.throws(() => createDevAuth({ STUDIO_ENV: "development" }, "http://localhost/"), /STUDIO_DEV/);
  const { makeApi } = require("../fixtures/harness");
  const api = makeApi();
  api.deps.auth = { verify: async (t, o) => { const a = createDevAuth({ STUDIO_ENV: "development" }, "http://localhost/"); return a.verify(t, o); } };
  assert.equal((await api.call("dev:admin:teo@covered.test", "GET", "/v1/me")).status, 401);
});

test("non-local Host with STUDIO_DEV=1: 401 even for a well-formed dev token (checked on EVERY request)", async () => {
  const auth = createDevAuth(DEV, "http://localhost/");
  const good = await auth.verify("dev:editor:molly@covered.test", { url: "http://localhost:8787/v1/me" });
  assert.equal(good.email, "molly@covered.test");
  for (const url of ["https://studio.example.com/v1/me", "http://10.0.0.5:8787/v1/me", "http://localhost.evil.example/v1/me", "http://evil.example@127.0.0.1.evil.example/", "http://0.0.0.0/", ""]) {
    await assert.rejects(() => auth.verify("dev:editor:molly@covered.test", { url }), (e) => e.name === "AuthError", url);
  }
  for (const url of ["http://127.0.0.1:1/", "http://[::1]:8787/v1/me", "http://localhost/"]) assert.doesNotReject(() => auth.verify("dev:editor:molly@covered.test", { url }));
  // through the whole handler: a request that arrives on a public address
  const { makeApi } = require("../fixtures/harness");
  const api = makeApi();
  const res = await api.handler(new Request("https://studio.example.com/v1/me", { headers: { authorization: "Bearer dev:editor:molly@covered.test", origin: "http://localhost:8080", "x-studio-client-ip": "9.9.9.9" } }));
  assert.equal(res.status, 401);
});

test("real secrets next to STUDIO_DEV=1 are refused", () => {
  assert.throws(() => createDevAuth(Object.assign({ GITHUB_APP_PRIVATE_KEY: "-----BEGIN" }, DEV), "http://localhost/"), /GITHUB_APP_PRIVATE_KEY/);
  assert.throws(() => createDevAuth(Object.assign({ SUPABASE_JWT_SECRET: "x".repeat(32) }, DEV), "http://localhost/"), /SUPABASE_JWT_SECRET/);
  assert.throws(() => loadConfig(Object.assign({ GITHUB_APP_PRIVATE_KEY: "k" }, DEV)), /GITHUB_APP_PRIVATE_KEY/);
  assert.throws(() => loadConfig(Object.assign({ SUPABASE_JWT_SECRET: "x".repeat(32) }, DEV)), /SUPABASE_JWT_SECRET/);
  assert.throws(() => loadConfig(Object.assign({ STUDIO_ALLOWED_ORIGINS: "https://studio.example.com" }, DEV)), /localhost/);
});

test("token grammar: role word and an email ending .test or @localhost only", async () => {
  const auth = createDevAuth(DEV, "http://localhost/");
  const u = { url: "http://localhost/" };
  for (const bad of ["dev:root:a@b.test", "dev:editor:a@b.com", "dev:editor:a@b.test.evil.com", "dev:editor:A@b.test", "dev:editor:a b@b.test", "dev:editor:", "dev:editor", "Bearer dev:editor:a@b.test", "dev:editor:a@b.test\n", "dev:editor:a@btest"]) {
    await assert.rejects(() => auth.verify(bad, u), (e) => e.name === "AuthError", JSON.stringify(bad));
  }
  assert.equal((await auth.verify("dev:admin:me@localhost", u)).email, "me@localhost");
  assert.equal((await auth.verify("dev:editor:a@sub.covered.test", u)).email, "a@sub.covered.test");
  assertDevAllowed(DEV, "http://localhost:3000");
});
