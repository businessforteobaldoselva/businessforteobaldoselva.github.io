"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { makeApi, patch, heroOp, T, uuid } = require("../fixtures/harness");

test("common response headers, request id, JSON error envelope", async () => {
  const api = makeApi();
  const ok = await api.call("editor", "GET", "/v1/me");
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get("content-type"), /^application\/json; charset=utf-8$/);
  assert.equal(ok.headers.get("cache-control"), "no-store");
  assert.equal(ok.headers.get("x-content-type-options"), "nosniff");
  assert.equal(ok.headers.get("referrer-policy"), "no-referrer");
  assert.match(ok.headers.get("x-request-id"), /^[0-9a-f-]{36}$/);
  assert.equal(ok.headers.get("set-cookie"), null);
  const bad = await api.call("editor", "GET", "/v1/nothing-here");
  assert.equal(bad.status, 404);
  assert.deepEqual(Object.keys(bad.json).sort(), ["error", "requestId"]);
  assert.deepEqual(Object.keys(bad.json.error).sort(), ["code", "details", "message"]);
  assert.equal(bad.json.requestId, bad.headers.get("x-request-id"));
});

test("auth: missing, malformed, unknown-person and wrong tokens", async () => {
  const api = makeApi();
  assert.equal((await api.call(null, "GET", "/v1/me")).status, 401);
  assert.equal((await api.call("not-a-token-at-all", "GET", "/v1/me")).status, 401);
  assert.equal((await api.call("dev:admin:someone@evil.example", "GET", "/v1/me")).status, 401); // dev emails must end .test
  const stranger = await api.call("dev:editor:stranger@covered.test", "GET", "/v1/me");
  assert.equal(stranger.status, 403);
  assert.equal(stranger.json.error.code, "not_invited");
  const pre = await api.call(null, "GET", "/v1/preview-config");
  assert.equal(pre.status, 200); // the only anonymous route
  assert.equal(JSON.stringify(pre.json).includes("secret"), false);
});

test("role matrix: editor < approver < admin", async () => {
  const api = makeApi();
  // editor drafts; cannot list everyone's drafts, publish, or manage people
  const made = await api.call("editor", "POST", "/v1/drafts", patch(api, [heroOp("Editor edit")]));
  assert.equal(made.status, 201, JSON.stringify(made.json));
  const id = made.json.draft.id;
  assert.equal((await api.call("editor", "GET", "/v1/drafts?scope=all")).status, 403);
  assert.equal((await api.call("editor", "GET", "/v1/admin/people")).status, 403);
  assert.equal((await api.call("editor", "PUT", "/v1/admin/people", { email: "x@y.test", role: "editor", active: true })).status, 403);
  const pub = await api.call("editor", "POST", "/v1/drafts/" + id + "/publish", { idempotencyKey: uuid(), expectedHeadSha: made.json.draft.headSha });
  assert.equal(pub.status, 403);
  // approver sees everyone's drafts and any draft by id; cannot manage people
  const all = await api.call("approver", "GET", "/v1/drafts?scope=all");
  assert.equal(all.status, 200);
  assert.equal(all.json.drafts.length, 1);
  assert.equal((await api.call("approver", "GET", "/v1/drafts/" + id)).status, 200);
  assert.equal((await api.call("approver", "GET", "/v1/drafts?scope=mine")).json.drafts.length, 0);
  assert.equal((await api.call("approver", "GET", "/v1/admin/people")).status, 403);
  // an editor cannot see another editor's draft (404, not 403: do not reveal it exists)
  const other = makeApi({ people: [{ email: "zed@covered.test", displayName: "Zed", role: "editor" }] });
  const zed = "dev:editor:zed@covered.test";
  const m2 = await other.call("editor", "POST", "/v1/drafts", patch(other, [heroOp("Molly edit")]));
  assert.equal((await other.call(zed, "GET", "/v1/drafts/" + m2.json.draft.id)).status, 404);
  assert.equal((await other.call(zed, "DELETE", "/v1/drafts/" + m2.json.draft.id)).status, 404);
  assert.equal((await other.call(zed, "GET", "/v1/drafts?scope=mine")).json.drafts.length, 0);
  // admin manages people
  const people = await api.call("admin", "GET", "/v1/admin/people");
  assert.equal(people.status, 200);
  assert.equal(people.json.people.length, 3);
  const add = await api.call("admin", "PUT", "/v1/admin/people", { email: "New.Person@covered.test", role: "editor", active: true, displayName: "New Person" });
  assert.equal(add.status, 200);
  assert.equal(add.json.person.email, "new.person@covered.test");
});

