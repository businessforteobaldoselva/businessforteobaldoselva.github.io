"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { makeApi, patch, heroOp, ORIGIN } = require("../fixtures/harness");
const { createCors, isValidOrigin, templateToRegExp } = require("../../api/cors");
const { loadConfig } = require("../../api/config");

test("exact origins: echoed, never *, no credentials header, Vary: Origin", async () => {
  const api = makeApi();
  const r = await api.call("editor", "GET", "/v1/me");
  assert.equal(r.headers.get("access-control-allow-origin"), ORIGIN);
  assert.equal(r.headers.get("vary"), "Origin");
  assert.equal(r.headers.get("access-control-allow-credentials"), null);
  assert.notEqual(r.headers.get("access-control-allow-origin"), "*");
});

test("a non-allowed origin gets no CORS headers, and cannot make state-changing calls", async () => {
  const api = makeApi();
  const evil = { origin: "https://evil.example" };
  const get = await api.call("editor", "GET", "/v1/me", undefined, evil);
  assert.equal(get.headers.get("access-control-allow-origin"), null);
  const post = await api.call("editor", "POST", "/v1/drafts", patch(api, [heroOp("hacked")]), evil);
  assert.equal(post.status, 403);
  assert.equal(post.headers.get("access-control-allow-origin"), null);
  assert.equal(api.repo.prs.size, 0);
  for (const o of ["http://localhost:8080.evil.example", "http://localhost:80801", "https://localhost:8080", "http://localhost", "null", "http://LOCALHOST:8080"]) {
    const r = await api.call("editor", "DELETE", "/v1/drafts/uabcdefg--x", undefined, { origin: o });
    assert.equal(r.status, 403, o);
  }
});

test("preflight: allowed origin gets 204 with the exact header set; others are refused", async () => {
  const api = makeApi();
  const ok = await api.call(null, "OPTIONS", "/v1/drafts", undefined, { "access-control-request-method": "POST" });
  assert.equal(ok.status, 204);
  assert.equal(ok.headers.get("access-control-allow-origin"), ORIGIN);
  assert.equal(ok.headers.get("access-control-allow-headers"), "Authorization, Content-Type, Idempotency-Key");
  assert.equal(ok.headers.get("access-control-allow-methods"), "GET, POST, PUT, DELETE, OPTIONS");
  assert.equal(ok.headers.get("access-control-max-age"), "600");
  const no = await api.call(null, "OPTIONS", "/v1/drafts", undefined, { origin: "https://evil.example" });
  assert.equal(no.status, 403);
  assert.equal(no.headers.get("access-control-allow-origin"), null);
});

test("CSRF: writes need an allowed Origin (or the explicit test flag) and application/json; cookies are never read", async () => {
  const strict = makeApi({ env: { STUDIO_ALLOW_NO_ORIGIN: "" } });
  const noOrigin = await strict.call("editor", "POST", "/v1/drafts", patch(strict, [heroOp("x")]), { origin: "" });
  assert.equal(noOrigin.status, 403);
  const form = await strict.call("editor", "POST", "/v1/drafts", "a=b", { "content-type": "application/x-www-form-urlencoded" });
  assert.equal(form.status, 415);
  const plain = await strict.call("editor", "POST", "/v1/drafts", JSON.stringify(patch(strict, [heroOp("x")])), { "content-type": "text/plain" });
  assert.equal(plain.status, 415);
  // a cookie alone authenticates nothing
  const cookie = await strict.call(null, "GET", "/v1/me", undefined, { cookie: "token=dev:admin:teo@covered.test; session=abc" });
  assert.equal(cookie.status, 401);
  assert.equal(strict.repo.prs.size, 0);
});

test("origin validation and the preview template are strict", () => {
  for (const bad of ["*", "", "https://*.example.com", "https://a.example/path", "http://example.com", "ftp://x", "https://a b.example", "https://", "localhost:8080"]) assert.equal(isValidOrigin(bad), false, bad);
  for (const good of ["https://studio.example.com", "http://localhost:8080", "http://127.0.0.1:3000", "https://a.example:8443"]) assert.equal(isValidOrigin(good), true, good);
  const re = templateToRegExp("https://deploy-preview-{n}--coveredaccess.netlify.app");
  assert.equal(re.test("https://deploy-preview-57--coveredaccess.netlify.app"), true);
  for (const bad of ["https://deploy-preview-57--coveredaccess.netlify.app.evil.com", "https://deploy-preview-x--coveredaccess.netlify.app", "http://deploy-preview-57--coveredaccess.netlify.app", "https://deploy-preview-57--other.netlify.app", "https://deploy-preview-1234567--coveredaccess.netlify.app", "https://xdeploy-preview-5--coveredaccess.netlify.app", "https://deploy-preview-5--coveredaccessXnetlify.app", "https://deploy-preview-5--coveredaccess.netlify.app:8443"]) assert.equal(re.test(bad), false, bad);
  assert.throws(() => templateToRegExp("https://x.example"), /\{n\}/);
  assert.throws(() => templateToRegExp("http://x-{n}.example"), /https/);
  const cors = createCors({ allowedOrigins: [], previewTemplate: "https://deploy-preview-{n}--coveredaccess.netlify.app" });
  assert.ok(cors.headers("https://deploy-preview-9--coveredaccess.netlify.app")["Access-Control-Allow-Origin"]);
  assert.deepEqual(cors.headers("https://deploy-preview-9--coveredaccess.netlify.app.evil.com"), {});
});

test("configuration refuses a wildcard, empty entry, path or non-local http origin", () => {
  const base = { STUDIO_ENV: "development", STUDIO_DEV: "1" };
  for (const bad of ["*", "http://localhost:8080,", "https://a.example/x", "http://evil.example", " , "]) assert.throws(() => loadConfig(Object.assign({}, base, { STUDIO_ALLOWED_ORIGINS: bad })), /origin|ALLOWED/i, bad);
  assert.doesNotThrow(() => loadConfig(Object.assign({}, base, { STUDIO_ALLOWED_ORIGINS: "http://localhost:8080, http://127.0.0.1:8080" })));
});