test("people: last admin and self-demotion guards, validation", async () => {
  const api = makeApi();
  const self = await api.call("admin", "PUT", "/v1/admin/people", { email: "teo@covered.test", role: "editor", active: true });
  assert.equal(self.status, 403);
  const off = await api.call("admin", "PUT", "/v1/admin/people", { email: "teo@covered.test", role: "admin", active: false });
  assert.equal(off.status, 403);
  for (const bad of [{ email: "nope", role: "editor", active: true }, { email: "a@b.test", role: "root", active: true }, { email: "a@b.test", role: "editor", active: "yes" }, { email: "a@b.test", role: "editor", active: true, displayName: "<img onerror=x>" }, { email: "a@b.test", role: "editor", active: true, extra: 1 }]) {
    assert.equal((await api.call("admin", "PUT", "/v1/admin/people", bad)).status, 400, JSON.stringify(bad));
  }
  // promote a second admin, then the first may step down
  await api.call("admin", "PUT", "/v1/admin/people", { email: "amelia@covered.test", role: "admin", active: true });
  const t2 = "dev:admin:amelia@covered.test";
  const down = await api.call(t2, "PUT", "/v1/admin/people", { email: "teo@covered.test", role: "editor", active: true });
  assert.equal(down.status, 200);
  const last = await api.call(t2, "PUT", "/v1/admin/people", { email: "amelia@covered.test", role: "editor", active: true });
  assert.equal(last.status, 403); // her own admin role
});

test("revoking a person takes effect within the 30 second role cache", async () => {
  const api = makeApi();
  assert.equal((await api.call("editor", "GET", "/v1/me")).status, 200);
  await api.call("admin", "PUT", "/v1/admin/people", { email: "molly@covered.test", role: "editor", active: false });
  assert.equal((await api.call("editor", "GET", "/v1/me")).status, 403); // the admin route clears the cache at once
  const b = makeApi();
  assert.equal((await b.call("editor", "GET", "/v1/me")).status, 200);
  await b.deps.roles.upsertPerson("x", { email: "molly@covered.test", role: "editor", active: false }); // revoked behind the API's back
  assert.equal((await b.call("editor", "GET", "/v1/me")).status, 200); // still cached
  b.advance(31000);
  assert.equal((await b.call("editor", "GET", "/v1/me")).status, 403);
});

test("rate limits: anonymous per IP, failed auth per IP, writes per user; Retry-After is set", async () => {
  const api = makeApi({ ipOctet: 9 });
  let last;
  for (let i = 0; i < 31; i += 1) last = await api.call(null, "GET", "/v1/preview-config");
  assert.equal(last.status, 429);
  assert.equal(last.json.error.code, "rate_limited");
  assert.ok(Number(last.headers.get("retry-after")) >= 1);
  const bad = makeApi({ ipOctet: 10 });
  const codes = [];
  for (let i = 0; i < 12; i += 1) codes.push((await bad.call("garbage-token-garbage", "GET", "/v1/me")).status);
  assert.equal(codes.filter((c) => c === 401).length, 10);
  assert.equal(codes[11], 429);
  const w = makeApi({ ipOctet: 11 });
  let status = 0;
  for (let i = 0; i < 22; i += 1) status = (await w.call("editor", "POST", "/v1/drafts", { idempotencyKey: "bad" })).status;
  assert.equal(status, 429);
});

test("bodies: size cap, content type, JSON syntax, unknown fields", async () => {
  const api = makeApi({ env: { STUDIO_MAX_BODY_BYTES: "2000" } });
  const big = await api.call("editor", "POST", "/v1/drafts", JSON.stringify({ pad: "x".repeat(3000) }));
  assert.equal(big.status, 413);
  const noJson = await api.call("editor", "POST", "/v1/drafts", "plain", { "content-type": "text/plain" });
  assert.equal(noJson.status, 415);
  const broken = await api.call("editor", "POST", "/v1/drafts", "{not json");
  assert.equal(broken.status, 400);
  const unknown = await api.call("editor", "POST", "/v1/drafts", { idempotencyKey: uuid(), baseSha: api.mainSha(), ops: [], rogue: true });
  assert.equal(unknown.status, 422);
  assert.equal(unknown.json.error.code, "validation_failed");
});

test("server errors are generic and carry only a request id", async () => {
  const api = makeApi();
  api.deps.git.getHead = async () => { throw new Error("secret-token-ghs_abc123 leaked in a library message"); };
  const origErr = console.error; let logged = "";
  console.error = (m) => { logged += m; };
  try {
    const r = await api.call("editor", "POST", "/v1/drafts", patch(api, [heroOp("x")]));
    assert.equal(r.status, 500);
    assert.equal(r.json.error.code, "internal");
    assert.equal(r.text.includes("ghs_"), false);
    assert.equal(r.text.includes("secret"), false);
    assert.ok(r.text.includes(r.json.requestId));
  } finally { console.error = origErr; }
  assert.ok(logged.includes("internal error"));
});

test("the dev token is useless against a non-dev API (tokens never grant roles by themselves)", async () => {
  const api = makeApi();
  const r = await api.call("dev:admin:teo@covered.test", "GET", "/v1/me");
  assert.equal(r.json.role, "admin"); // the ROLE STORE decided that, not the token text
  const r2 = await api.call("dev:admin:molly@covered.test", "GET", "/v1/me");
  assert.equal(r2.json.role, "editor"); // claiming admin in the token changes nothing
  assert.equal((await api.call("dev:admin:molly@covered.test", "GET", "/v1/admin/people")).status, 403);
});
